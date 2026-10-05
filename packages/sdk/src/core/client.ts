import type { StructuredDocument } from "./document.js";
import { ConfigurationError, StorageError, TimeoutError } from "./errors.js";
import { sleep, Transport } from "./http.js";
import type {
  Artifact,
  CreateOptions,
  Finding,
  Health,
  HtmlToPdfMode,
  ImageContentType,
  Info,
  Job,
  PdfMode,
  ReadingOrderRemediation,
  ReadingOrderSnapshot,
  RemediationAction,
  RequestOptions,
  UploadContentType,
  UploadTicket,
  WaitOptions,
} from "./types.js";

/** Bytes to upload: a Blob/File, raw bytes, or a UTF-8 string (HTML only). */
export type UploadSource = Blob | Uint8Array | ArrayBuffer | string;

export interface CreatePdfJobInput extends CreateOptions {
  file: UploadSource;
  fileName?: string;
  mode: PdfMode;
  /** BCP 47 tag, used only when the document has none; never guessed. */
  explicitLanguage?: string | null;
  /** 1-500 printable characters; replaces an existing title. Validated before any request. */
  explicitTitle?: string | null;
}

export interface CreateHtmlToPdfJobInput extends CreateOptions {
  file: UploadSource;
  fileName?: string;
  mode: HtmlToPdfMode;
  explicitLanguage?: string | null;
  explicitTitle?: string | null;
  /** Print only the elements matching this CSS selector (1-200 printable characters). */
  contentSelector?: string | null;
}

export interface CreateWebScanInput extends CreateOptions {
  url: string | URL;
}

export interface UploadImageOptions extends RequestOptions {
  /** Defaults to the Blob's own type. */
  contentType?: ImageContentType;
  fileName?: string;
}

const IMAGE_TYPES: readonly string[] = ["image/png", "image/jpeg", "image/svg+xml"];
const UPLOAD_TYPES: readonly string[] = ["application/pdf", "text/html", ...IMAGE_TYPES];
const MAX_DELAY_MS = 10_000;

/** A job that is no longer queued or running; an unknown state from a newer core counts as final. */
export function isFinished(job: Pick<Job, "state">): boolean {
  return job.state !== "queued" && job.state !== "running";
}

/** The resources every surface exposes; the Node and browser clients differ only in how they authenticate. */
export class CoreClient {
  readonly uploads: Uploads;
  readonly jobs: Jobs;
  readonly pdf: Pdf;
  readonly web: Web;
  readonly htmlToPdf: HtmlToPdf;
  readonly documents: Documents;
  readonly artifacts: Artifacts;

  constructor(protected readonly transport: Transport) {
    this.uploads = new Uploads(transport);
    this.jobs = new Jobs(transport);
    this.pdf = new Pdf(transport, this.uploads, this.jobs);
    this.web = new Web(transport, this.jobs);
    this.htmlToPdf = new HtmlToPdf(transport, this.uploads, this.jobs);
    this.documents = new Documents(transport, this.uploads, this.jobs);
    this.artifacts = new Artifacts(transport);
  }

  /** Version and enabled features of the server (`GET /v1/info`). */
  async info(options: RequestOptions = {}): Promise<Info> {
    return (await this.transport.call<Info>("GET", "/v1/info", { signal: options.signal, retryOnBusy: true })).value;
  }

  /** Liveness probe (`GET /healthz`); sends no credential. */
  async health(options: RequestOptions = {}): Promise<Health> {
    return (await this.transport.call<Health>("GET", "/healthz", { signal: options.signal, anonymous: true, retryOnBusy: true })).value;
  }
}

/** POSTs a job request and applies `wait` / `untilFinished`; shared by every creation call. */
async function createJob(transport: Transport, jobs: Jobs, path: string, body: unknown, key: string, options: CreateOptions): Promise<Job> {
  const { value, meta } = await transport.call<Job>("POST", path, { body, idempotencyKey: key, wait: options.wait, signal: options.signal });
  options.onResponse?.(meta);
  if (options.untilFinished && !isFinished(value)) {
    const poll = options.untilFinished === true ? {} : options.untilFinished;
    return jobs.wait(value.id, { ...poll, signal: options.signal });
  }
  return value;
}

export class Uploads {
  constructor(private readonly transport: Transport) {}

  /** Issue a ticket and PUT the bytes to storage (no bearer on the PUT). Returns the consumed ticket. */
  async upload(source: UploadSource, contentType: UploadContentType, fileName: string, options: RequestOptions = {}): Promise<UploadTicket> {
    if (!UPLOAD_TYPES.includes(contentType)) {
      throw new ConfigurationError(`contentType must be one of ${UPLOAD_TYPES.join(", ")}`);
    }
    const bytes = await toBytes(source);
    if (bytes.byteLength === 0) {
      throw new ConfigurationError("the file is empty");
    }
    const sha256 = await sha256Hex(bytes);
    const { value: ticket, meta } = await this.transport.call<UploadTicket>("POST", "/v1/uploads", {
      body: { fileName, sizeBytes: bytes.byteLength, sha256, contentType },
      idempotencyKey: options.idempotencyKey ?? newIdempotencyKey(),
      signal: options.signal,
    });
    options.onResponse?.(meta);
    if (typeof ticket.maxBytes === "number" && bytes.byteLength > ticket.maxBytes) {
      throw new ConfigurationError(`the file (${bytes.byteLength} bytes) exceeds the ticket limit of ${ticket.maxBytes} bytes`);
    }
    try {
      await this.transport.storage("PUT", ticket.uploadUrl, { body: new Blob([bytes as BlobPart]), contentType, signal: options.signal });
    } catch (error) {
      // A replayed ticket belongs to an earlier attempt whose PUT already stored these exact bytes (size and hash are part of the replayed request).
      const stored = error instanceof StorageError && error.status === 409 && error.code === "UPLOAD_ALREADY_COMPLETED";
      if (!(meta.idempotentReplayed && stored)) throw error;
    }
    return ticket;
  }
}

export class Pdf {
  constructor(
    private readonly transport: Transport,
    private readonly uploads: Uploads,
    private readonly jobs: Jobs,
  ) {}

  /** Upload a PDF and queue `analyze` or `fix`. */
  async createJob(input: CreatePdfJobInput): Promise<Job> {
    validateMode(input.mode, ["analyze", "fix"]);
    validateLanguage(input.explicitLanguage);
    const explicitTitle = validateTitle(input.explicitTitle);
    const key = input.idempotencyKey ?? newIdempotencyKey();
    const ticket = await this.uploads.upload(input.file, "application/pdf", input.fileName ?? "document.pdf", { idempotencyKey: derivedKey(key, "upload"), signal: input.signal });
    const body = compact({ uploadId: ticket.uploadId, mode: input.mode, profile: "ua1", explicitLanguage: input.explicitLanguage, explicitTitle });
    return createJob(this.transport, this.jobs, "/v1/pdf/jobs", body, key, input);
  }
}

export class HtmlToPdf {
  constructor(
    private readonly transport: Transport,
    private readonly uploads: Uploads,
    private readonly jobs: Jobs,
  ) {}

  /** Upload one self-contained static HTML file and queue the render, inspect and validate pipeline. Never a URL. */
  async createJob(input: CreateHtmlToPdfJobInput): Promise<Job> {
    validateMode(input.mode, ["generate_analyze", "generate_fix"]);
    validateLanguage(input.explicitLanguage);
    const explicitTitle = validateTitle(input.explicitTitle);
    const contentSelector = validateContentSelector(input.contentSelector);
    const key = input.idempotencyKey ?? newIdempotencyKey();
    const ticket = await this.uploads.upload(input.file, "text/html", input.fileName ?? "page.html", { idempotencyKey: derivedKey(key, "upload"), signal: input.signal });
    const body = compact({ uploadId: ticket.uploadId, mode: input.mode, profile: "ua1", contentSelector, explicitLanguage: input.explicitLanguage, explicitTitle });
    return createJob(this.transport, this.jobs, "/v1/html-to-pdf/jobs", body, key, input);
  }
}

export class Web {
  constructor(
    private readonly transport: Transport,
    private readonly jobs: Jobs,
  ) {}

  /** Queue one automated scan of a public http(s) URL. */
  async createScan(input: CreateWebScanInput): Promise<Job> {
    const url = input.url instanceof URL ? input.url.toString() : input.url;
    if (!/^https?:\/\//i.test(url)) {
      throw new ConfigurationError("url must be an absolute http(s) URL");
    }
    return createJob(this.transport, this.jobs, "/v1/web/jobs", { url }, input.idempotencyKey ?? newIdempotencyKey(), input);
  }
}

export class Documents {
  constructor(
    private readonly transport: Transport,
    private readonly uploads: Uploads,
    private readonly jobs: Jobs,
  ) {}

  /** Queue a structured document for rendering to a tagged PDF. Images are referenced by the `uploadId` of `uploadImage`. */
  async createJob(document: StructuredDocument, options: CreateOptions = {}): Promise<Job> {
    if (typeof document !== "object" || document === null || Array.isArray(document)) {
      throw new ConfigurationError("document must be a structured document object");
    }
    return createJob(this.transport, this.jobs, "/v1/documents/jobs", document, options.idempotencyKey ?? newIdempotencyKey(), options);
  }

  /** Upload one PNG, JPEG or SVG image for use in an `image` block. */
  async uploadImage(source: UploadSource, options: UploadImageOptions = {}): Promise<UploadTicket> {
    const blobType = typeof Blob !== "undefined" && source instanceof Blob ? source.type : undefined;
    const contentType = options.contentType ?? blobType;
    if (!contentType || !IMAGE_TYPES.includes(contentType)) {
      throw new ConfigurationError(`image contentType must be one of ${IMAGE_TYPES.join(", ")}`);
    }
    const blobName = typeof File !== "undefined" && source instanceof File ? source.name : undefined;
    return this.uploads.upload(source, contentType as ImageContentType, options.fileName ?? blobName ?? "image", options);
  }
}

export class Jobs {
  constructor(private readonly transport: Transport) {}

  async get(jobId: string, options: RequestOptions = {}): Promise<Job> {
    return (await this.transport.call<Job>("GET", `/v1/jobs/${jobPath(jobId)}`, { signal: options.signal, retryOnBusy: true })).value;
  }

  /**
   * Poll until the job is no longer `queued` or `running` and return it (a failed job is returned, not
   * thrown: read `job.error`). Honours `Retry-After`, otherwise backs off from `initialDelayMs` up to 10 s.
   * Abort with `signal`; `timeoutMs` throws `TimeoutError`.
   */
  async wait(jobId: string, options: WaitOptions = {}): Promise<Job> {
    const timeoutMs = options.timeoutMs ?? 600_000;
    const started = Date.now();
    let delay = options.initialDelayMs ?? 1_000;
    for (;;) {
      const { value: job, retryAfterSeconds } = await this.transport.call<Job>("GET", `/v1/jobs/${jobPath(jobId)}`, { signal: options.signal, retryOnBusy: true });
      options.onUpdate?.(job);
      if (isFinished(job)) {
        return job;
      }
      const pause = retryAfterSeconds !== undefined ? retryAfterSeconds * 1000 : delay;
      if (Date.now() - started + pause > timeoutMs) {
        throw new TimeoutError(jobId, timeoutMs);
      }
      await sleep(pause, options.signal);
      delay = Math.min(delay * 2, MAX_DELAY_MS);
    }
  }

  async findings(jobId: string, options: RequestOptions = {}): Promise<Finding[]> {
    return (await this.transport.call<{ items: Finding[] }>("GET", `/v1/jobs/${jobPath(jobId)}/findings`, { signal: options.signal, retryOnBusy: true })).value.items;
  }

  /** What each repair rule did on a `fix` job (applied, skipped, failed, rolled_back, with a reason). */
  async actions(jobId: string, options: RequestOptions = {}): Promise<RemediationAction[]> {
    return (await this.transport.call<{ items: RemediationAction[] }>("GET", `/v1/jobs/${jobPath(jobId)}/actions`, { signal: options.signal, retryOnBusy: true })).value.items;
  }

  /** Files of the job with fresh signed download URLs. */
  async artifacts(jobId: string, options: RequestOptions = {}): Promise<Artifact[]> {
    return (await this.transport.call<{ items: Artifact[] }>("GET", `/v1/jobs/${jobPath(jobId)}/artifacts`, { signal: options.signal, retryOnBusy: true })).value.items;
  }

  /** Reading-order evidence bound to the artifact hash; `reviewRequired` is always true. */
  async getReadingOrder(jobId: string, options: RequestOptions = {}): Promise<ReadingOrderSnapshot> {
    return (await this.transport.call<ReadingOrderSnapshot>("GET", `/v1/jobs/${jobPath(jobId)}/reading-order`, { signal: options.signal, retryOnBusy: true })).value;
  }

  /**
   * Queue a correction a person approved: the complete children of one parent in the new order, bound to
   * the snapshot's artifact hash and version. `acknowledged` must be `true`. 409 means the snapshot is
   * stale (reload and review again); 422 means the plan cannot be applied safely.
   */
  async remediateReadingOrder(jobId: string, approval: ReadingOrderRemediation, options: CreateOptions = {}): Promise<Job> {
    if (approval.acknowledged !== true) {
      throw new ConfigurationError("a reading-order correction must be acknowledged by the reviewer (acknowledged: true)");
    }
    if (!Array.isArray(approval.orderedNodeIds) || approval.orderedNodeIds.length < 2 || new Set(approval.orderedNodeIds).size !== approval.orderedNodeIds.length) {
      throw new ConfigurationError("orderedNodeIds must list at least two distinct node ids");
    }
    if (!/^[a-f0-9]{64}$/.test(approval.baseArtifactSha256)) {
      throw new ConfigurationError("baseArtifactSha256 must be the 64-hex artifact hash from the snapshot");
    }
    const reviewer = validateReviewer(approval.reviewer);
    const body = compact({
      baseArtifactSha256: approval.baseArtifactSha256,
      snapshotVersion: approval.snapshotVersion,
      target: approval.target,
      orderedNodeIds: approval.orderedNodeIds,
      acknowledged: true,
      reviewer,
    });
    return createJob(this.transport, this, `/v1/jobs/${jobPath(jobId)}/reading-order/remediations`, body, options.idempotencyKey ?? newIdempotencyKey(), options);
  }
}

export class Artifacts {
  constructor(private readonly transport: Transport) {}

  /** Fetch an artifact through its signed URL (no bearer) and verify its size and SHA-256 before returning bytes. */
  async download(artifact: Artifact, options: RequestOptions = {}): Promise<Uint8Array> {
    const response = await this.transport.storage("GET", artifact.downloadUrl, { signal: options.signal });
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength !== artifact.sizeBytes) {
      throw new StorageError(`artifact ${artifact.kind}: received ${bytes.byteLength} bytes, expected ${artifact.sizeBytes}`);
    }
    const sha = await sha256Hex(bytes);
    if (sha !== artifact.sha256) {
      throw new StorageError(`artifact ${artifact.kind}: SHA-256 mismatch`);
    }
    return bytes;
  }
}

function jobPath(jobId: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(jobId)) {
    throw new ConfigurationError("jobId must be a UUID");
  }
  return jobId.toLowerCase();
}

function validateMode(mode: string, allowed: string[]): void {
  if (!allowed.includes(mode)) {
    throw new ConfigurationError(`mode must be one of ${allowed.join(", ")}`);
  }
}

/** Bounded and printable here; whether it is valid CSS only the renderer can tell. Sent only when given. */
function validateContentSelector(selector: string | null | undefined): string | undefined {
  if (selector === undefined || selector === null) return undefined;
  const trimmed = selector.trim();
  if (trimmed.length === 0 || trimmed.length > 200 || /\p{Cc}/u.test(trimmed)) {
    throw new ConfigurationError("contentSelector must be 1-200 printable characters (a CSS selector)");
  }
  return trimmed;
}

function validateLanguage(tag: string | null | undefined): void {
  if (tag !== undefined && tag !== null && !/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(tag)) {
    throw new ConfigurationError("explicitLanguage must be a well-formed BCP 47 tag");
  }
}

/** Trimmed, 1-500 printable characters (counted as code points, like the API), or undefined when absent. */
function validateTitle(title: string | null | undefined): string | undefined {
  if (title === undefined || title === null) return undefined;
  const t = title.trim();
  if (t.length === 0 || [...t].length > 500 || /\p{Cc}/u.test(t)) {
    throw new ConfigurationError("explicitTitle must be 1-500 printable characters");
  }
  return t;
}

function validateReviewer(reviewer: string | undefined): string | undefined {
  if (reviewer === undefined) return undefined;
  const trimmed = typeof reviewer === "string" ? reviewer.trim() : "";
  if (trimmed.length === 0 || [...trimmed].length > 200 || /\p{Cc}/u.test(trimmed)) {
    throw new ConfigurationError("reviewer must be 1-200 printable characters");
  }
  return trimmed;
}

/** Drops undefined and null members so optional fields are absent on the wire. */
function compact(body: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined && v !== null));
}

/** A key for a companion request of one logical call (the upload before a job), within the 255-character limit. */
function derivedKey(key: string, purpose: string): string {
  return `${key.slice(0, 240)}:${purpose}`;
}

export async function toBytes(source: UploadSource): Promise<Uint8Array> {
  if (typeof source === "string") return new TextEncoder().encode(source);
  if (source instanceof Uint8Array) return source;
  if (source instanceof ArrayBuffer) return new Uint8Array(source);
  if (typeof Blob !== "undefined" && source instanceof Blob) return new Uint8Array(await source.arrayBuffer());
  throw new ConfigurationError("file must be a Blob/File, Uint8Array, ArrayBuffer or string");
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** 32 hex characters from the CSPRNG; one per creation call unless the caller supplies a key. */
export function newIdempotencyKey(): string {
  return globalThis.crypto.randomUUID().replace(/-/g, "");
}
