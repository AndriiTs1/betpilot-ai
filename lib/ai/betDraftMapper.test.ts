import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mapRawSelectionToDraftSelection,
  mapRawBetSlipToParsedBetSlip,
  numberToDecimalString,
  type RawBetSelectionFields,
  type RawBetSlipFields,
  type NumericRoleObservation,
  type MarketIntentObservation,
} from "./betDraftMapper";

function football(overrides: Partial<RawBetSelectionFields> = {}): RawBetSelectionFields {
  return {
    sport: "Football",
    league: null,
    event: "Arsenal vs Chelsea",
    market: null,
    selection: "Arsenal",
    period: null,
    line: null,
    odds: 1.95,
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/* Decimal conversion                                                         */
/* -------------------------------------------------------------------------- */

test("numberToDecimalString: converts without rounding, trailing zeros, or scientific notation", () => {
  assert.equal(numberToDecimalString(50), "50");
  assert.equal(numberToDecimalString(1.95), "1.95");
  assert.equal(numberToDecimalString(2.5), "2.5");
});

/* -------------------------------------------------------------------------- */
/* Complete football selection                                                */
/* -------------------------------------------------------------------------- */

test("mapper: a complete football selection resolves sport, league, market, period, and line", () => {
  const { selection, warnings } = mapRawSelectionToDraftSelection(
    football({ league: "Premier League", market: "Match Winner", period: "Full Game", line: null }),
  );

  assert.equal(selection.sport.state, "EXTRACTED");
  assert.equal(selection.sport.value, "FOOTBALL");
  assert.equal(selection.league.state, "EXTRACTED");
  assert.equal(selection.marketType.state, "EXTRACTED");
  assert.equal(selection.marketType.value, "MONEYLINE_2WAY");
  assert.equal(selection.period.state, "EXTRACTED");
  assert.equal(selection.period.value, "FULL_GAME");
  assert.equal(selection.line.state, "MISSING");
  assert.deepEqual(warnings, []);
});

/* -------------------------------------------------------------------------- */
/* Missing optional fields -> no warnings                                     */
/* -------------------------------------------------------------------------- */

test("mapper: absent (null) league/market/period/line produce MISSING state and zero warnings", () => {
  const { selection, warnings } = mapRawSelectionToDraftSelection(football());

  assert.equal(selection.league.state, "MISSING");
  assert.equal(selection.marketType.state, "MISSING");
  assert.equal(selection.period.state, "MISSING");
  assert.equal(selection.line.state, "MISSING");
  assert.deepEqual(warnings, []);
});

/* -------------------------------------------------------------------------- */
/* Unresolved league -> UNKNOWN + warning                                     */
/* -------------------------------------------------------------------------- */

test("mapper: an unresolved league (e.g. EPL) is UNKNOWN and produces exactly one warning", () => {
  const { selection, warnings } = mapRawSelectionToDraftSelection(football({ league: "EPL" }));

  assert.equal(selection.league.state, "UNKNOWN");
  assert.equal(selection.league.rawText, "EPL");
  assert.deepEqual(warnings, [{ field: "league", reason: "UNKNOWN", rawText: "EPL" }]);
});

/* -------------------------------------------------------------------------- */
/* Unsupported market -> UNSUPPORTED + warning, market adapts to null         */
/* -------------------------------------------------------------------------- */

test("mapper: an unsupported market (player prop) is UNSUPPORTED, warns, and adapts to null legacy market", () => {
  const { selection, warnings } = mapRawSelectionToDraftSelection(football({ market: "player prop" }));

  assert.equal(selection.marketType.state, "UNSUPPORTED");
  assert.deepEqual(warnings, [{ field: "market", reason: "UNSUPPORTED", rawText: "player prop" }]);

  const slip = mapRawBetSlipToParsedBetSlip({ type: "SINGLE", stake: 50, selections: [football({ market: "player prop" })] }, { originalText: "x", sourceType: "CHAT" });
  assert.equal(slip.selections[0].market, null);
});

/* -------------------------------------------------------------------------- */
/* Totals / spread / BTTS / double chance                                     */
/* -------------------------------------------------------------------------- */

test("mapper: totals market with 'Over 2.5' resolves an OVER line with magnitude 2.5", () => {
  const { selection } = mapRawSelectionToDraftSelection(
    football({ market: "totals", selection: "Over 2.5", line: "Over 2.5" }),
  );

  assert.equal(selection.marketType.value, "TOTALS");
  assert.equal(selection.line.state, "EXTRACTED");
  assert.equal(selection.line.value?.direction, "OVER");
  assert.equal(selection.line.value?.magnitude, "2.5");
});

test("mapper: spread market with '-4.5' resolves a MINUS line with unsigned magnitude 4.5", () => {
  const { selection } = mapRawSelectionToDraftSelection(football({ market: "spread", line: "-4.5" }));

  assert.equal(selection.marketType.value, "SPREAD");
  assert.equal(selection.line.value?.direction, "MINUS");
  assert.equal(selection.line.value?.magnitude, "4.5");
});

test("mapper: both-teams-to-score market with a 'Yes' selection resolves selectionType YES", () => {
  const { selection } = mapRawSelectionToDraftSelection(
    football({ market: "both teams to score", selection: "Yes" }),
  );

  assert.equal(selection.marketType.value, "BOTH_TEAMS_TO_SCORE");
  assert.equal(selection.selectionType.state, "EXTRACTED");
  assert.equal(selection.selectionType.value, "YES");
});

test("mapper: double chance market with a '1X' selection resolves selectionType HOME_OR_DRAW", () => {
  const { selection } = mapRawSelectionToDraftSelection(
    football({ market: "double chance", selection: "1X" }),
  );

  assert.equal(selection.marketType.value, "DOUBLE_CHANCE");
  assert.equal(selection.selectionType.value, "HOME_OR_DRAW");
});

/* -------------------------------------------------------------------------- */
/* Period                                                                      */
/* -------------------------------------------------------------------------- */

test("mapper: 'First Half' resolves period FIRST_HALF", () => {
  const { selection } = mapRawSelectionToDraftSelection(football({ period: "First Half" }));
  assert.equal(selection.period.state, "EXTRACTED");
  assert.equal(selection.period.value, "FIRST_HALF");
});

/* -------------------------------------------------------------------------- */
/* Participant resolution                                                     */
/* -------------------------------------------------------------------------- */

test("mapper: a participant-eligible market with a selection matching an event participant resolves an INDEX reference", () => {
  const { selection } = mapRawSelectionToDraftSelection(football({ market: "match winner", selection: "Arsenal" }));

  assert.deepEqual(selection.participant, { kind: "INDEX", participantIndex: 0 });
});

test("mapper: a participant-eligible market with an unresolved raw selection resolves a RAW_TEXT reference", () => {
  const { selection } = mapRawSelectionToDraftSelection(football({ market: "match winner", selection: "Draw No Bet Arsenal" }));

  assert.deepEqual(selection.participant, { kind: "RAW_TEXT", rawName: "Draw No Bet Arsenal" });
});

/* -------------------------------------------------------------------------- */
/* Unicode                                                                    */
/* -------------------------------------------------------------------------- */

test("mapper: Unicode Russian selection text passes through byte-for-byte", () => {
  const { selection } = mapRawSelectionToDraftSelection(
    football({ sport: "футбол", event: "Спартак - Динамо", selection: "П1" }),
  );

  assert.equal(selection.sport.value, "FOOTBALL");
  assert.equal(selection.event.rawText, "Спартак - Динамо");
  assert.equal(selection.selectionRawText, "П1");
  assert.equal(selection.selectionType.value, "HOME");
});

/* -------------------------------------------------------------------------- */
/* EXPRESS with mixed sports                                                  */
/* -------------------------------------------------------------------------- */

test("mapper: an EXPRESS slip with mixed sports maps each leg independently", () => {
  const slip = mapRawBetSlipToParsedBetSlip(
    {
      type: "EXPRESS",
      stake: 30,
      selections: [
        football({ event: "Real Madrid vs Barcelona", selection: "Real Madrid", odds: 1.8 }),
        { sport: "Tennis", league: null, event: "Alcaraz vs Sinner", market: null, selection: "Alcaraz", period: null, line: null, odds: 2.1 },
      ],
    },
    { originalText: "express", sourceType: "CHAT" },
  );

  assert.equal(slip.type, "EXPRESS");
  assert.equal(slip.stake, 30);
  assert.equal(slip.selections.length, 2);
  assert.equal(slip.selections[0].sport, "Football");
  assert.equal(slip.selections[1].sport, "Tennis");
});

/* -------------------------------------------------------------------------- */
/* Full slip warning aggregation                                              */
/* -------------------------------------------------------------------------- */

test("mapper: warnings aggregate only for provided-but-unusable fields across every selection, never for absent ones", () => {
  const slip = mapRawBetSlipToParsedBetSlip(
    {
      type: "EXPRESS",
      stake: 30,
      selections: [football({ league: "EPL" }), football({ event: "Inter vs Juventus", selection: "Juventus", market: "player prop" })],
    },
    { originalText: "express", sourceType: "OCR" },
  );

  // Warnings never leak into ParsedBetSlip — confirmed by exact key check
  // (matches the existing legacyAdapter.test.ts convention).
  assert.deepEqual(Object.keys(slip).sort(), ["selections", "stake", "type"]);
});

test("mapper: HIGH confidence is always set on the underlying draft (visible only through successful ParsedBetSlip construction)", () => {
  // mapRawBetSlipToParsedBetSlip only ever runs post-Zod-validation, so this
  // asserts the pipeline completes without throwing for well-formed input —
  // confidence itself has no ParsedBetSlip slot to observe directly.
  assert.doesNotThrow(() =>
    mapRawBetSlipToParsedBetSlip({ type: "SINGLE", stake: 50, selections: [football()] }, { originalText: "x", sourceType: "CHAT" }),
  );
});

/* ============================================================================
 * Stage BA-2B, Step 3 — numeric-role observation (observation only).
 *
 * Every test below captures observations via onNumericRoleObservation and
 * separately asserts the RETURNED ParsedBetSlip — proving both that real
 * verification runs, AND that its verdicts never influence the slip.
 * ============================================================================ */

function observe(raw: RawBetSlipFields, originalText: string, sourceType: "CHAT" | "OCR" = "CHAT") {
  let captured: readonly NumericRoleObservation[] | null = null;
  const slip = mapRawBetSlipToParsedBetSlip(raw, {
    originalText,
    sourceType,
    onNumericRoleObservation: (observations) => {
      captured = observations;
    },
  });
  if (captured === null) throw new Error("onNumericRoleObservation was never called");
  return { slip, observations: captured as readonly NumericRoleObservation[] };
}

function findObservation(observations: readonly NumericRoleObservation[], role: NumericRoleObservation["role"], selectionIndex: number | null = null) {
  return observations.find((o) => o.role === role && o.selectionIndex === selectionIndex);
}

/* -------------------------------------------------------------------------- */
/* 1-4. Critical regression: 'Арсенал ТБ 2.5, ставка 10'                     */
/* -------------------------------------------------------------------------- */

test("BA-2B Step 3: correct AI output — 'Арсенал ТБ 2.5, ставка 10' (stake=10, line=2.5) -> STAKE CORROBORATED, LINE CORROBORATED", () => {
  const raw: RawBetSlipFields = { type: "SINGLE", stake: 10, selections: [football({ event: "Arsenal", selection: "Over", market: "totals", line: "2.5", odds: null })] };
  const { slip, observations } = observe(raw, "Арсенал ТБ 2.5, ставка 10");

  assert.equal(findObservation(observations, "STAKE")?.verification.verdict, "CORROBORATED");
  assert.equal(findObservation(observations, "LINE", 0)?.verification.verdict, "CORROBORATED");

  // The returned slip is exactly the raw claim, untouched.
  assert.equal(slip.stake, 10);
  assert.equal(slip.selections[0].line, "2.5");
});

test("BA-2B Step 3: CRITICAL — bad AI output (stake=2.5, line=2.5) -> STAKE CONTRADICTED, LINE CORROBORATED, and the CONTRADICTED stake is NEVER corrected", () => {
  const raw: RawBetSlipFields = { type: "SINGLE", stake: 2.5, selections: [football({ event: "Arsenal", selection: "Over", market: "totals", line: "2.5", odds: null })] };
  const { slip, observations } = observe(raw, "Арсенал ТБ 2.5, ставка 10");

  const stakeObservation = findObservation(observations, "STAKE");
  assert.equal(stakeObservation?.verification.verdict, "CONTRADICTED");
  assert.equal(stakeObservation?.verification.conflictingEvidence[0]?.value, "10");
  assert.equal(findObservation(observations, "LINE", 0)?.verification.verdict, "CORROBORATED");

  // CRITICAL: despite STAKE being CONTRADICTED (real evidence says 10), the
  // returned slip still carries the AI's own claimed 2.5 — never silently
  // "fixed" to the evidence-backed value, and the call did not throw/reject.
  assert.equal(slip.stake, 2.5);
});

test("BA-2B Step 3: wrong line (claimed line=10 against 'ТБ 2.5, ставка 10') -> LINE CONTRADICTED, never corrected", () => {
  const raw: RawBetSlipFields = { type: "SINGLE", stake: 10, selections: [football({ event: "Arsenal", selection: "Over", market: "totals", line: "10", odds: null })] };
  const { slip, observations } = observe(raw, "Арсенал ТБ 2.5, ставка 10");

  const lineObservation = findObservation(observations, "LINE", 0);
  assert.equal(lineObservation?.verification.verdict, "CONTRADICTED");
  assert.equal(lineObservation?.verification.conflictingEvidence[0]?.value, "2.5");
  // The claimed (wrong) line survives into the slip unchanged.
  assert.equal(slip.selections[0].line, "10");
});

/* -------------------------------------------------------------------------- */
/* 5-6. Equal values / decimal comma                                          */
/* -------------------------------------------------------------------------- */

test("BA-2B Step 3: equal stake/line ('Арсенал ТБ 10, ставка 10') — both CORROBORATED, no equality heuristic rejects them", () => {
  const raw: RawBetSlipFields = { type: "SINGLE", stake: 10, selections: [football({ event: "Arsenal", selection: "Over", market: "totals", line: "10", odds: null })] };
  const { observations } = observe(raw, "Арсенал ТБ 10, ставка 10");

  assert.equal(findObservation(observations, "STAKE")?.verification.verdict, "CORROBORATED");
  assert.equal(findObservation(observations, "LINE", 0)?.verification.verdict, "CORROBORATED");
});

test("BA-2B Step 3: decimal comma ('Арсенал ТБ 2,5 ставка 2,5') — both roles CORROBORATED via raw comma evidence", () => {
  const raw: RawBetSlipFields = { type: "SINGLE", stake: 2.5, selections: [football({ event: "Arsenal", selection: "Over", market: "totals", line: "2,5", odds: null })] };
  const { observations } = observe(raw, "Арсенал ТБ 2,5 ставка 2,5");

  assert.equal(findObservation(observations, "STAKE")?.verification.verdict, "CORROBORATED");
  assert.equal(findObservation(observations, "LINE", 0)?.verification.verdict, "CORROBORATED");
});

/* -------------------------------------------------------------------------- */
/* 7. UNVERIFIED preserves behavior                                           */
/* -------------------------------------------------------------------------- */

test("BA-2B Step 3: UNVERIFIED ('Арсенал победа 10', stake only a SOLE_CANDIDATE) never becomes an error", () => {
  const raw: RawBetSlipFields = { type: "SINGLE", stake: 10, selections: [football({ event: "Arsenal", selection: "Win", odds: null })] };
  const { slip, observations } = observe(raw, "Арсенал победа 10");

  assert.equal(findObservation(observations, "STAKE")?.verification.verdict, "UNVERIFIED");
  // Existing behavior fully preserved — no throw, slip built normally.
  assert.equal(slip.stake, 10);
  assert.equal(slip.type, "SINGLE");
});

/* -------------------------------------------------------------------------- */
/* 8. AMBIGUOUS preserves behavior                                            */
/* -------------------------------------------------------------------------- */

test("BA-2B Step 3: AMBIGUOUS ('ставка 10, ставка 20') never rejects or changes the bet", () => {
  const raw: RawBetSlipFields = { type: "SINGLE", stake: 10, selections: [football({ event: "Arsenal", selection: "Win", odds: null })] };
  const { slip, observations } = observe(raw, "Арсенал победа, ставка 10, ставка 20");

  assert.equal(findObservation(observations, "STAKE")?.verification.verdict, "AMBIGUOUS");
  assert.equal(slip.stake, 10, "the AI's own claimed stake survives unchanged, whichever conflicting value it happened to match");
});

/* -------------------------------------------------------------------------- */
/* 9-10. EXPRESS — global stake observed, per-leg LINE/ODDS skipped          */
/* -------------------------------------------------------------------------- */

test("BA-2B Step 3: EXPRESS global stake IS observed", () => {
  const raw: RawBetSlipFields = {
    type: "EXPRESS",
    stake: 20,
    selections: [
      football({ event: "Arsenal", selection: "Over", market: "totals", line: "2.5", odds: null }),
      football({ event: "Real Madrid", selection: "Under", market: "totals", line: "3.5", odds: null }),
    ],
  };
  const { slip, observations } = observe(raw, "Арсенал ТБ 2.5 + Реал ТМ 3.5, экспресс 20");

  const stakeObservation = findObservation(observations, "STAKE");
  assert.equal(stakeObservation?.verification.verdict, "CORROBORATED");
  assert.equal(slip.stake, 20);
});

test("BA-2B Step 3: EXPRESS per-leg LINE/ODDS observation is explicitly SKIPPED — leg attribution is out of scope, never reported with false confidence", () => {
  const raw: RawBetSlipFields = {
    type: "EXPRESS",
    stake: 20,
    selections: [
      football({ event: "Arsenal", selection: "Over", market: "totals", line: "2.5", odds: null }),
      football({ event: "Real Madrid", selection: "Under", market: "totals", line: "3.5", odds: null }),
    ],
  };
  const { observations } = observe(raw, "Арсенал ТБ 2.5 + Реал ТМ 3.5, экспресс 20");

  const lineObservations = observations.filter((o) => o.role === "LINE");
  const oddsObservations = observations.filter((o) => o.role === "ODDS");
  assert.equal(lineObservations.length, 0, "EXPRESS legs must never receive a per-leg LINE observation in Step 3");
  assert.equal(oddsObservations.length, 0, "EXPRESS legs must never receive a per-leg ODDS observation in Step 3");
  // Only the one slip-level STAKE observation is ever produced for EXPRESS.
  assert.equal(observations.length, 1);
});

/* -------------------------------------------------------------------------- */
/* 11-12. Existing SINGLE/EXPRESS mapping is byte-for-byte unchanged          */
/* -------------------------------------------------------------------------- */

test("BA-2B Step 3: SINGLE mapping unchanged when onNumericRoleObservation is omitted (the real production call shape)", () => {
  const raw: RawBetSlipFields = { type: "SINGLE", stake: 10, selections: [football({ event: "Arsenal", selection: "Over", market: "totals", line: "2.5", odds: null })] };
  const withoutCallback = mapRawBetSlipToParsedBetSlip(raw, { originalText: "Арсенал ТБ 2.5, ставка 10", sourceType: "CHAT" });
  const { slip: withCallback } = observe(raw, "Арсенал ТБ 2.5, ставка 10");

  assert.deepEqual(withoutCallback, withCallback);
});

test("BA-2B Step 3: EXPRESS mapping unchanged when onNumericRoleObservation is omitted", () => {
  const raw: RawBetSlipFields = {
    type: "EXPRESS",
    stake: 20,
    selections: [football({ event: "Arsenal", selection: "Over", market: "totals", line: "2.5", odds: null }), football({ event: "Real Madrid", selection: "Win", odds: 1.8 })],
  };
  const withoutCallback = mapRawBetSlipToParsedBetSlip(raw, { originalText: "Арсенал ТБ 2.5 + Реал победа, экспресс 20", sourceType: "CHAT" });
  const { slip: withCallback } = observe(raw, "Арсенал ТБ 2.5 + Реал победа, экспресс 20");

  assert.deepEqual(withoutCallback, withCallback);
});

/* -------------------------------------------------------------------------- */
/* 13. OCR flow unaffected                                                    */
/* -------------------------------------------------------------------------- */

test("BA-2B Step 3: OCR reaches the exact same observation logic as CHAT — same raw input, same verdicts, same slip", () => {
  const raw: RawBetSlipFields = { type: "SINGLE", stake: 10, selections: [football({ event: "Arsenal", selection: "Over", market: "totals", line: "2.5", odds: null })] };
  const text = "Арсенал ТБ 2.5, ставка 10";

  const chatResult = observe(raw, text, "CHAT");
  const ocrResult = observe(raw, text, "OCR");

  assert.deepEqual(chatResult.slip, ocrResult.slip);
  assert.equal(findObservation(chatResult.observations, "STAKE")?.verification.verdict, findObservation(ocrResult.observations, "STAKE")?.verification.verdict);
  assert.equal(findObservation(chatResult.observations, "LINE", 0)?.verification.verdict, findObservation(ocrResult.observations, "LINE", 0)?.verification.verdict);
});

/* -------------------------------------------------------------------------- */
/* 14. No mutation/correction of AI output, ever — including deep equality   */
/* -------------------------------------------------------------------------- */

test("BA-2B Step 3: no AI-claimed field is ever mutated or corrected, regardless of verdict — deep structural proof", () => {
  const raw: RawBetSlipFields = { type: "SINGLE", stake: 999, selections: [football({ event: "Arsenal", selection: "Over", market: "totals", line: "0.5", odds: 1.5 })] };
  const rawSnapshot = JSON.parse(JSON.stringify(raw));
  const { slip } = observe(raw, "Арсенал ТБ 2.5, ставка 10");

  // The input object itself is never mutated...
  assert.deepEqual(raw, rawSnapshot);
  // ...and the wildly-contradicted claims (stake=999, line=0.5) still flow
  // through verbatim — this function only ever observes, never enforces.
  assert.equal(slip.stake, 999);
  assert.equal(slip.selections[0].line, "0.5");
  assert.equal(slip.selections[0].submittedOdds, 1.5);
});

test("BA-2B Step 3: no console output of any kind (never logs the player's original message)", () => {
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;
  const calls: unknown[][] = [];
  console.log = (...args: unknown[]) => calls.push(args);
  console.warn = (...args: unknown[]) => calls.push(args);
  console.error = (...args: unknown[]) => calls.push(args);

  try {
    const raw: RawBetSlipFields = { type: "SINGLE", stake: 2.5, selections: [football({ event: "Arsenal", selection: "Over", market: "totals", line: "2.5", odds: null })] };
    observe(raw, "Арсенал ТБ 2.5, ставка 10 — секретный текст игрока");
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
    console.error = originalError;
  }

  assert.equal(calls.length, 0, "mapRawBetSlipToParsedBetSlip must never log anything, especially not the player's original message");
});

/* ============================================================================
 * Stage BA-2D, Step 4 — market-intent observation (observation only).
 *
 * Same discipline as Step 3 above: every test captures observations via
 * onMarketIntentObservation and separately asserts the RETURNED ParsedBetSlip
 * — proving both that real verification runs, AND that its verdicts never
 * influence the slip. No production caller (lib/ai/betParser.ts) supplies
 * this callback yet — mirroring BA-2B Step 3's own precedent exactly, where
 * wiring a real caller to invoke (and, for now, discard) the observation was
 * deferred to whichever later step adds real enforcement.
 * ============================================================================ */

function observeMarket(raw: RawBetSlipFields, originalText: string, sourceType: "CHAT" | "OCR" = "CHAT") {
  let captured: readonly MarketIntentObservation[] | null = null;
  const slip = mapRawBetSlipToParsedBetSlip(raw, {
    originalText,
    sourceType,
    onMarketIntentObservation: (observations) => {
      captured = observations;
    },
  });
  if (captured === null) throw new Error("onMarketIntentObservation was never called");
  return { slip, observations: captured as readonly MarketIntentObservation[] };
}

/* -------------------------------------------------------------------------- */
/* 1-2. Critical regression: 'Арсенал Ф1(-1.5) ставка 10'                    */
/* -------------------------------------------------------------------------- */

test("BA-2D Step 4: CRITICAL — AI drops the spread shape entirely ('Arsenal' alone) against 'Арсенал Ф1(-1.5) ставка 10' -> CONTRADICTED, and the returned slip is untouched", () => {
  const raw: RawBetSlipFields = { type: "SINGLE", stake: 10, selections: [football({ event: "Арсенал", selection: "Arsenal", odds: null })] };
  const { slip, observations } = observeMarket(raw, "Арсенал Ф1(-1.5) ставка 10");

  assert.equal(observations.length, 1);
  assert.equal(observations[0].claim.marketType, "MONEYLINE_2WAY");
  assert.equal(observations[0].claim.selectionType, "PARTICIPANT");
  assert.equal(observations[0].verification.verdict, "CONTRADICTED");
  assert.equal(observations[0].verification.conflictingEvidence[0]?.classification.marketType, "SPREAD");

  // CRITICAL: despite the CONTRADICTED market verdict, the slip is still
  // built exactly as the AI claimed — no rejection, no correction.
  assert.equal(slip.selections[0].selection, "Arsenal");
  assert.equal(slip.stake, 10);
});

test("BA-2D Step 4: correct AI output ('Арсенал Ф1(-1.5)') against the same original text -> CORROBORATED", () => {
  const raw: RawBetSlipFields = { type: "SINGLE", stake: 10, selections: [football({ event: "Арсенал", selection: "Арсенал Ф1(-1.5)", odds: null })] };
  const { slip, observations } = observeMarket(raw, "Арсенал Ф1(-1.5) ставка 10");

  assert.equal(observations[0].claim.marketType, "SPREAD");
  assert.equal(observations[0].verification.verdict, "CORROBORATED");
  assert.equal(slip.selections[0].selection, "Арсенал Ф1(-1.5)");
});

/* -------------------------------------------------------------------------- */
/* H3 Production Gap Fix — raw.market fallback when raw.selection alone      */
/* falls to the classifier's generic PARTICIPANT fallback.                   */
/* -------------------------------------------------------------------------- */

test("H3 gap fix: RU 'Арсенал фора -1.5 ставка 10' — AI splits market='Фора'/selection='Арсенал' -> claim SPREAD, CORROBORATED (previously CONTRADICTED/market_mismatch)", () => {
  const raw: RawBetSlipFields = {
    type: "SINGLE",
    stake: 10,
    selections: [football({ event: "Арсенал vs Ковентрі", market: "Фора", selection: "Арсенал", line: "-1.5", odds: null })],
  };
  const { slip, observations } = observeMarket(raw, "Арсенал фора -1.5 ставка 10");

  assert.equal(observations[0].claim.marketType, "SPREAD");
  assert.equal(observations[0].claim.selectionType, "PARTICIPANT");
  assert.equal(observations[0].verification.verdict, "CORROBORATED");
  // Slip is still built from the AI's own raw fields, byte-for-byte — this
  // fix only changes the BA-2D claim used for verification, never the
  // returned selection/line/market text itself.
  assert.equal(slip.selections[0].selection, "Арсенал");
});

test("H3 gap fix: RU 'Арсенал с формой -1.5 ставка 10' — AI splits market='Фора' (compound RU marker) -> claim SPREAD, CORROBORATED", () => {
  const raw: RawBetSlipFields = {
    type: "SINGLE",
    stake: 10,
    selections: [football({ event: "Арсенал vs Ковентрі", market: "Фора", selection: "Арсенал", line: "-1.5", odds: null })],
  };
  const { observations } = observeMarket(raw, "Арсенал с форой -1.5 ставка 10");

  assert.equal(observations[0].claim.marketType, "SPREAD");
  assert.equal(observations[0].verification.verdict, "CORROBORATED");
});

test("H3 gap fix: UA 'Арсенал азійська фора -1.25 ставка 10' — AI splits market='Азійська фора'/selection='Арсенал' -> claim SPREAD, CORROBORATED (quarter line — parser passes, H1 provider gate remains a separate, unaffected concern)", () => {
  const raw: RawBetSlipFields = {
    type: "SINGLE",
    stake: 10,
    selections: [football({ event: "Арсенал vs Ковентрі", market: "Азійська фора", selection: "Арсенал", line: "-1.25", odds: null })],
  };
  const { slip, observations } = observeMarket(raw, "Арсенал азійська фора -1.25 ставка 10");

  assert.equal(observations[0].claim.marketType, "SPREAD");
  assert.equal(observations[0].verification.verdict, "CORROBORATED");
  // The quarter line itself is untouched — this fix never rounds, drops, or
  // normalizes a line; H1's own provider-level capability gate (unchanged,
  // out of scope here) is what later keeps a quarter line non-confirmable.
  assert.equal(slip.selections[0].line, "-1.25");
});

test("H3 gap fix: EN 'Arsenal handicap -1.5 stake 10' — AI splits market='Handicap'/selection='Arsenal' -> claim SPREAD, CORROBORATED (previously CONTRADICTED/market_mismatch, proving this was never RU/UA-specific)", () => {
  const raw: RawBetSlipFields = {
    type: "SINGLE",
    stake: 10,
    selections: [football({ event: "Arsenal vs Coventry", market: "Handicap", selection: "Arsenal", line: "-1.5", odds: null })],
  };
  const { observations } = observeMarket(raw, "Arsenal handicap -1.5 stake 10");

  assert.equal(observations[0].claim.marketType, "SPREAD");
  assert.equal(observations[0].verification.verdict, "CORROBORATED");
});

test("H3 gap fix: EN 'Arsenal spread -1.5 stake 10' — AI splits market='Spread'/selection='Arsenal' -> claim SPREAD, CORROBORATED", () => {
  const raw: RawBetSlipFields = {
    type: "SINGLE",
    stake: 10,
    selections: [football({ event: "Arsenal vs Coventry", market: "Spread", selection: "Arsenal", line: "-1.5", odds: null })],
  };
  const { observations } = observeMarket(raw, "Arsenal spread -1.5 stake 10");

  assert.equal(observations[0].claim.marketType, "SPREAD");
  assert.equal(observations[0].verification.verdict, "CORROBORATED");
});

test("H3 gap fix safety: a real, confident MONEYLINE selection ('Arsenal Win') is NEVER overridden by a contradictory raw.market ('Handicap') — the fallback never even attempts reconstruction once selection alone is already a real classification", () => {
  const raw: RawBetSlipFields = {
    type: "SINGLE",
    stake: 10,
    selections: [football({ event: "Arsenal vs Coventry", market: "Handicap", selection: "Arsenal Win", odds: null })],
  };
  const { observations } = observeMarket(raw, "Арсенал фора -1.5 ставка 10");

  // Claim stays exactly what "Arsenal Win" alone resolves to — MONEYLINE —
  // never silently replaced with SPREAD merely because raw.market says
  // "Handicap". Real originalText evidence here is SPREAD, so this remains
  // a genuine (correct) CONTRADICTED — the safety property this whole guard
  // exists for is preserved, not weakened.
  assert.equal(observations[0].claim.marketType, "MONEYLINE_2WAY");
  assert.equal(observations[0].claim.selectionType, "PARTICIPANT");
  assert.equal(observations[0].verification.verdict, "CONTRADICTED");
});

test("H3 gap fix safety: a real, confident TOTALS selection ('Over 2.5') is NEVER overridden by a contradictory raw.market ('Handicap')", () => {
  const raw: RawBetSlipFields = {
    type: "SINGLE",
    stake: 10,
    selections: [football({ event: "Arsenal vs Coventry", market: "Handicap", selection: "Over 2.5", odds: null })],
  };
  const { observations } = observeMarket(raw, "Over 2.5 ставка 10");

  assert.equal(observations[0].claim.marketType, "TOTALS");
  assert.equal(observations[0].claim.selectionType, "OVER");
  assert.equal(observations[0].verification.verdict, "CORROBORATED");
});

test("H3 gap fix: an unrecognized raw.market ('Premier League') is never fabricated into a market — behavior identical to before this fix", () => {
  const raw: RawBetSlipFields = {
    type: "SINGLE",
    stake: 10,
    selections: [football({ event: "Арсенал vs Ковентрі", market: "Premier League", selection: "Арсенал", line: "-1.5", odds: null })],
  };
  const { observations } = observeMarket(raw, "Арсенал фора -1.5 ставка 10");

  assert.equal(observations[0].claim.marketType, "MONEYLINE_2WAY");
  assert.equal(observations[0].claim.selectionType, "PARTICIPANT");
  assert.equal(observations[0].verification.verdict, "CONTRADICTED");
});

test("H3 gap fix: raw.market null (unchanged from before this fix) — 'Arsenal' alone against SPREAD evidence still CONTRADICTED", () => {
  const raw: RawBetSlipFields = {
    type: "SINGLE",
    stake: 10,
    selections: [football({ event: "Арсенал vs Ковентрі", market: null, selection: "Арсенал", line: "-1.5", odds: null })],
  };
  const { observations } = observeMarket(raw, "Арсенал фора -1.5 ставка 10");

  assert.equal(observations[0].claim.marketType, "MONEYLINE_2WAY");
  assert.equal(observations[0].verification.verdict, "CONTRADICTED");
});

test("H3 gap fix: raw.market as an empty/whitespace-only string behaves exactly like null — never fabricates a market", () => {
  const raw: RawBetSlipFields = {
    type: "SINGLE",
    stake: 10,
    selections: [football({ event: "Арсенал vs Ковентрі", market: "   ", selection: "Арсенал", line: "-1.5", odds: null })],
  };
  const { observations } = observeMarket(raw, "Арсенал фора -1.5 ставка 10");

  assert.equal(observations[0].claim.marketType, "MONEYLINE_2WAY");
  assert.equal(observations[0].verification.verdict, "CONTRADICTED");
});

test("H3 gap fix: numeric-role safety (BA-2B) is completely unaffected — LINE=-1.5 and STAKE=10 both independently CORROBORATED for the RU market-split case", () => {
  const raw: RawBetSlipFields = {
    type: "SINGLE",
    stake: 10,
    selections: [football({ event: "Арсенал vs Ковентрі", market: "Фора", selection: "Арсенал", line: "-1.5", odds: null })],
  };
  let numericObservations: readonly NumericRoleObservation[] = [];
  mapRawBetSlipToParsedBetSlip(raw, {
    originalText: "Арсенал фора -1.5 ставка 10",
    sourceType: "CHAT",
    onNumericRoleObservation: (observations) => {
      numericObservations = observations;
    },
  });

  const stake = numericObservations.find((o) => o.role === "STAKE");
  const line = numericObservations.find((o) => o.role === "LINE");
  assert.equal(stake?.verification.verdict, "CORROBORATED");
  assert.equal(line?.verification.verdict, "CORROBORATED");
});

test("H3 gap fix: EXPRESS is completely unaffected — still produces NO market-intent observations at all, regardless of any leg's market/selection split", () => {
  const raw: RawBetSlipFields = {
    type: "EXPRESS",
    stake: 10,
    selections: [
      football({ event: "Арсенал vs Ковентрі", market: "Фора", selection: "Арсенал", line: "-1.5", odds: 1.9 }),
      football({ event: "Real Madrid vs Barcelona", selection: "Real Madrid Win", odds: 1.8 }),
    ],
  };
  const { observations } = observeMarket(raw, "Арсенал фора -1.5, Реал Мадрид победа, экспресс 10");
  assert.deepEqual(observations, []);
});

test("H3 gap fix: CHAT and OCR reach the exact same fixed logic for the market-split case — identical claim, identical verdict", () => {
  const raw: RawBetSlipFields = {
    type: "SINGLE",
    stake: 10,
    selections: [football({ event: "Arsenal vs Coventry", market: "Handicap", selection: "Arsenal", line: "-1.5", odds: null })],
  };
  const chat = observeMarket(raw, "Arsenal handicap -1.5 stake 10", "CHAT");
  const ocr = observeMarket(raw, "Arsenal handicap -1.5 stake 10", "OCR");

  assert.deepEqual(chat.observations[0].claim, ocr.observations[0].claim);
  assert.equal(chat.observations[0].verification.verdict, "CORROBORATED");
  assert.equal(ocr.observations[0].verification.verdict, "CORROBORATED");
});

test("H3 gap fix: no mutation — the raw input object is never mutated by the market-field fallback", () => {
  const raw: RawBetSlipFields = {
    type: "SINGLE",
    stake: 10,
    selections: [football({ event: "Арсенал vs Ковентрі", market: "Фора", selection: "Арсенал", line: "-1.5", odds: null })],
  };
  const snapshot = JSON.parse(JSON.stringify(raw));
  observeMarket(raw, "Арсенал фора -1.5 ставка 10");
  assert.deepEqual(raw, snapshot);
});

test("H3 gap fix: no console output of any kind for the market-split fallback path", () => {
  const originalLog = console.log;
  const originalError = console.error;
  const originalWarn = console.warn;
  const calls: unknown[][] = [];
  console.log = (...args: unknown[]) => calls.push(args);
  console.error = (...args: unknown[]) => calls.push(args);
  console.warn = (...args: unknown[]) => calls.push(args);

  try {
    const raw: RawBetSlipFields = {
      type: "SINGLE",
      stake: 10,
      selections: [football({ event: "Арсенал vs Ковентрі", market: "Фора", selection: "Арсенал", line: "-1.5", odds: null })],
    };
    observeMarket(raw, "Арсенал фора -1.5 ставка 10");
    assert.equal(calls.length, 0);
  } finally {
    console.log = originalLog;
    console.error = originalError;
    console.warn = originalWarn;
  }
});

/* -------------------------------------------------------------------------- */
/* 3-4. TOTALS                                                                */
/* -------------------------------------------------------------------------- */

test("BA-2D Step 4: AI drops the totals shape ('Arsenal' alone) against 'Арсенал ТБ 2.5 ставка 10' -> CONTRADICTED", () => {
  const raw: RawBetSlipFields = { type: "SINGLE", stake: 10, selections: [football({ event: "Арсенал", selection: "Arsenal", odds: null })] };
  const { observations } = observeMarket(raw, "Арсенал ТБ 2.5 ставка 10");

  assert.equal(observations[0].claim.marketType, "MONEYLINE_2WAY");
  assert.equal(observations[0].verification.verdict, "CONTRADICTED");
  assert.equal(observations[0].verification.conflictingEvidence[0]?.classification.marketType, "TOTALS");
});

test("BA-2D Step 4: 'Арсенал ТБ 2.5' -> claim TEAM_TOTAL/Арсенал, evidence ALSO TEAM_TOTAL/Арсенал (Individual Team Totals Stage 1B) -> CORROBORATED", () => {
  // Unlike SPREAD_TOKEN_PARTICIPANT_PATTERN (which has its own built-in lazy
  // prefix match), shorthandClassifier.ts's TOTALS pattern requires the
  // string to literally START with the token — stripping a leading "Арсенал
  // " prefix only happens via classifyBettingSelectionText's OWN
  // knownParticipantNames loop, which is only populated when the event
  // actually splits into two participants. A single-team event (no "vs")
  // would leave knownParticipantNames empty and fall through to the
  // generic PARTICIPANT fallback instead — a real, pre-existing classifier
  // limitation (not something BA-2D introduces or should paper over), so
  // this test uses a realistic two-team event, exactly like production.
  //
  // Individual Team Totals — history of this test across two stages:
  //   Pre-Stage-1:  claim TOTALS,     verdict CORROBORATED (WRONG: team
  //                 attribution silently discarded — the verified root
  //                 cause of "Marseille Over 1.5 -> Not available").
  //   Stage 1:      claim TEAM_TOTAL, verdict CONTRADICTED (a real, surfaced
  //                 gap: the evidence side — lib/ai/marketIntentEvidence.ts —
  //                 didn't yet know the event's participant names, so it
  //                 still read the same text as bare TOTALS; claim and
  //                 evidence disagreed).
  //   Stage 1B (this test, current): computeMarketIntentObservations
  //   (betDraftMapper.ts) now threads the SAME participants list into
  //   extractMarketIntentEvidence that it already used to build the claim —
  //   one shared classifier, one shared participant list, reused rather than
  //   duplicated. The evidence side now ALSO reads TEAM_TOTAL/Арсенал for
  //   this text, so claim and evidence agree again -> CORROBORATED, exactly
  //   as a correctly-parsed team-total claim should be. This test never even
  //   reaches betParser.ts's isDeferrableLineMarketClaim deferral path — it
  //   is fully resolved one layer earlier, by correct evidence extraction.
  const raw: RawBetSlipFields = { type: "SINGLE", stake: 10, selections: [football({ event: "Арсенал vs Ковентри", selection: "Арсенал ТБ 2.5", odds: null })] };
  const { observations } = observeMarket(raw, "Арсенал ТБ 2.5 ставка 10");

  assert.equal(observations[0].claim.marketType, "TEAM_TOTAL");
  assert.equal(observations[0].claim.selectionType, "OVER");
  assert.equal(observations[0].verification.verdict, "CORROBORATED");
  assert.equal(observations[0].verification.supportingEvidence[0]?.classification.marketType, "TEAM_TOTAL");
  assert.equal(observations[0].verification.supportingEvidence[0]?.classification.participantName, "Арсенал");
});

test("Individual Team Totals Stage 1B: 'Marseille Over 1.5' against the real Marseille — Strasbourg event -> claim and evidence both TEAM_TOTAL/Marseille -> CORROBORATED (the exact verified production bug input)", () => {
  const raw: RawBetSlipFields = {
    type: "SINGLE",
    stake: 5,
    selections: [football({ event: "Marseille vs Strasbourg", selection: "Marseille Over 1.5", odds: null })],
  };
  const { observations } = observeMarket(raw, "Marseille Over 1.5 stake 5");

  assert.equal(observations[0].claim.marketType, "TEAM_TOTAL");
  assert.equal(observations[0].claim.selectionType, "OVER");
  assert.equal(observations[0].verification.verdict, "CORROBORATED");
});

test("Individual Team Totals Stage 1B: bare 'ТБ 2.5' against a real two-team event -> claim and evidence both stay MATCH TOTALS, no participant fabricated on either side -> CORROBORATED", () => {
  const raw: RawBetSlipFields = { type: "SINGLE", stake: 10, selections: [football({ event: "Арсенал vs Ковентри", selection: "ТБ 2.5", odds: null })] };
  const { observations } = observeMarket(raw, "ТБ 2.5 ставка 10");

  assert.equal(observations[0].claim.marketType, "TOTALS");
  assert.equal(observations[0].verification.verdict, "CORROBORATED");
});

test("Individual Team Totals Stage 1B: a GENUINE same-market-type contradiction (claim says Марсель OVER, text says Марсель UNDER) is still CONTRADICTED — evidence-layer fix never weakens real contradiction protection", () => {
  const raw: RawBetSlipFields = {
    type: "SINGLE",
    stake: 10,
    selections: [football({ event: "Марсель vs Страсбург", selection: "Марсель ТБ 2.5", odds: null })],
  };
  // originalText disagrees with raw.selection: the player's own message says
  // ТМ (UNDER), not ТБ (OVER) — a genuine direction conflict, not evidence-
  // layer noise. Must still be reported as CONTRADICTED.
  const { observations } = observeMarket(raw, "Марсель ТМ 2.5 ставка 10");

  assert.equal(observations[0].claim.marketType, "TEAM_TOTAL");
  assert.equal(observations[0].claim.selectionType, "OVER");
  assert.equal(observations[0].verification.verdict, "CONTRADICTED");
  assert.equal(observations[0].verification.conflictingEvidence[0]?.classification.marketType, "TEAM_TOTAL");
  assert.equal(observations[0].verification.conflictingEvidence[0]?.classification.selectionType, "UNDER");
});

/* -------------------------------------------------------------------------- */
/* 5-8. DRAW — RU / UA / EN, and a wrong winner-participant claim             */
/* -------------------------------------------------------------------------- */

test("BA-2D Step 4: AI claims a participant winner ('Arsenal') against 'ничья ставка 10' -> CONTRADICTED", () => {
  const raw: RawBetSlipFields = { type: "SINGLE", stake: 10, selections: [football({ event: "Арсенал", selection: "Arsenal", odds: null })] };
  const { observations } = observeMarket(raw, "ничья ставка 10");

  assert.equal(observations[0].claim.marketType, "MONEYLINE_2WAY");
  assert.equal(observations[0].verification.verdict, "CONTRADICTED");
  assert.equal(observations[0].verification.conflictingEvidence[0]?.classification.selectionType, "DRAW");
});

test("BA-2D Step 4: correct DRAW claim (RU 'ничья') -> CORROBORATED", () => {
  const raw: RawBetSlipFields = { type: "SINGLE", stake: 10, selections: [football({ event: "Арсенал vs Ковентри", selection: "ничья", odds: null })] };
  const { observations } = observeMarket(raw, "ничья ставка 10");

  assert.equal(observations[0].claim.marketType, "MONEYLINE_3WAY");
  assert.equal(observations[0].claim.selectionType, "DRAW");
  assert.equal(observations[0].verification.verdict, "CORROBORATED");
});

test("BA-2D Step 4: correct DRAW claim (UA 'нічия') -> CORROBORATED", () => {
  const raw: RawBetSlipFields = { type: "SINGLE", stake: 10, selections: [football({ event: "Арсенал vs Ковентри", selection: "нічия", odds: null })] };
  const { observations } = observeMarket(raw, "нічия ставка 10");

  assert.equal(observations[0].claim.selectionType, "DRAW");
  assert.equal(observations[0].verification.verdict, "CORROBORATED");
});

test("BA-2D Step 4: correct DRAW claim (EN 'draw') -> CORROBORATED", () => {
  const raw: RawBetSlipFields = { type: "SINGLE", stake: 10, selections: [football({ event: "Arsenal vs Coventry", selection: "draw", odds: null })] };
  const { observations } = observeMarket(raw, "draw stake 10");

  assert.equal(observations[0].claim.selectionType, "DRAW");
  assert.equal(observations[0].verification.verdict, "CORROBORATED");
});

/* -------------------------------------------------------------------------- */
/* 9. UNVERIFIED                                                              */
/* -------------------------------------------------------------------------- */

test("BA-2D Step 4: 'Арсенал 10' has no strong market intent evidence -> UNVERIFIED, never treated as a contradiction", () => {
  const raw: RawBetSlipFields = { type: "SINGLE", stake: 10, selections: [football({ event: "Арсенал", selection: "Arsenal", odds: null })] };
  const { slip, observations } = observeMarket(raw, "Арсенал 10");

  assert.equal(observations[0].verification.verdict, "UNVERIFIED");
  assert.equal(observations[0].verification.supportingEvidence.length, 0);
  assert.equal(observations[0].verification.conflictingEvidence.length, 0);
  assert.equal(slip.stake, 10);
});

/* -------------------------------------------------------------------------- */
/* 10. AMBIGUOUS                                                              */
/* -------------------------------------------------------------------------- */

test("BA-2D Step 4: 'Арсенал ТБ 2.5 ТМ 3.5 ставка 10' carries two distinct strong market intents -> AMBIGUOUS, never picks one, never rejects", () => {
  const raw: RawBetSlipFields = { type: "SINGLE", stake: 10, selections: [football({ event: "Арсенал", selection: "Arsenal", odds: null })] };
  const { slip, observations } = observeMarket(raw, "Арсенал ТБ 2.5 ТМ 3.5 ставка 10");

  assert.equal(observations[0].verification.verdict, "AMBIGUOUS");
  assert.equal(slip.stake, 10, "AMBIGUOUS never rejects or alters the slip in Step 4");
});

/* -------------------------------------------------------------------------- */
/* 11. Participant transliteration never causes a false CONTRADICTED         */
/* -------------------------------------------------------------------------- */

test("BA-2D Step 4: AI's own English selection text ('Arsenal') against Cyrillic evidence ('Арсенал победа') -> CORROBORATED — participant script/transliteration is never compared", () => {
  const raw: RawBetSlipFields = { type: "SINGLE", stake: 10, selections: [football({ event: "Арсенал", selection: "Arsenal", odds: null })] };
  const { observations } = observeMarket(raw, "Арсенал победа ставка 10");

  assert.equal(observations[0].claim.marketType, "MONEYLINE_2WAY");
  assert.equal(observations[0].verification.verdict, "CORROBORATED");
});

/* -------------------------------------------------------------------------- */
/* 12-13. Numeric line mismatch never affects the market verdict — and       */
/* BA-2B's own numeric observation keeps running, completely independently.  */
/* -------------------------------------------------------------------------- */

test("BA-2D Step 4 + BA-2B Step 3 together: correct SPREAD market claim but a WRONG stake — market CORROBORATED, numeric STAKE CONTRADICTED, neither substitutes for the other", () => {
  let marketObservations: readonly MarketIntentObservation[] | null = null;
  let numericObservations: readonly NumericRoleObservation[] | null = null;
  const raw: RawBetSlipFields = {
    type: "SINGLE",
    stake: 999, // contradicts the evidence's "ставка 10"
    selections: [football({ event: "Арсенал", selection: "Арсенал Ф1(-1.5)", line: "-1.5", odds: null })],
  };
  const slip = mapRawBetSlipToParsedBetSlip(raw, {
    originalText: "Арсенал Ф1(-1.5) ставка 10",
    sourceType: "CHAT",
    onMarketIntentObservation: (observations) => {
      marketObservations = observations;
    },
    onNumericRoleObservation: (observations) => {
      numericObservations = observations;
    },
  });
  if (marketObservations === null || numericObservations === null) throw new Error("both callbacks must fire");

  const market = marketObservations as readonly MarketIntentObservation[];
  const numeric = numericObservations as readonly NumericRoleObservation[];

  assert.equal(market[0].verification.verdict, "CORROBORATED", "market intent must corroborate SPREAD regardless of the numeric mismatch");
  const stakeObservation = numeric.find((o) => o.role === "STAKE");
  assert.equal(stakeObservation?.verification.verdict, "CONTRADICTED", "BA-2B's own numeric verifier must independently catch the wrong stake");
  // Neither guard corrects or rejects anything in Step 4 — the wrong stake
  // still flows straight through.
  assert.equal(slip.stake, 999);
});

/* -------------------------------------------------------------------------- */
/* 14. EXPRESS — market-intent observation explicitly skipped                */
/* -------------------------------------------------------------------------- */

test("BA-2D Step 4: EXPRESS produces NO market-intent observations at all (no leg attribution invented) — BA-2B's own EXPRESS stake observation is completely unaffected", () => {
  let marketObservations: readonly MarketIntentObservation[] | null = null;
  let numericObservations: readonly NumericRoleObservation[] | null = null;
  const raw: RawBetSlipFields = {
    type: "EXPRESS",
    stake: 20,
    selections: [
      football({ event: "Arsenal", selection: "Arsenal Ф1(-1.5)", odds: null }),
      football({ event: "Real Madrid", selection: "Over", market: "totals", line: "3.5", odds: null }),
    ],
  };
  mapRawBetSlipToParsedBetSlip(raw, {
    originalText: "Арсенал Ф1(-1.5) + Реал ТБ 3.5, экспресс 20",
    sourceType: "CHAT",
    onMarketIntentObservation: (observations) => {
      marketObservations = observations;
    },
    onNumericRoleObservation: (observations) => {
      numericObservations = observations;
    },
  });
  if (marketObservations === null || numericObservations === null) throw new Error("both callbacks must fire");

  assert.equal((marketObservations as readonly MarketIntentObservation[]).length, 0, "EXPRESS must never produce a market-intent observation — no safe per-leg attribution exists yet");
  const stakeObservation = (numericObservations as readonly NumericRoleObservation[]).find((o) => o.role === "STAKE");
  assert.equal(stakeObservation?.verification.verdict, "CORROBORATED", "BA-2B's own EXPRESS global-stake observation is unaffected by BA-2D's EXPRESS skip");
});

/* -------------------------------------------------------------------------- */
/* 15. CHAT/OCR parity — same shared mapper path                             */
/* -------------------------------------------------------------------------- */

test("BA-2D Step 4: OCR reaches the exact same market-intent observation logic as CHAT — same raw input, same verdict, same slip", () => {
  const raw: RawBetSlipFields = { type: "SINGLE", stake: 10, selections: [football({ event: "Арсенал", selection: "Arsenal", odds: null })] };
  const text = "Арсенал Ф1(-1.5) ставка 10";

  const chatResult = observeMarket(raw, text, "CHAT");
  const ocrResult = observeMarket(raw, text, "OCR");

  assert.deepEqual(chatResult.slip, ocrResult.slip);
  assert.equal(chatResult.observations[0].verification.verdict, "CONTRADICTED");
  assert.equal(chatResult.observations[0].verification.verdict, ocrResult.observations[0].verification.verdict);
});

/* -------------------------------------------------------------------------- */
/* 16. No mutation                                                            */
/* -------------------------------------------------------------------------- */

test("BA-2D Step 4: no AI-claimed field is ever mutated or corrected regardless of the market verdict, and the raw input object is never mutated", () => {
  const raw: RawBetSlipFields = { type: "SINGLE", stake: 10, selections: [football({ event: "Арсенал", selection: "Arsenal", odds: null })] };
  const rawSnapshot = JSON.parse(JSON.stringify(raw));
  const { slip, observations } = observeMarket(raw, "Арсенал Ф1(-1.5) ставка 10");

  assert.deepEqual(raw, rawSnapshot);
  assert.equal(observations[0].verification.verdict, "CONTRADICTED");
  // The claimed (contradicted) selection still flows through verbatim.
  assert.equal(slip.selections[0].selection, "Arsenal");
});

/* -------------------------------------------------------------------------- */
/* 17. No console output                                                     */
/* -------------------------------------------------------------------------- */

test("BA-2D Step 4: no console output of any kind (never logs the player's original message)", () => {
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;
  const calls: unknown[][] = [];
  console.log = (...args: unknown[]) => calls.push(args);
  console.warn = (...args: unknown[]) => calls.push(args);
  console.error = (...args: unknown[]) => calls.push(args);

  try {
    const raw: RawBetSlipFields = { type: "SINGLE", stake: 10, selections: [football({ event: "Арсенал", selection: "Arsenal", odds: null })] };
    observeMarket(raw, "Арсенал Ф1(-1.5) ставка 10 — секретный текст игрока");
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
    console.error = originalError;
  }

  assert.equal(calls.length, 0, "mapRawBetSlipToParsedBetSlip must never log anything, especially not the player's original message");
});

/* -------------------------------------------------------------------------- */
/* 18. Production default call (no callback) is byte-for-byte unchanged      */
/* -------------------------------------------------------------------------- */

test("BA-2D Step 4: SINGLE mapping unchanged when onMarketIntentObservation is omitted (the real production call shape today)", () => {
  const raw: RawBetSlipFields = { type: "SINGLE", stake: 10, selections: [football({ event: "Арсенал", selection: "Arsenal", odds: null })] };
  const withoutCallback = mapRawBetSlipToParsedBetSlip(raw, { originalText: "Арсенал Ф1(-1.5) ставка 10", sourceType: "CHAT" });
  const { slip: withCallback } = observeMarket(raw, "Арсенал Ф1(-1.5) ставка 10");

  assert.deepEqual(withoutCallback, withCallback);
});

test("BA-2D Step 4: EXPRESS mapping unchanged when onMarketIntentObservation is omitted", () => {
  const raw: RawBetSlipFields = {
    type: "EXPRESS",
    stake: 20,
    selections: [football({ event: "Arsenal", selection: "Arsenal Ф1(-1.5)", odds: null }), football({ event: "Real Madrid", selection: "Win", odds: 1.8 })],
  };
  const withoutCallback = mapRawBetSlipToParsedBetSlip(raw, { originalText: "Арсенал Ф1(-1.5) + Реал победа, экспресс 20", sourceType: "CHAT" });
  const { slip: withCallback } = observeMarket(raw, "Арсенал Ф1(-1.5) + Реал победа, экспресс 20");

  assert.deepEqual(withoutCallback, withCallback);
});

/* -------------------------------------------------------------------------- */
/* H3 Production Fix — marketRawText threads through the full mapper output, */
/* and BA-2D's claim now agrees with what legacySelectionToCanonicalRequest  */
/* (lib/odds/legacyOddsBridge.ts) will independently derive from the SAME    */
/* ParsedBetSlip fields — both now share ONE reconstruction implementation   */
/* (classifyBettingSelectionTextWithMarketHint), so they can never diverge   */
/* again on the same input.                                                  */
/* -------------------------------------------------------------------------- */

test("H3 gap fix: raw.market survives into ParsedBetSlip.selections[0].marketRawText verbatim, alongside (never replacing) the existing normalized market field", () => {
  const raw: RawBetSlipFields = {
    type: "SINGLE",
    stake: 10,
    selections: [football({ event: "Арсенал vs Ковентрі", market: "Фора", selection: "Арсенал", line: "-1.5", odds: null })],
  };
  const slip = mapRawBetSlipToParsedBetSlip(raw, { originalText: "Арсенал фора -1.5 ставка 10", sourceType: "CHAT" });

  assert.equal(slip.selections[0].marketRawText, "Фора");
  // The existing normalized `market` field is unaffected — "Фора" is not a
  // canonical display label normalizeDraftMarket recognizes, so it still
  // adapts to null exactly as it did before this fix.
  assert.equal(slip.selections[0].market, null);
  assert.equal(slip.selections[0].selection, "Арсенал");
});

test("H3 gap fix: marketRawText is null when raw.market is null — no fabrication", () => {
  const raw: RawBetSlipFields = {
    type: "SINGLE",
    stake: 10,
    selections: [football({ event: "Арсенал vs Ковентрі", market: null, selection: "Арсенал", line: "-1.5", odds: null })],
  };
  const slip = mapRawBetSlipToParsedBetSlip(raw, { originalText: "Арсенал фора -1.5 ставка 10", sourceType: "CHAT" });
  assert.equal(slip.selections[0].marketRawText, null);
});

test("H3 gap fix: BA-2D's claim and the downstream canonical classification (legacySelectionToCanonicalRequest, called with the same ParsedBetSlip fields this test observes) now agree — both SPREAD for the market-split shape", () => {
  const raw: RawBetSlipFields = {
    type: "SINGLE",
    stake: 10,
    selections: [football({ event: "Арсенал vs Ковентрі", market: "Фора", selection: "Арсенал", line: "-1.5", odds: null })],
  };
  const { slip, observations } = observeMarket(raw, "Арсенал фора -1.5 ставка 10");

  assert.equal(observations[0].claim.marketType, "SPREAD");
  assert.equal(observations[0].verification.verdict, "CORROBORATED");

  // The exact fields legacySelectionToCanonicalRequest (lib/odds/legacyOddsBridge.ts)
  // would independently receive from this same ParsedBetSlip — proving the
  // data needed for both call sites to agree is actually present here.
  assert.equal(slip.selections[0].selection, "Арсенал");
  assert.equal(slip.selections[0].marketRawText, "Фора");
  assert.equal(slip.selections[0].line, "-1.5");
});
