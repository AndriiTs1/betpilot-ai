// EVAL-1 — run metadata: everything needed to compare two eval runs fairly
// (Section 9). No Claude call, no I/O beyond hashing already-imported
// strings.

import { createHash } from "node:crypto";
import { chatPrompt, ocrPrompt } from "@/lib/ai/betParserPrompt";

// H4-B1/AI-1 — kept in sync MANUALLY with the real literals in
// lib/ai/betParser.ts (CLAUDE_MODEL, and the `temperature: 0.1` in
// parseTextSlipWithClaude's request) and lib/ocr/claudeOcrProvider.ts
// (CLAUDE_OCR_MODEL, and `temperature: 0` in its request). None of these
// are exported production constants — this stage does not modify
// lib/ai/betParser.ts or lib/ocr/claudeOcrProvider.ts to export them
// (that would be a production-file change, out of EVAL-1's explicit
// "evaluation infrastructure ONLY" scope), so there is a real, documented
// risk of drift if a future stage changes those literals without updating
// this file too. If these ever diverge, this eval's metadata would
// silently misreport what actually ran — treat any prompt/temperature
// change as requiring a matching update here.
export const PARSER_MODEL = "claude-sonnet-4-6";
export const PARSER_TEMPERATURE = 0.1;
export const OCR_MODEL = "claude-sonnet-4-6";
export const OCR_TEMPERATURE = 0;

// A short, stable fingerprint — not the full prompt text — so a report
// can prove "these two runs used the identical prompt" or "these differ"
// without duplicating the (fairly long) prompt strings inside every report
// file. chatPrompt/ocrPrompt are real, already-exported production
// constants (lib/ai/betParserPrompt.ts) — imported directly, never
// copy-pasted.
function fingerprint(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
}

export interface PromptFingerprints {
  readonly chatPrompt: string;
  readonly ocrPrompt: string;
  // lib/ocr/claudeOcrProvider.ts's OCR_SYSTEM_PROMPT and
  // lib/ocr/regionDetection.ts's REGION_DETECTION_SYSTEM_PROMPT are both
  // module-private (not exported) — capturing their fingerprint would
  // require exporting them, a production-file change outside this stage's
  // scope. Recorded as `null` rather than silently omitted, so a report
  // reader sees the gap explicitly instead of assuming full prompt
  // coverage. See README.md's "Known limitations".
  readonly ocrSystemPrompt: null;
  readonly regionDetectionSystemPrompt: null;
}

export function computePromptFingerprints(): PromptFingerprints {
  return {
    chatPrompt: fingerprint(chatPrompt),
    ocrPrompt: fingerprint(ocrPrompt),
    ocrSystemPrompt: null,
    regionDetectionSystemPrompt: null,
  };
}

export interface RunMetadata {
  readonly timestamp: string;
  readonly parserModel: string;
  readonly parserTemperature: number;
  readonly ocrModel: string;
  readonly ocrTemperature: number;
  readonly promptFingerprints: PromptFingerprints;
  readonly datasetFingerprint: string;
  readonly caseCount: number;
}

// Deterministic fingerprint of the exact dataset a run was scored against —
// two reports with the same datasetFingerprint were scored against
// byte-identical cases.json content, regardless of file mtime/ordering
// noise (the input is the already-parsed-and-reserialized case array, not
// the raw file bytes, so key order in the source file never matters).
export function computeDatasetFingerprint(cases: unknown): string {
  return fingerprint(JSON.stringify(cases));
}

export function buildRunMetadata(cases: unknown, caseCount: number): RunMetadata {
  return {
    timestamp: new Date().toISOString(),
    parserModel: PARSER_MODEL,
    parserTemperature: PARSER_TEMPERATURE,
    ocrModel: OCR_MODEL,
    ocrTemperature: OCR_TEMPERATURE,
    promptFingerprints: computePromptFingerprints(),
    datasetFingerprint: computeDatasetFingerprint(cases),
    caseCount,
  };
}
