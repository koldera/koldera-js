"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  AuthenticationError,
  ConfigurationError,
  isFinished,
  KolderaBrowserClient,
  type Artifact,
  type Finding,
  type HtmlToPdfMode,
  type ImageContentType,
  type Job,
  type PdfMode,
  type ReadingOrderRemediation,
  type ReadingOrderSnapshot,
  type StructuredDocument,
  type UploadSource,
} from "@koldera/sdk/browser";

export type {
  Artifact,
  Finding,
  Job,
  JobState,
  MachineValidation,
  ReadingOrderNode,
  ReadingOrderRemediation,
  ReadingOrderSnapshot,
  StructuredDocument,
} from "@koldera/sdk/browser";
export {
  ApiError,
  AuthenticationError,
  ConfigurationError,
  ConflictError,
  HostNotAllowedError,
  NotFoundError,
  PermissionError,
  RateLimitError,
  ServerError,
  ServiceUnavailableError,
  StorageError,
  TimeoutError,
  UnsupportedMediaTypeError,
  ValidationError,
} from "@koldera/sdk/browser";

/** What your backend hands the browser after it authenticated the user and minted a client session. */
export interface SessionGrant {
  sessionToken: string;
  /** ISO timestamp; the provider refreshes about 30 s before it. */
  expiresAt?: string;
}

export interface KolderaProviderProps {
  /** API origin of your koldera-core server. */
  baseUrl: string;
  /**
   * Asks YOUR backend for a fresh session. Called lazily before the first request, again when a session
   * expires or the API answers 401. Never return a server token.
   */
  getSessionToken: () => Promise<SessionGrant | string>;
  children: ReactNode;
  /** Test seam. */
  fetch?: typeof fetch;
}

interface ProviderValue {
  client: KolderaBrowserClient;
  /** Runs an SDK call; on a 401 the cached session is dropped and the call retried once with a fresh one. */
  run: <T>(call: (client: KolderaBrowserClient) => Promise<T>) => Promise<T>;
}

const Context = createContext<ProviderValue | null>(null);

/** Wraps the browser SDK: one client, one lazily minted session, transparent refresh. */
export function KolderaProvider({ baseUrl, getSessionToken, children, fetch: fetchImpl }: KolderaProviderProps) {
  const cache = useRef<{ token: string; expiresAtMs: number | null } | null>(null);
  const inflight = useRef<Promise<string> | null>(null);
  const getToken = useRef(getSessionToken);
  getToken.current = getSessionToken;

  const value = useMemo<ProviderValue>(() => {
    const currentToken = async (): Promise<string> => {
      const cached = cache.current;
      if (cached && (cached.expiresAtMs === null || cached.expiresAtMs - 30_000 > Date.now())) {
        return cached.token;
      }
      inflight.current ??= (async () => {
        try {
          const grant = await getToken.current();
          const token = typeof grant === "string" ? grant : grant?.sessionToken;
          if (typeof token !== "string" || token.trim().length === 0) {
            throw new ConfigurationError("getSessionToken must return a session token minted by your backend");
          }
          const expiresAt = typeof grant === "string" ? undefined : grant.expiresAt;
          cache.current = { token, expiresAtMs: expiresAt ? Date.parse(expiresAt) : null };
          return token;
        } finally {
          inflight.current = null;
        }
      })();
      return inflight.current;
    };
    const client = new KolderaBrowserClient({ baseUrl, sessionToken: currentToken, fetch: fetchImpl });
    const run = async <T,>(call: (c: KolderaBrowserClient) => Promise<T>): Promise<T> => {
      try {
        return await call(client);
      } catch (error) {
        if (error instanceof AuthenticationError && cache.current !== null) {
          cache.current = null;
          return await call(client);
        }
        throw error;
      }
    };
    return { client, run };
  }, [baseUrl, fetchImpl]);

  return <Context.Provider value={value}>{children}</Context.Provider>;
}

function useProvider(): ProviderValue {
  const value = useContext(Context);
  if (!value) {
    throw new ConfigurationError("wrap your component tree in <KolderaProvider>");
  }
  return value;
}

export type JobStatus = "idle" | "uploading" | "queued" | "running" | "completed" | "failed" | "cancelled" | "error";

export interface JobHandle {
  /**
   * `idle`, `uploading`, `queued`, `running`, then `completed` or `failed` (the job's own outcome; any other
   * final state counts as `failed`), `error` (a request failed) or `cancelled` (you cancelled).
   */
  status: JobStatus;
  job: Job | null;
  error: Error | null;
  /** Loaded once the job has finished (findings of a failed job are loaded too). */
  findings: Finding[] | null;
  /** Aborts the upload or the polling; a job the server already accepted keeps running. */
  cancel: () => void;
  reset: () => void;
  /** Lists fresh download links (call when the user asks; they expire). */
  loadArtifacts: () => Promise<Artifact[]>;
}

/** Options shared by every `createJob`: `wait` asks the server to hold the request (1-900 s) so a quick job needs no polling. */
export interface CreateJobOptions {
  wait?: number;
}

export interface PdfJobHandle extends JobHandle {
  createJob: (file: File | Blob | UploadSource, options: CreateJobOptions & { mode: PdfMode; explicitLanguage?: string | null; explicitTitle?: string | null; fileName?: string }) => Promise<Job | null>;
}

export interface HtmlToPdfJobHandle extends JobHandle {
  createJob: (
    file: File | Blob | UploadSource,
    options: CreateJobOptions & { mode: HtmlToPdfMode; explicitLanguage?: string | null; explicitTitle?: string | null; contentSelector?: string | null; fileName?: string },
  ) => Promise<Job | null>;
}

export interface DocumentJobHandle extends JobHandle {
  createJob: (document: StructuredDocument, options?: CreateJobOptions) => Promise<Job | null>;
  /** Uploads one image for an `image` block and returns its `uploadId`. */
  uploadImage: (image: File | Blob | UploadSource, options?: { contentType?: ImageContentType; fileName?: string }) => Promise<string>;
}

export interface WebScanHandle extends JobHandle {
  createScan: (url: string, options?: CreateJobOptions) => Promise<Job | null>;
}

type Create = (client: KolderaBrowserClient, signal: AbortSignal) => Promise<Job>;

/** Shared job lifecycle: create, poll, findings, with cancel on unmount. */
function useJobLifecycle(): JobHandle & { start: (create: Create) => Promise<Job | null>; run: ProviderValue["run"] } {
  const { run } = useProvider();
  const [status, setStatus] = useState<JobStatus>("idle");
  const [job, setJob] = useState<Job | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [findings, setFindings] = useState<Finding[] | null>(null);
  const controller = useRef<AbortController | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      controller.current?.abort(new DOMException("component unmounted", "AbortError"));
    };
  }, []);

  const cancel = useCallback(() => {
    controller.current?.abort(new DOMException("cancelled", "AbortError"));
    controller.current = null;
    if (mounted.current) setStatus("cancelled");
  }, []);

  const reset = useCallback(() => {
    controller.current?.abort(new DOMException("reset", "AbortError"));
    controller.current = null;
    setStatus("idle");
    setJob(null);
    setError(null);
    setFindings(null);
  }, []);

  const start = useCallback(
    async (create: Create): Promise<Job | null> => {
      controller.current?.abort(new DOMException("superseded", "AbortError"));
      const own = new AbortController();
      controller.current = own;
      setStatus("uploading");
      setError(null);
      setJob(null);
      setFindings(null);
      try {
        const accepted = await run((client) => create(client, own.signal));
        if (own.signal.aborted) return null;
        setJob(accepted);
        setStatus(statusOf(accepted));
        // A wait on the server may already have produced the final job; only an unfinished one is polled.
        const done = isFinished(accepted)
          ? accepted
          : await run((client) =>
              client.jobs.wait(accepted.id, {
                signal: own.signal,
                onUpdate: (latest) => {
                  if (!own.signal.aborted && mounted.current) {
                    setJob(latest);
                    setStatus(statusOf(latest));
                  }
                },
              }),
            );
        if (own.signal.aborted) return null;
        const list = await run((client) => client.jobs.findings(done.id, { signal: own.signal }));
        if (own.signal.aborted) return null;
        setFindings(list);
        setJob(done);
        setStatus(statusOf(done));
        return done;
      } catch (e) {
        if (own.signal.aborted || (e instanceof DOMException && e.name === "AbortError")) {
          if (mounted.current) setStatus("cancelled");
          return null;
        }
        if (mounted.current) {
          setError(e instanceof Error ? e : new Error(String(e)));
          setStatus("error");
        }
        return null;
      } finally {
        if (controller.current === own) controller.current = null;
      }
    },
    [run],
  );

  const loadArtifacts = useCallback(async (): Promise<Artifact[]> => {
    if (!job) throw new ConfigurationError("no job yet");
    return run((client) => client.jobs.artifacts(job.id));
  }, [job, run]);

  return { status, job, error, findings, cancel, reset, loadArtifacts, start, run };
}

function statusOf(job: Job): JobStatus {
  if (job.state === "queued") return "queued";
  if (job.state === "running") return "running";
  return job.state === "completed" ? "completed" : "failed";
}

function fileNameOf(file: unknown, given: string | undefined): string | undefined {
  return given ?? (typeof File !== "undefined" && file instanceof File ? file.name : undefined);
}

/** Upload a PDF and follow it to completion. */
export function usePdfJob(): PdfJobHandle {
  const { start, run: _run, ...rest } = useJobLifecycle();
  const createJob = useCallback<PdfJobHandle["createJob"]>(
    (file, { fileName, ...options }) => start((client, signal) => client.pdf.createJob({ ...options, file, fileName: fileNameOf(file, fileName), signal })),
    [start],
  );
  return { ...rest, createJob };
}

/** Upload one self-contained static HTML file and follow the render, inspect and validate job. */
export function useHtmlToPdfJob(): HtmlToPdfJobHandle {
  const { start, run: _run, ...rest } = useJobLifecycle();
  const createJob = useCallback<HtmlToPdfJobHandle["createJob"]>(
    (file, { fileName, ...options }) => start((client, signal) => client.htmlToPdf.createJob({ ...options, file, fileName: fileNameOf(file, fileName), signal })),
    [start],
  );
  return { ...rest, createJob };
}

/** Render a structured document to a tagged PDF and follow the job. */
export function useDocumentJob(): DocumentJobHandle {
  const { start, run, ...rest } = useJobLifecycle();
  const createJob = useCallback<DocumentJobHandle["createJob"]>((document, options = {}) => start((client, signal) => client.documents.createJob(document, { ...options, signal })), [start]);
  const uploadImage = useCallback<DocumentJobHandle["uploadImage"]>(async (image, options = {}) => (await run((client) => client.documents.uploadImage(image, options))).uploadId, [run]);
  return { ...rest, createJob, uploadImage };
}

/** Queue a scan of one public URL and follow it. */
export function useWebScan(): WebScanHandle {
  const { start, run: _run, ...rest } = useJobLifecycle();
  const createScan = useCallback<WebScanHandle["createScan"]>((url, options = {}) => start((client, signal) => client.web.createScan({ ...options, url, signal })), [start]);
  return { ...rest, createScan };
}

export interface ReadingOrderHandle {
  snapshot: ReadingOrderSnapshot | null;
  loading: boolean;
  error: Error | null;
  reload: () => Promise<void>;
  /** Queue a correction a person approved. Returns the correction job; `wait` holds the request on the server. */
  remediate: (approval: ReadingOrderRemediation, options?: CreateJobOptions) => Promise<Job>;
}

/** Evidence for one job; `snapshot.reviewRequired` is always true and nothing here is a verdict. */
export function useReadingOrder(jobId: string | null): ReadingOrderHandle {
  const { run } = useProvider();
  const [snapshot, setSnapshot] = useState<ReadingOrderSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const controller = useRef<AbortController | null>(null);

  const reload = useCallback(async () => {
    controller.current?.abort();
    if (!jobId) {
      setSnapshot(null);
      return;
    }
    const own = new AbortController();
    controller.current = own;
    setLoading(true);
    setError(null);
    try {
      const value = await run((client) => client.jobs.getReadingOrder(jobId, { signal: own.signal }));
      if (!own.signal.aborted) setSnapshot(value);
    } catch (e) {
      if (!own.signal.aborted) setError(e instanceof Error ? e : new Error(String(e)));
    } finally {
      if (!own.signal.aborted) setLoading(false);
    }
  }, [jobId, run]);

  useEffect(() => {
    void reload();
    return () => controller.current?.abort();
  }, [reload]);

  const remediate = useCallback(
    async (approval: ReadingOrderRemediation, options: CreateJobOptions = {}): Promise<Job> => {
      if (!jobId) throw new ConfigurationError("no job selected");
      return run((client) => client.jobs.remediateReadingOrder(jobId, approval, options));
    },
    [jobId, run],
  );

  return { snapshot, loading, error, reload, remediate };
}
