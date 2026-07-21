import { test } from "node:test";
import assert from "node:assert/strict";
import { buildBetSlipPreview, BetSlipValidationError } from "./buildBetSlipPreview";
import type { ParsedBetSlip } from "./betSlip";
import type { OddsVerificationInput } from "@/lib/odds/oddsVerifier";
import type { OddsCheckResult } from "@/types/oddsSnapshot";
import { verifyPreviewToken, verifyExpressPreviewToken } from "@/lib/betPreview/previewToken";

const TEST_SECRET = "test-preview-token-secret";

function verified(sourceOdds: number, submittedOdds: number, bookmaker = "Pinnacle"): OddsCheckResult {
  const discrepancyPercent = Number((((submittedOdds - sourceOdds) / sourceOdds) * 100).toFixed(2));
  return {
    matched: true,
    withinTolerance: true,
    sourceOdds,
    submittedOdds,
    discrepancyPercent,
    bookmaker,
    note: null,
  };
}

function oddsChanged(sourceOdds: number, submittedOdds: number): OddsCheckResult {
  return { ...verified(sourceOdds, submittedOdds), withinTolerance: false };
}

function notFound(submittedOdds: number): OddsCheckResult {
  return {
    matched: false,
    withinTolerance: null,
    sourceOdds: null,
    submittedOdds,
    discrepancyPercent: null,
    bookmaker: null,
    note: "No matching event found",
  };
}

// Keyed by event name so a test can control exactly what each selection's
// (fake) odds check resolves to, independent of the others.
function fakeVerifyOddsFn(byEvent: Record<string, OddsCheckResult | "reject">) {
  return async (input: OddsVerificationInput): Promise<OddsCheckResult> => {
    const outcome = byEvent[input.event];
    if (outcome === undefined) throw new Error(`No fake outcome configured for event "${input.event}"`);
    if (outcome === "reject") throw new Error(`Simulated odds-check failure for "${input.event}"`);
    return outcome;
  };
}

function singleSlip(submittedOdds: number | null): ParsedBetSlip {
  return {
    type: "SINGLE",
    stake: 75,
    selections: [
      { sport: "Football", event: "Manchester City vs Chelsea", market: null, selection: "Manchester City Win", submittedOdds },
    ],
  };
}

test("buildBetSlipPreview: SINGLE regression — token signed, totals correct, VERIFIED", async () => {
  const slip = singleSlip(1.95);
  const result = await buildBetSlipPreview(slip, "player-1", TEST_SECRET, {
    verifyOddsFn: fakeVerifyOddsFn({ "Manchester City vs Chelsea": verified(1.95, 1.95) }),
  });

  assert.equal(result.preview.type, "SINGLE");
  assert.equal(result.preview.selections.length, 1);
  assert.equal(result.preview.totalOdds, 1.95);
  assert.equal(result.preview.potentialWin, 146.25); // 75 * 1.95
  assert.equal(result.preview.selections[0].oddsStatus, "VERIFIED");
  assert.equal(typeof result.previewToken, "string");
  assert.ok(result.previewToken && result.previewToken.length > 0);
});

test("buildBetSlipPreview: SINGLE token is still redeemable via the unchanged verifyPreviewToken", async () => {
  const slip = singleSlip(1.95);
  const result = await buildBetSlipPreview(slip, "player-1", TEST_SECRET, {
    verifyOddsFn: fakeVerifyOddsFn({ "Manchester City vs Chelsea": verified(1.95, 1.95) }),
  });

  assert.ok(result.previewToken !== null);
  const verified_ = verifyPreviewToken(result.previewToken!, TEST_SECRET);
  assert.equal(verified_.ok, true);
  if (!verified_.ok) return;
  assert.equal(verified_.payload.type, "SINGLE");
  assert.equal(verified_.payload.playerId, "player-1");
  assert.equal(verified_.payload.event, "Manchester City vs Chelsea");
  assert.equal(verified_.payload.outcome, "Manchester City Win");
  assert.equal(verified_.payload.stake, 75);
});

test("buildBetSlipPreview: EXPRESS with 2 selections — matches the acceptance criteria (3.06 / 153.00), token now signed", async () => {
  const slip: ParsedBetSlip = {
    type: "EXPRESS",
    stake: 50,
    selections: [
      { sport: "Football", event: "Real Madrid vs Barcelona", market: null, selection: "Real Madrid Win", submittedOdds: 1.8 },
      { sport: "Football", event: "Inter vs Juventus", market: null, selection: "Over 2.5", submittedOdds: 1.7 },
    ],
  };

  const result = await buildBetSlipPreview(slip, "player-1", TEST_SECRET, {
    verifyOddsFn: fakeVerifyOddsFn({
      "Real Madrid vs Barcelona": verified(1.8, 1.8),
      "Inter vs Juventus": verified(1.7, 1.7),
    }),
  });

  assert.equal(result.preview.type, "EXPRESS");
  assert.equal(result.preview.selections.length, 2);
  assert.equal(result.preview.totalOdds, 3.06);
  assert.equal(result.preview.potentialWin, 153);
  assert.equal(typeof result.previewToken, "string");
  assert.ok(result.previewToken && result.previewToken.length > 0);
});

test("buildBetSlipPreview: EXPRESS token is redeemable via verifyExpressPreviewToken with the exact decimal strings and playerId/previewId set", async () => {
  const slip: ParsedBetSlip = {
    type: "EXPRESS",
    stake: 50,
    selections: [
      { sport: "Football", event: "Real Madrid vs Barcelona", market: "Match Winner", selection: "Real Madrid Win", submittedOdds: 1.8 },
      { sport: "Tennis", event: "Inter vs Juventus", market: null, selection: "Over 2.5", submittedOdds: 1.7 },
    ],
  };

  const result = await buildBetSlipPreview(slip, "player-42", TEST_SECRET, {
    verifyOddsFn: fakeVerifyOddsFn({
      "Real Madrid vs Barcelona": verified(1.8, 1.8),
      "Inter vs Juventus": verified(1.7, 1.7),
    }),
  });

  assert.ok(result.previewToken !== null);
  const verified_ = verifyExpressPreviewToken(result.previewToken!, TEST_SECRET);
  assert.equal(verified_.ok, true);
  if (!verified_.ok) return;

  const { payload } = verified_;
  assert.equal(payload.type, "EXPRESS");
  assert.equal(payload.playerId, "player-42");
  assert.equal(typeof payload.previewId, "string");
  assert.ok(payload.previewId.length > 0);
  assert.equal(payload.stake, "50"); // Prisma.Decimal(50).toString() — exact, not a re-parsed float
  assert.equal(payload.totalOdds, "3.06");
  assert.equal(payload.potentialWin, "153");
  assert.equal(payload.selections.length, 2);

  assert.equal(payload.selections[0].sport, "Football");
  assert.equal(payload.selections[0].event, "Real Madrid vs Barcelona");
  assert.equal(payload.selections[0].outcome, "Real Madrid Win");
  assert.equal(payload.selections[0].market, "Match Winner");
  assert.equal(payload.selections[0].submittedOdds, "1.8");
  assert.equal(payload.selections[0].currentOdds, "1.8");
  assert.equal(payload.selections[0].oddsStatus, "VERIFIED");

  assert.equal(payload.selections[1].sport, "Tennis");
  assert.equal(payload.selections[1].event, "Inter vs Juventus");
  assert.equal(payload.selections[1].market, null);
  assert.equal(payload.selections[1].submittedOdds, "1.7");
  assert.equal(payload.selections[1].oddsStatus, "VERIFIED");
});

test("buildBetSlipPreview: EXPRESS token's currentOdds is null for a selection whose odds check never ran", async () => {
  const slip: ParsedBetSlip = {
    type: "EXPRESS",
    stake: 40,
    selections: [
      { sport: "Football", event: "Verified Match", market: null, selection: "A Win", submittedOdds: 2.0 },
      { sport: "Football", event: "Rejected Match", market: null, selection: "D Win", submittedOdds: 1.6 },
    ],
  };

  const result = await buildBetSlipPreview(slip, "player-1", TEST_SECRET, {
    verifyOddsFn: fakeVerifyOddsFn({
      "Verified Match": verified(2.0, 2.0),
      "Rejected Match": "reject",
    }),
  });

  assert.ok(result.previewToken !== null);
  const verified_ = verifyExpressPreviewToken(result.previewToken!, TEST_SECRET);
  assert.equal(verified_.ok, true);
  if (!verified_.ok) return;

  assert.equal(verified_.payload.selections[0].currentOdds, "2");
  assert.equal(verified_.payload.selections[0].oddsStatus, "VERIFIED");
  // The rejected odds check means no sourceOdds was ever obtained — null,
  // not a stale or fabricated value — and the status reflects that too.
  assert.equal(verified_.payload.selections[1].currentOdds, null);
  assert.equal(verified_.payload.selections[1].oddsStatus, "UNAVAILABLE");
});

test("buildBetSlipPreview: EXPRESS token signed with exactly 10 selections (the maximum)", async () => {
  const events = Array.from({ length: 10 }, (_, i) => `Match ${i}`);
  const slip: ParsedBetSlip = {
    type: "EXPRESS",
    stake: 10,
    selections: events.map((event) => ({
      sport: "Football",
      event,
      market: null,
      selection: "Win",
      submittedOdds: 1.1,
    })),
  };

  const byEvent = Object.fromEntries(events.map((event) => [event, verified(1.1, 1.1)]));
  const result = await buildBetSlipPreview(slip, "player-1", TEST_SECRET, {
    verifyOddsFn: fakeVerifyOddsFn(byEvent),
  });

  assert.ok(result.previewToken !== null);
  const verified_ = verifyExpressPreviewToken(result.previewToken!, TEST_SECRET);
  assert.equal(verified_.ok, true);
  if (!verified_.ok) return;
  assert.equal(verified_.payload.selections.length, 10);
});

test("buildBetSlipPreview: EXPRESS with unknown odds still has no token (nothing valid to sign)", async () => {
  const slip: ParsedBetSlip = {
    type: "EXPRESS",
    stake: 40,
    selections: [
      { sport: "Football", event: "Known Odds", market: null, selection: "A Win", submittedOdds: 2.0 },
      { sport: "Football", event: "Unknown Odds", market: null, selection: "B Win", submittedOdds: null },
    ],
  };

  const result = await buildBetSlipPreview(slip, "player-1", TEST_SECRET, {
    verifyOddsFn: fakeVerifyOddsFn({ "Known Odds": verified(2.0, 2.0) }),
  });

  assert.equal(result.preview.totalOdds, null);
  assert.equal(result.preview.potentialWin, null);
  assert.equal(result.previewToken, null);
});

test("buildBetSlipPreview: rejects EXPRESS with 1 selection", async () => {
  const slip: ParsedBetSlip = {
    type: "EXPRESS",
    stake: 50,
    selections: [{ sport: "Football", event: "A vs B", market: null, selection: "A Win", submittedOdds: 1.5 }],
  };

  await assert.rejects(
    () => buildBetSlipPreview(slip, "player-1", TEST_SECRET, { verifyOddsFn: fakeVerifyOddsFn({}) }),
    (err: unknown) => {
      assert.ok(err instanceof BetSlipValidationError);
      assert.equal(err.code, "EXPRESS_TOO_FEW_SELECTIONS");
      return true;
    },
  );
});

test("buildBetSlipPreview: rejects EXPRESS with 11 selections", async () => {
  const slip: ParsedBetSlip = {
    type: "EXPRESS",
    stake: 50,
    selections: Array.from({ length: 11 }, (_, i) => ({
      sport: "Football",
      event: `Event ${i}`,
      market: null,
      selection: "Win",
      submittedOdds: 1.5,
    })),
  };

  await assert.rejects(
    () => buildBetSlipPreview(slip, "player-1", TEST_SECRET, { verifyOddsFn: fakeVerifyOddsFn({}) }),
    (err: unknown) => {
      assert.ok(err instanceof BetSlipValidationError);
      assert.equal(err.code, "EXPRESS_TOO_MANY_SELECTIONS");
      return true;
    },
  );
});

test("buildBetSlipPreview: one odds verification rejected -> Preview still succeeds", async () => {
  const slip: ParsedBetSlip = {
    type: "EXPRESS",
    stake: 50,
    selections: [
      { sport: "Football", event: "Real Madrid vs Barcelona", market: null, selection: "Real Madrid Win", submittedOdds: 1.8 },
      { sport: "Football", event: "Inter vs Juventus", market: null, selection: "Over 2.5", submittedOdds: 1.7 },
    ],
  };

  // Does not throw, even though one leg's check rejects.
  const result = await buildBetSlipPreview(slip, "player-1", TEST_SECRET, {
    verifyOddsFn: fakeVerifyOddsFn({
      "Real Madrid vs Barcelona": verified(1.8, 1.8),
      "Inter vs Juventus": "reject",
    }),
  });

  assert.equal(result.preview.selections.length, 2);
  assert.equal(result.preview.selections[0].oddsStatus, "VERIFIED");
  assert.equal(result.preview.selections[1].oddsStatus, "UNAVAILABLE");
  // totalOdds/potentialWin are still computed from *submitted* odds
  // regardless of verification outcome — a rejected odds check is not a
  // missing submitted odds.
  assert.equal(result.preview.totalOdds, 3.06);
  assert.equal(result.preview.potentialWin, 153);
});

test("buildBetSlipPreview: statuses are mapped independently across a mixed EXPRESS", async () => {
  const slip: ParsedBetSlip = {
    type: "EXPRESS",
    stake: 40,
    selections: [
      { sport: "Football", event: "Verified Match", market: null, selection: "A Win", submittedOdds: 2.0 },
      { sport: "Football", event: "Changed Match", market: null, selection: "B Win", submittedOdds: 1.9 },
      { sport: "Football", event: "Not Found Match", market: null, selection: "C Win", submittedOdds: 1.5 },
      { sport: "Football", event: "Rejected Match", market: null, selection: "D Win", submittedOdds: 1.6 },
    ],
  };

  const result = await buildBetSlipPreview(slip, "player-1", TEST_SECRET, {
    verifyOddsFn: fakeVerifyOddsFn({
      "Verified Match": verified(2.0, 2.0),
      "Changed Match": oddsChanged(2.5, 1.9),
      "Not Found Match": notFound(1.5),
      "Rejected Match": "reject",
    }),
  });

  const [a, b, c, d] = result.preview.selections;
  assert.equal(a.oddsStatus, "VERIFIED");
  assert.equal(b.oddsStatus, "ODDS_CHANGED");
  assert.equal(c.oddsStatus, "NOT_FOUND");
  assert.equal(d.oddsStatus, "UNAVAILABLE");

  // The signed token must carry the same four statuses per selection, not
  // just the preview response — the two are built from the same
  // previewSelections array but assigned to independently.
  assert.ok(result.previewToken !== null);
  const verified_ = verifyExpressPreviewToken(result.previewToken!, TEST_SECRET);
  assert.equal(verified_.ok, true);
  if (!verified_.ok) return;
  const [ta, tb, tc, td] = verified_.payload.selections;
  assert.equal(ta.oddsStatus, "VERIFIED");
  assert.equal(tb.oddsStatus, "ODDS_CHANGED");
  assert.equal(tc.oddsStatus, "NOT_FOUND");
  assert.equal(td.oddsStatus, "UNAVAILABLE");
});

test("buildBetSlipPreview: a selection with no submitted odds is skipped by verifyOddsFn and totals become null", async () => {
  const slip: ParsedBetSlip = {
    type: "EXPRESS",
    stake: 40,
    selections: [
      { sport: "Football", event: "Known Odds", market: null, selection: "A Win", submittedOdds: 2.0 },
      { sport: "Football", event: "Unknown Odds", market: null, selection: "B Win", submittedOdds: null },
    ],
  };

  const result = await buildBetSlipPreview(slip, "player-1", TEST_SECRET, {
    verifyOddsFn: fakeVerifyOddsFn({ "Known Odds": verified(2.0, 2.0) }),
  });

  assert.equal(result.preview.selections[1].oddsStatus, "UNAVAILABLE");
  assert.equal(result.preview.totalOdds, null);
  assert.equal(result.preview.potentialWin, null);
});
