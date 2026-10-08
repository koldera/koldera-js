# PDF remediation demo (Node.js, TypeScript)

A small TypeScript program that runs the whole PDF lifecycle against your own koldera-core with `@koldera/sdk`:
analyze a PDF, write a fixed copy, download it with its SHA-256 checked, and print what a person still has to
review. It uses the SDK from this workspace (`workspace:*`), runs locally, and needs no paid or hosted service.

The input `synthetic-report.pdf` is synthetic: one page of invented text ("Example Co." is not a real company),
untagged on purpose and with a non-embedded font, so the check has something to find. Never use real documents for a
demonstration you share. This package is `private` and is never published.

## 1. Start koldera-core locally

koldera-core is not on a public registry. Build the image from a koldera-core checkout (or `docker load` it from your
release bundle), then start one container bound to localhost:

```bash
# in the koldera-core checkout
docker build -f docker/Dockerfile -t koldera-core:dev .

export KOLDERA_TOKEN="$(openssl rand -base64 32)"
docker run -d --name koldera-demo -p 127.0.0.1:8080:8080 -v koldera-demo-data:/data \
  -e KOLDERA_TOKEN -e KOLDERA_PUBLIC_URL=http://localhost:8080 -e KOLDERA_FEATURES=pdf,html,document \
  --cap-drop ALL --security-opt no-new-privileges koldera-core:dev
curl -fsS http://localhost:8080/healthz
```

This is a local demonstration setup, not a production one: plain HTTP on 127.0.0.1, no reverse proxy, no egress proxy,
and web scans switched off. For production use koldera-core's `docker/compose.yaml` (see its `docs/deployment.md`).

## 2. Run the demo

From the root of this repository, with Node.js 20 or later and pnpm 10:

```bash
pnpm install --frozen-lockfile
pnpm -r build
export KOLDERA_URL=http://localhost:8080   # KOLDERA_TOKEN is already set from step 1
pnpm --filter @koldera/example-node-pdf-demo start
```

The fixed copy is written to `examples/node-pdf-demo/out/`. To use another synthetic file:
`node examples/node-pdf-demo/dist/main.js my-synthetic.pdf demo-out`.

## What it prints

Abbreviated output from a run against koldera-core built from `main` (job ids differ per run):

```text
== Analysis (job ...): completed, machine validation failed
   failed rule ISO 14289-1:2014 6.2-1 x1
   failed rule ISO 14289-1:2014 7.1-3 x3
   ...
== Fix (job ...): completed, remediation applied
   before: failed (7 failed rules)
   after:  failed (ISO 14289-1:2014 5-1)
== Repairs applied
 - PDF_STRUCTURE_INFERRED_V1: ... inferred paragraphs 1, headings 1 ...
 - PDF_FONT_EMBEDDING_V1: embedded metric-compatible substitutes for 1 fonts: Helvetica → Liberation Sans Regular
 ...
== Fixed copy: out/synthetic-report.fixed.pdf (12287 bytes, SHA-256 ..., verified)
== Manual review required: true
 - FONT_EMBEDDED_SUBSTITUTE: ...
 - MANUAL_REVIEW_REQUIRED: ...
 - STRUCTURE_INFERRED: ... Check the headings, lists, tables and reading order against the document.
```

## How to read the result

- `manualReviewRequired` is always `true`. Findings with `needsHumanReview` list what a person must check; inferred
  structure, substituted fonts, the language and the title are machine guesses until someone confirms them.
- The fixed copy is **not declared PDF/UA**. koldera-core never writes the PDF/UA-1 identifier (`pdfuaid:part=1`) by
  itself; it is written only through an explicit opt-in after human review, which this demo does not use. So the final
  machine check keeps rule `ISO 14289-1:2014 5-1` (the identifier) as failing, by design.
- A machine check is not an accessibility statement. No automated run makes a document fully accessible.
- Your original file is never modified; the fixed copy is a separate file.
