// EVAL-1 — pure comparison/scoring engine. No Claude, no network, no file
// I/O, no Date.now() — a deterministic function of its inputs, same purity
// discipline as lib/bets/settlement/evaluateSelectionOutcome.ts. This file
// is what evals/compareResult.test.ts exercises without ever calling the
// real pipeline; evals/runScreenshotEval.ts is the only caller that ever
// feeds it real (or real-shaped) production output.
//
// Reuses lib/ai/betDraftMapper.ts's own numberToDecimalString() for
// converting ParsedBetSlip's plain-number stake/odds into the same
// canonical decimal-string form the rest of this codebase already uses for
// safe comparison — never a second, ad hoc number formatter, and never raw
// JS floating-point equality (Section 8's own requirement).

import { Prisma } from "@/lib/generated/prisma/client";
import { numberToDecimalString } from "@/lib/ai/betDraftMapper";
import type { BetSlipSelectionInput } from "@/lib/bets/betSlip";
import { COMPARABLE_FIELD_NAMES, type ComparableFieldName, type GroundTruthCase, type GroundTruthSelection } from "./caseSchema";

// The real pipeline's outcome, reduced to exactly the three shapes this
// comparator needs to reason about. Deliberately distinct from
// lib/ai/betParser.ts's own ParseBetSlipResult: REJECTED (a real, valid
// business decision — Claude/BA-2B/BA-2D correctly or incorrectly declined
// to extract a bet) is kept structurally separate from PIPELINE_ERROR (the
// run itself failed — network/timeout/exception) so a case can never be
// silently scored as "the model rejected it" when what actually happened is
// "the eval run crashed before it could ask."
export type ActualPipelineResult =
  | { readonly kind: "PARSED"; readonly type: "SINGLE" | "EXPRESS"; readonly stake: number; readonly selections: readonly BetSlipSelectionInput[] }
  | { readonly kind: "REJECTED"; readonly reason: string }
  | { readonly kind: "PIPELINE_ERROR"; readonly message: string };

export type CaseVerdict = "PASS" | "NON_CRITICAL_MISMATCH" | "CRITICAL_MISMATCH" | "PIPELINE_ERROR";

export interface FieldDiff {
  readonly field: ComparableFieldName;
  // Present for a per-selection field (sport/league/event/market/selection/
  // line/odds); absent for a bet-level field (type/stake).
  readonly selectionIndex?: number;
  readonly expected: string | null;
  readonly actual: string | null;
  readonly critical: boolean;
}

export interface CaseComparisonResult {
  readonly caseId: string;
  readonly verdict: CaseVerdict;
  readonly diffs: readonly FieldDiff[];
  // Present only for verdict "PIPELINE_ERROR".
  readonly pipelineError?: string;
}

// Fields that are CRITICAL by default — every comparable field except
// `league`, matching Section 4's own explicit list almost 1:1 (wrong
// participant/event/market type, wrong handicap sign/line, MONEYLINE<->
// SPREAD confusion, stake<->odds swaps) and the task's own single named
// exception ("competition formatting mismatch" is the one worked example
// of a non-critical difference). `selection` stands in for "participant"
// here — see caseSchema.ts's own comment on why a canonical participant
// field isn't compared directly in EVAL-1; a wrong participant reliably
// shows up as a `selection` text diff instead. `league` is the sole
// default-non-critical field: a screenshot's OCR'd competition name can
// differ in harmless ways (abbreviation, formatting) without the
// underlying bet being misunderstood. A specific case can still elevate
// `league` (or downgrade nothing — there is no downgrade mechanism in
// EVAL-1) via its own `criticalFields`.
const DEFAULT_CRITICAL_FIELDS: ReadonlySet<ComparableFieldName> = new Set([
  "type",
  "sport",
  "event",
  "market",
  "selection",
  "line",
  "odds",
  "stake",
]);

function isCritical(field: ComparableFieldName, caseCriticalFields: readonly ComparableFieldName[] | undefined): boolean {
  if (caseCriticalFields?.includes(field)) return true;
  return DEFAULT_CRITICAL_FIELDS.has(field);
}

// Light, deliberately non-fuzzy normalization for free-text comparison —
// trim + collapse internal whitespace + lowercase. Not Levenshtein/fuzzy
// matching (out of EVAL-1's scope; see README.md's "Known limitations").
function normalizeText(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function textEquals(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  return normalizeText(a) === normalizeText(b);
}

// Decimal-safe: never native floating point. Two decimal strings are equal
// only if they represent the exact same numeric value INCLUDING sign — a
// handicap line's sign is safety-critical (Section 8: "-1.5 must never
// equal +1.5"), and Prisma.Decimal equality already respects sign
// correctly with no special-casing needed.
function decimalStringEquals(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  try {
    return new Prisma.Decimal(a).equals(new Prisma.Decimal(b));
  } catch {
    // Either side isn't a parseable decimal at all — genuinely unequal,
    // never silently treated as a match.
    return false;
  }
}

// actual.submittedOdds/stake are plain JS numbers (the real, current
// ParsedBetSlip shape) — converted through the same production
// numberToDecimalString() the real pipeline itself uses, never re-derived
// with a second formatter.
function actualNumberToDecimalStringOrNull(value: number | null): string | null {
  if (value === null) return null;
  return numberToDecimalString(value);
}

function diffField(
  field: ComparableFieldName,
  expected: string | null,
  actual: string | null,
  caseCriticalFields: readonly ComparableFieldName[] | undefined,
  equals: (a: string | null, b: string | null) => boolean,
  selectionIndex?: number,
): FieldDiff | null {
  if (equals(expected, actual)) return null;
  return { field, selectionIndex, expected, actual, critical: isCritical(field, caseCriticalFields) };
}

function diffSelection(
  index: number,
  expected: GroundTruthSelection | undefined,
  actual: BetSlipSelectionInput | undefined,
  caseCriticalFields: readonly ComparableFieldName[] | undefined,
): FieldDiff[] {
  // A missing leg on either side (extra/invented, or dropped) — every
  // per-selection field is reported once as a single, clearly-attributed
  // diff rather than N confusing individual field diffs against nothing.
  if (expected === undefined || actual === undefined) {
    const critical = true; // an extra or missing leg is always dangerous
    return [
      {
        field: "selection",
        selectionIndex: index,
        expected: expected ? expected.selection : null,
        actual: actual ? actual.selection : null,
        critical,
      },
    ];
  }

  const diffs: FieldDiff[] = [];
  const push = (d: FieldDiff | null) => {
    if (d) diffs.push(d);
  };

  push(diffField("sport", expected.sport, actual.sport, caseCriticalFields, textEquals, index));
  push(diffField("league", expected.league ?? null, actual.league ?? null, caseCriticalFields, textEquals, index));
  push(diffField("event", expected.event, actual.event, caseCriticalFields, textEquals, index));
  push(diffField("market", expected.market, actual.market, caseCriticalFields, textEquals, index));
  push(diffField("selection", expected.selection, actual.selection, caseCriticalFields, textEquals, index));
  push(diffField("line", expected.line ?? null, actual.line ?? null, caseCriticalFields, decimalStringEquals, index));
  push(
    diffField(
      "odds",
      expected.odds,
      actualNumberToDecimalStringOrNull(actual.submittedOdds),
      caseCriticalFields,
      decimalStringEquals,
      index,
    ),
  );

  return diffs;
}

function diffParsedResult(
  expected: NonNullable<GroundTruthCase["expected"]>,
  actual: Extract<ActualPipelineResult, { kind: "PARSED" }>,
  caseCriticalFields: readonly ComparableFieldName[] | undefined,
): FieldDiff[] {
  const diffs: FieldDiff[] = [];
  const push = (d: FieldDiff | null) => {
    if (d) diffs.push(d);
  };

  push(diffField("type", expected.type, actual.type, caseCriticalFields, textEquals));
  push(diffField("stake", expected.stake, actualNumberToDecimalStringOrNull(actual.stake), caseCriticalFields, decimalStringEquals));

  const legCount = Math.max(expected.selections.length, actual.selections.length);
  for (let i = 0; i < legCount; i++) {
    diffs.push(...diffSelection(i, expected.selections[i], actual.selections[i], caseCriticalFields));
  }

  return diffs;
}

export function compareCase(groundTruth: GroundTruthCase, actual: ActualPipelineResult): CaseComparisonResult {
  if (actual.kind === "PIPELINE_ERROR") {
    return { caseId: groundTruth.id, verdict: "PIPELINE_ERROR", diffs: [], pipelineError: actual.message };
  }

  if (groundTruth.expected === null) {
    // This input is expected to be REJECTED — a real ParsedBetSlip here is
    // exactly Section 4's "unsupported market incorrectly accepted"
    // danger class, never merely a mismatch.
    if (actual.kind === "REJECTED") {
      return { caseId: groundTruth.id, verdict: "PASS", diffs: [] };
    }
    return {
      caseId: groundTruth.id,
      verdict: "CRITICAL_MISMATCH",
      diffs: [{ field: "type", expected: "REJECTED", actual: "ACCEPTED", critical: true }],
    };
  }

  if (actual.kind === "REJECTED") {
    // A real, legitimate bet was wrongly declined — always critical: the
    // player's bet never even reached extraction.
    return {
      caseId: groundTruth.id,
      verdict: "CRITICAL_MISMATCH",
      diffs: [{ field: "type", expected: "ACCEPTED", actual: `REJECTED: ${actual.reason}`, critical: true }],
    };
  }

  const diffs = diffParsedResult(groundTruth.expected, actual, groundTruth.criticalFields);
  if (diffs.length === 0) {
    return { caseId: groundTruth.id, verdict: "PASS", diffs: [] };
  }
  const verdict: CaseVerdict = diffs.some((d) => d.critical) ? "CRITICAL_MISMATCH" : "NON_CRITICAL_MISMATCH";
  return { caseId: groundTruth.id, verdict, diffs };
}

/* -------------------------------------------------------------------------- */
/* Aggregate metrics                                                          */
/* -------------------------------------------------------------------------- */

export interface FieldAccuracy {
  readonly sport: number | null;
  readonly event: number | null;
  readonly market: number | null;
  readonly selection: number | null;
  readonly line: number | null;
  readonly odds: number | null;
  readonly stake: number | null;
  readonly betType: number | null;
  // Explicitly null in EVAL-1, always — ParsedBetSlip (the real pipeline's
  // output at this stage) carries no canonical participant field; see
  // caseSchema.ts's own comment on GroundTruthSelection.participant and
  // README.md's "Known limitations". Reported as an explicit field (not
  // silently omitted) so a report reader sees the gap rather than assuming
  // 100%/0%/absence means something it doesn't.
  readonly participant: null;
}

export interface AggregateMetrics {
  readonly caseCount: number;
  readonly exactMatchAccuracy: number | null;
  readonly fieldAccuracy: FieldAccuracy;
  readonly criticalErrorCount: number;
  readonly criticalErrorRate: number | null;
  readonly pipelineErrorCount: number;
}

// A field's own "accuracy" = (comparable cases where this field had no
// diff) / (comparable cases where this field was actually evaluated).
// PIPELINE_ERROR cases are excluded from every field-level denominator —
// there is no actual output to compare against, so they would only ever
// silently deflate the number, not honestly measure anything. Section 11's
// "no divide-by-zero / NaN metrics, no fake 100% accuracy" is satisfied by
// returning null (not 0, not 1) whenever a denominator would be zero.
function fieldAccuracyFor(field: ComparableFieldName, results: readonly CaseComparisonResult[]): number | null {
  const relevant = results.filter((r) => r.verdict !== "PIPELINE_ERROR");
  if (relevant.length === 0) return null;
  const withFieldDiff = relevant.filter((r) => r.diffs.some((d) => d.field === field));
  return (relevant.length - withFieldDiff.length) / relevant.length;
}

export function aggregateResults(results: readonly CaseComparisonResult[]): AggregateMetrics {
  const caseCount = results.length;
  const pipelineErrorCount = results.filter((r) => r.verdict === "PIPELINE_ERROR").length;
  const criticalErrorCount = results.filter((r) => r.verdict === "CRITICAL_MISMATCH").length;
  const comparableCount = caseCount - pipelineErrorCount;

  const exactMatchAccuracy = comparableCount > 0 ? results.filter((r) => r.verdict === "PASS").length / comparableCount : null;
  const criticalErrorRate = comparableCount > 0 ? criticalErrorCount / comparableCount : null;

  return {
    caseCount,
    exactMatchAccuracy,
    fieldAccuracy: {
      sport: fieldAccuracyFor("sport", results),
      event: fieldAccuracyFor("event", results),
      market: fieldAccuracyFor("market", results),
      selection: fieldAccuracyFor("selection", results),
      line: fieldAccuracyFor("line", results),
      odds: fieldAccuracyFor("odds", results),
      stake: fieldAccuracyFor("stake", results),
      betType: fieldAccuracyFor("type", results),
      participant: null,
    },
    criticalErrorCount,
    criticalErrorRate,
    pipelineErrorCount,
  };
}

// Re-exported so callers (runScreenshotEval.ts, tests) don't need a second
// import from caseSchema.ts just for the field-name list.
export { COMPARABLE_FIELD_NAMES };
