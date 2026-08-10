// EVAL-1 — manual, local, LIVE evaluation runner. Calls the real Claude
// OCR provider and the real production bet parser against every case in
// cases.json, scores each one with evals/compareResult.ts, and writes a
// report under evals/reports/.
//
// Deliberately NOT a *.test.ts file and NOT part of `npm test` — same
// "manual, one-off, never picked up by the test runner, never spends live
// quota by accident" convention scripts/candidateResolverSmokeTest.ts and
// its siblings already established for this codebase's other real-API
// smoke tests. Run explicitly:
//
//   npm run eval:screenshots
//
// Reuses the real production pipeline end to end — createClaudeOcrProvider
// (lib/ocr/claudeOcrProvider.ts), recognizeBetSlipScreenshot
// (lib/ocr/recognizeBetSlipScreenshot.ts), parseBetSlipMessage
// (lib/ai/betParser.ts) — never a parallel/duplicated OCR or parsing
// implementation. This file's only job is to drive that real pipeline over
// a dataset and score the result; see evals/compareResult.ts for the
// (separately, deterministically tested) scoring logic itself.

import "dotenv/config";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createClaudeOcrProvider } from "@/lib/ocr/claudeOcrProvider";
import { recognizeBetSlipScreenshot } from "@/lib/ocr/recognizeBetSlipScreenshot";
import { parseBetSlipMessage } from "@/lib/ai/betParser";
import type { OcrMimeType, OcrProvider } from "@/lib/ocr/ocrTypes";
import { parseGroundTruthDataset, type GroundTruthCase } from "./caseSchema";
import { compareCase, aggregateResults, type ActualPipelineResult, type CaseComparisonResult, type AggregateMetrics } from "./compareResult";
import { buildRunMetadata, type RunMetadata } from "./metadata";

const EVALS_ROOT = join(process.cwd(), "evals");
const CASES_PATH = join(EVALS_ROOT, "cases.json");
const SCREENSHOTS_DIR = join(EVALS_ROOT, "screenshots");
const REPORTS_DIR = join(EVALS_ROOT, "reports");

function mimeTypeForFile(filename: string): OcrMimeType | null {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".webp")) return "image/webp";
  return null;
}

// Fails loudly and immediately — never silently substitutes a mock/fake
// evaluation when credentials are missing (Section 5's explicit
// requirement: "Never silently mock a 'live evaluation'"). AI_PROVIDER
// must also be exactly "claude" — otherwise parseBetSlipMessage() silently
// falls back to the local Ollama parser (lib/ai/betParser.ts's own
// provider branch), which would produce a misleading "evaluation" that
// never actually asked Claude anything at all.
function assertLiveCredentials(): void {
  const missing: string[] = [];
  if (!process.env.ANTHROPIC_API_KEY) missing.push("ANTHROPIC_API_KEY is not set");
  if (process.env.AI_PROVIDER !== "claude") {
    missing.push(`AI_PROVIDER must be exactly "claude" (currently ${JSON.stringify(process.env.AI_PROVIDER ?? null)})`);
  }
  if (missing.length > 0) {
    console.error("evals/runScreenshotEval.ts: cannot run a live evaluation:");
    for (const m of missing) console.error(`  - ${m}`);
    console.error("\nSet these in your shell environment or .env.local before running `npm run eval:screenshots`.");
    process.exitCode = 1;
    throw new Error("Live evaluation credentials/config missing");
  }
}

async function runCase(caseDef: GroundTruthCase, provider: OcrProvider): Promise<CaseComparisonResult> {
  try {
    const mimeType = mimeTypeForFile(caseDef.image);
    if (mimeType === null) {
      return compareCase(caseDef, { kind: "PIPELINE_ERROR", message: `unsupported image extension: ${caseDef.image}` });
    }

    const imagePath = join(SCREENSHOTS_DIR, caseDef.image);
    if (!existsSync(imagePath)) {
      return compareCase(caseDef, { kind: "PIPELINE_ERROR", message: `screenshot not found: ${imagePath}` });
    }

    const buffer = readFileSync(imagePath);

    const recognition = await recognizeBetSlipScreenshot({
      buffer,
      intake: { mimeType, originalFilename: caseDef.image },
      provider,
    });

    if (recognition.kind === "IMAGE_TOO_LARGE") {
      return compareCase(caseDef, { kind: "PIPELINE_ERROR", message: "image exceeds the pipeline's maximum dimensions" });
    }

    if (recognition.ocrResult.kind === "FAILURE") {
      return compareCase(caseDef, {
        kind: "PIPELINE_ERROR",
        message: `OCR failed: ${recognition.ocrResult.code} — ${recognition.ocrResult.safeMessage}`,
      });
    }

    const parsed = await parseBetSlipMessage(recognition.ocrResult.normalizedText, "OCR");

    if (!parsed.valid) {
      if (parsed.code === "timeout") {
        // A real Claude request timeout is an infrastructure failure, not
        // a business decision — distinct from a genuine reject_bet/BA-2B/
        // BA-2D rejection below.
        return compareCase(caseDef, { kind: "PIPELINE_ERROR", message: `Claude request timed out: ${parsed.error}` });
      }
      // reject_bet, or a BA-2B (numeric_mismatch) / BA-2D (market_mismatch)
      // safety rejection — all genuine "the pipeline declined to extract a
      // bet" outcomes, never an exception.
      return compareCase(caseDef, { kind: "REJECTED", reason: parsed.code ? `${parsed.code}: ${parsed.error}` : parsed.error });
    }

    const actual: ActualPipelineResult = {
      kind: "PARSED",
      type: parsed.type,
      stake: parsed.stake,
      selections: parsed.selections,
    };
    return compareCase(caseDef, actual);
  } catch (err) {
    // Never let one case's unexpected exception crash the whole run — every
    // other case must still get a chance to execute and be reported.
    const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    return compareCase(caseDef, { kind: "PIPELINE_ERROR", message });
  }
}

function formatPct(value: number | null): string {
  if (value === null) return "n/a (no comparable cases)";
  return `${(value * 100).toFixed(1)}%`;
}

function writeReport(metadata: RunMetadata, results: readonly CaseComparisonResult[], metrics: AggregateMetrics): string {
  mkdirSync(REPORTS_DIR, { recursive: true });
  const filename = `${metadata.timestamp.replace(/[:.]/g, "-")}.json`;
  const path = join(REPORTS_DIR, filename);
  writeFileSync(path, JSON.stringify({ metadata, summary: metrics, cases: results }, null, 2), "utf8");
  return path;
}

function printSummary(metrics: AggregateMetrics, results: readonly CaseComparisonResult[], reportPath: string): void {
  console.log("\n=== EVAL-1 Screenshot Evaluation Summary ===");
  console.log(`Cases: ${metrics.caseCount} (pipeline errors: ${metrics.pipelineErrorCount})`);
  console.log(`Exact-match accuracy: ${formatPct(metrics.exactMatchAccuracy)}`);
  console.log(`Critical errors: ${metrics.criticalErrorCount} (${formatPct(metrics.criticalErrorRate)})`);
  console.log("Field accuracy:");
  for (const [field, value] of Object.entries(metrics.fieldAccuracy)) {
    console.log(`  ${field}: ${formatPct(value as number | null)}`);
  }

  // Never hide failures behind the aggregate percentage (Section 6's own
  // requirement) — every non-PASS case is listed with exactly which
  // field(s) differed.
  const failures = results.filter((r) => r.verdict !== "PASS");
  if (failures.length > 0) {
    console.log(`\nFailed cases (${failures.length}):`);
    for (const f of failures) {
      console.log(`  [${f.verdict}] ${f.caseId}`);
      if (f.pipelineError) console.log(`    error: ${f.pipelineError}`);
      for (const d of f.diffs) {
        const location = d.selectionIndex !== undefined ? `${d.field}[${d.selectionIndex}]` : d.field;
        console.log(`    ${location}: expected=${JSON.stringify(d.expected)} actual=${JSON.stringify(d.actual)}${d.critical ? " (CRITICAL)" : ""}`);
      }
    }
  } else {
    console.log("\nNo failures.");
  }

  console.log(`\nFull report written to: ${reportPath}`);
}

async function main(): Promise<void> {
  assertLiveCredentials();

  if (!existsSync(CASES_PATH)) {
    console.error(`evals/runScreenshotEval.ts: cases.json not found at ${CASES_PATH}`);
    process.exitCode = 1;
    return;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(CASES_PATH, "utf8"));
  } catch (err) {
    console.error("evals/runScreenshotEval.ts: cases.json is not valid JSON:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
    return;
  }

  const dataset = parseGroundTruthDataset(raw);
  if (!dataset.ok) {
    console.error("evals/runScreenshotEval.ts: cases.json failed schema validation:");
    console.error(dataset.error);
    process.exitCode = 1;
    return;
  }

  const cases = dataset.cases;
  const metadata = buildRunMetadata(cases, cases.length);

  // Empty dataset — Section 11's explicit requirement: schema validation
  // succeeds, no divide-by-zero/NaN metrics, no fake 100% accuracy, a
  // clearly documented "no cases" status rather than a crash.
  if (cases.length === 0) {
    console.log("evals/runScreenshotEval.ts: dataset is empty (0 cases) — nothing to evaluate.");
    console.log("See evals/README.md for how to add the first ground-truth examples.");
    const metrics = aggregateResults([]);
    const reportPath = writeReport(metadata, [], metrics);
    console.log(`Empty-run report written to: ${reportPath}`);
    return;
  }

  const provider = createClaudeOcrProvider();
  const results: CaseComparisonResult[] = [];
  for (const caseDef of cases) {
    console.log(`Running case ${caseDef.id}...`);
    // Sequential, not parallel — every case is a paid, live Claude call;
    // running them one at a time keeps this script's own behavior simple
    // and avoids bursting the API with concurrent requests for what is
    // explicitly a manual, occasional-use tool, not a latency-sensitive one.
    results.push(await runCase(caseDef, provider));
  }

  const metrics = aggregateResults(results);
  const reportPath = writeReport(metadata, results, metrics);
  printSummary(metrics, results, reportPath);
}

main().catch((err) => {
  console.error("evals/runScreenshotEval.ts: fatal error:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
