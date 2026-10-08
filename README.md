# koldera-js

JavaScript and TypeScript SDK for [koldera-core](https://github.com/koldera/koldera-core), the self-hosted service
that checks PDFs against the PDF/UA-1 machine rules, writes fixed copies, renders HTML and structured documents to
tagged PDF, and scans web pages. Node.js, browsers and React.

Everything koldera-core reports is a **machine check**. A person still has to review the result: `job.manualReviewRequired`
is always `true`, and this SDK never turns a passing machine check into a statement that a document is accessible.

Status: early release (0.1). The API may change before 1.0.

## Packages

| Package | What it is |
| --- | --- |
| [`@koldera/sdk`](packages/sdk) | Typed client. `@koldera/sdk/node` for servers (holds your server token, mints browser sessions), `@koldera/sdk/browser` for pages (a short-lived session token only), `@koldera/sdk` for types and errors. |
| [`@koldera/react`](packages/react) | `KolderaProvider` and hooks (`usePdfJob`, `useHtmlToPdfJob`, `useDocumentJob`, `useWebScan`, `useReadingOrder`). React 18 or 19. |

The API reference (TypeDoc) is published to GitHub Pages with each release and built in CI on every pull request
(`pnpm docs:api`).

## Install

```bash
npm install @koldera/sdk                  # server and browser
npm install @koldera/sdk @koldera/react   # React apps (react 18 or 19 is a peer dependency)
```

Node.js 20 or later for the server client. The browser client targets modern browsers (ES2022) and uses only `fetch`.

## Quick start: server (Node.js)

Point the client at your koldera-core instance. `KOLDERA_URL` and `KOLDERA_TOKEN` are read from the environment when
the options are omitted; `baseUrl` and `token` take precedence.

```ts
import { readFile, writeFile } from "node:fs/promises";
import { KolderaClient } from "@koldera/sdk/node";

const koldera = new KolderaClient(); // KOLDERA_URL and KOLDERA_TOKEN

// Upload, create a "fix" job, let the server hold the request for up to 60 s and poll if it is still running.
const job = await koldera.pdf.createJob({
  file: await readFile("report.pdf"),
  fileName: "report.pdf",
  mode: "fix",
  wait: 60,
  untilFinished: true,
});
console.log(job.state, job.remediationStatus, job.manualReviewRequired);

// Findings: machine checks, some flagged for a person.
for (const finding of await koldera.jobs.findings(job.id)) {
  console.log(finding.ruleId, finding.message, finding.needsHumanReview);
}

// The fixed copy. The download verifies size and SHA-256 and throws StorageError on a mismatch.
const artifacts = await koldera.jobs.artifacts(job.id);
const fixed = artifacts.find((artifact) => artifact.kind === "remediated");
if (fixed) {
  await writeFile("report.fixed.pdf", await koldera.artifacts.download(fixed));
}
```

`mode` is `"analyze"` (validate only) or `"fix"` (validate, write a separate repaired copy, validate again).
Your original file is never modified. For HTML the modes are `"generate_analyze"` and `"generate_fix"`
(`koldera.htmlToPdf.createJob`). The deprecated `safe_fix`, `structure_fix` and `generate_safe_fix` are refused locally.

`wait` (1 to 900 seconds) is sent as `Prefer: wait=N`. When the job is still running after the wait, the call returns
the job in its real state; set `untilFinished` to keep polling, or call `koldera.jobs.wait(job.id)` yourself.

Other calls: `koldera.web.createScan({ url })`, `koldera.documents.createJob(document)`, `koldera.jobs.get(id)`,
`koldera.jobs.actions(id)`, `koldera.jobs.getReadingOrder(id)`, `koldera.jobs.remediateReadingOrder(id, approval)`,
`koldera.info()` and `koldera.health()`.

## Quick start: browser

The browser never gets your server token. Your backend authenticates the user, then mints a short-lived session for
one origin with limited scopes and budgets:

```ts
import { createServer } from "node:http";
import { KolderaClient } from "@koldera/sdk/node";

const koldera = new KolderaClient();

createServer(async (_request, response) => {
  // Authenticate your user here before minting anything.
  const session = await koldera.clientSessions.create({
    allowedOrigin: "https://app.example",
    scopes: ["jobs:create", "jobs:read"],
    maxJobs: 5,
    ttlSeconds: 600,
  });
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(session)); // { sessionToken, expiresAt }
}).listen(3000);
```

The page uses `KolderaBrowserClient` with that session. `sessionToken` can be a function, called before each request,
so you can fetch a fresh session when the old one has expired:

```ts
import { KolderaBrowserClient } from "@koldera/sdk/browser";

const koldera = new KolderaBrowserClient({
  baseUrl: "https://koldera.example.com",
  sessionToken: async () => {
    const response = await fetch("/api/koldera-session");
    return ((await response.json()) as { sessionToken: string }).sessionToken;
  },
});

const input = document.querySelector<HTMLInputElement>("input[type=file]")!;
const file = input.files![0]!;
const job = await koldera.pdf.createJob({ file, mode: "analyze", wait: 30, untilFinished: true });
console.log(job.state, job.validation);
```

The browser client rejects a `token` option, never reads the environment and has no session-minting call. Origin and
CORS checks on the server are a second layer, not a secret.

## Quick start: React

```tsx
import { KolderaProvider, usePdfJob, useDocumentJob } from "@koldera/react";
import type { StructuredDocument } from "@koldera/react";

export function App() {
  return (
    <KolderaProvider
      baseUrl="https://koldera.example.com"
      getSessionToken={async () => {
        const response = await fetch("/api/koldera-session");
        return (await response.json()) as { sessionToken: string; expiresAt?: string };
      }}
    >
      <PdfChecker />
      <InvoiceButton />
    </KolderaProvider>
  );
}

function PdfChecker() {
  const { createJob, status, job, findings, error } = usePdfJob();
  return (
    <section>
      <label>
        PDF file
        <input
          type="file"
          accept="application/pdf"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void createJob(file, { mode: "analyze", wait: 30 });
          }}
        />
      </label>
      <p role="status">{status}</p>
      {error && <p role="alert">{error.message}</p>}
      {job && <p>Manual review required: {String(job.manualReviewRequired)}</p>}
      <ul>
        {findings?.map((finding, index) => (
          <li key={index}>
            {finding.ruleId}: {finding.message}
          </li>
        ))}
      </ul>
    </section>
  );
}

const invoice: StructuredDocument = {
  title: "Invoice 2026-0042",
  language: "en",
  body: [
    { type: "heading", level: 1, text: "Invoice 2026-0042" },
    { type: "paragraph", content: ["Thank you for your order."] },
  ],
};

function InvoiceButton() {
  const { createJob, status, loadArtifacts } = useDocumentJob();
  return (
    <div>
      <button
        type="button"
        onClick={async () => {
          const job = await createJob(invoice, { wait: 60 });
          if (job) console.log((await loadArtifacts()).map((artifact) => artifact.kind));
        }}
      >
        Render invoice
      </button>
      <p role="status">{status}</p>
    </div>
  );
}
```

The provider asks your backend for a session lazily, refreshes it about 30 seconds before it expires and once more
when the API answers 401 (the whole call is repeated once, which includes the upload; see the `@koldera/react` README). Hooks poll only unfinished jobs and abort on unmount.

## Structured documents

A structured document is JSON that declares semantic blocks. Structure is declared by you, never inferred. Images are
uploaded first and referenced by `uploadId`, with either `alt` or `decorative: true`.

```ts
import { readFile, writeFile } from "node:fs/promises";
import { KolderaClient, type StructuredDocument } from "@koldera/sdk/node";

const koldera = new KolderaClient();

const logo = await koldera.documents.uploadImage(await readFile("logo.png"), { contentType: "image/png", fileName: "logo.png" });

const document: StructuredDocument = {
  title: "Invoice 2026-0042",
  language: "en",
  page: { size: "A4", margins: "20mm" },
  footer: [{ type: "pageNumber" }],
  body: [
    { type: "heading", level: 1, text: "Invoice 2026-0042" },
    { type: "image", uploadId: logo.uploadId, alt: "Company logo: a blue square with the letters EC" },
    {
      type: "table",
      caption: "Items billed",
      header: [["Description", "Amount"]],
      rows: [["Consulting, 10 hours", "1000.00"]],
      columnAlign: ["left", "right"],
    },
  ],
};

const job = await koldera.documents.createJob(document, { wait: 60, untilFinished: true });
const pdf = (await koldera.jobs.artifacts(job.id)).find((artifact) => artifact.kind === "generated_pdf");
if (pdf) await writeFile("invoice.pdf", await koldera.artifacts.download(pdf));
```

A rejected document raises `ValidationError` whose `errors` list `{ path, code, message }` per problem. The block rules
are in [koldera-core's documents guide](https://github.com/koldera/koldera-core/blob/main/docs/documents.md).

## Errors

Every non-2xx answer becomes a subclass of `ApiError` with the stable problem `code`, `status` and, when the server
sent one, `retryAfterSeconds`. Unknown codes, states and kinds from a newer koldera-core do not crash the client: the
types are open and `jobs.wait` treats any state other than `queued` or `running` as final.

```ts
import { readFile } from "node:fs/promises";
import { KolderaClient, ApiError, RateLimitError, StorageError, TimeoutError, ValidationError } from "@koldera/sdk/node";

const koldera = new KolderaClient();

try {
  await koldera.pdf.createJob({
    file: await readFile("report.pdf"),
    mode: "fix",
    wait: 60,
    untilFinished: { timeoutMs: 120_000 },
  });
} catch (error) {
  if (error instanceof ValidationError) {
    for (const problem of error.errors) console.error(problem.path, problem.code, problem.message);
  } else if (error instanceof RateLimitError) {
    console.error("retry in", error.retryAfterSeconds, "seconds");
  } else if (error instanceof ApiError) {
    console.error(error.status, error.code, error.message);
  } else if (error instanceof TimeoutError) {
    console.error("still running:", error.jobId);
  } else if (error instanceof StorageError) {
    console.error("upload or download failed:", error.message);
  } else {
    throw error;
  }
}
```

The classes are `AuthenticationError` (401), `PermissionError` (403), `NotFoundError` (404), `ConflictError` (409),
`ValidationError` (400, 422), `UnsupportedMediaTypeError` (415), `HostNotAllowedError` (421), `RateLimitError` (429),
`ServiceUnavailableError` (503), `ServerError` (other 5xx), plus `ConfigurationError` (the SDK was used wrongly),
`TimeoutError` and `StorageError`. Error messages never contain a credential.

Creation calls carry an `Idempotency-Key` (generated, or pass `idempotencyKey`). A network failure on a creation call is
repeated up to twice with the same key, so a lost response does not create a second job.

## Configuration

| Option | Server (`KolderaClient`) | Browser (`KolderaBrowserClient`) |
| --- | --- | --- |
| `baseUrl` | origin of koldera-core; env `KOLDERA_URL` | required |
| `token` | server token; env `KOLDERA_TOKEN` | not accepted |
| `sessionToken` | not used | string, or function returning the session token |
| `fetch` | custom `fetch` | custom `fetch` |
| `storageFetch` | `fetch` for signed storage URLs (default: global `fetch`; must not add credentials) | same |
| `timeoutMs` | per-request timeout (default 30 000) | per-request timeout (default 30 000) |
| `storageTimeoutMs` | timeout of a whole upload or download, body included (default 600 000) | same |
| `userAgentSuffix` | appended to the SDK user agent | not sent |

Signed upload and download URLs are always requested with the global `fetch` (or `storageFetch`), never with `fetch`,
without an `Authorization` header, credentials or redirects, so a `fetch` wrapper that adds credentials never sees them.
A download is read up to the artifact's expected size only, and storage errors never contain the signed URL.

Per call: `signal` (an `AbortSignal`), `idempotencyKey`, and on job creation `wait`, `untilFinished` and `onResponse`
(status, `Location`, `Preference-Applied`, `Idempotent-Replayed`).

## Compatibility

| SDK | koldera-core | Node.js | React |
| --- | --- | --- | --- |
| 0.1.x | 0.1.x | 20, 22, 24 | 18, 19 |

The vendored API description in [`contracts/`](contracts) records the koldera-core commit it was taken from
(`contracts/CORE_VERSION`), and CI checks that the copy matches. Run koldera-core as described in its
[README](https://github.com/koldera/koldera-core#readme) and
[deployment guide](https://github.com/koldera/koldera-core/blob/main/docs/deployment.md).

## Examples

Runnable demonstrations against a koldera-core you start locally, with synthetic inputs (not published to npm):

- [examples/node-pdf-demo](examples/node-pdf-demo): analyze a PDF, write a fixed copy, download it, list what needs a person.
- [examples/structured-invoice-demo](examples/structured-invoice-demo): a synthetic invoice as a structured document to a tagged PDF.

## Links

- [koldera-core](https://github.com/koldera/koldera-core): the service, API reference and deployment guide.
- [Contributing](CONTRIBUTING.md), [security policy](SECURITY.md), [changelog](CHANGELOG.md).

## Licence

This SDK is licensed under the [Apache License 2.0](LICENSE).

koldera-core itself is licensed under the AGPL-3.0. Talking to it over HTTP with this SDK does not make your code
AGPL: the SDK is a separate work under Apache-2.0, and a network client of an AGPL server is not a derivative of it.
If you modify koldera-core and offer the modified version as a service, the AGPL applies to those modifications; see
koldera-core's licence pages for details and for the commercial option. This is our reading of the licence, not legal
advice.
