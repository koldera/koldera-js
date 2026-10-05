# @koldera/react

React provider and hooks for [koldera-core](https://github.com/koldera/koldera-core), built on
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

Examples for every hook, errors and configuration: see the [repository README](https://github.com/koldera/koldera-js#readme).
Apache-2.0.
