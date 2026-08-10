import { test } from "node:test";
import assert from "node:assert/strict";
import { compareCase, aggregateResults, type ActualPipelineResult } from "./compareResult";
import type { GroundTruthCase, GroundTruthSelection } from "./caseSchema";

// ---------------------------------------------------------------------
// These are tests of the EVAL ENGINE (compareCase/aggregateResults) — pure
// functions operating on hand-constructed inputs. No Claude, no OCR, no
// network call anywhere in this file. They prove the comparator/scorer
// itself is correct; they do NOT measure real extraction quality (that's
// runScreenshotEval.ts's job, run manually — see README.md).
// ---------------------------------------------------------------------

function selection(overrides: Partial<GroundTruthSelection> = {}): GroundTruthSelection {
  return {
    sport: "Football",
    league: "Premier League",
    event: "Arsenal vs Coventry City",
    market: "Handicap",
    selection: "Arsenal -1.5",
    odds: "1.90",
    line: "-1.5",
    ...overrides,
  };
}

function groundTruthCase(overrides: Partial<GroundTruthCase> = {}): GroundTruthCase {
  return {
    id: "case-1",
    image: "screenshots/case-1.png",
    language: "EN",
    inputType: "BOOKMAKER_SCREENSHOT",
    betType: "SINGLE",
    expected: {
      type: "SINGLE",
      stake: "100",
      selections: [selection()],
    },
    ...overrides,
  };
}

function actualSelection(overrides: Partial<{ sport: string; league: string | null; event: string; market: string | null; selection: string; submittedOdds: number | null; line: string | null }> = {}) {
  return {
    sport: "Football",
    league: "Premier League",
    event: "Arsenal vs Coventry City",
    market: "Handicap",
    selection: "Arsenal -1.5",
    submittedOdds: 1.9,
    line: "-1.5",
    ...overrides,
  };
}

function parsedResult(overrides: Partial<Extract<ActualPipelineResult, { kind: "PARSED" }>> = {}): ActualPipelineResult {
  return {
    kind: "PARSED",
    type: "SINGLE",
    stake: 100,
    selections: [actualSelection()],
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/* Required test 1: perfect match                                            */
/* -------------------------------------------------------------------------- */

test("compareCase: a perfect match is PASS with zero diffs", () => {
  const result = compareCase(groundTruthCase(), parsedResult());
  assert.equal(result.verdict, "PASS");
  assert.deepEqual(result.diffs, []);
});

/* -------------------------------------------------------------------------- */
/* Required test 2: wrong event                                              */
/* -------------------------------------------------------------------------- */

test("compareCase: wrong event is a CRITICAL_MISMATCH (event defaults critical per Section 4's own 'wrong event' danger class)", () => {
  const gt = groundTruthCase();
  const actual = parsedResult({ selections: [actualSelection({ event: "Real Madrid vs Barcelona" })] });
  const result = compareCase(gt, actual);

  assert.equal(result.verdict, "CRITICAL_MISMATCH");
  const eventDiff = result.diffs.find((d) => d.field === "event");
  assert.ok(eventDiff);
  assert.equal(eventDiff?.expected, "Arsenal vs Coventry City");
  assert.equal(eventDiff?.actual, "Real Madrid vs Barcelona");
});

/* -------------------------------------------------------------------------- */
/* Required test 3: wrong participant                                       */
/* -------------------------------------------------------------------------- */

test("compareCase: wrong participant surfaces as a selection-field diff (participant itself is not a comparable field in EVAL-1 — see caseSchema.ts's own comment)", () => {
  const gt = groundTruthCase({
    expected: { type: "SINGLE", stake: "100", selections: [selection({ selection: "Arsenal -1.5" })] },
  });
  const actual = parsedResult({ selections: [actualSelection({ selection: "Coventry City -1.5" })] });
  const result = compareCase(gt, actual);

  assert.equal(result.verdict, "CRITICAL_MISMATCH");
  const diff = result.diffs.find((d) => d.field === "selection");
  assert.equal(diff?.expected, "Arsenal -1.5");
  assert.equal(diff?.actual, "Coventry City -1.5");
});

/* -------------------------------------------------------------------------- */
/* Required test 4: wrong market                                             */
/* -------------------------------------------------------------------------- */

test("compareCase: wrong market is a CRITICAL_MISMATCH by default (market defaults critical)", () => {
  const gt = groundTruthCase();
  const actual = parsedResult({ selections: [actualSelection({ market: "Total Goals" })] });
  const result = compareCase(gt, actual);

  assert.equal(result.verdict, "CRITICAL_MISMATCH");
  const diff = result.diffs.find((d) => d.field === "market");
  assert.equal(diff?.critical, true);
});

/* -------------------------------------------------------------------------- */
/* Required test 5: -1.5 vs +1.5 (handicap sign)                             */
/* -------------------------------------------------------------------------- */

test("compareCase: line -1.5 vs +1.5 is a CRITICAL_MISMATCH — sign is never treated as equal", () => {
  const gt = groundTruthCase({ expected: { type: "SINGLE", stake: "100", selections: [selection({ line: "-1.5" })] } });
  const actual = parsedResult({ selections: [actualSelection({ line: "1.5" })] });
  const result = compareCase(gt, actual);

  assert.equal(result.verdict, "CRITICAL_MISMATCH");
  const diff = result.diffs.find((d) => d.field === "line");
  assert.equal(diff?.expected, "-1.5");
  assert.equal(diff?.actual, "1.5");
  assert.equal(diff?.critical, true);
});

test("compareCase: line comparison is Decimal-exact, not string-exact — '2.50' and '2.5' are the SAME value, not a diff", () => {
  const gt = groundTruthCase({ expected: { type: "SINGLE", stake: "100", selections: [selection({ line: "2.50" })] } });
  const actual = parsedResult({ selections: [actualSelection({ line: "2.5" })] });
  const result = compareCase(gt, actual);

  assert.equal(result.verdict, "PASS");
});

/* -------------------------------------------------------------------------- */
/* Required test 6: wrong line                                               */
/* -------------------------------------------------------------------------- */

test("compareCase: wrong line magnitude (-1.5 vs -2.5, same sign) is still a CRITICAL_MISMATCH", () => {
  const gt = groundTruthCase({ expected: { type: "SINGLE", stake: "100", selections: [selection({ line: "-1.5" })] } });
  const actual = parsedResult({ selections: [actualSelection({ line: "-2.5" })] });
  const result = compareCase(gt, actual);

  assert.equal(result.verdict, "CRITICAL_MISMATCH");
});

/* -------------------------------------------------------------------------- */
/* Required test 7: wrong odds                                               */
/* -------------------------------------------------------------------------- */

test("compareCase: wrong odds is a CRITICAL_MISMATCH, compared via Decimal not raw number equality", () => {
  const gt = groundTruthCase({ expected: { type: "SINGLE", stake: "100", selections: [selection({ odds: "1.90" })] } });
  const actual = parsedResult({ selections: [actualSelection({ submittedOdds: 2.1 })] });
  const result = compareCase(gt, actual);

  assert.equal(result.verdict, "CRITICAL_MISMATCH");
  const diff = result.diffs.find((d) => d.field === "odds");
  assert.equal(diff?.expected, "1.90");
  assert.equal(diff?.actual, "2.1");
});

test("compareCase: odds 1.90 (ground truth) vs 1.9 (actual, from numberToDecimalString) are the SAME value, not a diff", () => {
  const gt = groundTruthCase({ expected: { type: "SINGLE", stake: "100", selections: [selection({ odds: "1.90" })] } });
  const actual = parsedResult({ selections: [actualSelection({ submittedOdds: 1.9 })] });
  const result = compareCase(gt, actual);

  assert.equal(result.verdict, "PASS");
});

/* -------------------------------------------------------------------------- */
/* Required test 8: wrong stake                                              */
/* -------------------------------------------------------------------------- */

test("compareCase: wrong stake is a CRITICAL_MISMATCH", () => {
  const gt = groundTruthCase({ expected: { type: "SINGLE", stake: "100", selections: [selection()] } });
  const actual = parsedResult({ stake: 50 });
  const result = compareCase(gt, actual);

  assert.equal(result.verdict, "CRITICAL_MISMATCH");
  const diff = result.diffs.find((d) => d.field === "stake");
  assert.equal(diff?.expected, "100");
  assert.equal(diff?.actual, "50");
});

test("compareCase: stake interpreted as odds (or vice versa) is caught as two independent critical field diffs", () => {
  // Ground truth: stake 10, odds 2.49. Actual: the model swapped them.
  const gt = groundTruthCase({ expected: { type: "SINGLE", stake: "10", selections: [selection({ odds: "2.49" })] } });
  const actual = parsedResult({ stake: 2.49, selections: [actualSelection({ submittedOdds: 10 })] });
  const result = compareCase(gt, actual);

  assert.equal(result.verdict, "CRITICAL_MISMATCH");
  assert.ok(result.diffs.some((d) => d.field === "stake"));
  assert.ok(result.diffs.some((d) => d.field === "odds"));
});

/* -------------------------------------------------------------------------- */
/* Required test 9: SINGLE vs EXPRESS mismatch                               */
/* -------------------------------------------------------------------------- */

test("compareCase: SINGLE vs EXPRESS bet-type mismatch is CRITICAL", () => {
  const gt = groundTruthCase({ expected: { type: "SINGLE", stake: "100", selections: [selection()] } });
  const actual = parsedResult({ type: "EXPRESS" });
  const result = compareCase(gt, actual);

  assert.equal(result.verdict, "CRITICAL_MISMATCH");
  const diff = result.diffs.find((d) => d.field === "type");
  assert.equal(diff?.expected, "SINGLE");
  assert.equal(diff?.actual, "EXPRESS");
});

/* -------------------------------------------------------------------------- */
/* Required tests 10/11: critical vs non-critical classification             */
/* -------------------------------------------------------------------------- */

test("compareCase: a league-only difference (competition formatting) is NON_CRITICAL_MISMATCH, not CRITICAL — matches the task's own worked example", () => {
  const gt = groundTruthCase({
    expected: { type: "SINGLE", stake: "100", selections: [selection({ league: "Premier League" })] },
  });
  const actual = parsedResult({ selections: [actualSelection({ league: "EPL" })] });
  const result = compareCase(gt, actual);

  assert.equal(result.verdict, "NON_CRITICAL_MISMATCH");
  assert.equal(result.diffs.length, 1);
  assert.equal(result.diffs[0].field, "league");
  assert.equal(result.diffs[0].critical, false);
});

test("compareCase: criticalFields override elevates a normally-non-critical field to CRITICAL for a specific case", () => {
  const gt = groundTruthCase({
    expected: { type: "SINGLE", stake: "100", selections: [selection({ league: "Premier League" })] },
    criticalFields: ["league"],
  });
  const actual = parsedResult({ selections: [actualSelection({ league: "EPL" })] });
  const result = compareCase(gt, actual);

  assert.equal(result.verdict, "CRITICAL_MISMATCH");
  assert.equal(result.diffs[0].critical, true);
});

test("compareCase: text comparison is normalized (trim/case/whitespace), not raw string-exact — harmless OCR formatting noise is never a diff", () => {
  const gt = groundTruthCase({ expected: { type: "SINGLE", stake: "100", selections: [selection({ event: "Arsenal vs Coventry City" })] } });
  const actual = parsedResult({ selections: [actualSelection({ event: "  arsenal   VS   coventry city  " })] });
  const result = compareCase(gt, actual);

  assert.equal(result.verdict, "PASS");
});

/* -------------------------------------------------------------------------- */
/* Required test 12: pipeline error representation                           */
/* -------------------------------------------------------------------------- */

test("compareCase: a PIPELINE_ERROR actual result always produces verdict PIPELINE_ERROR, regardless of expected", () => {
  const gt = groundTruthCase();
  const result = compareCase(gt, { kind: "PIPELINE_ERROR", message: "OCR request timed out" });

  assert.equal(result.verdict, "PIPELINE_ERROR");
  assert.equal(result.pipelineError, "OCR request timed out");
  assert.deepEqual(result.diffs, []);
});

/* -------------------------------------------------------------------------- */
/* Rejection handling — Section 4's "unsupported market incorrectly accepted"*/
/* -------------------------------------------------------------------------- */

test("compareCase: expected=null (should be rejected) + actual REJECTED -> PASS", () => {
  const gt = groundTruthCase({ expected: null });
  const result = compareCase(gt, { kind: "REJECTED", reason: "no legible bet slip" });
  assert.equal(result.verdict, "PASS");
});

test("compareCase: expected=null (should be rejected) + actual PARSED -> CRITICAL_MISMATCH (unsupported market incorrectly accepted)", () => {
  const gt = groundTruthCase({ expected: null });
  const result = compareCase(gt, parsedResult());
  assert.equal(result.verdict, "CRITICAL_MISMATCH");
});

test("compareCase: expected a real bet + actual REJECTED -> CRITICAL_MISMATCH (a legitimate bet was wrongly declined)", () => {
  const gt = groundTruthCase();
  const result = compareCase(gt, { kind: "REJECTED", reason: "could not read stake" });
  assert.equal(result.verdict, "CRITICAL_MISMATCH");
});

/* -------------------------------------------------------------------------- */
/* EXPRESS leg count mismatches                                              */
/* -------------------------------------------------------------------------- */

test("compareCase: EXPRESS with a missing leg (actual shorter than expected) is CRITICAL_MISMATCH", () => {
  const gt = groundTruthCase({
    betType: "EXPRESS",
    expected: { type: "EXPRESS", stake: "50", selections: [selection(), selection({ event: "Real Madrid vs Barcelona", selection: "Real Madrid Win" })] },
  });
  const actual = parsedResult({ type: "EXPRESS", stake: 50, selections: [actualSelection()] });
  const result = compareCase(gt, actual);

  assert.equal(result.verdict, "CRITICAL_MISMATCH");
  const diff = result.diffs.find((d) => d.selectionIndex === 1);
  assert.equal(diff?.actual, null);
});

test("compareCase: EXPRESS with an extra/invented leg (actual longer than expected) is CRITICAL_MISMATCH", () => {
  const gt = groundTruthCase({ betType: "EXPRESS", expected: { type: "EXPRESS", stake: "50", selections: [selection()] } });
  const actual = parsedResult({
    type: "EXPRESS",
    stake: 50,
    selections: [actualSelection(), actualSelection({ event: "Real Madrid vs Barcelona", selection: "Real Madrid Win" })],
  });
  const result = compareCase(gt, actual);

  assert.equal(result.verdict, "CRITICAL_MISMATCH");
  const diff = result.diffs.find((d) => d.selectionIndex === 1);
  assert.equal(diff?.expected, null);
});

/* -------------------------------------------------------------------------- */
/* Required test 13: empty dataset                                          */
/* -------------------------------------------------------------------------- */

test("aggregateResults: an empty result set produces null metrics, never NaN or a fake 100%", () => {
  const metrics = aggregateResults([]);

  assert.equal(metrics.caseCount, 0);
  assert.equal(metrics.exactMatchAccuracy, null);
  assert.equal(metrics.criticalErrorRate, null);
  assert.equal(metrics.criticalErrorCount, 0);
  assert.equal(metrics.pipelineErrorCount, 0);
  for (const value of Object.values(metrics.fieldAccuracy)) {
    assert.equal(value, null);
  }
});

/* -------------------------------------------------------------------------- */
/* Required test 14: aggregate metric calculation                           */
/* -------------------------------------------------------------------------- */

test("aggregateResults: exact-match/critical-error rates and field accuracy are computed correctly across a mixed set", () => {
  const pass = compareCase(groundTruthCase({ id: "a" }), parsedResult());
  const criticalWrongLine = compareCase(
    groundTruthCase({ id: "b", expected: { type: "SINGLE", stake: "100", selections: [selection({ line: "-1.5" })] } }),
    parsedResult({ selections: [actualSelection({ line: "1.5" })] }),
  );
  const nonCritical = compareCase(
    groundTruthCase({ id: "c", expected: { type: "SINGLE", stake: "100", selections: [selection({ league: "Premier League" })] } }),
    parsedResult({ selections: [actualSelection({ league: "EPL" })] }),
  );
  const pipelineError = compareCase(groundTruthCase({ id: "d" }), { kind: "PIPELINE_ERROR", message: "network failure" });

  const metrics = aggregateResults([pass, criticalWrongLine, nonCritical, pipelineError]);

  assert.equal(metrics.caseCount, 4);
  // 3 comparable (pipeline error excluded from denominator), 1 PASS.
  assert.equal(metrics.exactMatchAccuracy, 1 / 3);
  assert.equal(metrics.criticalErrorCount, 1);
  assert.equal(metrics.criticalErrorRate, 1 / 3);
  assert.equal(metrics.pipelineErrorCount, 1);
  // line was wrong in exactly 1 of 3 comparable cases -> 2/3 line accuracy.
  assert.equal(metrics.fieldAccuracy.line, 2 / 3);
  // league was wrong in exactly 1 of 3 comparable cases -> 2/3 league...
  // wait, league isn't in FieldAccuracy — check event/market/etc instead.
  assert.equal(metrics.fieldAccuracy.event, 1); // event never differed
  assert.equal(metrics.fieldAccuracy.participant, null); // never computed in EVAL-1
});

test("aggregateResults: purity — same input always produces a deep-equal result", () => {
  const results = [compareCase(groundTruthCase(), parsedResult())];
  const first = aggregateResults(results);
  const second = aggregateResults(results);
  assert.deepEqual(first, second);
});
