import type { Problem, ProblemCode, ProblemError } from "./types.js";

/**
 * Every non-2xx answer becomes one of these. `code` is the stable problem code
 * (`QUEUE_FULL`, `STALE_READING_ORDER_SNAPSHOT`, ...); the class tells the caller what to do.
 * Messages never include a credential.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: ProblemCode;
  readonly title: string;
  readonly detail: string | undefined;
  /** Per-problem entries of a rejected structured document (`path`, `code`, `message`); empty otherwise. */
  readonly errors: readonly ProblemError[];
  /** Seconds the API asked to wait (`Retry-After`), when given. */
  readonly retryAfterSeconds: number | undefined;

  constructor(problem: Problem, retryAfterSeconds?: number) {
    super(`${problem.title} (${problem.code}, HTTP ${problem.status})${problem.detail ? ": " + problem.detail : ""}`);
    this.name = new.target.name;
    this.status = problem.status;
    this.code = problem.code;
    this.title = problem.title;
    this.detail = problem.detail;
    this.errors = problem.errors ?? [];
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** 401: the token is missing, malformed, expired or unknown. */
export class AuthenticationError extends ApiError {}
/** 403: the token is valid but lacks the scope or the right (`INSUFFICIENT_SCOPE`, `FORBIDDEN`, `SIGNATURE_INVALID`). */
export class PermissionError extends ApiError {}
/** 404: the resource does not exist, is not visible to this token, or its feature is switched off. */
export class NotFoundError extends ApiError {}
/** 409: idempotency key reused with another body, stale reading-order snapshot, expired artifact. */
export class ConflictError extends ApiError {}
/** 422, and 400 for a malformed body: the request or the input is invalid. See `code` and `errors`. */
export class ValidationError extends ApiError {}
/** 415: the body is not JSON, or the input type is unsupported. */
export class UnsupportedMediaTypeError extends ApiError {}
/** 421: the request reached a host the server does not serve. */
export class HostNotAllowedError extends ApiError {}
/** 429: a client-session budget is used up (`SESSION_JOB_LIMIT`, `SESSION_UPLOAD_LIMIT`). Mint a new session. */
export class RateLimitError extends ApiError {}
/** Any other 5xx. */
export class ServerError extends ApiError {}
/** 503, including `QUEUE_FULL`; `retryAfterSeconds` says when to try again. */
export class ServiceUnavailableError extends ServerError {}

export function errorFromProblem(problem: Problem, retryAfterSeconds?: number): ApiError {
  switch (problem.status) {
    case 400:
    case 422:
      return new ValidationError(problem, retryAfterSeconds);
    case 401:
      return new AuthenticationError(problem, retryAfterSeconds);
    case 403:
      return new PermissionError(problem, retryAfterSeconds);
    case 404:
      return new NotFoundError(problem, retryAfterSeconds);
    case 409:
      return new ConflictError(problem, retryAfterSeconds);
    case 415:
      return new UnsupportedMediaTypeError(problem, retryAfterSeconds);
    case 421:
      return new HostNotAllowedError(problem, retryAfterSeconds);
    case 429:
      return new RateLimitError(problem, retryAfterSeconds);
    case 503:
      return new ServiceUnavailableError(problem, retryAfterSeconds);
    default:
      return problem.status >= 500 ? new ServerError(problem, retryAfterSeconds) : new ApiError(problem, retryAfterSeconds);
  }
}

/** The SDK was used wrongly (bad options, an unacknowledged correction, an invalid argument). */
export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

/** `jobs.wait` ran past its `timeoutMs`. The job keeps running server-side. */
export class TimeoutError extends Error {
  readonly jobId: string;

  constructor(jobId: string, timeoutMs: number) {
    super(`job ${jobId} did not finish within ${timeoutMs} ms`);
    this.name = "TimeoutError";
    this.jobId = jobId;
  }
}

/** A signed storage exchange (upload PUT or artifact download) failed, or the downloaded bytes did not match. */
export class StorageError extends Error {
  readonly status: number | undefined;
  /** Problem code of the storage answer (`SIGNATURE_INVALID`, `UPLOAD_EXPIRED`, ...), when it sent one. */
  readonly code: ProblemCode | undefined;

  constructor(message: string, status?: number, code?: ProblemCode) {
    super(message);
    this.name = "StorageError";
    this.status = status;
    this.code = code;
  }
}
