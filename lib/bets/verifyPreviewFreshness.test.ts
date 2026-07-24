import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyPreviewFreshness } from "./verifyPreviewFreshness";
import type { PreviewTokenPayload, ExpressPreviewTokenPayload } from "@/lib/betPreview/previewToken";
import type { OddsVerificationInput } from "@/lib/odds/oddsVerifier";
import type { OddsCheckResult } from "@/types/oddsSnapshot";

// Same fixture/fake conventions as lib/bets/buildBetSlipPreview.test.ts —
// this file exercises the exact same production odds-verification pipeline
// via verifyPreviewFreshness's one call to buildBetSlipPreview(), so no
// second set of odds-comparison semantics is invented here.

const TEST_SECRET = "test-preview-token-secret-freshness";

function verified(sourceOdds: number, submittedOdds: number, bookmaker = "Pinnacle"): OddsCheckResult {
  const discrepancyPercent = Number((((submittedOdds - sourceOdds) / sourceOdds) * 100).toFixed(2));
  return { matched: true, withinTolerance: true, sourceOdds, submittedOdds, discrepancyPercent, bookmaker, note: null };
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

function fakeVerifyOddsFn(byEvent: Record<string, OddsCheckResult | "reject">) {
  return async (input: OddsVerificationInput): Promise<OddsCheckResult> => {
    const outcome = byEvent[input.event];
    if (outcome === undefined) throw new Error(`No fake outcome configured for event "${input.event}"`);
    if (outcome === "reject") throw new Error(`Simulated odds-check failure for "${input.event}"`);
    return outcome;
  };
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function singlePayload(overrides: Partial<PreviewTokenPayload> = {}): PreviewTokenPayload {
  const issuedAt = nowSeconds();
  return {
    v: 1,
    previewId: "preview-single-1",
    playerId: "player-1",
    type: "SINGLE",
    sport: "Football",
    event: "Real Madrid vs Barcelona",
    outcome: "Real Madrid",
    stake: 50,
    odds: 2.05,
    totalOdds: 2.05,
    oddsCheck: { matched: true, withinTolerance: true, sourceOdds: 2.05, bookmaker: "Pinnacle" },
    issuedAt,
    expiresAt: issuedAt + 180,
    ...overrides,
  };
}

function expressPayload(overrides: Partial<ExpressPreviewTokenPayload> = {}): ExpressPreviewTokenPayload {
  const issuedAt = nowSeconds();
  return {
    v: 1,
    previewId: "preview-express-1",
    playerId: "player-1",
    type: "EXPRESS",
    stake: "30",
    totalOdds: "3.49",
    potentialWin: "104.7",
    selections: [
      {
        sport: "Football",
        event: "Real Madrid vs Barcelona",
        outcome: "Real Madrid",
        market: null,
        submittedOdds: "1.8",
        currentOdds: "1.8",
        oddsStatus: "VERIFIED",
      },
      {
        sport: "Football",
        event: "Inter vs Juventus",
        outcome: "Juventus",
        market: null,
        submittedOdds: "1.94",
        currentOdds: "1.94",
        oddsStatus: "VERIFIED",
      },
    ],
    issuedAt,
    expiresAt: issuedAt + 180,
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/* A. SINGLE                                                                  */
/* -------------------------------------------------------------------------- */

test("verifyPreviewFreshness: SINGLE VERIFIED accepts", async () => {
  const payload = singlePayload({ odds: 2.05 });

  const decision = await verifyPreviewFreshness(payload, TEST_SECRET, {
    verifyOddsFn: fakeVerifyOddsFn({ "Real Madrid vs Barcelona": verified(2.05, 2.05) }),
  });

  assert.deepEqual(decision, { kind: "ACCEPT" });
});

test("verifyPreviewFreshness: SINGLE ODDS_CHANGED (worse) returns ODDS_CHANGED with a refreshed preview and a non-empty reconfirmable token", async () => {
  const payload = singlePayload({ odds: 2.05 });

  const decision = await verifyPreviewFreshness(payload, TEST_SECRET, {
    verifyOddsFn: fakeVerifyOddsFn({ "Real Madrid vs Barcelona": oddsChanged(1.93, 2.05) }),
  });

  assert.equal(decision.kind, "ODDS_CHANGED");
  if (decision.kind !== "ODDS_CHANGED") return;
  assert.equal(decision.refreshedPreview.selections[0].currentOdds, 1.93);
  assert.equal(decision.refreshedPreview.selections[0].oddsStatus, "ODDS_CHANGED");
  // Statically string (not string | null) — this assertion also proves the
  // runtime value actually is one, not just the type.
  assert.equal(typeof decision.refreshedPreviewToken, "string");
  assert.ok(decision.refreshedPreviewToken.length > 0);
});

test("verifyPreviewFreshness: SINGLE ODDS_CHANGED (better) is never silently accepted — still ODDS_CHANGED", async () => {
  const payload = singlePayload({ odds: 2.05 });

  const decision = await verifyPreviewFreshness(payload, TEST_SECRET, {
    verifyOddsFn: fakeVerifyOddsFn({ "Real Madrid vs Barcelona": oddsChanged(2.5, 2.05) }),
  });

  assert.equal(decision.kind, "ODDS_CHANGED");
});

test("verifyPreviewFreshness: SINGLE NOT_FOUND returns SELECTION_UNAVAILABLE, never conflated with a provider outage", async () => {
  const payload = singlePayload({ odds: 2.05 });

  const decision = await verifyPreviewFreshness(payload, TEST_SECRET, {
    verifyOddsFn: fakeVerifyOddsFn({ "Real Madrid vs Barcelona": notFound(2.05) }),
  });

  assert.deepEqual(decision, { kind: "SELECTION_UNAVAILABLE" });
});

test("verifyPreviewFreshness: SINGLE UNAVAILABLE (provider throws) returns VERIFICATION_UNAVAILABLE", async () => {
  const payload = singlePayload({ odds: 2.05 });

  const decision = await verifyPreviewFreshness(payload, TEST_SECRET, {
    verifyOddsFn: fakeVerifyOddsFn({ "Real Madrid vs Barcelona": "reject" }),
  });

  assert.deepEqual(decision, { kind: "VERIFICATION_UNAVAILABLE" });
});

test("verifyPreviewFreshness: SINGLE provider timeout returns VERIFICATION_UNAVAILABLE", async () => {
  const payload = singlePayload({ odds: 2.05 });
  const timeoutVerifyOddsFn = async (): Promise<OddsCheckResult> => {
    throw new Error("The Odds API request timed out after 8000ms");
  };

  const decision = await verifyPreviewFreshness(payload, TEST_SECRET, { verifyOddsFn: timeoutVerifyOddsFn });

  assert.deepEqual(decision, { kind: "VERIFICATION_UNAVAILABLE" });
});

// PENDING is not representable through any injectable seam: buildBetSlipPreview.ts
// always computes oddsStatus via mapOddsCheckToSelectionStatus
// (lib/odds/mapOddsStatus.ts), whose implementation is exhaustive over
// exactly four cases (null -> UNAVAILABLE; matched:false -> NOT_FOUND;
// withinTolerance -> VERIFIED; else -> ODDS_CHANGED) and never returns
// "PENDING" — confirmed by direct inspection of that file, which this step
// does not modify. Per the review's own conditional instruction ("unless
// repository types prove it is impossible in a completed preview"), no
// runtime test exists for it; STATUS_RANK still ranks it identically to
// UNAVAILABLE (rank 3) as pure defense-in-depth, in case that invariant
// ever changes.

/* -------------------------------------------------------------------------- */
/* C. Null submitted-odds semantics                                          */
/* -------------------------------------------------------------------------- */

test("verifyPreviewFreshness: null submittedOdds is exempt from gating and never produces a false ODDS_CHANGED", async () => {
  const payload = singlePayload({ odds: null, oddsCheck: null });

  // No fake outcome configured at all — buildBetSlipPreview must never even
  // attempt to verify a null-submittedOdds selection, so this test also
  // proves no provider call is made.
  const decision = await verifyPreviewFreshness(payload, TEST_SECRET, { verifyOddsFn: fakeVerifyOddsFn({}) });

  assert.deepEqual(decision, { kind: "ACCEPT" });
});

test("verifyPreviewFreshness: a null-submittedOdds leg never hides a genuine NOT_FOUND on another leg", async () => {
  const payload = expressPayload({
    selections: [
      { ...expressPayload().selections[0], submittedOdds: null, currentOdds: null, oddsStatus: "UNAVAILABLE" },
      expressPayload().selections[1],
    ],
  });

  const decision = await verifyPreviewFreshness(payload, TEST_SECRET, {
    verifyOddsFn: fakeVerifyOddsFn({ "Inter vs Juventus": notFound(1.94) }),
  });

  assert.deepEqual(decision, { kind: "SELECTION_UNAVAILABLE" });
});

test("verifyPreviewFreshness: a null-submittedOdds leg never hides a genuine UNAVAILABLE on another leg", async () => {
  const payload = expressPayload({
    selections: [
      { ...expressPayload().selections[0], submittedOdds: null, currentOdds: null, oddsStatus: "UNAVAILABLE" },
      expressPayload().selections[1],
    ],
  });

  const decision = await verifyPreviewFreshness(payload, TEST_SECRET, {
    verifyOddsFn: fakeVerifyOddsFn({ "Inter vs Juventus": "reject" }),
  });

  assert.deepEqual(decision, { kind: "VERIFICATION_UNAVAILABLE" });
});

/* -------------------------------------------------------------------------- */
/* B. EXPRESS                                                                 */
/* -------------------------------------------------------------------------- */

test("verifyPreviewFreshness: EXPRESS with every leg VERIFIED accepts", async () => {
  const payload = expressPayload();

  const decision = await verifyPreviewFreshness(payload, TEST_SECRET, {
    verifyOddsFn: fakeVerifyOddsFn({
      "Real Madrid vs Barcelona": verified(1.8, 1.8),
      "Inter vs Juventus": verified(1.94, 1.94),
    }),
  });

  assert.deepEqual(decision, { kind: "ACCEPT" });
});

test("verifyPreviewFreshness: EXPRESS with exactly one leg ODDS_CHANGED rejects the entire slip (no partial acceptance)", async () => {
  const payload = expressPayload();

  const decision = await verifyPreviewFreshness(payload, TEST_SECRET, {
    verifyOddsFn: fakeVerifyOddsFn({
      "Real Madrid vs Barcelona": verified(1.8, 1.8),
      "Inter vs Juventus": oddsChanged(2.1, 1.94),
    }),
  });

  assert.equal(decision.kind, "ODDS_CHANGED");
  if (decision.kind !== "ODDS_CHANGED") return;
  // The unchanged leg is still reported correctly in the refreshed preview
  // — the whole slip is rejected, but nothing about the other leg is lost
  // or misreported.
  assert.equal(decision.refreshedPreview.selections[0].oddsStatus, "VERIFIED");
  assert.equal(decision.refreshedPreview.selections[1].oddsStatus, "ODDS_CHANGED");
  assert.equal(typeof decision.refreshedPreviewToken, "string");
  assert.ok(decision.refreshedPreviewToken.length > 0);
});

test("verifyPreviewFreshness: EXPRESS odds changed with every leg's odds known produces a non-empty reconfirmable token", async () => {
  const payload = expressPayload();

  const decision = await verifyPreviewFreshness(payload, TEST_SECRET, {
    verifyOddsFn: fakeVerifyOddsFn({
      "Real Madrid vs Barcelona": oddsChanged(1.6, 1.8),
      "Inter vs Juventus": verified(1.94, 1.94),
    }),
  });

  assert.equal(decision.kind, "ODDS_CHANGED");
  if (decision.kind !== "ODDS_CHANGED") return;
  assert.equal(typeof decision.refreshedPreviewToken, "string");
  assert.ok(decision.refreshedPreviewToken.length > 0);
});

test("verifyPreviewFreshness: EXPRESS odds changed but no reconfirmable token can be produced (another exempt null-odds leg) returns SELECTION_UNAVAILABLE, never ODDS_CHANGED with a null token", async () => {
  // Real repository-supported case: buildBetSlipPreview only signs an
  // EXPRESS refreshedPreviewToken when EVERY selection's submittedOdds is
  // known (allOddsKnown), regardless of which selections are
  // freshness-relevant. A second, exempt (null-submittedOdds) leg alongside
  // a genuinely ODDS_CHANGED leg is exactly the scenario where odds changed
  // is detected but no signed replacement preview can exist.
  const payload = expressPayload({
    selections: [
      expressPayload().selections[0],
      { ...expressPayload().selections[1], submittedOdds: null, currentOdds: null, oddsStatus: "UNAVAILABLE" },
    ],
  });

  const decision = await verifyPreviewFreshness(payload, TEST_SECRET, {
    verifyOddsFn: fakeVerifyOddsFn({ "Real Madrid vs Barcelona": oddsChanged(1.6, 1.8) }),
  });

  assert.deepEqual(decision, { kind: "SELECTION_UNAVAILABLE" });
});

test("verifyPreviewFreshness: EXPRESS with multiple legs ODDS_CHANGED still rejects the entire slip as ODDS_CHANGED", async () => {
  const payload = expressPayload();

  const decision = await verifyPreviewFreshness(payload, TEST_SECRET, {
    verifyOddsFn: fakeVerifyOddsFn({
      "Real Madrid vs Barcelona": oddsChanged(1.6, 1.8),
      "Inter vs Juventus": oddsChanged(2.1, 1.94),
    }),
  });

  assert.equal(decision.kind, "ODDS_CHANGED");
});

test("verifyPreviewFreshness: EXPRESS with one leg NOT_FOUND returns SELECTION_UNAVAILABLE for the whole slip", async () => {
  const payload = expressPayload();

  const decision = await verifyPreviewFreshness(payload, TEST_SECRET, {
    verifyOddsFn: fakeVerifyOddsFn({
      "Real Madrid vs Barcelona": verified(1.8, 1.8),
      "Inter vs Juventus": notFound(1.94),
    }),
  });

  assert.deepEqual(decision, { kind: "SELECTION_UNAVAILABLE" });
});

test("verifyPreviewFreshness: EXPRESS with one leg UNAVAILABLE returns VERIFICATION_UNAVAILABLE for the whole slip", async () => {
  const payload = expressPayload();

  const decision = await verifyPreviewFreshness(payload, TEST_SECRET, {
    verifyOddsFn: fakeVerifyOddsFn({
      "Real Madrid vs Barcelona": verified(1.8, 1.8),
      "Inter vs Juventus": "reject",
    }),
  });

  assert.deepEqual(decision, { kind: "VERIFICATION_UNAVAILABLE" });
});

test("verifyPreviewFreshness: EXPRESS ODDS_CHANGED + NOT_FOUND resolves to SELECTION_UNAVAILABLE, never a reconfirmable refreshed preview", async () => {
  const payload = expressPayload();

  const decision = await verifyPreviewFreshness(payload, TEST_SECRET, {
    verifyOddsFn: fakeVerifyOddsFn({
      "Real Madrid vs Barcelona": oddsChanged(1.6, 1.8),
      "Inter vs Juventus": notFound(1.94),
    }),
  });

  assert.deepEqual(decision, { kind: "SELECTION_UNAVAILABLE" });
});

test("verifyPreviewFreshness: EXPRESS ODDS_CHANGED + UNAVAILABLE resolves to VERIFICATION_UNAVAILABLE, never a reconfirmable refreshed preview", async () => {
  const payload = expressPayload();

  const decision = await verifyPreviewFreshness(payload, TEST_SECRET, {
    verifyOddsFn: fakeVerifyOddsFn({
      "Real Madrid vs Barcelona": oddsChanged(1.6, 1.8),
      "Inter vs Juventus": "reject",
    }),
  });

  assert.deepEqual(decision, { kind: "VERIFICATION_UNAVAILABLE" });
});

test("verifyPreviewFreshness: EXPRESS NOT_FOUND + UNAVAILABLE resolves to VERIFICATION_UNAVAILABLE", async () => {
  const payload = expressPayload();

  const decision = await verifyPreviewFreshness(payload, TEST_SECRET, {
    verifyOddsFn: fakeVerifyOddsFn({
      "Real Madrid vs Barcelona": notFound(1.8),
      "Inter vs Juventus": "reject",
    }),
  });

  assert.deepEqual(decision, { kind: "VERIFICATION_UNAVAILABLE" });
});

test("verifyPreviewFreshness: the reconstructed slip forwards exactly sport/event/selection/odds to the provider, nothing invented", async () => {
  const payload = singlePayload({ sport: "Tennis", event: "Alcaraz vs Sinner", outcome: "Alcaraz", odds: 1.75 });
  let capturedInput: OddsVerificationInput | undefined;

  const decision = await verifyPreviewFreshness(payload, TEST_SECRET, {
    verifyOddsFn: async (input) => {
      capturedInput = input;
      return verified(1.75, 1.75);
    },
  });

  assert.deepEqual(decision, { kind: "ACCEPT" });
  // Sport casing is normalized somewhere along the existing legacy-bridge
  // translation this test deliberately doesn't re-implement or assert
  // against precisely — only that the RIGHT sport/event/selection/odds
  // reached the provider, not the exact casing convention.
  assert.equal(capturedInput?.sport.toLowerCase(), "tennis");
  assert.equal(capturedInput?.event, "Alcaraz vs Sinner");
  assert.equal(capturedInput?.selection, "Alcaraz");
  assert.equal(capturedInput?.odds, 1.75);
});
