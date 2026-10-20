# Golden HTTP fixtures for the koldera-core API

One JSON file per case, re-authored for koldera-core (`openapi.yaml`, commit in `../CORE_VERSION`). Every SDK test
suite replays every case that applies to its surface. The shape is the one of the earlier platform fixtures
(`name`, `operationId`, `auth`, `request`, `response`, `notes`), so the existing replay harnesses keep working.

## Format

* `name` — equals the file name without `.json`; unique.
* `operationId` — an operation of `openapi.yaml` (always set, also for the two signed-URL transfers).
* `auth` — `server` (server token), `session` (client-session token) or `none` (no credential at all, `/healthz`).
* `request` — `method`; `path` relative to the base URL, including the query (`exp`, `sig`) of signed URLs;
  `headers` that must be present with these values; optional `forbiddenHeaders` that must be absent; the exact JSON
  `body`, or `rawBody` (bytes as a latin1 string) with its `sha256`.
* `response` — `status`, `headers`, and the JSON `body` or `rawBody` (+ `sha256`). The SDK must expose the parsed result
  or map the problem (`status` + `code`) to its typed error class.
* `notes` — what the case pins down.

Placeholders (replace before comparing): `{{baseUrl}}` (mock server origin), `{{secretKey}}` (server token; use
`test-server-token`), `{{sessionToken}}` (a fake token shaped like core's `v1.<b64url>.<b64url>`),
`{{idempotencyKey}}` (any 1-255 printable ASCII characters; the SDK generates one per creation call).

Signed URLs: `uploadUrl` and `downloadUrl` are absolute (`{{baseUrl}}/v1/uploads/{id}/content?exp=..&sig=..`). The signed
PUT/GET never carry the bearer token (`forbiddenHeaders: ["Authorization"]`).

All values are synthetic: placeholder UUIDs, `example.com` / `.invalid` hosts, fake tokens and signatures.

## Behaviour pinned by the fixtures

* `202` carries `Location: /v1/jobs/{id}`. With `Prefer: wait=N` the server answers `200` (finished) or `202` (still running),
  both with `Preference-Applied: wait=N`. A replayed idempotent request adds `Idempotent-Replayed: true`.
* A queued or running job read answers `200` with `Retry-After` (whole seconds); a failed job is still `200`.
* `503 QUEUE_FULL` carries `Retry-After`. `429 SESSION_JOB_LIMIT` / `SESSION_UPLOAD_LIMIT` carry **no** `Retry-After` in core.
* `422 VALIDATION_ERROR` for a structured document carries `errors[]` (`path` JSON Pointer, `code`, `message`).
* `validation.status` `declaration_withheld` (PDF fix and document jobs): the only failing check is the missing PDF/UA
  identifier (veraPDF `5-1`, still in `failedRules`), withheld because declaring PDF/UA requires a human review. It is
  not a pass; an SDK must never report it as passed. An unknown status is no verdict.
* `421 HOST_NOT_ALLOWED` comes from a host filter in front of every route; `openapi.yaml` does not list it per operation.

## Validation

`node validate-golden.mjs [dir]` checks every fixture against `openapi.yaml`: operation, method, path template, path and
query parameters, request and response bodies (ajv, JSON Schema 2020-12), declared status and content type, problem shape
and `status`/`code`, document bodies also against `document.schema.json`, the header rules above, and sha256 /
Content-Length of raw bodies. `pnpm test` runs the validator's own tests.

## Fixtures

### listActions

- `actions`: GET /v1/jobs/{id}/actions -> 200

### downloadArtifact

- `artifact-download-not-found`: GET /v1/artifacts/{id}/content -> 404 NOT_FOUND
- `artifact-download-original`: GET /v1/artifacts/{id}/content -> 200
- `artifact-download-remediated`: GET /v1/artifacts/{id}/content -> 200
- `artifact-download-signature-invalid`: GET /v1/artifacts/{id}/content -> 403 SIGNATURE_INVALID

### listArtifacts

- `artifacts-empty`: GET /v1/jobs/{id}/artifacts -> 200
- `artifacts`: GET /v1/jobs/{id}/artifacts -> 200

### createClientSession

- `client-session-defaults`: POST /v1/client-sessions -> 201
- `client-session-forbidden`: POST /v1/client-sessions -> 403 FORBIDDEN
- `client-session-invalid`: POST /v1/client-sessions -> 422 VALIDATION_ERROR
- `client-session-unsupported-media-type`: POST /v1/client-sessions -> 415 UNSUPPORTED_MEDIA_TYPE
- `client-session`: POST /v1/client-sessions -> 201

### createDocumentJob

- `document-job-accepted`: POST /v1/documents/jobs -> 202
- `document-job-image-upload-invalid`: POST /v1/documents/jobs -> 422 VALIDATION_ERROR
- `document-job-prefer-wait-finished`: POST /v1/documents/jobs -> 200
- `document-job-validation-errors`: POST /v1/documents/jobs -> 422 VALIDATION_ERROR

### listFindings

- `findings`: GET /v1/jobs/{id}/findings -> 200

### getHealth

- `healthz`: GET /healthz -> 200

### createHtmlToPdfJob

- `html-job-accepted`: POST /v1/html-to-pdf/jobs -> 202
- `html-job-analyze`: POST /v1/html-to-pdf/jobs -> 202

### getInfo

- `info-session`: GET /v1/info -> 200
- `info`: GET /v1/info -> 200

### getJob

- `job-completed-document-declaration-withheld`: GET /v1/jobs/{id} -> 200
- `job-completed-fix-declaration-withheld`: GET /v1/jobs/{id} -> 200
- `job-completed-fix`: GET /v1/jobs/{id} -> 200
- `job-completed-session`: GET /v1/jobs/{id} -> 200
- `job-completed`: GET /v1/jobs/{id} -> 200
- `job-failed`: GET /v1/jobs/{id} -> 200
- `job-insufficient-scope`: GET /v1/jobs/{id} -> 403 INSUFFICIENT_SCOPE
- `job-not-found`: GET /v1/jobs/{id} -> 404 NOT_FOUND
- `job-queued-retry-after`: GET /v1/jobs/{id} -> 200
- `job-running`: GET /v1/jobs/{id} -> 200
- `job-unauthorized`: GET /v1/jobs/{id} -> 401 UNAUTHORIZED

### createPdfJob

- `pdf-job-accepted-fix`: POST /v1/pdf/jobs -> 202
- `pdf-job-accepted`: POST /v1/pdf/jobs -> 202
- `pdf-job-feature-off`: POST /v1/pdf/jobs -> 404 NOT_FOUND
- `pdf-job-idempotency-key-reused`: POST /v1/pdf/jobs -> 409 IDEMPOTENCY_KEY_REUSED
- `pdf-job-idempotent-replay`: POST /v1/pdf/jobs -> 202
- `pdf-job-insufficient-scope`: POST /v1/pdf/jobs -> 403 INSUFFICIENT_SCOPE
- `pdf-job-invalid-json`: POST /v1/pdf/jobs -> 400 INVALID_JSON
- `pdf-job-prefer-wait-finished`: POST /v1/pdf/jobs -> 200
- `pdf-job-prefer-wait-timeout`: POST /v1/pdf/jobs -> 202
- `pdf-job-queue-full`: POST /v1/pdf/jobs -> 503 QUEUE_FULL
- `pdf-job-session-job-limit`: POST /v1/pdf/jobs -> 429 SESSION_JOB_LIMIT
- `pdf-job-session`: POST /v1/pdf/jobs -> 202
- `pdf-job-unauthorized`: POST /v1/pdf/jobs -> 401 UNAUTHORIZED
- `pdf-job-unsupported-input`: POST /v1/pdf/jobs -> 415 UNSUPPORTED_INPUT
- `pdf-job-validation-error`: POST /v1/pdf/jobs -> 422 VALIDATION_ERROR

### getReadingOrder

- `reading-order-not-found`: GET /v1/jobs/{id}/reading-order -> 404 NOT_FOUND
- `reading-order`: GET /v1/jobs/{id}/reading-order -> 200

### createReadingOrderRemediation

- `remediation-accepted`: POST /v1/jobs/{id}/reading-order/remediations -> 202
- `remediation-artifact-expired`: POST /v1/jobs/{id}/reading-order/remediations -> 409 ARTIFACT_EXPIRED
- `remediation-stale`: POST /v1/jobs/{id}/reading-order/remediations -> 409 STALE_READING_ORDER_SNAPSHOT
- `remediation-unsupported`: POST /v1/jobs/{id}/reading-order/remediations -> 422 ORDER_FIX_UNSUPPORTED
- `remediation-without-reviewer`: POST /v1/jobs/{id}/reading-order/remediations -> 200

### putUploadContent

- `upload-put-already-completed`: PUT /v1/uploads/{id}/content -> 409 UPLOAD_ALREADY_COMPLETED
- `upload-put-checksum-mismatch`: PUT /v1/uploads/{id}/content -> 422 CHECKSUM_MISMATCH
- `upload-put-expired`: PUT /v1/uploads/{id}/content -> 410 UPLOAD_EXPIRED
- `upload-put-html`: PUT /v1/uploads/{id}/content -> 204
- `upload-put-image-png`: PUT /v1/uploads/{id}/content -> 204
- `upload-put-pdf`: PUT /v1/uploads/{id}/content -> 204
- `upload-put-signature-invalid`: PUT /v1/uploads/{id}/content -> 403 SIGNATURE_INVALID

### createUpload

- `upload-ticket-html`: POST /v1/uploads -> 201
- `upload-ticket-image-png`: POST /v1/uploads -> 201
- `upload-ticket-pdf`: POST /v1/uploads -> 201
- `upload-ticket-session-limit`: POST /v1/uploads -> 429 SESSION_UPLOAD_LIMIT
- `upload-ticket-session`: POST /v1/uploads -> 201
- `upload-ticket-too-large`: POST /v1/uploads -> 422 FILE_TOO_LARGE

### createWebJob

- `web-job-accepted`: POST /v1/web/jobs -> 202
- `web-job-host-not-allowed`: POST /v1/web/jobs -> 421 HOST_NOT_ALLOWED
- `web-job-url-rejected`: POST /v1/web/jobs -> 422 VALIDATION_ERROR

