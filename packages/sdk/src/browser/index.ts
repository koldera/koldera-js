import { ConfigurationError } from "../core/errors.js";
import { Transport, type FetchLike } from "../core/http.js";
import { CoreClient } from "../core/client.js";

export * from "../core/types.js";
export * from "../core/document.js";
export * from "../core/errors.js";
export type { CreateHtmlToPdfJobInput, CreatePdfJobInput, CreateWebScanInput, UploadImageOptions, UploadSource } from "../core/client.js";
export { isFinished, newIdempotencyKey } from "../core/client.js";

export interface KolderaBrowserClientOptions {
  /** API origin of your koldera-core server. */
  baseUrl: string;
  /** Short-lived session token minted by your backend with the server SDK; a function is called before each request. */
  sessionToken: string | (() => string | Promise<string>);
  fetch?: FetchLike;
  /** Fetch for signed storage URLs; defaults to the global `fetch`. Must not add credentials. */
  storageFetch?: FetchLike;
  timeoutMs?: number;
  /** Timeout of a whole upload or download in milliseconds (default 600 000). */
  storageTimeoutMs?: number;
}

/**
 * Browser client. Its only credential is a session token that your backend minted for this origin, with
 * scopes and budgets. It cannot mint sessions and never reads the environment.
 */
export class KolderaBrowserClient extends CoreClient {
  constructor(options: KolderaBrowserClientOptions) {
    const given = options as unknown as Record<string, unknown>;
    if ("token" in given || "secretKey" in given) {
      throw new ConfigurationError("a browser client takes a sessionToken minted by your backend, never a server token");
    }
    const source = options.sessionToken;
    if (typeof source !== "string" && typeof source !== "function") {
      throw new ConfigurationError("sessionToken is required: a string or a function returning the current session token");
    }
    if (typeof source === "string" && source.trim().length === 0) {
      throw new ConfigurationError("sessionToken must be a non-empty string");
    }
    const bearer = async (): Promise<string> => {
      const token = typeof source === "string" ? source : await source();
      if (typeof token !== "string" || token.trim().length === 0) {
        throw new ConfigurationError("sessionToken must be a non-empty string");
      }
      return token;
    };
    super(new Transport({ baseUrl: options.baseUrl, bearer, fetch: options.fetch, storageFetch: options.storageFetch, timeoutMs: options.timeoutMs, storageTimeoutMs: options.storageTimeoutMs, sendUserAgent: false }));
  }
}
