# @koldera/sdk

JavaScript and TypeScript client for [koldera-core](https://github.com/koldera/koldera-core): PDF/UA-1 machine checks
and fixed copies, HTML and structured documents to tagged PDF, web scans. Results are machine checks; a person still
reviews them.

```bash
npm install @koldera/sdk
```

```ts
import { KolderaClient } from "@koldera/sdk/node";

const koldera = new KolderaClient(); // KOLDERA_URL and KOLDERA_TOKEN
const info = await koldera.info();
console.log(info.features);
```

Entry points: `@koldera/sdk/node` (servers), `@koldera/sdk/browser` (pages, session token only), `@koldera/sdk`
(types and errors). Node.js 20 or later.

Full guide, browser and React usage, errors and configuration: see the [repository README](https://github.com/koldera/koldera-js#readme).
Apache-2.0.
