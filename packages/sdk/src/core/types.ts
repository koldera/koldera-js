/** Wire shapes of the koldera-core API (camelCase as on the wire). */

/** A known value for editor completion, or any string a newer core may send; unknown values are never rejected. */
export type Open<T extends string> = T | (string & {});

export type JobKind = Open<"pdf" | "html_to_pdf" | "document_to_pdf" | "web" | "order_pdf" | "order_html">;
export type JobState = Open<"queued" | "running" | "completed" | "failed">;
export type JobMode = Open<"analyze" | "fix" | "generate_analyze" | "generate_fix" | "scan" | "reorder">;
export type RemediationStatus = Open<"not_requested" | "no_applicable_fix" | "applied" | "skipped" | "rolled_back">;

/** `analyze` validates only; `fix` also writes a repaired copy as a separate `remediated` artifact. The original is never modified. */
export type PdfMode = "analyze" | "fix";
/** `generate_analyze` validates the generated PDF; `generate_fix` also repairs it. */
export type HtmlToPdfMode = "generate_analyze" | "generate_fix";

export interface FailedRule {
  ruleId: string;
  count: number;
}

export interface MachineValidation {
  profile: string;
  status: Open<"passed" | "failed" | "error" | "not_run">;
  failedRules: FailedRule[];
}

/** Why a job failed (for example `WORKER_TIMEOUT`, `INVALID_INPUT`). Not a problem code. */
export interface JobError {
  code: string;
  message: string;
}

/** One repair rule's outcome on a `fix` job, from `jobs.actions`. */
export interface RemediationAction {
  ruleId: string;
  outcome: Open<"applied" | "skipped" | "failed" | "rolled_back">;
  reason: string;
  before?: string | null;
  after?: string | null;
}

/**
 * A job as the API reports it. `state` is execution state only; `validation` is the machine check and
 * `manualReviewRequired` stays true: nothing here states conformance.
 */
export interface Job {
  id: string;
  kind: JobKind;
  mode: JobMode | null;
  state: JobState;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  validation: MachineValidation | null;
  baselineValidation: MachineValidation | null;
  finalValidation: MachineValidation | null;
  remediationStatus: RemediationStatus | null;
  manualReviewRequired: boolean;
  engineVersion: string | null;
  error: JobError | null;
  /** Web jobs only, without query or fragment. */
  targetUrl: string | null;
  /** HTML jobs: the CSS selector that was printed instead of the whole document. */
  contentSelector?: string | null;
}

export interface Finding {
  source: Open<"pdf" | "html" | "web">;
  ruleId: string;
  message: string;
  pageNumber?: number | null;
  selector?: string | null;
  needsHumanReview: boolean;
  /** Set only on machine checks of a job whose fix was applied. */
  resolution?: Open<"fixed_in_copy" | "still_failing"> | null;
}

export type ArtifactKind = Open<"original" | "remediated" | "baseline_report" | "final_report" | "generated_pdf" | "source_html" | "web_report" | "reordered">;

export interface Artifact {
  id: string;
  kind: ArtifactKind;
  sha256: string;
  sizeBytes: number;
  /** Short-lived signed URL; fetched without any bearer token. */
  downloadUrl: string;
  expiresAt: string;
}

export interface UploadTicket {
  uploadId: string;
  method: "PUT";
  uploadUrl: string;
  expiresAt: string;
  /** The configured size limit for this content type, if any. */
  maxBytes?: number | null;
}

export type ImageContentType = "image/png" | "image/jpeg" | "image/svg+xml";
export type UploadContentType = "application/pdf" | "text/html" | ImageContentType;

export interface ReadingOrderNode {
  nodeId: string;
  parentId?: string | null;
  role: string;
  logicalIndex: number;
  pageNumber?: number | null;
  origin: Open<"pdf_structure" | "html_dom">;
  textPreview?: string | null;
  boundingBox?: Record<string, unknown> | null;
}

/** Evidence bound to one artifact hash. `reviewRequired` is always true; it is never a verdict. */
export interface ReadingOrderSnapshot {
  jobId: string;
  sourceArtifactSha256: string;
  snapshotVersion: number;
  nodes: ReadingOrderNode[];
  reviewRequired: boolean;
  readingOrderReview: Open<"needs_review">;
  focusOrderReview: Open<"needs_review" | "not_run">;
  focusOrderNodeIds: string[];
  visualOrderCandidateNodeIds: string[];
  artifactHashes: Record<string, string>;
}

export type RemediationTarget = "source_html" | "pdf_tags";

/** What a person approved: the complete children of one parent, in the new order. */
export interface ReadingOrderRemediation {
  baseArtifactSha256: string;
  snapshotVersion: number;
  target: RemediationTarget;
  orderedNodeIds: string[];
  /** Must be literally `true`: a person checked the sequence against the content. */
  acknowledged: true;
  /** Audit label asserted by the caller, not authenticated (1-200 characters). */
  reviewer?: string;
}

export type SessionScope = "jobs:create" | "jobs:read";

export interface ClientSessionRequest {
  /** Absolute http(s) origin without a path, for example `https://app.example`. */
  allowedOrigin: string;
  /** Default is both scopes. */
  scopes?: SessionScope[];
  /** 1-1000, default 10. */
  maxJobs?: number;
  /** 1-10000, default ten per job. */
  maxUploads?: number;
  /** 1-3600, default 900. */
  ttlSeconds?: number;
}

export interface ClientSession {
  sessionToken: string;
  expiresAt: string;
}

export type FeatureName = Open<"document" | "html" | "pdf" | "web">;

export interface Info {
  version?: string | null;
  engineVersion?: string | null;
  features: FeatureName[];
}

export interface Health {
  status: string;
}

/** One problem of a structured document (`path` is a JSON Pointer). */
export interface ProblemError {
  path: string;
  code: Open<
    | "SCHEMA"
    | "IMAGE_ALT_MISSING"
    | "HEADING_LEVEL_SKIPPED"
    | "TABLE_HEADER_EMPTY"
    | "TABLE_ROW_LENGTH_MISMATCH"
    | "LINK_TEXT_EMPTY"
    | "FONT_UNKNOWN"
    | "LANGUAGE_INVALID"
    | "FILE_IMAGE_NOT_ALLOWED"
    | "IMAGE_UPLOAD_INVALID"
  >;
  message: string;
}

export interface Problem {
  type: string;
  title: string;
  status: number;
  code: string;
  detail?: string;
  errors?: ProblemError[];
}

/** Response metadata of a call, for callers that need more than the parsed body. */
export interface ResponseMeta {
  status: number;
  /** Where to poll the job, as sent. */
  location: string | undefined;
  /** `wait=N` when the server held the request. */
  preferenceApplied: string | undefined;
  /** True when the stored answer of an earlier request was replayed. */
  idempotentReplayed: boolean;
}

/** Common options of every call. */
export interface RequestOptions {
  signal?: AbortSignal;
  /** Overrides the generated Idempotency-Key on creation calls (1-255 printable ASCII characters). */
  idempotencyKey?: string;
  onResponse?: (meta: ResponseMeta) => void;
}

export interface WaitOptions {
  signal?: AbortSignal;
  /** Give up after this many milliseconds (default 10 minutes); throws TimeoutError. */
  timeoutMs?: number;
  /** First delay when the API sends no Retry-After (default 1000 ms); doubles up to 10 s. */
  initialDelayMs?: number;
  /** Called after every poll with the latest job. */
  onUpdate?: (job: Job) => void;
}

/** Options of every call that creates a job. */
export interface CreateOptions extends RequestOptions {
  /**
   * Ask the server to hold the request for up to this many seconds (1-900, sent as `Prefer: wait=N`).
   * A finished job comes back as it is; a job still running after the wait comes back with its current
   * state, so check `job.state` or set `untilFinished`.
   */
  wait?: number;
  /** When the returned job is not finished yet, keep polling until it is (see `jobs.wait`). */
  untilFinished?: boolean | Pick<WaitOptions, "timeoutMs" | "initialDelayMs" | "onUpdate">;
}
