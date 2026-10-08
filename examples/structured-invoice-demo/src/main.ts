import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { StructuredDocument } from "@koldera/sdk";
import { KolderaClient } from "@koldera/sdk/node";

// Structured document demo: a synthetic invoice as JSON becomes a tagged PDF; structure is declared, never guessed.
// Needs a running koldera-core: KOLDERA_URL and KOLDERA_TOKEN in the environment (see README.md).
const input = process.argv[2] ?? fileURLToPath(new URL("../invoice.json", import.meta.url));
const outputDir = process.argv[3] ?? "out";

const koldera = new KolderaClient();
const invoice = JSON.parse(await readFile(input, "utf8")) as StructuredDocument;
console.log(`Input: ${input} ("${invoice.title}", ${invoice.body.length} blocks)`);

const job = await koldera.documents.createJob(invoice, { wait: 120, untilFinished: true });
console.log(`\n== Document job ${job.id}: ${job.state}`);
if (job.state === "failed") {
  console.log(`   job failed: ${job.error?.code} ${job.error?.message}`);
  process.exit(3);
}
console.log(`   PDF/UA-1 machine validation: ${job.validation?.status}`);
for (const rule of job.validation?.failedRules ?? []) console.log(`   failed rule ${rule.ruleId} x${rule.count}`);
for (const finding of await koldera.jobs.findings(job.id)) {
  console.log(` - ${finding.ruleId}${finding.needsHumanReview ? " (needs human review)" : ""}: ${finding.message}`);
}

// The SDK checks size and SHA-256 of the download and throws StorageError on a mismatch.
const pdf = (await koldera.jobs.artifacts(job.id)).find((artifact) => artifact.kind === "generated_pdf");
if (pdf) {
  await mkdir(outputDir, { recursive: true });
  const target = path.join(outputDir, `${path.parse(input).name}.pdf`);
  await writeFile(target, await koldera.artifacts.download(pdf));
  console.log(`\n== Tagged PDF: ${target} (${pdf.sizeBytes} bytes, SHA-256 ${pdf.sha256}, verified)`);
}

console.log(`
== Manual review required: ${job.manualReviewRequired}
Headings, table headers, the language and descriptions are what the JSON declares; a person still checks that they
are right. A passing machine check is not an accessibility statement and does not make the invoice fully accessible.
The Typst renderer itself writes a PDF/UA-1 identifier into generated PDFs; that is a property of the renderer's
output, not the result of a human review.

== Known limitations (koldera-core with Typst 0.15.1)
 - Row headers ("rowHeaders": true) are tagged as bold data cells (TD), not TH. This demo does not use them.
 - Links in the header and footer render as plain text (billing@example.com in the footer is not clickable).`);
