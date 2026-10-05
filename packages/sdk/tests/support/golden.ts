import { readdirSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Replays contracts/golden/*.json: a scripted mock API that verifies each request the SDK
 * sends (method, path, headers, body) against the next expected fixture and answers with the
 * fixture's response. Shared by the Node, browser and React suites.
 */
export interface Fixture {
  name: string;
  operationId: string | null;
  auth: "server" | "session";
  request: { method: string; path: string; headers: Record<string, string>; body?: unknown; rawBody?: string; forbiddenHeaders?: string[] };
  response: { status: number; headers: Record<string, string>; body?: unknown; rawBody?: string };
  notes?: string;
}

const goldenDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../contracts/golden");
export const fixtures: Record<string, Fixture> = Object.fromEntries(
  readdirSync(goldenDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      const fixture = JSON.parse(readFileSync(path.join(goldenDir, f), "utf8")) as Fixture;
      return [fixture.name, fixture];
    }),
);

export const SECRET_KEY = "test-server-token";
export const SESSION_TOKEN = "v1.eyJmYWtlIjoidHJ1ZSJ9.ZmFrZS1zaWduYXR1cmU";
export const STALE_SESSION_TOKEN = "v1.eyJzdGFsZSI6dHJ1ZX0.c3RhbGUtc2lnbmF0dXJl";

export interface Exchange {
  fixture: Fixture;
  /** What the SDK actually sent. */
  received: { method: string; path: string; headers: Record<string, string>; body: Buffer };
}

export class GoldenServer {
  private server: Server | null = null;
  private script: Fixture[] = [];
  readonly exchanges: Exchange[] = [];
  readonly mismatches: string[] = [];
  origin = "";
  /** Browser/React suites replay server-auth fixtures with the session bearer instead of the secret. */
  bearerAs: "server" | "session" = "server";

  async start(): Promise<string> {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const body = Buffer.concat(chunks);
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(req.headers)) headers[k.toLowerCase()] = Array.isArray(v) ? v.join(",") : (v ?? "");
        // Browsers (and happy-dom) preflight cross-origin calls; answer like the real API's /v1 policy, off-script.
        const cors: Record<string, string> = headers["origin"]
          ? { "Access-Control-Allow-Origin": headers["origin"], "Access-Control-Expose-Headers": "Retry-After, Preference-Applied, Location, Idempotent-Replayed", Vary: "Origin" }
          : {};
        if (req.method === "OPTIONS") {
          res.writeHead(204, { ...cors, "Access-Control-Allow-Methods": "GET, POST, PUT", "Access-Control-Allow-Headers": "authorization, content-type, idempotency-key, prefer" }).end();
          return;
        }
        const expected = this.script.shift();
        if (!expected) {
          this.mismatches.push(`unexpected request ${req.method} ${req.url}`);
          res.writeHead(500, { "content-type": "application/problem+json" }).end(JSON.stringify({ type: "about:blank", title: "unscripted", status: 500, code: "INTERNAL_ERROR" }));
          return;
        }
        this.exchanges.push({ fixture: expected, received: { method: req.method ?? "", path: req.url ?? "", headers, body } });
        this.verify(expected, req.method ?? "", req.url ?? "", headers, body);
        const responseHeaders: Record<string, string> = { ...cors };
        for (const [k, v] of Object.entries(expected.response.headers)) responseHeaders[k] = this.resolve(v);
        if (expected.response.rawBody !== undefined) {
          res.writeHead(expected.response.status, responseHeaders).end(Buffer.from(expected.response.rawBody, "latin1"));
        } else if (expected.response.body !== undefined) {
          res.writeHead(expected.response.status, responseHeaders).end(this.resolve(JSON.stringify(expected.response.body)));
        } else {
          res.writeHead(expected.response.status, responseHeaders).end();
        }
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    this.origin = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this.origin;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }

  /** Queue the fixtures the next SDK call must produce, in order. */
  expect(...names: string[]): void {
    for (const name of names) {
      const fixture = fixtures[name];
      if (!fixture) throw new Error("unknown fixture " + name);
      this.script.push(fixture);
    }
  }

  /** Throws with every mismatch recorded so far and every fixture still unconsumed. */
  assertConsumed(): void {
    const problems = [...this.mismatches, ...this.script.map((f) => `fixture not reached: ${f.name}`)];
    this.mismatches.length = 0;
    this.script.length = 0;
    if (problems.length > 0) throw new Error(problems.join("\n"));
  }

  private resolve(text: string): string {
    return text
      .replaceAll("{{baseUrl}}", this.origin)
      .replaceAll("{{secretKey}}", this.bearerAs === "session" ? SESSION_TOKEN : SECRET_KEY)
      .replaceAll("{{sessionToken}}", SESSION_TOKEN)
      .replaceAll("{{staleSessionToken}}", STALE_SESSION_TOKEN);
  }

  private verify(expected: Fixture, method: string, url: string, headers: Record<string, string>, body: Buffer): void {
    const at = `${expected.name}: `;
    if (method !== expected.request.method) this.mismatches.push(at + `method ${method} != ${expected.request.method}`);
    if (url !== expected.request.path) this.mismatches.push(at + `path ${url} != ${expected.request.path}`);
    for (const [name, value] of Object.entries(expected.request.headers)) {
      const actual = headers[name.toLowerCase()];
      if (actual === undefined) {
        this.mismatches.push(at + `missing header ${name}`);
      } else if (value === "{{idempotencyKey}}") {
        if (!/^[\x21-\x7e]{1,255}$/.test(actual)) this.mismatches.push(at + `Idempotency-Key not 1-255 printable ASCII: ${actual}`);
      } else if (actual.split(";")[0]!.trim() !== this.resolve(value)) {
        this.mismatches.push(at + `header ${name}: ${actual} != ${this.resolve(value)}`);
      }
    }
    for (const name of expected.request.forbiddenHeaders ?? []) {
      if (headers[name.toLowerCase()] !== undefined) this.mismatches.push(at + `forbidden header ${name} present`);
    }
    if (expected.request.rawBody !== undefined) {
      if (!body.equals(Buffer.from(expected.request.rawBody, "latin1"))) this.mismatches.push(at + "raw body differs");
    } else if (expected.request.body !== undefined) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(body.toString("utf8"));
      } catch {
        this.mismatches.push(at + "body is not JSON");
        return;
      }
      const want = JSON.stringify(sortKeys(expected.request.body));
      const got = JSON.stringify(sortKeys(parsed));
      if (want !== got) this.mismatches.push(at + `body ${got} != ${want}`);
    } else if (body.length > 0) {
      this.mismatches.push(at + "unexpected request body");
    }
  }
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as object)
        .sort()
        .map((k) => [k, sortKeys((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

/** Bytes of the fixture uploads (the SHA-256 in the ticket requests is of exactly these). */
export const PDF_BYTES = Buffer.from(fixtures["upload-put-pdf"]!.request.rawBody!, "latin1");
export const HTML_BYTES = Buffer.from(fixtures["upload-put-html"]!.request.rawBody!, "latin1");
export const PNG_BYTES = Buffer.from(fixtures["upload-put-image-png"]!.request.rawBody!, "latin1");
