import { readFileSync } from "node:fs";
import { afterAll, vi, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  ApiError,
  AuthenticationError,
  ConfigurationError,
  ConflictError,
  HostNotAllowedError,
  KolderaClient,
  NotFoundError,
  PermissionError,
  RateLimitError,
  ServerError,
  ServiceUnavailableError,
  StorageError,
  TimeoutError,
  UnsupportedMediaTypeError,
  ValidationError,
  type Artifact,
  type ProblemCode,
  type ResponseMeta,
  type StructuredDocument,
} from "../dist/node/index.js";
import { fixtures, GoldenServer, HTML_BYTES, PDF_BYTES, PNG_BYTES, SECRET_KEY, SESSION_TOKEN } from "./support/golden.js";

const JOB_ID = "4d2d5a6e-2b1c-4e4a-9d6b-1f3c5e7a9b01";
const server = new GoldenServer();
let client: KolderaClient;
let session: KolderaClient;

beforeAll(async () => {
  const origin = await server.start();
  client = new KolderaClient({ token: SECRET_KEY, baseUrl: origin });
  session = new KolderaClient({ token: SESSION_TOKEN, baseUrl: origin });
});
afterAll(() => server.stop());
afterEach(() => server.assertConsumed());

/** A fetch that stands in for the network but can still reach the golden server. */
const stubFetch = (handler: (url: string, init: RequestInit, forward: typeof fetch) => Promise<Response>) => (url: string, init: RequestInit) => handler(url, init, fetch);
const problem = (status: number, code: string, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({ type: "about:blank", title: "stub", status, code }), { status, headers: { "Content-Type": "application/problem+json", ...headers } });
const job = (fields: Record<string, unknown>) => ({
  id: JOB_ID,
  kind: "pdf",
  mode: "analyze",
  state: "queued",
  createdAt: "2026-10-05T10:00:00Z",
  startedAt: null,
  finishedAt: null,
  validation: null,
  baselineValidation: null,
  finalValidation: null,
  remediationStatus: null,
  manualReviewRequired: true,
  engineVersion: null,
  error: null,
  targetUrl: null,
  ...fields,
});
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });

describe("configuration", () => {
  const saved = { token: process.env["KOLDERA_TOKEN"], url: process.env["KOLDERA_URL"] };
  const restore = () => {
    for (const [name, value] of [["KOLDERA_TOKEN", saved.token], ["KOLDERA_URL", saved.url]] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };

  it("needs a base URL and a non-empty token, from options or KOLDERA_URL / KOLDERA_TOKEN", () => {
    delete process.env["KOLDERA_TOKEN"];
    delete process.env["KOLDERA_URL"];
    try {
      expect(() => new KolderaClient({})).toThrow(ConfigurationError);
      expect(() => new KolderaClient({ token: "", baseUrl: server.origin })).toThrow(/token/);
      expect(() => new KolderaClient({ token: "   ", baseUrl: server.origin })).toThrow(/token/);
      expect(() => new KolderaClient({ token: SECRET_KEY })).toThrow(/KOLDERA_URL/);
      expect(() => new KolderaClient({ token: SECRET_KEY, baseUrl: "not a url" })).toThrow(ConfigurationError);
      process.env["KOLDERA_TOKEN"] = SECRET_KEY;
      process.env["KOLDERA_URL"] = server.origin;
      expect(new KolderaClient()).toBeInstanceOf(KolderaClient);
    } finally {
      restore();
    }
  });

  it("accepts any token string: no key-prefix rules", () => {
    for (const token of ["x", "pk_looks_like_a_vendor_key", "plain token with spaces", "0123456789"]) {
      expect(new KolderaClient({ token, baseUrl: server.origin })).toBeInstanceOf(KolderaClient);
    }
  });

  it("sends the token as the bearer and identifies the SDK", async () => {
    server.expect("info");
    await client.info();
    const sent = server.exchanges.at(-1)!.received.headers;
    expect(sent["authorization"]).toBe("Bearer " + SECRET_KEY);
    expect(sent["user-agent"]).toMatch(/^koldera-sdk-js\//);
  });
});

describe("golden: service", () => {
  it("info() reads version and features with the token, also for a session", async () => {
    server.expect("info");
    const info = await client.info();
    expect(info.features).toEqual(["document", "html", "pdf", "web"]);
    expect(info.version).toBe("0.1.0");
    server.expect("info-session");
    expect((await session.info()).features.length).toBeGreaterThan(0);
  });

  it("health() sends no credential", async () => {
    server.expect("healthz");
    expect(await client.health()).toEqual({ status: "ok" });
    expect(server.exchanges.at(-1)!.received.headers["authorization"]).toBeUndefined();
  });
});

describe("golden: job creation", () => {
  it("pdf.createJob issues a ticket, PUTs the bytes without the bearer and queues the job", async () => {
    server.expect("upload-ticket-pdf", "upload-put-pdf", "pdf-job-accepted");
    const created = await client.pdf.createJob({ file: PDF_BYTES, fileName: "sample.pdf", mode: "analyze" });
    expect(created.id).toBe(JOB_ID);
    expect(created.state).toBe("queued");
    expect(created.manualReviewRequired).toBe(true);
    const keys = server.exchanges.slice(-3).map((e) => e.received.headers["idempotency-key"]);
    expect(keys[0]).toBeDefined();
    expect(keys[0]).not.toBe(keys[2]);
    expect(server.exchanges.at(-2)!.received.headers["authorization"]).toBeUndefined();
  });

  it("pdf fix sends the language and the trimmed title, and omits what is not given", async () => {
    server.expect("upload-ticket-pdf", "upload-put-pdf", "pdf-job-accepted-fix");
    const created = await client.pdf.createJob({ file: PDF_BYTES, fileName: "sample.pdf", mode: "fix", explicitLanguage: "en", explicitTitle: "  Sample report  " });
    expect(created.mode).toBe("fix");
  });

  it("pdf.createJob accepts only analyze and fix: the retired modes are refused locally", async () => {
    for (const mode of ["safe_fix", "structure_fix", "scan", "generate_fix"]) {
      await expect(client.pdf.createJob({ file: PDF_BYTES, mode: mode as never })).rejects.toThrow(/analyze, fix/);
    }
  });

  it("htmlToPdf.createJob uploads text/html with selector, language and title; generate_safe_fix is refused", async () => {
    server.expect("upload-ticket-html", "upload-put-html", "html-job-accepted");
    const created = await client.htmlToPdf.createJob({ file: HTML_BYTES, fileName: "page.html", mode: "generate_fix", contentSelector: "main", explicitLanguage: "en", explicitTitle: "Sample page" });
    expect(created.kind).toBe("html_to_pdf");
    server.expect("upload-ticket-html", "upload-put-html", "html-job-analyze");
    expect((await client.htmlToPdf.createJob({ file: HTML_BYTES, fileName: "page.html", mode: "generate_analyze" })).mode).toBe("generate_analyze");
    await expect(client.htmlToPdf.createJob({ file: HTML_BYTES, mode: "generate_safe_fix" as never })).rejects.toThrow(ConfigurationError);
    await expect(client.htmlToPdf.createJob({ file: HTML_BYTES, mode: "generate_fix", contentSelector: "   " })).rejects.toThrow(ConfigurationError);
    expect((client.htmlToPdf as unknown as Record<string, unknown>)["createFromUrl"]).toBeUndefined();
  });

  it("web.createScan sends the URL and refuses non-http schemes locally", async () => {
    server.expect("web-job-accepted");
    const created = await client.web.createScan({ url: new URL("https://example.com/page") });
    expect(created.targetUrl).toBe("https://example.com/page");
    await expect(client.web.createScan({ url: "file:///etc/passwd" })).rejects.toThrow(ConfigurationError);
  });

  it("validates mode, language, title and file before any request", async () => {
    await expect(client.pdf.createJob({ file: PDF_BYTES, mode: "analyze", explicitLanguage: "english!" })).rejects.toThrow(/BCP 47/);
    await expect(client.pdf.createJob({ file: PDF_BYTES, mode: "fix", explicitTitle: "  " })).rejects.toThrow("explicitTitle must be 1-500 printable characters");
    await expect(client.pdf.createJob({ file: PDF_BYTES, mode: "fix", explicitTitle: "x".repeat(501) })).rejects.toThrow("explicitTitle");
    await expect(client.pdf.createJob({ file: PDF_BYTES, mode: "fix", explicitTitle: "\u{1F600}".repeat(501) })).rejects.toThrow("explicitTitle");
    await expect(client.pdf.createJob({ file: new Uint8Array(0), mode: "analyze" })).rejects.toThrow(/empty/);
  });
});

describe("golden: structured documents", () => {
  const document = fixtures["document-job-accepted"]!.request.body as StructuredDocument;

  it("documents.createJob posts the document itself, unwrapped", async () => {
    server.expect("document-job-accepted");
    const created = await client.documents.createJob(document);
    expect(created.kind).toBe("document_to_pdf");
    expect(created.mode).toBe("generate_analyze");
  });

  it("documents.uploadImage uploads an image ticket and returns the upload id for an image block", async () => {
    server.expect("upload-ticket-image-png", "upload-put-image-png");
    const ticket = await client.documents.uploadImage(PNG_BYTES, { contentType: "image/png", fileName: "logo.png" });
    expect(ticket.uploadId).toBe("33333333-3333-4333-8333-333333333333");
    expect(ticket.maxBytes).toBeNull();
    expect(server.exchanges.at(-1)!.received.headers["authorization"]).toBeUndefined();
  });

  it("takes the image type from a File and refuses anything that is not an image", async () => {
    server.expect("upload-ticket-image-png", "upload-put-image-png");
    await client.documents.uploadImage(new File([PNG_BYTES], "logo.png", { type: "image/png" }));
    await expect(client.documents.uploadImage(PNG_BYTES)).rejects.toThrow(/image contentType/);
    await expect(client.documents.uploadImage(PNG_BYTES, { contentType: "application/pdf" as never })).rejects.toThrow(ConfigurationError);
    await expect(client.documents.createJob(null as never)).rejects.toThrow(ConfigurationError);
  });

  it("a rejected document carries every problem in errors[]", async () => {
    server.expect("document-job-validation-errors");
    const e = (await client.documents.createJob(fixtures["document-job-validation-errors"]!.request.body as StructuredDocument).catch((x: unknown) => x)) as ValidationError;
    expect(e).toBeInstanceOf(ValidationError);
    expect(e.code).toBe("VALIDATION_ERROR");
    expect(e.errors).toEqual([
      { path: "/body/0/level", code: "HEADING_LEVEL_SKIPPED", message: "The first heading must be level 1 or 2." },
      { path: "/body/1/alt", code: "IMAGE_ALT_MISSING", message: "An image needs a description." },
    ]);
  });

  it("a failed image reference is reported with its JSON Pointer", async () => {
    server.expect("document-job-image-upload-invalid");
    const e = (await client.documents.createJob(fixtures["document-job-image-upload-invalid"]!.request.body as StructuredDocument).catch((x: unknown) => x)) as ValidationError;
    expect(e.errors[0]).toMatchObject({ path: "/body/3/uploadId", code: "IMAGE_UPLOAD_INVALID" });
  });
});

describe("wait / Prefer handling", () => {
  it("wait sends Prefer: wait=N and a 200 returns the finished job", async () => {
    server.expect("upload-ticket-pdf", "upload-put-pdf", "pdf-job-prefer-wait-finished");
    let meta: ResponseMeta | undefined;
    const done = await client.pdf.createJob({ file: PDF_BYTES, fileName: "sample.pdf", mode: "fix", wait: 60, onResponse: (m) => (meta = m) });
    expect(done.state).toBe("completed");
    expect(done.finalValidation?.status).toBe("passed");
    expect(meta).toEqual({ status: 200, location: `/v1/jobs/${JOB_ID}`, preferenceApplied: "wait=60", idempotentReplayed: false });
  });

  it("a 202 after the wait is returned as unfinished, never reported as done, and nothing polls on its own", async () => {
    server.expect("upload-ticket-pdf", "upload-put-pdf", "pdf-job-prefer-wait-timeout");
    let meta: ResponseMeta | undefined;
    const pending = await client.pdf.createJob({ file: PDF_BYTES, fileName: "sample.pdf", mode: "fix", wait: 5, onResponse: (m) => (meta = m) });
    expect(pending.state).toBe("running");
    expect(pending.finishedAt).toBeNull();
    expect(meta).toMatchObject({ status: 202, preferenceApplied: "wait=5" });
    // assertConsumed in afterEach proves no GET /v1/jobs/{id} was sent.
  });

  it("untilFinished continues with jobs.wait after a 202 and returns the final job", async () => {
    server.expect("upload-ticket-pdf", "upload-put-pdf", "pdf-job-prefer-wait-timeout", "job-completed-fix");
    const done = await client.pdf.createJob({ file: PDF_BYTES, fileName: "sample.pdf", mode: "fix", wait: 5, untilFinished: { initialDelayMs: 10 } });
    expect(done.state).toBe("completed");
    expect(server.exchanges.at(-1)!.received.method).toBe("GET");
  });

  it("untilFinished does not poll when the wait already produced a finished job", async () => {
    server.expect("upload-ticket-pdf", "upload-put-pdf", "pdf-job-prefer-wait-finished");
    const done = await client.pdf.createJob({ file: PDF_BYTES, fileName: "sample.pdf", mode: "fix", wait: 60, untilFinished: true });
    expect(done.state).toBe("completed");
  });

  it("untilFinished without wait polls after a plain 202", async () => {
    const seen: string[] = [];
    const c = new KolderaClient({
      token: SECRET_KEY,
      baseUrl: server.origin,
      fetch: async (url, init) => {
        seen.push(`${init.method} ${url.replace(server.origin, "")}`);
        return init.method === "POST" ? json(job({ kind: "web" }), 202) : json(job({ kind: "web", state: "completed" }));
      },
    });
    const done = await c.web.createScan({ url: "https://example.com/page", untilFinished: { initialDelayMs: 10 } });
    expect(done.state).toBe("completed");
    expect(seen).toEqual(["POST /v1/web/jobs", `GET /v1/jobs/${JOB_ID}`]);
  });

  it("documents and reading-order corrections take wait too", async () => {
    server.expect("document-job-prefer-wait-finished");
    const document = fixtures["document-job-prefer-wait-finished"]!.request.body as StructuredDocument;
    expect((await client.documents.createJob(document, { wait: 30 })).state).toBe("completed");
    server.expect("remediation-without-reviewer");
    const body = fixtures["remediation-without-reviewer"]!.request.body as { baseArtifactSha256: string; snapshotVersion: number; target: "pdf_tags"; orderedNodeIds: string[] };
    const fixed = await client.jobs.remediateReadingOrder(JOB_ID, { ...body, acknowledged: true }, { wait: 60 });
    expect(fixed.kind).toBe("order_pdf");
    expect(fixed.state).toBe("completed");
  });

  it("rejects a wait outside 1-900 seconds before any request", async () => {
    for (const wait of [0, -1, 901, 1.5, Number.NaN]) {
      await expect(client.web.createScan({ url: "https://example.com/page", wait })).rejects.toThrow(/wait must be/);
    }
  });

  it("exposes an idempotent replay", async () => {
    server.expect("upload-ticket-pdf", "upload-put-pdf", "pdf-job-idempotent-replay");
    let meta: ResponseMeta | undefined;
    await client.pdf.createJob({ file: PDF_BYTES, fileName: "sample.pdf", mode: "fix", idempotencyKey: "retry-1", onResponse: (m) => (meta = m) });
    expect(meta).toMatchObject({ status: 202, idempotentReplayed: true });
  });

  it("stretches the request timeout over the wait", async () => {
    const slow = new KolderaClient({
      token: SECRET_KEY,
      baseUrl: server.origin,
      timeoutMs: 100,
      fetch: async (_url, init) => {
        await new Promise((resolve) => setTimeout(resolve, 400));
        if (init.signal?.aborted) throw init.signal.reason;
        return json(job({ kind: "web", mode: "scan", state: "completed" }));
      },
    });
    expect((await slow.web.createScan({ url: "https://example.com/page", wait: 1 })).state).toBe("completed");
    await expect(slow.web.createScan({ url: "https://example.com/page" })).rejects.toMatchObject({ name: "TimeoutError" });
  });
});

describe("golden: polling and reads", () => {
  it("jobs.wait honours Retry-After and returns the terminal job", async () => {
    server.expect("job-queued-retry-after", "job-running", "job-completed");
    const seen: string[] = [];
    const started = Date.now();
    const done = await client.jobs.wait(JOB_ID, { onUpdate: (j) => seen.push(j.state) });
    expect(Date.now() - started).toBeGreaterThanOrEqual(3_900);
    expect(seen).toEqual(["queued", "running", "completed"]);
    expect(done.remediationStatus).toBe("not_requested");
  }, 15_000);

  it("a failed job is returned, not thrown", async () => {
    server.expect("job-failed");
    const done = await client.jobs.wait(JOB_ID);
    expect(done.state).toBe("failed");
    expect(done.error?.code).toBe("WORKER_TIMEOUT");
  });

  it("lists findings, actions and artifacts", async () => {
    server.expect("findings", "actions", "artifacts");
    const findings = await client.jobs.findings(JOB_ID);
    expect(findings.map((f) => f.resolution)).toEqual(["fixed_in_copy", null]);
    const actions = await client.jobs.actions(JOB_ID);
    expect(actions.map((a) => a.outcome)).toEqual(["applied", "rolled_back"]);
    const artifacts = await client.jobs.artifacts(JOB_ID);
    expect(artifacts.map((a) => a.kind)).toEqual(["original", "remediated"]);
  });

  it("rejects a malformed job id locally", async () => {
    await expect(client.jobs.get("../organizations")).rejects.toThrow(ConfigurationError);
  });
});

describe("golden: artifact downloads are verified", () => {
  const artifactAt = (name: string, fields: Partial<Artifact> = {}): Artifact => {
    const f = fixtures[name]!;
    const sha = (f.response as unknown as { sha256?: string }).sha256 ?? "";
    return { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1", kind: "original", sha256: sha, sizeBytes: Buffer.from(f.response.rawBody ?? "", "latin1").length, downloadUrl: server.origin + f.request.path, expiresAt: "2026-10-05T10:10:00Z", ...fields };
  };

  it("returns the bytes when size and SHA-256 match, without the bearer", async () => {
    server.expect("artifact-download-original");
    const bytes = await client.artifacts.download(artifactAt("artifact-download-original"));
    expect(Buffer.from(bytes).equals(PDF_BYTES)).toBe(true);
    expect(server.exchanges.at(-1)!.received.headers["authorization"]).toBeUndefined();
  });

  it("raises on a wrong hash and returns no bytes", async () => {
    server.expect("artifact-download-original");
    const result = await client.artifacts.download(artifactAt("artifact-download-original", { sha256: "0".repeat(64) })).then(
      (bytes) => ({ bytes }),
      (error: unknown) => ({ error }),
    );
    expect(result).not.toHaveProperty("bytes");
    expect((result as { error: Error }).error).toBeInstanceOf(StorageError);
    expect((result as { error: Error }).error.message).toMatch(/SHA-256/);
  });

  it("raises on a wrong size, also when the hash would match", async () => {
    server.expect("artifact-download-original");
    const real = artifactAt("artifact-download-original");
    const result = await client.artifacts.download({ ...real, sizeBytes: real.sizeBytes + 1 }).catch((error: unknown) => error);
    expect(result).toBeInstanceOf(StorageError);
    expect((result as Error).message).toMatch(/bytes/);
  });

  it("maps a refused download to StorageError with the problem code", async () => {
    server.expect("artifact-download-signature-invalid", "artifact-download-not-found");
    const denied = (await client.artifacts.download(artifactAt("artifact-download-signature-invalid")).catch((e: unknown) => e)) as StorageError;
    expect(denied).toBeInstanceOf(StorageError);
    expect([denied.status, denied.code]).toEqual([403, "SIGNATURE_INVALID"]);
    const missing = (await client.artifacts.download(artifactAt("artifact-download-not-found")).catch((e: unknown) => e)) as StorageError;
    expect([missing.status, missing.code]).toEqual([404, "NOT_FOUND"]);
  });

  it("maps a refused upload to StorageError with the problem code", async () => {
    server.expect("upload-ticket-pdf", "upload-put-checksum-mismatch");
    const e = (await client.uploads.upload(PDF_BYTES, "application/pdf", "sample.pdf").catch((x: unknown) => x)) as StorageError;
    expect([e.status, e.code]).toEqual([422, "CHECKSUM_MISMATCH"]);
  });
});

describe("golden: reading order", () => {
  const approval = fixtures["remediation-accepted"]!.request.body as { baseArtifactSha256: string; snapshotVersion: number; target: "pdf_tags"; orderedNodeIds: string[]; reviewer: string };

  it("returns the snapshot and queues an acknowledged correction with a reviewer", async () => {
    server.expect("reading-order", "remediation-accepted");
    const snapshot = await client.jobs.getReadingOrder(JOB_ID);
    expect(snapshot.reviewRequired).toBe(true);
    expect(snapshot.readingOrderReview).toBe("needs_review");
    const created = await client.jobs.remediateReadingOrder(JOB_ID, { ...approval, acknowledged: true });
    expect(created.kind).toBe("order_pdf");
    expect(created.mode).toBe("reorder");
  });

  it("omits the reviewer when none is given and refuses a blank or overlong one locally", async () => {
    server.expect("remediation-without-reviewer");
    const { reviewer: _reviewer, ...withoutReviewer } = approval;
    await client.jobs.remediateReadingOrder(JOB_ID, { ...withoutReviewer, acknowledged: true }, { wait: 60 });
    await expect(client.jobs.remediateReadingOrder(JOB_ID, { ...approval, reviewer: " ", acknowledged: true })).rejects.toThrow(/reviewer/);
    await expect(client.jobs.remediateReadingOrder(JOB_ID, { ...approval, reviewer: "r".repeat(201), acknowledged: true })).rejects.toThrow(/reviewer/);
  });

  it("refuses an unacknowledged or malformed approval before any request", async () => {
    await expect(client.jobs.remediateReadingOrder(JOB_ID, { ...approval, acknowledged: false as never })).rejects.toThrow(/acknowledged/);
    await expect(client.jobs.remediateReadingOrder(JOB_ID, { ...approval, orderedNodeIds: ["n1", "n1"], acknowledged: true })).rejects.toThrow(/distinct/);
    await expect(client.jobs.remediateReadingOrder(JOB_ID, { ...approval, baseArtifactSha256: "nope", acknowledged: true })).rejects.toThrow(/hash/);
  });

  it("maps a stale snapshot, an expired artifact and an unsafe plan to typed errors with the code", async () => {
    server.expect("remediation-stale", "remediation-artifact-expired", "remediation-unsupported", "reading-order-not-found");
    const { reviewer: _reviewer, ...base } = approval;
    const run = (target: "pdf_tags" | "source_html" = "pdf_tags") => client.jobs.remediateReadingOrder(JOB_ID, { ...base, target, acknowledged: true }).catch((e: unknown) => e) as Promise<ApiError>;
    const stale = await run();
    expect(stale).toBeInstanceOf(ConflictError);
    expect(stale.code).toBe("STALE_READING_ORDER_SNAPSHOT");
    expect((await run()).code).toBe("ARTIFACT_EXPIRED");
    const unsupported = await run("source_html");
    expect(unsupported).toBeInstanceOf(ValidationError);
    expect(unsupported.code).toBe("ORDER_FIX_UNSUPPORTED");
    expect(await client.jobs.getReadingOrder("4d2d5a6e-2b1c-4e4a-9d6b-1f3c5e7a9b02").catch((e: unknown) => e)).toBeInstanceOf(NotFoundError);
  });
});

describe("golden: client sessions", () => {
  it("mints a scoped session with the new request shape", async () => {
    server.expect("client-session");
    const minted = await client.clientSessions.create({ allowedOrigin: "https://app.example.com", scopes: ["jobs:create", "jobs:read"], maxJobs: 3, maxUploads: 6, ttlSeconds: 600 });
    expect(minted.sessionToken).toMatch(/^v1\./);
    expect(minted.expiresAt).toBe("2026-10-05T10:10:00Z");
    expect(minted).not.toHaveProperty("publishableKey", expect.anything());
  });

  it("sends only allowedOrigin when nothing else is set", async () => {
    server.expect("client-session-defaults");
    await client.clientSessions.create({ allowedOrigin: "https://app.example.com" });
  });

  it("refuses an origin with a path locally, and maps the server's refusals", async () => {
    await expect(client.clientSessions.create({ allowedOrigin: "https://app.example.com/path" })).rejects.toThrow(/origin/);
    server.expect("client-session-forbidden");
    const forbidden = await session.clientSessions.create({ allowedOrigin: "https://app.example.com" }).catch((e: unknown) => e);
    expect(forbidden).toBeInstanceOf(PermissionError);
    expect((forbidden as PermissionError).code).toBe("FORBIDDEN");
  });
});

describe("golden: problems become typed errors", () => {
  const upload = (name: string) => server.expect("upload-ticket-pdf", "upload-put-pdf", name);
  const create = (c: KolderaClient = client) => c.pdf.createJob({ file: PDF_BYTES, fileName: "sample.pdf", mode: "fix" }).catch((e: unknown) => e) as Promise<ApiError>;

  it.each([
    ["pdf-job-unauthorized", AuthenticationError, 401, "UNAUTHORIZED", { mode: "fix" }],
    ["pdf-job-feature-off", NotFoundError, 404, "NOT_FOUND", { mode: "fix" }],
    ["pdf-job-idempotency-key-reused", ConflictError, 409, "IDEMPOTENCY_KEY_REUSED", { mode: "analyze" }],
    ["pdf-job-unsupported-input", UnsupportedMediaTypeError, 415, "UNSUPPORTED_INPUT", { mode: "fix" }],
    ["pdf-job-validation-error", ValidationError, 422, "VALIDATION_ERROR", { mode: "analyze", explicitTitle: "x" }],
    ["pdf-job-invalid-json", ValidationError, 400, "INVALID_JSON", { mode: "fix" }],
  ] as const)("%s", async (name, errorClass, status, code, input) => {
    upload(name);
    const e = (await client.pdf.createJob({ file: PDF_BYTES, fileName: "sample.pdf", ...input }).catch((x: unknown) => x)) as ApiError;
    expect(e).toBeInstanceOf(errorClass);
    expect([e.status, e.code]).toEqual([status, code]);
  });

  it("403 INSUFFICIENT_SCOPE → PermissionError", async () => {
    server.expect("job-insufficient-scope");
    const e = (await session.jobs.get(JOB_ID).catch((x: unknown) => x)) as PermissionError;
    expect(e).toBeInstanceOf(PermissionError);
    expect(e.code).toBe("INSUFFICIENT_SCOPE");
  });

  it("421 → HostNotAllowedError", async () => {
    // The runtime's own fetch replays a 421 on a fresh connection, so the golden answer is served from a stub.
    const reply = fixtures["web-job-host-not-allowed"]!.response;
    const stub = new KolderaClient({ token: SECRET_KEY, baseUrl: server.origin, fetch: async () => new Response(JSON.stringify(reply.body), { status: reply.status, headers: reply.headers }) });
    const e = (await stub.web.createScan({ url: "https://example.com/page" }).catch((x: unknown) => x)) as HostNotAllowedError;
    expect(e).toBeInstanceOf(HostNotAllowedError);
    expect(e.code).toBe("HOST_NOT_ALLOWED");
  });

  it("429 SESSION_JOB_LIMIT and SESSION_UPLOAD_LIMIT → RateLimitError without Retry-After, and no automatic retry", async () => {
    server.expect("upload-ticket-session", "upload-put-pdf", "pdf-job-session-job-limit");
    const job = (await create(session)) as RateLimitError;
    expect(job).toBeInstanceOf(RateLimitError);
    expect([job.code, job.retryAfterSeconds]).toEqual(["SESSION_JOB_LIMIT", undefined]);
    server.expect("upload-ticket-session-limit");
    const uploads = (await create(session)) as RateLimitError;
    expect(uploads).toBeInstanceOf(RateLimitError);
    expect(uploads.code).toBe("SESSION_UPLOAD_LIMIT");
  });

  it("503 QUEUE_FULL → ServiceUnavailableError (a ServerError) with retryAfterSeconds, not retried", async () => {
    upload("pdf-job-queue-full");
    const e = (await create()) as ServiceUnavailableError;
    expect(e).toBeInstanceOf(ServiceUnavailableError);
    expect(e).toBeInstanceOf(ServerError);
    expect([e.code, e.retryAfterSeconds]).toEqual(["QUEUE_FULL", 30]);
    expect(server.exchanges.filter((x) => x.fixture.name === "pdf-job-queue-full")).toHaveLength(1);
  });

  it("422 FILE_TOO_LARGE on the upload ticket", async () => {
    const refusing = new KolderaClient({ token: SECRET_KEY, baseUrl: server.origin, fetch: async () => problem(422, "FILE_TOO_LARGE") });
    const e = (await refusing.uploads.upload(PDF_BYTES, "application/pdf", "huge.pdf").catch((x: unknown) => x)) as ValidationError;
    expect(e).toBeInstanceOf(ValidationError);
    expect(e.code).toBe("FILE_TOO_LARGE");
  });

  it("an error's text never contains the credential", async () => {
    server.expect("job-unauthorized");
    const e = (await client.jobs.get(JOB_ID).catch((x: unknown) => x)) as AuthenticationError;
    expect(e).toBeInstanceOf(AuthenticationError);
    expect(String(e) + JSON.stringify(e)).not.toContain(SECRET_KEY);
  });
});

describe("tolerance towards a newer core", () => {
  const sdkWith = (respond: (url: string) => Response) => new KolderaClient({ token: SECRET_KEY, baseUrl: server.origin, fetch: async (url) => respond(url) });

  it("keeps unknown enum values as they are instead of failing", async () => {
    const newer = sdkWith((url) => {
      if (url.endsWith("/artifacts")) return json({ items: [{ id: "a", kind: "stamped_copy", sha256: "0".repeat(64), sizeBytes: 1, downloadUrl: "https://x.invalid/a", expiresAt: "2030-01-01T00:00:00Z" }] });
      if (url.endsWith("/findings")) return json({ items: [{ source: "epub", ruleId: "X", message: "m", needsHumanReview: true, resolution: "needs_a_person" }] });
      if (url.endsWith("/actions")) return json({ items: [{ ruleId: "R", outcome: "deferred", reason: "r" }] });
      if (url.endsWith("/v1/info")) return json({ features: ["pdf", "ocr"] });
      return json(job({ kind: "epub_to_pdf", mode: "polish", state: "paused", remediationStatus: "queued_for_review", validation: { profile: "pdfua2", status: "partial", failedRules: [] } }));
    });
    const fetched = await newer.jobs.get(JOB_ID);
    expect([fetched.kind, fetched.mode, fetched.state, fetched.remediationStatus]).toEqual(["epub_to_pdf", "polish", "paused", "queued_for_review"]);
    expect(fetched.validation?.status).toBe("partial");
    expect((await newer.jobs.artifacts(JOB_ID))[0]!.kind).toBe("stamped_copy");
    expect((await newer.jobs.findings(JOB_ID))[0]).toMatchObject({ source: "epub", resolution: "needs_a_person" });
    expect((await newer.jobs.actions(JOB_ID))[0]!.outcome).toBe("deferred");
    expect((await newer.info()).features).toEqual(["pdf", "ocr"]);
  });

  it("jobs.wait treats an unknown state as final instead of polling forever", async () => {
    const newer = sdkWith(() => json(job({ state: "cancelled" })));
    expect((await newer.jobs.wait(JOB_ID)).state).toBe("cancelled");
  });

  it("an unknown problem code or status still becomes an ApiError that keeps the code", async () => {
    const newer = sdkWith(() =>
      new Response(JSON.stringify({ type: "about:blank", title: "Teapot", status: 418, code: "BREWING", errors: [{ path: "/x", code: "NEW_RULE", message: "m" }, { nonsense: true }] }), { status: 418, headers: { "Content-Type": "application/problem+json" } }),
    );
    const e = (await newer.jobs.get(JOB_ID).catch((x: unknown) => x)) as ApiError;
    expect(e).toBeInstanceOf(ApiError);
    expect(e.constructor).toBe(ApiError);
    expect([e.status, e.code]).toEqual([418, "BREWING"]);
    expect(e.errors).toEqual([{ path: "/x", code: "NEW_RULE", message: "m" }]);
  });

  it("a body that is not a problem still becomes an ApiError", async () => {
    const odd = sdkWith(() => new Response("<html>bad gateway</html>", { status: 502 }));
    const e = (await odd.jobs.get(JOB_ID).catch((x: unknown) => x)) as ApiError;
    expect(e).toBeInstanceOf(ServerError);
    expect(e.status).toBe(502);
  });
});

describe("retries", () => {
  it("a creation repeated after a lost response carries the same Idempotency-Key and the server replays", async () => {
    server.expect("upload-ticket-pdf", "upload-put-pdf", "pdf-job-idempotent-replay", "pdf-job-idempotent-replay");
    let posts = 0;
    const flaky = new KolderaClient({
      token: SECRET_KEY,
      baseUrl: server.origin,
      fetch: stubFetch(async (url, init, forward) => {
        const response = await forward(url, init);
        if (url.endsWith("/v1/pdf/jobs") && ++posts === 1) {
          await response.arrayBuffer();
          throw new TypeError("fetch failed");
        }
        return response;
      }),
    });
    let meta: ResponseMeta | undefined;
    const created = await flaky.pdf.createJob({ file: PDF_BYTES, fileName: "sample.pdf", mode: "fix", onResponse: (m) => (meta = m) });
    expect(created.id).toBe(JOB_ID);
    expect(posts).toBe(2);
    const sent = server.exchanges.slice(-2);
    expect(sent.map((e) => e.received.path)).toEqual(["/v1/pdf/jobs", "/v1/pdf/jobs"]);
    expect(sent[1]!.received.headers["idempotency-key"]).toBe(sent[0]!.received.headers["idempotency-key"]);
    expect(sent[1]!.received.body.equals(sent[0]!.received.body)).toBe(true);
    expect(meta?.idempotentReplayed).toBe(true);
  });

  it("gives up after two repeats and surfaces the network error", async () => {
    let calls = 0;
    const down = new KolderaClient({ token: SECRET_KEY, baseUrl: server.origin, fetch: async () => { calls += 1; throw new TypeError("fetch failed"); } });
    await expect(down.web.createScan({ url: "https://example.com/page" })).rejects.toThrow("fetch failed");
    expect(calls).toBe(3);
  });

  it("never repeats a call the caller aborted", async () => {
    let calls = 0;
    const controller = new AbortController();
    const c = new KolderaClient({ token: SECRET_KEY, baseUrl: server.origin, fetch: async () => { calls += 1; controller.abort(); throw new TypeError("fetch failed"); } });
    await expect(c.web.createScan({ url: "https://example.com/page", signal: controller.signal })).rejects.toBeDefined();
    expect(calls).toBe(1);
  });

  it("retries an idempotent read after a 503 with Retry-After, never a creation after a 503", async () => {
    let calls = 0;
    const flaky = new KolderaClient({
      token: SECRET_KEY,
      baseUrl: server.origin,
      fetch: stubFetch(async (url, init, forward) => {
        calls += 1;
        return calls === 1 ? problem(503, "QUEUE_FULL", { "Retry-After": "0" }) : forward(url, init);
      }),
    });
    server.expect("job-completed");
    expect((await flaky.jobs.get(JOB_ID)).state).toBe("completed");
    expect(calls).toBe(2);
    calls = 0;
    const e = await flaky.web.createScan({ url: "https://example.com/page" }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ServiceUnavailableError);
    expect(calls).toBe(1);
  });

  it("accepts idempotency keys of 1-255 printable ASCII characters and keeps derived upload keys within the limit", async () => {
    const key = "k".repeat(255);
    server.expect("upload-ticket-pdf", "upload-put-pdf", "pdf-job-accepted");
    await client.pdf.createJob({ file: PDF_BYTES, fileName: "sample.pdf", mode: "analyze", idempotencyKey: key });
    const keys = server.exchanges.slice(-3).map((e) => e.received.headers["idempotency-key"]!);
    expect(keys[2]).toBe(key);
    expect(keys[0]!.length).toBeLessThanOrEqual(255);
    expect(keys[0]).not.toBe(key);
    for (const bad of ["", "k".repeat(256), "tab\t", "é"]) {
      await expect(client.web.createScan({ url: "https://example.com/page", idempotencyKey: bad })).rejects.toThrow(/idempotencyKey/);
    }
  });
});

describe("cancellation and timeouts", () => {
  it("aborts a wait through AbortSignal", async () => {
    server.expect("job-queued-retry-after");
    const controller = new AbortController();
    const waiting = client.jobs.wait(JOB_ID, { signal: controller.signal });
    setTimeout(() => controller.abort(), 300);
    await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
  });

  it("throws TimeoutError when the budget cannot cover the next poll", async () => {
    server.expect("job-queued-retry-after");
    await expect(client.jobs.wait(JOB_ID, { timeoutMs: 500 })).rejects.toThrow(TimeoutError);
  });
});

describe("fix round 1", () => {
  const key = "caller-retry-key";
  it("a caller retry with the same key survives a replayed upload ticket (409 on the PUT is success)", async () => {
    const ticket = fixtures["upload-ticket-pdf"]!;
    fixtures["local-ticket-replayed"] = { ...ticket, name: "local-ticket-replayed", response: { ...ticket.response, headers: { ...ticket.response.headers, "Idempotent-Replayed": "true" } } };
    server.expect("upload-ticket-pdf", "upload-put-pdf", "pdf-job-queue-full");
    const first = await client.pdf.createJob({ file: PDF_BYTES, fileName: "sample.pdf", mode: "fix", idempotencyKey: key }).catch((e: unknown) => e);
    expect(first).toBeInstanceOf(ServiceUnavailableError);
    server.expect("local-ticket-replayed", "upload-put-already-completed", "pdf-job-idempotent-replay");
    const second = await client.pdf.createJob({ file: PDF_BYTES, fileName: "sample.pdf", mode: "fix", idempotencyKey: key });
    expect(second.state).toBe("queued");
  });

  it("a 409 on the PUT without a replayed ticket is still an error", async () => {
    server.expect("upload-ticket-pdf", "upload-put-already-completed");
    const e = await client.uploads.upload(PDF_BYTES, "application/pdf", "sample.pdf").catch((x: unknown) => x);
    expect(e).toBeInstanceOf(StorageError);
    expect((e as StorageError).code).toBe("UPLOAD_ALREADY_COMPLETED");
  });

  it("sends the trimmed reviewer and counts its length after trimming", async () => {
    const bodies: string[] = [];
    const spy = new KolderaClient({ token: SECRET_KEY, baseUrl: server.origin, fetch: async (_u, init) => { bodies.push(String(init.body)); return json(job({ kind: "order_pdf" }), 202); } });
    const base = { baseArtifactSha256: "a".repeat(64), snapshotVersion: 1, target: "pdf_tags" as const, orderedNodeIds: ["n1", "n2"], acknowledged: true as const };
    await spy.jobs.remediateReadingOrder(JOB_ID, { ...base, reviewer: " " + "r".repeat(200) + " " });
    expect(JSON.parse(bodies[0]!).reviewer).toBe("r".repeat(200));
    await expect(spy.jobs.remediateReadingOrder(JOB_ID, { ...base, reviewer: "r".repeat(201) })).rejects.toThrow(/reviewer/);
    await expect(spy.jobs.remediateReadingOrder(JOB_ID, { ...base, reviewer: "   " })).rejects.toThrow(/reviewer/);
  });

  it("idempotency keys follow the server: printable ASCII with interior spaces, not blank", async () => {
    server.expect("web-job-accepted");
    await client.web.createScan({ url: "https://example.com/page", idempotencyKey: "two words-1" });
    expect(server.exchanges.at(-1)!.received.headers["idempotency-key"]).toBe("two words-1");
    for (const bad of ["", "   ", "k".repeat(256), "tab	", "é"]) {
      await expect(client.web.createScan({ url: "https://example.com/page", idempotencyKey: bad })).rejects.toThrow(/idempotencyKey/);
    }
  });

  it("does not repeat a POST with wait after a request timeout, but still repeats a network failure", async () => {
    let calls = 0;
    const timing = new KolderaClient({ token: SECRET_KEY, baseUrl: server.origin, fetch: async () => { calls += 1; throw new DOMException("t", "TimeoutError"); } });
    await expect(timing.web.createScan({ url: "https://example.com/page", wait: 5 })).rejects.toMatchObject({ name: "TimeoutError" });
    expect(calls).toBe(1);
    calls = 0;
    await expect(timing.web.createScan({ url: "https://example.com/page" })).rejects.toMatchObject({ name: "TimeoutError" });
    expect(calls).toBe(3);
    calls = 0;
    const down = new KolderaClient({ token: SECRET_KEY, baseUrl: server.origin, fetch: async () => { calls += 1; throw new TypeError("fetch failed"); } });
    await expect(down.web.createScan({ url: "https://example.com/page", wait: 5 })).rejects.toThrow("fetch failed");
    expect(calls).toBe(3);
  });

  it("a runtime without process gets ConfigurationError, not ReferenceError", () => {
    vi.stubGlobal("process", undefined);
    try {
      expect(() => new KolderaClient({ baseUrl: "http://x.invalid" })).toThrow(ConfigurationError);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("problem codes are typed but open", () => {
    const known: ProblemCode = "QUEUE_FULL";
    const future: ProblemCode = "SOMETHING_NEW";
    expect([known, future]).toHaveLength(2);
  });
});
