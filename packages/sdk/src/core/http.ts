import { ConfigurationError, errorFromProblem, StorageError } from "./errors.js";
import type { Problem, ProblemError, ResponseMeta } from "./types.js";

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface TransportOptions {
  baseUrl: string;
  /** Returns the bearer for the next request (a server token, or a session token that may rotate). */
  bearer: () => string | Promise<string>;
  fetch?: FetchLike;
  /** Per-request timeout in milliseconds (default 30 000). */
  timeoutMs?: number;
  /** Product token appended to the SDK's User-Agent (Node only; browsers forbid the header). */
  userAgentSuffix?: string;
  sendUserAgent?: boolean;
}

export interface CallOptions {
  body?: unknown;
  idempotencyKey?: string;
  /** Seconds for `Prefer: wait=N`; the request timeout is stretched to cover it. */
  wait?: number;
  signal?: AbortSignal;
  /** Idempotent reads may be retried on 429/503 after Retry-After (bounded). */
  retryOnBusy?: boolean;
  /** Send no Authorization header (the liveness probe). */
  anonymous?: boolean;
}

export interface CallResult<T> {
  value: T;
  status: number;
  retryAfterSeconds: number | undefined;
  headers: Headers;
  meta: ResponseMeta;
}

export const SDK_NAME = "koldera-sdk-js";
export const SDK_VERSION = "0.1.0";
const MAX_BUSY_RETRIES = 2;
const MAX_NETWORK_RETRIES = 2;
const NETWORK_RETRY_DELAY_MS = 250;
const IDEMPOTENCY = /^[\x21-\x7e]{1,255}$/;

/** Bearer-authenticated JSON calls to koldera-core, shared by the Node and browser clients. */
export class Transport {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly userAgent: string | undefined;

  constructor(private readonly options: TransportOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.fetchImpl = options.fetch ?? defaultFetch();
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.userAgent = options.sendUserAgent === false ? undefined : `${SDK_NAME}/${SDK_VERSION}${options.userAgentSuffix ? " " + options.userAgentSuffix : ""}`;
  }

  async call<T>(method: "GET" | "POST", path: string, options: CallOptions = {}): Promise<CallResult<T>> {
    if (options.idempotencyKey !== undefined && !IDEMPOTENCY.test(options.idempotencyKey)) {
      throw new ConfigurationError("idempotencyKey must be 1-255 printable ASCII characters without spaces");
    }
    if (options.wait !== undefined && !(Number.isInteger(options.wait) && options.wait >= 1 && options.wait <= 900)) {
      throw new ConfigurationError("wait must be a whole number of seconds from 1 to 900");
    }
    const timeoutMs = options.wait === undefined ? this.timeoutMs : Math.max(this.timeoutMs, (options.wait + 10) * 1000);
    // A repeated creation carries the same key, so the server replays its answer instead of creating a second job.
    const safeToRepeat = method === "GET" || options.idempotencyKey !== undefined;
    let busy = 0;
    let network = 0;
    for (;;) {
      const headers: Record<string, string> = { Accept: "application/json" };
      if (!options.anonymous) headers["Authorization"] = `Bearer ${await this.options.bearer()}`;
      if (this.userAgent) headers["User-Agent"] = this.userAgent;
      if (options.body !== undefined) headers["Content-Type"] = "application/json";
      if (options.idempotencyKey !== undefined) headers["Idempotency-Key"] = options.idempotencyKey;
      if (options.wait !== undefined) headers["Prefer"] = `wait=${options.wait}`;
      let response: Response;
      try {
        response = await this.send(this.baseUrl + path, { method, headers, body: options.body === undefined ? null : JSON.stringify(options.body), signal: options.signal }, timeoutMs);
      } catch (error) {
        if (!options.signal?.aborted && safeToRepeat && network < MAX_NETWORK_RETRIES && isTransportFailure(error)) {
          network += 1;
          await sleep(NETWORK_RETRY_DELAY_MS * network, options.signal);
          continue;
        }
        throw error;
      }
      const retryAfterSeconds = parseRetryAfter(response.headers.get("Retry-After"));
      if (response.ok) {
        const value = response.status === 204 ? (undefined as T) : ((await response.json()) as T);
        return { value, status: response.status, retryAfterSeconds, headers: response.headers, meta: metaOf(response) };
      }
      const problem = await readProblem(response);
      const busyStatus = response.status === 429 || response.status === 503;
      if (method === "GET" && options.retryOnBusy && busyStatus && busy < MAX_BUSY_RETRIES) {
        busy += 1;
        await sleep(Math.min((retryAfterSeconds ?? 1) * 1000, 10_000), options.signal);
        continue;
      }
      throw errorFromProblem(problem, retryAfterSeconds);
    }
  }

  /** Raw request without the bearer: signed uploads and downloads. */
  async storage(method: "PUT" | "GET", url: string, init: { body?: BodyInit; contentType?: string; signal?: AbortSignal }): Promise<Response> {
    const headers: Record<string, string> = {};
    if (init.contentType) headers["Content-Type"] = init.contentType;
    const response = await this.send(url, { method, headers, body: init.body ?? null, signal: init.signal }, this.timeoutMs);
    if (!response.ok) {
      const problem = await readProblem(response);
      throw new StorageError(`storage answered HTTP ${response.status} (${problem.code}) to ${method}`, response.status, problem.code);
    }
    return response;
  }

  private async send(url: string, init: RequestInit & { signal?: AbortSignal }, timeoutMs: number): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new DOMException("request timed out", "TimeoutError")), timeoutMs);
    const onAbort = () => controller.abort(init.signal?.reason);
    if (init.signal) {
      if (init.signal.aborted) {
        clearTimeout(timer);
        throw init.signal.reason ?? new DOMException("aborted", "AbortError");
      }
      init.signal.addEventListener("abort", onAbort, { once: true });
    }
    try {
      return await this.fetchImpl(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
      init.signal?.removeEventListener("abort", onAbort);
    }
  }
}

/** A failed connection or our own timeout; not an abort by the caller and not an HTTP answer. */
function isTransportFailure(error: unknown): boolean {
  return error instanceof TypeError || (error instanceof DOMException && error.name === "TimeoutError");
}

function metaOf(response: Response): ResponseMeta {
  return {
    status: response.status,
    location: response.headers.get("Location") ?? undefined,
    preferenceApplied: response.headers.get("Preference-Applied") ?? undefined,
    idempotentReplayed: response.headers.get("Idempotent-Replayed") === "true",
  };
}

async function readProblem(response: Response): Promise<Problem> {
  const fallback: Problem = { type: "about:blank", title: response.statusText || "HTTP error", status: response.status, code: response.status >= 500 ? "INTERNAL_ERROR" : "UNKNOWN" };
  try {
    const body = (await response.json()) as Partial<Problem>;
    if (typeof body.code === "string" && typeof body.status === "number") {
      const errors = Array.isArray(body.errors) ? body.errors.filter(isProblemError) : undefined;
      return { type: body.type ?? fallback.type, title: body.title ?? fallback.title, status: body.status, code: body.code, detail: body.detail, errors };
    }
  } catch {
    // non-JSON body: use the fallback
  }
  return fallback;
}

function isProblemError(value: unknown): value is ProblemError {
  const v = value as Partial<ProblemError> | null;
  return typeof v === "object" && v !== null && typeof v.path === "string" && typeof v.code === "string" && typeof v.message === "string";
}

export function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds;
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, Math.ceil((at - Date.now()) / 1000));
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException("aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException("aborted", "AbortError"));
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function normalizeBaseUrl(value: string): string {
  if (typeof value !== "string" || !/^https?:\/\//.test(value)) {
    throw new ConfigurationError("baseUrl must be an absolute http(s) URL");
  }
  return value.replace(/\/+$/, "");
}

function defaultFetch(): FetchLike {
  if (typeof globalThis.fetch !== "function") {
    throw new ConfigurationError("no global fetch; pass options.fetch");
  }
  return (input, init) => globalThis.fetch(input, init);
}
