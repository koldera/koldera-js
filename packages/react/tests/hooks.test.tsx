import { act, render, renderHook, screen, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ConfigurationError, KolderaProvider, RateLimitError, useDocumentJob, useHtmlToPdfJob, usePdfJob, useReadingOrder, useWebScan, type SessionGrant, type StructuredDocument, type PdfMode, type HtmlToPdfMode, type ImageContentType, type ProblemError, type ProblemCode, type ResponseMeta, type Block, type Inline } from "../dist/index.js";
import { fixtures, GoldenServer, HTML_BYTES, PDF_BYTES, PNG_BYTES, SESSION_TOKEN, STALE_SESSION_TOKEN, type Fixture } from "../../sdk/tests/support/golden.js";

const JOB_ID = "4d2d5a6e-2b1c-4e4a-9d6b-1f3c5e7a9b01";
const DOC_JOB_ID = "4d2d5a6e-2b1c-4e4a-9d6b-1f3c5e7a9b02";

// The golden server is plain Node HTTP; the provider's test seam takes the runtime fetch explicitly.
const nodeFetch: typeof fetch = (input, init) => globalThis.fetch(input, init);
const server = new GoldenServer();
server.bearerAs = "session";
beforeAll(() => server.start());
afterAll(() => server.stop());
afterEach(() => server.assertConsumed());

function Provider({ children, getSessionToken }: { children: React.ReactNode; getSessionToken?: () => Promise<SessionGrant | string> }) {
  return (
    <KolderaProvider baseUrl={server.origin} fetch={nodeFetch} getSessionToken={getSessionToken ?? (async () => SESSION_TOKEN)}>
      {children}
    </KolderaProvider>
  );
}

/** A request/response pair that exists only for the harness (the contract set has no fixture for these reads). */
function local(name: string, request: Partial<Fixture["request"]> & { path: string }, response: Fixture["response"]): void {
  fixtures[name] = { name, operationId: null, auth: "session", request: { method: "GET", headers: { Authorization: "Bearer {{sessionToken}}" }, ...request }, response };
}

describe("provider", () => {
  it("takes no publishable key, and hooks refuse to run outside the provider", () => {
    expect(() => renderHook(() => usePdfJob())).toThrow(ConfigurationError);
    expect(() => renderHook(() => useDocumentJob())).toThrow(/KolderaProvider/);
  });

  it("mints the session lazily and reuses it while it is valid", async () => {
    const grants = vi.fn<() => Promise<SessionGrant>>().mockResolvedValue({ sessionToken: SESSION_TOKEN, expiresAt: new Date(Date.now() + 600_000).toISOString() });
    const { result } = renderHook(() => useReadingOrder(JOB_ID), { wrapper: ({ children }) => <Provider getSessionToken={grants}>{children}</Provider> });
    server.expect("reading-order");
    await waitFor(() => expect(result.current.snapshot).not.toBeNull());
    expect(grants).toHaveBeenCalledTimes(1);
    server.expect("reading-order");
    await act(async () => {
      await result.current.reload();
    });
    expect(grants).toHaveBeenCalledTimes(1);
    expect(server.exchanges.at(-1)!.received.headers["authorization"]).toBe("Bearer " + SESSION_TOKEN);
  });

  it("refreshes the session once after a 401 and retries the call", async () => {
    let calls = 0;
    const grants = async (): Promise<SessionGrant> => {
      calls += 1;
      return { sessionToken: calls === 1 ? STALE_SESSION_TOKEN : SESSION_TOKEN };
    };
    local(
      "local-session-expired",
      { path: `/v1/jobs/${JOB_ID}/reading-order`, headers: { Authorization: "Bearer {{staleSessionToken}}" } },
      { status: 401, headers: { "Content-Type": "application/problem+json" }, body: { type: "about:blank", title: "Unauthorized", status: 401, code: "UNAUTHORIZED" } },
    );
    server.expect("local-session-expired", "reading-order");
    const { result } = renderHook(() => useReadingOrder(JOB_ID), { wrapper: ({ children }) => <Provider getSessionToken={grants}>{children}</Provider> });
    await waitFor(() => expect(result.current.snapshot).not.toBeNull());
    expect(calls).toBe(2);
    expect(result.current.error).toBeNull();
  });

  it("accepts any non-empty token string and refuses an empty grant", async () => {
    const { result } = renderHook(() => useReadingOrder(JOB_ID), { wrapper: ({ children }) => <Provider getSessionToken={async () => ({ sessionToken: "" })}>{children}</Provider> });
    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.error).toBeInstanceOf(ConfigurationError);
  });
});

describe("usePdfJob", () => {
  it("uploads, polls to completion, loads findings and exposes download links on demand", async () => {
    server.expect("upload-ticket-session", "upload-put-pdf", "pdf-job-session", "job-completed-session", "findings", "artifacts");
    const { result } = renderHook(() => usePdfJob(), { wrapper: Provider });
    expect(result.current.status).toBe("idle");
    const file = new File([PDF_BYTES], "sample.pdf", { type: "application/pdf" });
    let done: unknown;
    await act(async () => {
      done = await result.current.createJob(file, { mode: "analyze" });
    });
    expect((done as { state: string }).state).toBe("completed");
    expect(result.current.status).toBe("completed");
    expect(result.current.job?.manualReviewRequired).toBe(true);
    expect(result.current.findings?.map((f) => f.ruleId)).toEqual(["7.1-3", "TITLE_FROM_FILE_NAME"]);
    const artifacts = await result.current.loadArtifacts();
    expect(artifacts.map((a) => a.kind)).toEqual(["original", "remediated"]);
    expect(server.exchanges.at(-1)!.received.headers["authorization"]).toBe("Bearer " + SESSION_TOKEN);
  });

  it("uploads through the global fetch, not the provider's fetch prop", async () => {
    server.expect("upload-ticket-pdf", "upload-put-pdf", "pdf-job-prefer-wait-finished", "findings");
    const seen: string[] = [];
    const spy: typeof fetch = (input, init) => { seen.push(String(input)); return globalThis.fetch(input, init); };
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <KolderaProvider baseUrl={server.origin} fetch={spy} getSessionToken={async () => SESSION_TOKEN}>
        {children}
      </KolderaProvider>
    );
    const { result } = renderHook(() => usePdfJob(), { wrapper });
    await act(async () => {
      await result.current.createJob(PDF_BYTES, { mode: "fix", fileName: "sample.pdf", wait: 60 });
    });
    expect(seen.some((u) => u.includes("/content"))).toBe(false);
    expect(seen.some((u) => u.endsWith("/v1/pdf/jobs"))).toBe(true);
  });

  it("wait: a job finished within the server's wait is not polled", async () => {
    server.expect("upload-ticket-pdf", "upload-put-pdf", "pdf-job-prefer-wait-finished", "findings");
    const { result } = renderHook(() => usePdfJob(), { wrapper: Provider });
    await act(async () => {
      await result.current.createJob(PDF_BYTES, { mode: "fix", fileName: "sample.pdf", wait: 60 });
    });
    expect(result.current.status).toBe("completed");
    expect(result.current.job?.finalValidation?.status).toBe("passed");
    // The next fixture after the create answer is the findings read: no GET /v1/jobs/{id} in between.
    expect(server.exchanges.map((e) => e.received.method + " " + e.received.path).slice(-2)).toEqual(["POST /v1/pdf/jobs", `GET /v1/jobs/${JOB_ID}/findings`]);
  });

  it("wait: a 202 after the wait keeps polling until the job has finished", async () => {
    server.expect("upload-ticket-pdf", "upload-put-pdf", "pdf-job-prefer-wait-timeout", "job-completed-fix", "findings");
    const { result } = renderHook(() => usePdfJob(), { wrapper: Provider });
    await act(async () => {
      await result.current.createJob(PDF_BYTES, { mode: "fix", fileName: "sample.pdf", wait: 5 });
    });
    expect(result.current.status).toBe("completed");
    expect(result.current.job?.state).toBe("completed");
  });

  it("surfaces an exhausted session budget as a typed error in state", async () => {
    server.expect("upload-ticket-session", "upload-put-pdf", "pdf-job-session-job-limit");
    const { result } = renderHook(() => usePdfJob(), { wrapper: Provider });
    await act(async () => {
      await result.current.createJob(PDF_BYTES, { mode: "fix", fileName: "sample.pdf" });
    });
    expect(result.current.status).toBe("error");
    expect(result.current.error).toBeInstanceOf(RateLimitError);
    expect(result.current.job).toBeNull();
  });

  it("cancel() stops polling and unmount aborts the in-flight request", async () => {
    server.expect("upload-ticket-session", "upload-put-pdf", "pdf-job-session", "job-queued-retry-after");
    const { result, unmount } = renderHook(() => usePdfJob(), { wrapper: Provider });
    let pending: Promise<unknown>;
    act(() => {
      pending = result.current.createJob(PDF_BYTES, { mode: "analyze", fileName: "sample.pdf" });
    });
    await waitFor(() => expect(result.current.status).toBe("queued"));
    act(() => result.current.cancel());
    expect(await pending!).toBeNull();
    expect(result.current.status).toBe("cancelled");
    unmount();
  });
});

describe("useHtmlToPdfJob and useWebScan", () => {
  it("forwards selector, language and title to the HTML job", async () => {
    local("local-html-job", { path: `/v1/jobs/${DOC_JOB_ID}` }, {
      status: 200,
      headers: { "Content-Type": "application/json" },
      body: { ...(fixtures["html-job-accepted"]!.response.body as object), state: "completed" },
    });
    local("local-html-findings", { path: `/v1/jobs/${DOC_JOB_ID}/findings` }, { status: 200, headers: { "Content-Type": "application/json" }, body: { items: [] } });
    server.expect("upload-ticket-html", "upload-put-html", "html-job-accepted", "local-html-job", "local-html-findings");
    const { result } = renderHook(() => useHtmlToPdfJob(), { wrapper: Provider });
    await act(async () => {
      await result.current.createJob(HTML_BYTES, { mode: "generate_fix", fileName: "page.html", contentSelector: "main", explicitLanguage: "en", explicitTitle: "Sample page" });
    });
    expect(result.current.status).toBe("completed");
  });

  it("queues a web scan", async () => {
    local("local-web-job", { path: `/v1/jobs/${DOC_JOB_ID}` }, {
      status: 200,
      headers: { "Content-Type": "application/json" },
      body: { ...(fixtures["web-job-accepted"]!.response.body as object), state: "completed" },
    });
    server.expect("web-job-accepted", "local-web-job", "local-html-findings");
    const { result } = renderHook(() => useWebScan(), { wrapper: Provider });
    await act(async () => {
      await result.current.createScan("https://example.com/page");
    });
    expect(result.current.status).toBe("completed");
  });
});

describe("useDocumentJob", () => {
  it("uploads an image, then renders the document with wait and follows it to its findings", async () => {
    local("local-doc-findings", { path: `/v1/jobs/${DOC_JOB_ID}/findings` }, { status: 200, headers: { "Content-Type": "application/json" }, body: { items: [] } });
    server.expect("upload-ticket-image-png", "upload-put-image-png", "document-job-prefer-wait-finished", "local-doc-findings");
    const { result } = renderHook(() => useDocumentJob(), { wrapper: Provider });
    let uploadId = "";
    await act(async () => {
      uploadId = await result.current.uploadImage(new File([PNG_BYTES], "logo.png", { type: "image/png" }));
    });
    expect(uploadId).toBe("33333333-3333-4333-8333-333333333333");
    const document = fixtures["document-job-prefer-wait-finished"]!.request.body as StructuredDocument;
    expect(JSON.stringify(document)).toContain(uploadId);
    await act(async () => {
      await result.current.createJob(document, { wait: 30 });
    });
    expect(result.current.status).toBe("completed");
    expect(result.current.job?.kind).toBe("document_to_pdf");
    expect(result.current.findings).toEqual([]);
  });

  it("shows a rejected document's problems on the error", async () => {
    server.expect("document-job-validation-errors");
    const { result } = renderHook(() => useDocumentJob(), { wrapper: Provider });
    await act(async () => {
      await result.current.createJob(fixtures["document-job-validation-errors"]!.request.body as StructuredDocument);
    });
    expect(result.current.status).toBe("error");
    expect((result.current.error as unknown as { errors: Array<{ code: string }> }).errors.map((e) => e.code)).toEqual(["HEADING_LEVEL_SKIPPED", "IMAGE_ALT_MISSING"]);
  });
});

describe("useReadingOrder", () => {
  it("loads the snapshot for a job and queues an acknowledged correction with a reviewer", async () => {
    server.expect("reading-order", "remediation-accepted");
    const { result } = renderHook(() => useReadingOrder(JOB_ID), { wrapper: Provider });
    await waitFor(() => expect(result.current.snapshot).not.toBeNull());
    expect(result.current.snapshot!.reviewRequired).toBe(true);
    const body = fixtures["remediation-accepted"]!.request.body as { baseArtifactSha256: string; snapshotVersion: number; target: "pdf_tags"; orderedNodeIds: string[]; reviewer: string };
    let created: unknown;
    await act(async () => {
      created = await result.current.remediate({ ...body, acknowledged: true });
    });
    expect((created as { kind: string }).kind).toBe("order_pdf");
  });

  it("remediate takes wait", async () => {
    server.expect("reading-order", "remediation-without-reviewer");
    const { result } = renderHook(() => useReadingOrder(JOB_ID), { wrapper: Provider });
    await waitFor(() => expect(result.current.snapshot).not.toBeNull());
    const { reviewer: _reviewer, ...body } = fixtures["remediation-accepted"]!.request.body as { baseArtifactSha256: string; snapshotVersion: number; target: "pdf_tags"; orderedNodeIds: string[]; reviewer: string };
    let created: unknown;
    await act(async () => {
      created = await result.current.remediate({ ...body, acknowledged: true }, { wait: 60 });
    });
    expect((created as { state: string }).state).toBe("completed");
  });
});

describe("re-exports", () => {
  it("exposes the SDK types and errors a React app needs", async () => {
    const types: [PdfMode, HtmlToPdfMode, ImageContentType, ProblemError, ResponseMeta, Block, Inline, ProblemCode?] = ["fix", "generate_fix", "image/png", { path: "", code: "SCHEMA", message: "m" }, { status: 200, location: undefined, preferenceApplied: undefined, idempotentReplayed: false }, { type: "pageBreak" }, "text"];
    expect(types).toHaveLength(7);
    const sdk = await import("../dist/index.js");
    expect(sdk.UnsupportedMediaTypeError).toBeDefined();
  });
});

describe("rendering and bundle", () => {
  it("renders a component using the hook and never puts a credential into the DOM", async () => {
    function Status() {
      const { status } = usePdfJob();
      return <p data-testid="status">{status}</p>;
    }
    render(
      <Provider>
        <Status />
      </Provider>,
    );
    expect(screen.getByTestId("status").textContent).toBe("idle");
    expect(document.body.innerHTML).not.toContain(SESSION_TOKEN);
  });

  it("the built package has no server-token handling, session minting, environment reads or Node built-ins", async () => {
    const entry = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist/index.js");
    const bundle = await build({ entryPoints: [entry], bundle: true, write: false, format: "esm", platform: "browser", external: ["react", "react/jsx-runtime"] });
    const code = bundle.outputFiles[0]!.text;
    expect(code).not.toContain("process.env");
    expect(code).not.toContain("KOLDERA_TOKEN");
    expect(code).not.toContain("client-sessions");
    expect(code).not.toContain("clientSessions");
    expect(code).not.toContain("node:");
    expect(code).not.toContain("publishableKey");
    expect(readFileSync(entry, "utf8")).not.toContain("secretKey");
  });
});
