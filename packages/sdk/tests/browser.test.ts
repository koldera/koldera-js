import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ConfigurationError, KolderaBrowserClient, PermissionError, RateLimitError, type StructuredDocument } from "../dist/browser/index.js";
import { fixtures, GoldenServer, PDF_BYTES, SECRET_KEY, SESSION_TOKEN } from "./support/golden.js";

const JOB_ID = "4d2d5a6e-2b1c-4e4a-9d6b-1f3c5e7a9b01";
const server = new GoldenServer();
server.bearerAs = "session";
beforeAll(() => server.start());
afterAll(() => server.stop());
afterEach(() => server.assertConsumed());

const here = path.dirname(fileURLToPath(import.meta.url));

describe("browser client initialization", () => {
  const options = () => ({ baseUrl: server.origin, sessionToken: SESSION_TOKEN });

  it("takes a base URL and a session token, as a string or a function", () => {
    expect(new KolderaBrowserClient(options())).toBeInstanceOf(KolderaBrowserClient);
    expect(new KolderaBrowserClient({ ...options(), sessionToken: async () => SESSION_TOKEN })).toBeInstanceOf(KolderaBrowserClient);
    expect(() => new KolderaBrowserClient({ ...options(), sessionToken: "" })).toThrow(ConfigurationError);
    expect(() => new KolderaBrowserClient({ ...options(), sessionToken: undefined as never })).toThrow(/sessionToken/);
    expect(() => new KolderaBrowserClient({ baseUrl: "nope", sessionToken: SESSION_TOKEN })).toThrow(/baseUrl/);
  });

  it("needs no publishable key and does no prefix checks on the token", () => {
    expect(new KolderaBrowserClient({ baseUrl: server.origin, sessionToken: "any-opaque-string" })).toBeInstanceOf(KolderaBrowserClient);
  });

  it("refuses an option shaped like a server token and has no way to mint sessions", () => {
    expect(() => new KolderaBrowserClient({ ...options(), token: SECRET_KEY } as never)).toThrow(/never a server token/);
    expect(() => new KolderaBrowserClient({ ...options(), secretKey: SECRET_KEY } as never)).toThrow(/never a server token/);
    const client = new KolderaBrowserClient(options());
    expect((client as unknown as Record<string, unknown>)["clientSessions"]).toBeUndefined();
    expect((KolderaBrowserClient.prototype as unknown as Record<string, unknown>)["clientSessions"]).toBeUndefined();
  });

  it("rejects a token function that returns nothing usable", async () => {
    const client = new KolderaBrowserClient({ ...options(), sessionToken: async () => "" });
    await expect(client.jobs.get(JOB_ID)).rejects.toThrow(ConfigurationError);
  });

  it("never reads KOLDERA_TOKEN or KOLDERA_URL", () => {
    const saved = [process.env["KOLDERA_TOKEN"], process.env["KOLDERA_URL"]];
    process.env["KOLDERA_TOKEN"] = SECRET_KEY;
    process.env["KOLDERA_URL"] = server.origin;
    try {
      expect(() => new KolderaBrowserClient({ sessionToken: SESSION_TOKEN } as never)).toThrow(/baseUrl/);
    } finally {
      for (const [name, value] of [["KOLDERA_TOKEN", saved[0]], ["KOLDERA_URL", saved[1]]] as const) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });
});

describe("golden: session-authenticated calls", () => {
  const client = () => new KolderaBrowserClient({ baseUrl: server.origin, sessionToken: SESSION_TOKEN });

  it("creates a PDF job from a File with the session bearer, no User-Agent override and no bearer on the PUT", async () => {
    server.expect("upload-ticket-session", "upload-put-pdf", "pdf-job-session");
    const file = new File([PDF_BYTES], "sample.pdf", { type: "application/pdf" });
    const job = await client().pdf.createJob({ file, fileName: "sample.pdf", mode: "analyze" });
    expect(job.state).toBe("queued");
    expect(server.exchanges.at(-1)!.received.headers["authorization"]).toBe("Bearer " + SESSION_TOKEN);
    expect(server.exchanges.at(-1)!.received.headers["user-agent"] ?? "").not.toMatch(/koldera-sdk-js/);
    expect(server.exchanges.at(-2)!.received.headers["authorization"]).toBeUndefined();
  });

  it("reads a session's job and info", async () => {
    server.expect("job-completed-session", "info-session");
    expect((await client().jobs.get(JOB_ID)).validation?.status).toBe("failed");
    expect((await client().info()).features).toContain("pdf");
  });

  it("surfaces a used-up job budget as RateLimitError and a missing scope as PermissionError", async () => {
    server.expect("upload-ticket-session", "upload-put-pdf", "pdf-job-session-job-limit");
    const limited = await client().pdf.createJob({ file: PDF_BYTES, fileName: "sample.pdf", mode: "fix" }).catch((x: unknown) => x);
    expect(limited).toBeInstanceOf(RateLimitError);
    expect((limited as RateLimitError).code).toBe("SESSION_JOB_LIMIT");
    server.expect("job-insufficient-scope");
    expect(await client().jobs.get(JOB_ID).catch((x: unknown) => x)).toBeInstanceOf(PermissionError);
  });

  it("sends Prefer: wait with a document job and returns the finished job", async () => {
    server.expect("document-job-prefer-wait-finished");
    const job = await client().documents.createJob(fixtures["document-job-prefer-wait-finished"]!.request.body as StructuredDocument, { wait: 30 });
    expect(job.state).toBe("completed");
  });

  it("asks for a fresh token before every request when given a function", async () => {
    let calls = 0;
    const rotating = new KolderaBrowserClient({ baseUrl: server.origin, sessionToken: () => (++calls, SESSION_TOKEN) });
    server.expect("job-completed-session", "job-completed-session");
    await rotating.jobs.get(JOB_ID);
    await rotating.jobs.get(JOB_ID);
    expect(calls).toBe(2);
  });
});

describe("bundle scan", () => {
  it("the browser entry bundles without Node built-ins, environment reads, session minting or any server-token path", async () => {
    const entry = path.resolve(here, "../dist/browser/index.js");
    const result = await build({ entryPoints: [entry], bundle: true, write: false, format: "esm", platform: "browser", treeShaking: true, minify: false });
    const code = result.outputFiles[0]!.text;
    expect(code).not.toContain("process.env");
    expect(code).not.toContain("KOLDERA_TOKEN");
    expect(code).not.toContain("KOLDERA_URL");
    expect(code).not.toContain("client-sessions");
    expect(code).not.toContain("clientSessions");
    expect(code).not.toContain("node:");
    expect(code).not.toMatch(/\brequire\(/);
    expect(code).not.toContain(SECRET_KEY);
    const source = readFileSync(entry, "utf8");
    expect(source).not.toContain("readFile");
    expect(source).not.toContain("node/index");
  });

  it("the shared entry point has no client at all", async () => {
    const entry = path.resolve(here, "../dist/index.js");
    const result = await build({ entryPoints: [entry], bundle: true, write: false, format: "esm", platform: "browser" });
    const code = result.outputFiles[0]!.text;
    expect(code).not.toContain("Authorization");
    expect(code).not.toContain("process.env");
  });
});
