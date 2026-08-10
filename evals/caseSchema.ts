// EVAL-1 — the ground-truth case schema for the screenshot evaluation
// foundation. Reuses lib/odds/domain.ts's real MarketType/SelectionType
// enums (never a parallel duplicate) for the OPTIONAL canonical enrichment
// fields; see the header comment on GroundTruthSelection below for exactly
// which fields are actually compared in EVAL-1 versus collected for a
// future stage.
//
// Zod, matching this codebase's existing validation convention throughout
// lib/ai/ and lib/odds/ — no new validation library introduced.

import { z } from "zod";
import { MARKET_TYPES, SELECTION_TYPES, type MarketType, type SelectionType } from "@/lib/odds/domain";

export const EVAL_LANGUAGES = ["RU", "UA", "EN"] as const;
export type EvalLanguage = (typeof EVAL_LANGUAGES)[number];

// Screenshot *style*, not language — mirrors the real-world source shapes
// this eval is meant to exercise (a bookmaker's own app, a photographed
// paper/physical coupon, or a score-panel screenshot like MyScore/
// Flashscore showing odds alongside a live score).
export const EVAL_INPUT_TYPES = ["BOOKMAKER_SCREENSHOT", "COUPON_SCREENSHOT", "SCORE_PANEL_SCREENSHOT"] as const;
export type EvalInputType = (typeof EVAL_INPUT_TYPES)[number];

export const EVAL_BET_TYPES = ["SINGLE", "EXPRESS"] as const;
export type EvalBetType = (typeof EVAL_BET_TYPES)[number];

const marketTypeTuple = MARKET_TYPES as unknown as [MarketType, ...MarketType[]];
const selectionTypeTuple = SELECTION_TYPES as unknown as [SelectionType, ...SelectionType[]];

// Field names actually compared by evals/compareResult.ts. Kept in sync
// manually with lib/bets/betSlip.ts's BetSlipSelectionInput/ParsedBetSlip —
// the real production output shape at this stage of the pipeline (screenshot
// -> OCR -> parseBetSlipMessage -> ParsedBetSlip). No `period` field exists
// here because ParsedBetSlip itself drops it (confirmed by reading
// lib/bets/draft/legacyAdapter.ts's universalBetDraftToParsedBetSlip) — this
// schema does not invent a field production doesn't actually produce.
//
// marketType/selectionType/participant are OPTIONAL, collected for human
// labeling clarity and a future eval stage, but NOT compared against actual
// output in EVAL-1: ParsedBetSlip carries no canonical classification at
// this pipeline stage (that happens later, downstream, during odds
// verification — lib/odds/shorthandClassifier.ts /
// lib/odds/legacyOddsBridge.ts — which is out of this eval's stated scope).
// Reusing that classifier here would mean evaluating a *different, later*
// pipeline stage than the one this foundation is scoped to, and would
// duplicate/couple this eval to classification logic Section 1 explicitly
// says not to duplicate. See README.md's "Known limitations" section.
const groundTruthSelectionSchema = z.object({
  sport: z.string().min(1),
  league: z.string().min(1).nullable().optional(),
  event: z.string().min(1),
  market: z.string().min(1).nullable(),
  selection: z.string().min(1),
  odds: z.string().min(1).nullable(),
  line: z.string().min(1).nullable().optional(),
  // Optional canonical enrichment — not compared in EVAL-1, see above.
  marketType: z.enum(marketTypeTuple).optional(),
  selectionType: z.enum(selectionTypeTuple).optional(),
  participant: z.string().min(1).nullable().optional(),
});

export type GroundTruthSelection = z.infer<typeof groundTruthSelectionSchema>;

const groundTruthExpectedSchema = z.object({
  type: z.enum(EVAL_BET_TYPES),
  stake: z.string().min(1),
  selections: z.array(groundTruthSelectionSchema).min(1),
});

export type GroundTruthExpected = z.infer<typeof groundTruthExpectedSchema>;

// The set of field names a case's `criticalFields` override may reference —
// matches exactly what evals/compareResult.ts's diffFields() actually
// produces diffs for. Validated here (not just documented) so a typo in a
// case file (e.g. "odd" instead of "odds") fails loudly at dataset-load
// time rather than silently never taking effect.
export const COMPARABLE_FIELD_NAMES = ["type", "sport", "league", "event", "market", "selection", "line", "odds", "stake"] as const;
export type ComparableFieldName = (typeof COMPARABLE_FIELD_NAMES)[number];

export const groundTruthCaseSchema = z.object({
  id: z.string().min(1),
  // Relative path under evals/screenshots/ — never an absolute path, so the
  // dataset stays portable across machines/CI.
  image: z.string().min(1),
  language: z.enum(EVAL_LANGUAGES),
  inputType: z.enum(EVAL_INPUT_TYPES),
  betType: z.enum(EVAL_BET_TYPES),
  // null means this input is EXPECTED to be REJECTED by the real pipeline
  // (illegible slip, unsupported market, etc.) — not a bet extraction at
  // all. See compareResult.ts's handling of this case: a real ParsedBetSlip
  // produced for a null-expected case is a CRITICAL_MISMATCH (Section 4's
  // "unsupported market incorrectly accepted").
  expected: groundTruthExpectedSchema.nullable(),
  // Elevates specific fields to CRITICAL for this case, on top of
  // compareResult.ts's own DEFAULT_CRITICAL_FIELDS (everything except
  // `league`). Use this for a case where even a `league` mismatch would be
  // dangerous for this specific example.
  criticalFields: z.array(z.enum(COMPARABLE_FIELD_NAMES)).optional(),
  notes: z.string().optional(),
});

export type GroundTruthCase = z.infer<typeof groundTruthCaseSchema>;

export const groundTruthDatasetSchema = z.array(groundTruthCaseSchema).superRefine((cases, ctx) => {
  const seenIds = new Set<string>();
  for (const [index, entry] of cases.entries()) {
    if (seenIds.has(entry.id)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate case id "${entry.id}"`, path: [index, "id"] });
    }
    seenIds.add(entry.id);
  }
});

export interface DatasetValidationResult {
  readonly ok: boolean;
  readonly cases: readonly GroundTruthCase[];
  readonly error?: string;
}

// Never throws — a malformed cases.json is a data problem the runner must
// report clearly, not a reason to crash with a raw Zod stack trace.
export function parseGroundTruthDataset(raw: unknown): DatasetValidationResult {
  const result = groundTruthDatasetSchema.safeParse(raw);
  if (!result.success) {
    return { ok: false, cases: [], error: result.error.message };
  }
  return { ok: true, cases: result.data };
}
