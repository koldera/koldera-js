import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { KolderaClient } from "../packages/sdk/dist/node/index.js";
import type { Job } from "../packages/sdk/dist/node/index.js";

// Runs only against a real koldera-core: KOLDERA_URL=http://localhost:8080 KOLDERA_TOKEN=... pnpm test:live
// Skipped when either variable is missing, so normal CI never needs a server.
const live = Boolean(process.env.KOLDERA_URL && process.env.KOLDERA_TOKEN);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const finished = (job: Job) => job.state === "completed" || job.state === "failed";
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

describe.skipIf(!live)("live koldera-core", () => {
  // Built only when the suite runs: the constructor throws without KOLDERA_TOKEN.
  const client = live ? new KolderaClient() : (undefined as never);

  it("answers health and info", async () => {
    expect((await client.health()).status).toBe("ok");
    expect((await client.info()).features).toEqual(expect.arrayContaining(["pdf", "html", "document"]));
  });

  it("analyzes and fixes a synthetic PDF, downloads the fixed copy with a matching SHA-256", async () => {
    const file = readFileSync(path.join(root, "examples/node-pdf-demo/synthetic-report.pdf"));
    const analyzed = await client.pdf.createJob({ file, fileName: "synthetic-report.pdf", mode: "analyze", wait: 60, untilFinished: true });
    expect(analyzed.state).toBe("completed");
    expect(analyzed.manualReviewRequired).toBe(true);
    expect((await client.jobs.findings(analyzed.id)).length).toBeGreaterThan(0);

    const fixed = await client.pdf.createJob({ file, fileName: "synthetic-report.pdf", mode: "fix", explicitLanguage: "en", wait: 120, untilFinished: true });
    expect(finished(fixed)).toBe(true);
    expect(fixed.manualReviewRequired).toBe(true);
    const artifact = (await client.jobs.artifacts(fixed.id)).find((a) => a.kind === "remediated");
    if (artifact) expect(sha256(await client.artifacts.download(artifact))).toBe(artifact.sha256);
    console.log(JSON.stringify({ analyze: analyzed.id, analyzeStatus: analyzed.validation?.status, fix: fixed.id, fixState: fixed.state, remediationStatus: fixed.remediationStatus, finalStatus: fixed.finalValidation?.status, remediatedSha: artifact?.sha256 ?? null }));
  });

  it("renders synthetic HTML to a tagged PDF", async () => {
    const html = '<!doctype html><html lang="en"><head><title>Synthetic page</title></head><body><h1>Synthetic page</h1><p>Invented text for a live test.</p></body></html>';
    const job = await client.htmlToPdf.createJob({ file: new TextEncoder().encode(html), fileName: "synthetic.html", mode: "generate_analyze", wait: 120, untilFinished: true });
    expect(job.state).toBe("completed");
    const pdf = (await client.jobs.artifacts(job.id)).find((a) => a.kind === "generated_pdf");
    expect(pdf).toBeDefined();
    expect(sha256(await client.artifacts.download(pdf!))).toBe(pdf!.sha256);
    console.log(JSON.stringify({ html: job.id, status: job.validation?.status }));
  });

  it("renders a structured document to a tagged PDF", async () => {
    const job = await client.documents.createJob(
      { title: "Synthetic note", language: "en", body: [{ type: "heading", level: 1, text: "Synthetic note" }, { type: "paragraph", content: ["Invented text for a live test."] }] },
      { wait: 120, untilFinished: true },
    );
    expect(job.state).toBe("completed");
    const pdf = (await client.jobs.artifacts(job.id)).find((a) => a.kind === "generated_pdf");
    expect(pdf).toBeDefined();
    expect(sha256(await client.artifacts.download(pdf!))).toBe(pdf!.sha256);
    console.log(JSON.stringify({ document: job.id, status: job.validation?.status }));
  });
});
