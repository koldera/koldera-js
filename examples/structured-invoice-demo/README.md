# Structured invoice demo (Node.js, TypeScript)

Turns a synthetic invoice, written as a koldera structured document (JSON), into a tagged PDF with `@koldera/sdk`,
prints the PDF/UA-1 machine validation and downloads the PDF with its SHA-256 checked. Structure is declared by the
JSON (headings, table header, caption, language), never guessed. It runs locally and needs no paid or hosted service.

`invoice.json` is synthetic: "Example Co." and "Sample Customer Ltd." are fictional, the amounts are invented and the
only address is `billing@example.com`. Never use real invoices for a demonstration you share. This package is
`private` and is never published.

## Run it

Start koldera-core locally as described in [../node-pdf-demo/README.md](../node-pdf-demo/README.md#1-start-koldera-core-locally),
then from the root of this repository:

```bash
pnpm install --frozen-lockfile
pnpm -r build
export KOLDERA_URL=http://localhost:8080   # and KOLDERA_TOKEN from the start step
pnpm --filter @koldera/example-structured-invoice-demo start
```

The PDF is written to `examples/structured-invoice-demo/out/invoice.pdf`. Another document:
`node examples/structured-invoice-demo/dist/main.js my-document.json demo-out`. The format is described in
koldera-core's `docs/documents.md` and `contracts/document.schema.json`.

## What it prints

From a run against koldera-core built from `main` (the job id differs per run):

```text
== Document job ...: completed
   PDF/UA-1 machine validation: passed
 - MANUAL_REVIEW_REQUIRED (needs human review): automated validation covers machine-verifiable PDF/UA-1 requirements only; ...
== Tagged PDF: out/invoice.pdf (31119 bytes, SHA-256 ..., verified)
== Manual review required: true
== Known limitations (koldera-core with Typst 0.15.1)
 - Row headers ("rowHeaders": true) are tagged as bold data cells (TD), not TH. This demo does not use them.
 - Links in the header and footer render as plain text (billing@example.com in the footer is not clickable).
```

## How to read the result

- A passing machine check covers the machine-verifiable PDF/UA-1 rules only. `manualReviewRequired` is always `true`:
  a person checks that the declared headings, table headers, language and link texts are right. No automated run
  makes a document fully accessible.
- The Typst renderer writes a PDF/UA-1 identifier into the PDFs it generates. That comes from the renderer's own
  checks of the declared structure, not from a human review.
- Known limitations: row headers are tagged TD instead of TH, and links in the header and footer render as plain text.
