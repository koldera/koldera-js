import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { ConfigurationError } from "../core/errors.js";
import { Transport, type FetchLike } from "../core/http.js";
import { CoreClient } from "../core/client.js";
import type { ClientSession, ClientSessionRequest, RequestOptions } from "../core/types.js";

export * from "../core/types.js";
export * from "../core/document.js";
export * from "../core/errors.js";
export type { CreateHtmlToPdfJobInput, CreatePdfJobInput, CreateWebScanInput, UploadImageOptions, UploadSource } from "../core/client.js";
export { isFinished, newIdempotencyKey } from "../core/client.js";

export interface KolderaClientOptions {
  /** Origin of your koldera-core server. Falls back to `KOLDERA_URL`. */
  baseUrl?: string;
  /** Server token (any non-empty string the server accepts). Falls back to `KOLDERA_TOKEN`. Never ship it to a browser. */
  token?: string;
  fetch?: FetchLike;
  /** Fetch for signed storage URLs; defaults to the global `fetch`. Must not add credentials. */
  storageFetch?: FetchLike;
  timeoutMs?: number;
  /** Timeout of a whole upload or download in milliseconds (default 600 000). */
  storageTimeoutMs?: number;
  userAgentSuffix?: string;
}

/**
 * Server-side client (Node.js 20 or later). Holds the server token and can mint short-lived sessions
 * for the browser and React clients.
 */
export class KolderaClient extends CoreClient {
  readonly clientSessions: ClientSessions;

  constructor(options: KolderaClientOptions = {}) {
    const env = globalThis.process?.env ?? {};
    const token = options.token ?? env["KOLDERA_TOKEN"] ?? "";
    if (typeof token !== "string" || token.trim().length === 0) {
      throw new ConfigurationError("token is required: pass options.token or set KOLDERA_TOKEN");
    }
    const baseUrl = options.baseUrl ?? env["KOLDERA_URL"];
    if (!baseUrl) {
      throw new ConfigurationError("baseUrl is required: pass options.baseUrl or set KOLDERA_URL");
    }
    const transport = new Transport({ baseUrl, bearer: () => token, fetch: options.fetch, storageFetch: options.storageFetch, timeoutMs: options.timeoutMs, storageTimeoutMs: options.storageTimeoutMs, userAgentSuffix: options.userAgentSuffix });
    super(transport);
    this.clientSessions = new ClientSessions(transport);
  }
}

export class ClientSessions {
  constructor(private readonly transport: Transport) {}

  /**
   * Mint a scoped, short-lived browser session for an end user you authenticated. Call it from your
   * backend only, then hand `sessionToken` to the browser.
   */
  async create(request: ClientSessionRequest, options: RequestOptions = {}): Promise<ClientSession> {
    if (typeof request.allowedOrigin !== "string" || !/^https?:\/\/[^/]+$/.test(request.allowedOrigin)) {
      throw new ConfigurationError("allowedOrigin must be an absolute http(s) origin without a path");
    }
    const { value } = await this.transport.call<ClientSession>("POST", "/v1/client-sessions", { body: request, signal: options.signal });
    return value;
  }
}

/** Read a file for an upload (bytes plus a file name for the ticket). */
export async function openFile(path: string): Promise<{ file: Uint8Array; fileName: string }> {
  return { file: new Uint8Array(await readFile(path)), fileName: basename(path) };
}
