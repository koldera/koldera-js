# Changelog

All notable changes are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and the project follows [Semantic Versioning](https://semver.org/) (0.x releases may change the API).

## 0.1.0 - Unreleased

Initial release of `@koldera/sdk` and `@koldera/react`, for koldera-core 0.1.

### `@koldera/sdk`

- Server client `KolderaClient` (`@koldera/sdk/node`): `baseUrl` and `token` options, or `KOLDERA_URL` and
  `KOLDERA_TOKEN` from the environment.
- Browser client `KolderaBrowserClient` (`@koldera/sdk/browser`): takes only a session token (a string or a function)
  minted by your backend; it refuses a server token, never reads the environment and cannot mint sessions.
- `clientSessions.create` on the server client for scoped, short-lived browser sessions.
- PDF jobs (`analyze`, `fix`), HTML to PDF jobs (`generate_analyze`, `generate_fix`), web scans, structured documents
  with a typed document model and image uploads, reading-order evidence and approved corrections.
- `wait` (sent as `Prefer: wait=N`) and `untilFinished` polling on every creation call; `jobs.wait` treats any state
  other than `queued` or `running` as final.
- Open enums: unknown states, kinds, modes and problem codes from a newer koldera-core do not crash the client.
- Typed errors per HTTP status, with the problem `code`, per-problem `errors[]` and `retryAfterSeconds`.
- Idempotency keys on creation calls; network failures are repeated with the same key.
- Artifact downloads verify size and SHA-256 and raise `StorageError` on a mismatch.
- `info()` and `health()`.

### `@koldera/react`

- `KolderaProvider` with a lazily fetched, automatically refreshed session; no publishable key.
- Hooks: `usePdfJob`, `useHtmlToPdfJob`, `useDocumentJob`, `useWebScan`, `useReadingOrder`.
- React 18 and 19.

### Project

- Apache-2.0 licence, CI on Node.js 20, 22 and 24 and on React 18, contract check against koldera-core, licence
  check, secret scan, TypeDoc API reference, and a release workflow with npm trusted publishing and provenance.
