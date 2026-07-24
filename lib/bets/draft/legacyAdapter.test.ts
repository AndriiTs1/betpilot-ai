import { test } from "node:test";
import assert from "node:assert/strict";
import { universalBetDraftToParsedBetSlip, LegacyAdapterError } from "./legacyAdapter";
import { extractedField, missingField, unsupportedField } from "./domain";
import { draft, draftEvent, draftSelection } from "./fixtures";
import { normalizeDecimalString } from "./normalize";
import { buildBetSlipPreview } from "@/lib/bets/buildBetSlipPreview";
import type { OddsCheckResult } from "@/types/oddsSnapshot";

/* -------------------------------------------------------------------------- */
/* 1. Football SINGLE with odds                                               */
/* -------------------------------------------------------------------------- */

test("adapter: football SINGLE with odds adapts to the exact ParsedBetSlip shape", () => {
  const input = draft();
  const slip = universalBetDraftToParsedBetSlip(input);

  assert.deepEqual(slip, {
    type: "SINGLE",
    stake: 50,
    selections: [
      {
        sport: "Football",
        event: "Arsenal vs Chelsea",
        market: null,
        selection: "Arsenal",
        submittedOdds: 1.95,
      },
    ],
  });
});

/* -------------------------------------------------------------------------- */
/* 2. SINGLE with null odds                                                   */
/* -------------------------------------------------------------------------- */

test("adapter: null submittedOdds adapts to null, not zero or a fabricated value", () => {
  const input = draft({ selections: [draftSelection({ submittedOdds: null })] });
  const slip = universalBetDraftToParsedBetSlip(input);

  assert.equal(slip.selections[0].submittedOdds, null);
});

/* -------------------------------------------------------------------------- */
/* 3. EXPRESS with two selections                                             */
/* -------------------------------------------------------------------------- */

test("adapter: EXPRESS with two selections adapts both legs independently, in order", () => {
  const input = draft({
    slipType: "EXPRESS",
    stake: "30",
    selections: [
      draftSelection({
        event: draftEvent({ rawText: "Real Madrid vs Barcelona", participants: [{ index: 0, rawName: "Real Madrid" }, { index: 1, rawName: "Barcelona" }] }),
        selectionRawText: "Real Madrid",
        submittedOdds: "1.8",
      }),
      draftSelection({
        event: draftEvent({ rawText: "Inter vs Juventus", participants: [{ index: 0, rawName: "Inter" }, { index: 1, rawName: "Juventus" }] }),
        selectionRawText: "Juventus",
        submittedOdds: "2.1",
      }),
    ],
  });

  const slip = universalBetDraftToParsedBetSlip(input);

  assert.equal(slip.type, "EXPRESS");
  assert.equal(slip.stake, 30);
  assert.equal(slip.selections.length, 2);
  assert.equal(slip.selections[0].event, "Real Madrid vs Barcelona");
  assert.equal(slip.selections[0].submittedOdds, 1.8);
  assert.equal(slip.selections[1].event, "Inter vs Juventus");
  assert.equal(slip.selections[1].submittedOdds, 2.1);
});

/* -------------------------------------------------------------------------- */
/* 4. Existing market:null behavior                                           */
/* -------------------------------------------------------------------------- */

test("adapter: an unextracted market (MISSING) adapts to null — matches today's hardcoded-null behavior exactly", () => {
  const input = draft({ selections: [draftSelection({ marketType: missingField() })] });
  const slip = universalBetDraftToParsedBetSlip(input);

  assert.equal(slip.selections[0].market, null);
});

test("adapter: an UNSUPPORTED market also adapts to null, never a leaked internal state name", () => {
  const input = draft({ selections: [draftSelection({ marketType: unsupportedField("Player Prop") })] });
  const slip = universalBetDraftToParsedBetSlip(input);

  assert.equal(slip.selections[0].market, null);
});

/* -------------------------------------------------------------------------- */
/* 5. Extracted moneyline market                                              */
/* -------------------------------------------------------------------------- */

test("adapter: an EXTRACTED market adapts to its raw display text", () => {
  const input = draft({
    selections: [draftSelection({ marketType: extractedField("MONEYLINE_3WAY", "Match Winner") })],
  });
  const slip = universalBetDraftToParsedBetSlip(input);

  assert.equal(slip.selections[0].market, "Match Winner");
});

/* -------------------------------------------------------------------------- */
/* 6. Unicode Russian input                                                   */
/* -------------------------------------------------------------------------- */

test("adapter: Unicode Russian sport/event/selection text passes through byte-for-byte", () => {
  const input = draft({
    selections: [
      draftSelection({
        sport: extractedField("FOOTBALL", "футбол"),
        event: draftEvent({ rawText: "Спартак - Динамо", participants: [{ index: 0, rawName: "Спартак" }, { index: 1, rawName: "Динамо" }] }),
        selectionRawText: "П1",
        submittedOdds: "2.1",
      }),
    ],
  });

  const slip = universalBetDraftToParsedBetSlip(input);

  assert.equal(slip.selections[0].sport, "футбол");
  assert.equal(slip.selections[0].event, "Спартак - Динамо");
  assert.equal(slip.selections[0].selection, "П1");
});

/* -------------------------------------------------------------------------- */
/* 7. Decimal comma normalized BEFORE adaptation (not inside the adapter)     */
/* -------------------------------------------------------------------------- */

test("adapter: a comma-formatted decimal must already be normalized upstream — the adapter itself does not understand commas", () => {
  // Demonstrates the intended pipeline ordering: normalize.ts's
  // normalizeDecimalString() converts "50,5" -> "50.5" BEFORE a draft is
  // ever constructed; the adapter only ever receives the already-dotted
  // canonical string.
  const normalizedStake = normalizeDecimalString("50,5");
  assert.equal(normalizedStake, "50.5");

  const input = draft({ stake: normalizedStake! });
  const slip = universalBetDraftToParsedBetSlip(input);
  assert.equal(slip.stake, 50.5);
});

test("adapter: a raw, un-normalized comma string reaching the adapter directly is correctly rejected, not silently misparsed", () => {
  const input = draft({ stake: "50,5" });
  assert.throws(
    () => universalBetDraftToParsedBetSlip(input),
    (err: unknown) => err instanceof LegacyAdapterError && err.code === "INVALID_STAKE",
  );
});

/* -------------------------------------------------------------------------- */
/* 8. Stake conversion                                                        */
/* -------------------------------------------------------------------------- */

test("adapter: stake converts safely from a canonical decimal string to a number", () => {
  assert.equal(universalBetDraftToParsedBetSlip(draft({ stake: "75" })).stake, 75);
  assert.equal(universalBetDraftToParsedBetSlip(draft({ stake: "75.5" })).stake, 75.5);
});

/* -------------------------------------------------------------------------- */
/* 9. Submitted-odds conversion                                               */
/* -------------------------------------------------------------------------- */

test("adapter: submittedOdds converts safely from a decimal string to a number", () => {
  const input = draft({ selections: [draftSelection({ submittedOdds: "1.95" })] });
  assert.equal(universalBetDraftToParsedBetSlip(input).selections[0].submittedOdds, 1.95);
});

/* -------------------------------------------------------------------------- */
/* 10. Invalid stake rejected                                                 */
/* -------------------------------------------------------------------------- */

test("adapter: a non-numeric stake throws LegacyAdapterError rather than producing NaN", () => {
  const input = draft({ stake: "not-a-number" });
  assert.throws(
    () => universalBetDraftToParsedBetSlip(input),
    (err: unknown) => err instanceof LegacyAdapterError && err.code === "INVALID_STAKE",
  );
});

test("adapter: an Infinity-like stake throws LegacyAdapterError rather than producing Infinity", () => {
  const input = draft({ stake: "Infinity" });
  assert.throws(
    () => universalBetDraftToParsedBetSlip(input),
    (err: unknown) => err instanceof LegacyAdapterError && err.code === "INVALID_STAKE",
  );
});

/* -------------------------------------------------------------------------- */
/* 11. Invalid odds rejected                                                  */
/* -------------------------------------------------------------------------- */

test("adapter: a non-numeric submittedOdds throws LegacyAdapterError rather than producing NaN", () => {
  const input = draft({ selections: [draftSelection({ submittedOdds: "not-a-number" })] });
  assert.throws(
    () => universalBetDraftToParsedBetSlip(input),
    (err: unknown) => err instanceof LegacyAdapterError && err.code === "INVALID_SUBMITTED_ODDS",
  );
});

test("adapter: an Infinity-like submittedOdds throws LegacyAdapterError rather than producing Infinity", () => {
  const input = draft({ selections: [draftSelection({ submittedOdds: "Infinity" })] });
  assert.throws(
    () => universalBetDraftToParsedBetSlip(input),
    (err: unknown) => err instanceof LegacyAdapterError && err.code === "INVALID_SUBMITTED_ODDS",
  );
});

/* -------------------------------------------------------------------------- */
/* 12. No league/period/line leakage into output                             */
/* -------------------------------------------------------------------------- */

test("adapter: league/period/line/warnings/confidence/participants never leak into the adapted output shape", () => {
  const input = draft({
    selections: [
      draftSelection({
        league: extractedField({ rawText: "La Liga", resolvedName: "La Liga" }, "La Liga"),
        period: extractedField("FULL_GAME", "full game"),
        line: extractedField({ rawText: "2.5", magnitude: "2.5", direction: "OVER" as const }, "Over 2.5"),
      }),
    ],
  });

  const slip = universalBetDraftToParsedBetSlip(input);

  assert.deepEqual(Object.keys(slip).sort(), ["selections", "stake", "type"]);
  assert.deepEqual(Object.keys(slip.selections[0]).sort(), ["event", "market", "selection", "sport", "submittedOdds"]);
});

/* -------------------------------------------------------------------------- */
/* 13. Draft input remains unchanged                                          */
/* -------------------------------------------------------------------------- */

test("adapter: the input draft is never mutated — frozen input survives adaptation", () => {
  const input = draft();
  const frozen = JSON.parse(JSON.stringify(input));
  Object.freeze(input);
  Object.freeze(input.selections);
  Object.freeze(input.selections[0]);

  assert.doesNotThrow(() => universalBetDraftToParsedBetSlip(input));
  assert.deepEqual(JSON.parse(JSON.stringify(input)), frozen);
});

/* -------------------------------------------------------------------------- */
/* 14. Output can be passed to buildBetSlipPreview without type or runtime    */
/* changes                                                                     */
/* -------------------------------------------------------------------------- */

test("adapter: the adapted ParsedBetSlip is directly usable by the unchanged buildBetSlipPreview()", async () => {
  const input = draft();
  const slip = universalBetDraftToParsedBetSlip(input);

  const result = await buildBetSlipPreview(slip, "player-1", "test-preview-token-secret", {
    verifyOddsFn: async (): Promise<OddsCheckResult> => ({
      matched: true,
      withinTolerance: true,
      sourceOdds: 1.95,
      submittedOdds: 1.95,
      discrepancyPercent: 0,
      bookmaker: "Pinnacle",
      note: null,
    }),
  });

  assert.equal(result.preview.type, "SINGLE");
  assert.equal(result.preview.selections[0].oddsStatus, "VERIFIED");
  assert.equal(typeof result.previewToken, "string");
});
