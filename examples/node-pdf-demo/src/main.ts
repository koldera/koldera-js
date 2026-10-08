import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { KolderaClient } from "@koldera/sdk/node";

// PDF remediation demo: analyze a synthetic PDF, fix a copy, download it, and say plainly what still needs a person.
// Needs a running koldera-core: KOLDERA_URL and KOLDERA_TOKEN in the environment (see README.md).
const input = process.argv[2] ?? fileURLToPath(new URL("../synthetic-report.pdf", import.meta.url));
const outputDir = process.argv[3] ?? "out";

const koldera = new KolderaClient();
const info = await koldera.info();
console.log(`koldera-core ${info.version}, features: ${info.features.join(", ")}`);
console.log(`Input: ${input}`);

// 1. Analyze: validate only, nothing is changed.
const file = await readFile(input);
const fileName = path.basename(input);
const analyzed = await koldera.pdf.createJob({ file, fileName, mode: "analyze", wait: 60, untilFinished: true });
console.log(`\n== Analysis (job ${analyzed.id}): ${analyzed.state}, machine validation ${analyzed.validation?.status}`);
for (const rule of analyzed.validation?.failedRules ?? []) console.log(`   failed rule ${rule.ruleId} x${rule.count}`);

// 2. Fix: the server writes a separate repaired copy and validates it again. The input file is never modified.
const job = await koldera.pdf.createJob({ file, fileName, mode: "fix", explicitLanguage: "en", wait: 120, untilFinished: true });
console.log(`\n== Fix (job ${job.id}): ${job.state}, remediation ${job.remediationStatus}`);
if (job.state === "failed") {
  console.log(`   job failed: ${job.error?.code} ${job.error?.message}`);
  process.exit(3);
}
console.log(`   before: ${job.baselineValidation?.status} (${job.baselineValidation?.failedRules.length ?? 0} failed rules)`);
console.log(`   after:  ${job.finalValidation?.status} (${job.finalValidation?.failedRules.map((r) => r.ruleId).join(", ")})`);

console.log("\n== Repairs applied");
for (const action of await koldera.jobs.actions(job.id)) {
  if (action.outcome === "applied") console.log(` - ${action.ruleId}: ${action.reason}`);
}

const findings = await koldera.jobs.findings(job.id);
console.log("\n== Machine findings");
for (const finding of findings.filter((f) => !f.needsHumanReview)) console.log(` - ${finding.ruleId} [${finding.resolution ?? "n/a"}]`);

// 3. Download the copy. The SDK checks size and SHA-256 and throws StorageError on a mismatch.
const fixed = (await koldera.jobs.artifacts(job.id)).find((artifact) => artifact.kind === "remediated");
if (fixed) {
  await mkdir(outputDir, { recursive: true });
  const target = path.join(outputDir, `${path.parse(input).name}.fixed.pdf`);
  await writeFile(target, await koldera.artifacts.download(fixed));
  console.log(`\n== Fixed copy: ${target} (${fixed.sizeBytes} bytes, SHA-256 ${fixed.sha256}, verified)`);
} else {
  console.log("\nNo repaired copy was kept (see the remediation status above).");
}

// 4. What automation cannot decide.
console.log(`\n== Manual review required: ${job.manualReviewRequired}`);
for (const finding of findings.filter((f) => f.needsHumanReview)) console.log(` - ${finding.ruleId}: ${finding.message}`);
console.log(`
The fixed copy is NOT declared PDF/UA. koldera-core does not write the PDF/UA-1 identifier (pdfuaid:part=1)
on its own; it is written only through an explicit opt-in after a person has reviewed the document, which this
demo does not use. That is why rule 5-1 stays in the final machine check.
A machine check is not an accessibility statement: no automated run makes a document fully accessible.
A person still has to check reading order, headings, tables, alternative text, link purpose and language.`);
