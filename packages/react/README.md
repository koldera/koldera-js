# @koldera/react

React provider and hooks for koldera-core, built on
[`@koldera/sdk`](https://www.npmjs.com/package/@koldera/sdk). Your backend mints a short-lived session; the browser
never sees a server token.

```bash
npm install @koldera/sdk @koldera/react
```

```tsx
import { KolderaProvider } from "@koldera/react";
import type { ReactNode } from "react";

export function Providers({ children }: { children: ReactNode }) {
  return (
    <KolderaProvider
      baseUrl="https://koldera.example.com"
      getSessionToken={async () => (await fetch("/api/koldera-session")).json()}
    >
      {children}
    </KolderaProvider>
  );
}
```

Hooks: `usePdfJob`, `useHtmlToPdfJob`, `useDocumentJob`, `useWebScan`, `useReadingOrder`. React 18 or 19.

When the API answers 401 the provider drops the cached session and repeats the whole call once with a fresh one. For
`usePdfJob` and `useHtmlToPdfJob` that repeats the upload too (a new idempotency key, so a second upload counts against
the session's upload budget); the first upload is left unused. Mint sessions that outlast an upload to avoid it.

Signed upload and download URLs are fetched with the global `fetch`, never with the provider's `fetch` prop, and
without credentials. `storageFetch` replaces that fetch (it must not add credentials).

Examples for every hook, errors and configuration: see the [repository README](https://github.com/koldera/koldera-js#readme).
Apache-2.0.
