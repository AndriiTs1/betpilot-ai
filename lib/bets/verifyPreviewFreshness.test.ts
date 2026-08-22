import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyPreviewFreshness, decideFreshnessOutcome, reconstructParsedBetSlip } from "./verifyPreviewFreshness";
import type { PreviewTokenPayload, ExpressPreviewTokenPayload } from "@/lib/betPreview/previewToken";
import type { OddsVerificationInput, TotalsVerificationInput, SpreadVerificationInput, TeamTotalVerificationInput } from "@/lib/odds/oddsVerifier";
import type { OddsCheckResult } from "@/types/oddsSnapshot";
import type { BetSlipPreview } from "./buildBetSlipPreview";
import { TheOddsApiProvider } from "@/lib/odds/theOddsApiProvider";
import { OddsVerificationService } from "@/lib/odds/oddsVerificationService";

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
    // Stage 4.2B1 — matches the exact shape the real verifyOdds() produces
    // so TheOddsApiProvider's classifyLegacyFailureNote() classifies this
    // as a genuine EVENT_NOT_FOUND (-> NOT_FOUND), not its defensive
    // PROVIDER_UNAVAILABLE fallback (-> UNAVAILABLE) for an unrecognized
    // note shape — this fixture simulates a real "not found".
    note: 'No matching event found for "Test Event" in soccer_epl',
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
    acceptedOdds: 2.05,
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

// Stage M4.8 (Phase 5) — the existing, unmodified 3% tolerance is preserved,
// but now applied against acceptedOdds (the current preview's own baseline,
// 2.04), never the original screenshot/reference odds. Both cases here use
// a SINGLE payload whose `odds` (screenshot reference, 2.16) deliberately
// differs from `acceptedOdds` (2.04) — if the comparison were still using
// `odds`, both cases below would come out differently (2.16 vs 2.03 is a
// ~6.4% move — ODDS_CHANGED; 2.16 vs 1.80 is a much larger move — also
// ODDS_CHANGED either way, so a regression here specifically requires
// checking discrepancyPercent, not just the final kind — see the dedicated
// "reconstructed slip forwards... acceptedOdds" test above for the direct
// proof of which value is forwarded).
test("verifyPreviewFreshness: preview acceptedOdds 2.04, provider 2.03 (within the existing 3% tolerance, ~0.49% off) — accepted", async () => {
  const payload = singlePayload({ odds: 2.16, acceptedOdds: 2.04 });

  const decision = await verifyPreviewFreshness(payload, TEST_SECRET, {
    verifyOddsFn: fakeVerifyOddsFn({ "Real Madrid vs Barcelona": verified(2.03, 2.04) }),
  });

  assert.deepEqual(decision, { kind: "ACCEPT" });
});

test("verifyPreviewFreshness: preview acceptedOdds 2.04, provider 1.80 (well beyond the existing 3% tolerance) — reconfirmation required", async () => {
  const payload = singlePayload({ odds: 2.16, acceptedOdds: 2.04 });

  const decision = await verifyPreviewFreshness(payload, TEST_SECRET, {
    verifyOddsFn: fakeVerifyOddsFn({ "Real Madrid vs Barcelona": oddsChanged(1.8, 2.04) }),
  });

  assert.equal(decision.kind, "ODDS_CHANGED");
  if (decision.kind !== "ODDS_CHANGED") return;
  assert.equal(decision.refreshedPreview.selections[0].currentOdds, 1.8);
});

test("verifyPreviewFreshness: SINGLE NOT_FOUND returns SELECTION_UNAVAILABLE — the provider never confirmed this event/market, so it must never become a Bet", async () => {
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
// "PENDING" — confirmed by direct inspection of that file. No
// integration-style test (one that goes through verifyPreviewFreshness's
// real buildBetSlipPreview() call) can exercise it, so this instead
// unit-tests the exported decideFreshnessOutcome() directly with a
// synthetic "PENDING" status — it's ranked identically to UNAVAILABLE (both
// resolve to VERIFICATION_UNAVAILABLE) as pure defense-in-depth, in case
// that invariant ever changes.
test("decideFreshnessOutcome: PENDING resolves to VERIFICATION_UNAVAILABLE (unreachable via the real pipeline today, defense-in-depth)", () => {
  const dummyPreview: BetSlipPreview = { type: "SINGLE", stake: 50, totalOdds: null, potentialWin: null, selections: [] };

  const decision = decideFreshnessOutcome(["PENDING"], dummyPreview, null);

  assert.deepEqual(decision, { kind: "VERIFICATION_UNAVAILABLE" });
});

/* -------------------------------------------------------------------------- */
/* C. Null submitted-odds semantics                                          */
/* -------------------------------------------------------------------------- */

test("verifyPreviewFreshness: null submittedOdds is exempt from gating and never produces a false ODDS_CHANGED", async () => {
  const payload = singlePayload({ odds: null, acceptedOdds: null, oddsCheck: null });

  // No fake outcome configured at all — buildBetSlipPreview must never even
  // attempt to verify a null-submittedOdds selection, so this test also
  // proves no provider call is made.
  const decision = await verifyPreviewFreshness(payload, TEST_SECRET, { verifyOddsFn: fakeVerifyOddsFn({}) });

  assert.deepEqual(decision, { kind: "ACCEPT" });
});

// Stage M4.8 regression guard — the exact safety hazard the acceptedOdds
// fix had to avoid introducing: a selection that HAD a real player
// reference price (odds non-null) but genuinely couldn't be matched
// (NOT_FOUND, so acceptedOdds is null) must still be gated as
// SELECTION_UNAVAILABLE — never silently exempted from relevantStatuses and
// defaulted to ACCEPT just because its CURRENT price happens to be null.
test("verifyPreviewFreshness: a real reference price with no confirmable current price (NOT_FOUND) is still gated — never silently exempted and ACCEPTed", async () => {
  const payload = singlePayload({ odds: 2.16, acceptedOdds: null });

  const decision = await verifyPreviewFreshness(payload, TEST_SECRET, {
    verifyOddsFn: fakeVerifyOddsFn({ "Real Madrid vs Barcelona": notFound(2.16) }),
  });

  assert.deepEqual(decision, { kind: "SELECTION_UNAVAILABLE" });
});

test("verifyPreviewFreshness: a null-submittedOdds leg is exempted, but does not hide a genuine NOT_FOUND on another relevant leg", async () => {
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

test("verifyPreviewFreshness: EXPRESS odds changed alongside another exempt null-odds leg still returns a reconfirmable ODDS_CHANGED (Sector 1 correction, ADR-0002)", async () => {
  // Sector 1 correction — buildBetSlipPreview.ts now signs an EXPRESS
  // token whenever the slip is structurally valid, regardless of
  // allOddsKnown (previously, this exempt leg alone was enough to keep
  // refreshedPreviewToken null for the whole slip, forcing this scenario
  // into decideFreshnessOutcome's null-token SELECTION_UNAVAILABLE
  // fallback). That fallback is still correct code — it's just no longer
  // reachable for EXPRESS, since a token is always produced now.
  const payload = expressPayload({
    selections: [
      expressPayload().selections[0],
      { ...expressPayload().selections[1], submittedOdds: null, currentOdds: null, oddsStatus: "UNAVAILABLE" },
    ],
  });

  const decision = await verifyPreviewFreshness(payload, TEST_SECRET, {
    verifyOddsFn: fakeVerifyOddsFn({ "Real Madrid vs Barcelona": oddsChanged(1.6, 1.8) }),
  });

  assert.equal(decision.kind, "ODDS_CHANGED");
  if (decision.kind !== "ODDS_CHANGED") return;
  assert.equal(typeof decision.refreshedPreviewToken, "string");
  assert.ok(decision.refreshedPreviewToken.length > 0);
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

test("verifyPreviewFreshness: EXPRESS NOT_FOUND + VERIFIED returns SELECTION_UNAVAILABLE for the whole slip — one unconfirmed leg blocks the entire bet", async () => {
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

test("verifyPreviewFreshness: EXPRESS ODDS_CHANGED + NOT_FOUND now resolves to a reconfirmable ODDS_CHANGED (Sector 1 correction, ADR-0002) — but the refreshed preview itself is still NOT confirmable, because the NOT_FOUND leg is still present", async () => {
  // Before this correction, buildBetSlipPreview.ts kept refreshedPreviewToken
  // null whenever ANY leg was unverified, which forced this exact mix into
  // decideFreshnessOutcome's null-token SELECTION_UNAVAILABLE fallback — a
  // hard stop with no way to recover except restarting the whole EXPRESS.
  // Now a token always exists, so the player gets a real, usable reference
  // to this exact slip — but this does NOT mean the bet became confirmable:
  // the refreshed preview still has the NOT_FOUND leg, so
  // canConfirmBetSlip.ts's hasUnverifiedOddsStatus still blocks Confirm on
  // it (proven below, not just asserted by name). Recovering from here
  // requires Sector 1 exclusion (lib/bets/buildExpressLegExclusionPreview.ts)
  // on this exact refreshedPreviewToken, not a plain Confirm tap.
  const payload = expressPayload();

  const decision = await verifyPreviewFreshness(payload, TEST_SECRET, {
    verifyOddsFn: fakeVerifyOddsFn({
      "Real Madrid vs Barcelona": oddsChanged(1.6, 1.8),
      "Inter vs Juventus": notFound(1.94),
    }),
  });

  assert.equal(decision.kind, "ODDS_CHANGED");
  if (decision.kind !== "ODDS_CHANGED") return;
  assert.equal(typeof decision.refreshedPreviewToken, "string");
  assert.ok(decision.refreshedPreviewToken.length > 0);

  // Confirm gate proof: totalOdds/potentialWin are null (one leg still
  // unresolved) — the presence of a signed token never implies these are
  // known, and never bypasses the oddsStatus-based confirm gate.
  assert.equal(decision.refreshedPreview.totalOdds, null);
  assert.equal(decision.refreshedPreview.potentialWin, null);
  assert.deepEqual(
    decision.refreshedPreview.selections.map((s) => s.oddsStatus),
    ["ODDS_CHANGED", "NOT_FOUND"],
  );
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

// Stage M4.8 — EXPRESS's own version of the SINGLE proof above: each leg's
// submittedOdds (a stale screenshot reference) and currentOdds (the price
// actually shown for that leg in the preview being confirmed) are
// deliberately different, so this proves the reconstructed slip forwards
// currentOdds — never submittedOdds — as each leg's comparison baseline.
test("verifyPreviewFreshness: EXPRESS forwards each leg's currentOdds (never its stale submittedOdds) as the comparison baseline", async () => {
  const payload = expressPayload({
    selections: [
      { ...expressPayload().selections[0], submittedOdds: "2.16", currentOdds: "1.8" },
      { ...expressPayload().selections[1], submittedOdds: "2.30", currentOdds: "1.94" },
    ],
  });
  const capturedOdds: Record<string, number | null> = {};

  const decision = await verifyPreviewFreshness(payload, TEST_SECRET, {
    verifyOddsFn: async (input) => {
      capturedOdds[input.event] = input.odds;
      return verified(input.event === "Real Madrid vs Barcelona" ? 1.8 : 1.94, input.odds ?? 0);
    },
  });

  assert.deepEqual(decision, { kind: "ACCEPT" });
  assert.equal(capturedOdds["Real Madrid vs Barcelona"], 1.8, "must forward currentOdds (1.8), never submittedOdds (2.16)");
  assert.equal(capturedOdds["Inter vs Juventus"], 1.94, "must forward currentOdds (1.94), never submittedOdds (2.30)");
});

// Stage M4.8 — rewritten: odds (2.16, a stale screenshot reference) and
// acceptedOdds (1.75, the current price actually shown in the preview being
// confirmed) are deliberately DIFFERENT values here, so this test can prove
// exactly which one the reconstructed slip forwards as the freshness
// comparison baseline. A regression back to forwarding `odds` would send
// 2.16 to the provider and fail this assertion loudly.
test("verifyPreviewFreshness: the reconstructed slip forwards sport/event/selection unchanged, and acceptedOdds (never the stale odds/reference field) as the comparison baseline", async () => {
  const payload = singlePayload({
    sport: "Tennis",
    event: "Alcaraz vs Sinner",
    outcome: "Alcaraz",
    odds: 2.16,
    acceptedOdds: 1.75,
  });
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
  assert.equal(capturedInput?.odds, 1.75, "must forward acceptedOdds (1.75), never the stale odds/reference field (2.16)");
});

/* -------------------------------------------------------------------------- */
/* D. Individual Team Totals, Stage 5A — confirm-time reconstruction         */
/* -------------------------------------------------------------------------- */
//
// Root-cause fixture (real production bug): the player's PREVIEW-time
// selection text named the team as they typed it ("Интер"), but by the time
// Confirm re-verifies freshness, the token's `event` field has already been
// rewritten to the odds provider's own team names (formatFullEventName's
// substitution — "Интер vs Монца" -> "Inter Milan — Monza"). Re-classifying
// the ORIGINAL free text against that already-substituted event string is
// exactly what silently turned a verified TEAM_TOTAL selection into a
// fabricated MONEYLINE_2WAY one before this stage's fix.
//
// Every test below wires a REAL TheOddsApiProvider (via OddsVerificationService)
// with independently-capturing fakes for each of its four DI seams, so a
// selection reaching the wrong verifier function fails loudly — this is the
// "trace the reconstructed request all the way into TheOddsApiProvider and
// prove the correct verifier is selected" proof, not just an assertion on
// reconstructParsedBetSlip's return shape.

function capturingVerifyOddsFn(result: OddsCheckResult) {
  const calls: OddsVerificationInput[] = [];
  const fn = async (input: OddsVerificationInput): Promise<OddsCheckResult> => {
    calls.push(input);
    return result;
  };
  return { fn, calls };
}

function capturingVerifyTotalsOddsFn(result: OddsCheckResult) {
  const calls: TotalsVerificationInput[] = [];
  const fn = async (input: TotalsVerificationInput): Promise<OddsCheckResult> => {
    calls.push(input);
    return result;
  };
  return { fn, calls };
}

function capturingVerifySpreadOddsFn(result: OddsCheckResult) {
  const calls: SpreadVerificationInput[] = [];
  const fn = async (input: SpreadVerificationInput): Promise<OddsCheckResult> => {
    calls.push(input);
    return result;
  };
  return { fn, calls };
}

function capturingVerifyTeamTotalsOddsFn(result: OddsCheckResult) {
  const calls: TeamTotalVerificationInput[] = [];
  const fn = async (input: TeamTotalVerificationInput): Promise<OddsCheckResult> => {
    calls.push(input);
    return result;
  };
  return { fn, calls };
}

// Test A — RU TEAM_TOTAL OVER, full Preview -> signed token -> Confirm
// freshness path. The token's own `outcome`/`event` fields are exactly the
// real production values (comma-decimal RU shorthand text, provider-
// substituted event) — proving the fix works through decideFreshnessOutcome
// too, not merely through reconstructParsedBetSlip in isolation.
test("verifyPreviewFreshness (Stage 5A): RU TEAM_TOTAL OVER ('Интер ТБ 1,5') reconstructs to TEAM_TOTAL/Интер/OVER/1.5 and routes to the team-total verifier, never MONEYLINE — full token path", async () => {
  const payload = singlePayload({
    sport: "Football",
    event: "Inter Milan — Monza",
    outcome: "Интер ТБ 1,5",
    odds: 1.27,
    acceptedOdds: 1.27,
    canonicalMarketType: "TEAM_TOTAL",
    canonicalSelectionType: "OVER",
    canonicalParticipant: "Интер",
    canonicalLine: "1.5",
  });

  const { fn: h2hFn, calls: h2hCalls } = capturingVerifyOddsFn(verified(1.27, 1.27));
  const { fn: teamTotalFn, calls: teamTotalCalls } = capturingVerifyTeamTotalsOddsFn(verified(1.27, 1.27));
  const provider = new TheOddsApiProvider(h2hFn, undefined, undefined, teamTotalFn);
  const service = new OddsVerificationService(provider);

  const decision = await verifyPreviewFreshness(payload, TEST_SECRET, { oddsVerificationService: service });

  assert.deepEqual(decision, { kind: "ACCEPT" });
  assert.equal(h2hCalls.length, 0, "must never reach the h2h/moneyline verifier for a known TEAM_TOTAL selection");
  assert.equal(teamTotalCalls.length, 1, "must reach the team-total verifier exactly once");
  assert.equal(teamTotalCalls[0].participant, "Интер");
  assert.equal(teamTotalCalls[0].direction, "OVER");
  assert.equal(teamTotalCalls[0].line, "1.5");
  assert.equal(teamTotalCalls[0].event, "Inter Milan — Monza");
});

// Test B — same fixture, UNDER direction and a different exact line.
test("verifyPreviewFreshness (Stage 5A): RU TEAM_TOTAL UNDER ('Интер ТМ 2,5') reconstructs to TEAM_TOTAL/Интер/UNDER/2.5", async () => {
  const payload = singlePayload({
    sport: "Football",
    event: "Inter Milan — Monza",
    outcome: "Интер ТМ 2,5",
    odds: 1.55,
    acceptedOdds: 1.55,
    canonicalMarketType: "TEAM_TOTAL",
    canonicalSelectionType: "UNDER",
    canonicalParticipant: "Интер",
    canonicalLine: "2.5",
  });

  const { fn: h2hFn, calls: h2hCalls } = capturingVerifyOddsFn(verified(1.55, 1.55));
  const { fn: teamTotalFn, calls: teamTotalCalls } = capturingVerifyTeamTotalsOddsFn(verified(1.55, 1.55));
  const provider = new TheOddsApiProvider(h2hFn, undefined, undefined, teamTotalFn);
  const service = new OddsVerificationService(provider);

  const decision = await verifyPreviewFreshness(payload, TEST_SECRET, { oddsVerificationService: service });

  assert.deepEqual(decision, { kind: "ACCEPT" });
  assert.equal(h2hCalls.length, 0);
  assert.equal(teamTotalCalls.length, 1);
  assert.equal(teamTotalCalls[0].direction, "UNDER");
  assert.equal(teamTotalCalls[0].line, "2.5");
});

// Test C — away-participant TEAM_TOTAL: the confirm-time reconstruction must
// not silently default to whichever team happens to appear first in the
// (also provider-substituted) event string.
test("verifyPreviewFreshness (Stage 5A): away-team TEAM_TOTAL ('Монца ТМ 0.5') preserves the away participant, not the home team", async () => {
  const payload = singlePayload({
    sport: "Football",
    event: "Inter Milan — Monza",
    outcome: "Монца ТМ 0.5",
    odds: 2.1,
    acceptedOdds: 2.1,
    canonicalMarketType: "TEAM_TOTAL",
    canonicalSelectionType: "UNDER",
    canonicalParticipant: "Монца",
    canonicalLine: "0.5",
  });

  const { fn: h2hFn, calls: h2hCalls } = capturingVerifyOddsFn(verified(2.1, 2.1));
  const { fn: teamTotalFn, calls: teamTotalCalls } = capturingVerifyTeamTotalsOddsFn(verified(2.1, 2.1));
  const provider = new TheOddsApiProvider(h2hFn, undefined, undefined, teamTotalFn);
  const service = new OddsVerificationService(provider);

  const decision = await verifyPreviewFreshness(payload, TEST_SECRET, { oddsVerificationService: service });

  assert.deepEqual(decision, { kind: "ACCEPT" });
  assert.equal(h2hCalls.length, 0);
  assert.equal(teamTotalCalls.length, 1);
  assert.equal(teamTotalCalls[0].participant, "Монца");
  assert.equal(teamTotalCalls[0].direction, "UNDER");
});

// Test D — English-spelling participant variant (Марсель/Marseille): proves
// the fix is not RU-specific and does not depend on any transliteration.
test("verifyPreviewFreshness (Stage 5A): English participant spelling ('Marseille Over 1.5') reconstructs correctly across a provider-substituted event too", async () => {
  const payload = singlePayload({
    sport: "Football",
    event: "Olympique de Marseille — Lyon",
    outcome: "Marseille Over 1.5",
    odds: 1.4,
    acceptedOdds: 1.4,
    canonicalMarketType: "TEAM_TOTAL",
    canonicalSelectionType: "OVER",
    canonicalParticipant: "Marseille",
    canonicalLine: "1.5",
  });

  const { fn: h2hFn, calls: h2hCalls } = capturingVerifyOddsFn(verified(1.4, 1.4));
  const { fn: teamTotalFn, calls: teamTotalCalls } = capturingVerifyTeamTotalsOddsFn(verified(1.4, 1.4));
  const provider = new TheOddsApiProvider(h2hFn, undefined, undefined, teamTotalFn);
  const service = new OddsVerificationService(provider);

  const decision = await verifyPreviewFreshness(payload, TEST_SECRET, { oddsVerificationService: service });

  assert.deepEqual(decision, { kind: "ACCEPT" });
  assert.equal(h2hCalls.length, 0);
  assert.equal(teamTotalCalls.length, 1);
  assert.equal(teamTotalCalls[0].participant, "Marseille");
  assert.equal(teamTotalCalls[0].line, "1.5");
});

// Test E — EXPRESS with at least one TEAM_TOTAL leg, alongside a plain
// MONEYLINE leg that must keep behaving exactly as before (no canonical
// fields, still classified from free text).
test("verifyPreviewFreshness (Stage 5A): EXPRESS with a TEAM_TOTAL leg (Марсель) plus a plain MONEYLINE leg — each leg routes to its own correct verifier", async () => {
  const payload = expressPayload({
    selections: [
      {
        sport: "Football",
        event: "Olympique de Marseille — Lyon",
        outcome: "Марсель ТБ 1.5",
        market: null,
        submittedOdds: "1.4",
        currentOdds: "1.4",
        oddsStatus: "VERIFIED",
        canonicalMarketType: "TEAM_TOTAL",
        canonicalSelectionType: "OVER",
        canonicalParticipant: "Марсель",
        canonicalLine: "1.5",
      },
      {
        sport: "Football",
        event: "Real Madrid vs Barcelona",
        outcome: "Real Madrid",
        market: null,
        submittedOdds: "1.8",
        currentOdds: "1.8",
        oddsStatus: "VERIFIED",
      },
    ],
  });

  const { fn: h2hFn, calls: h2hCalls } = capturingVerifyOddsFn(verified(1.8, 1.8));
  const { fn: teamTotalFn, calls: teamTotalCalls } = capturingVerifyTeamTotalsOddsFn(verified(1.4, 1.4));
  const provider = new TheOddsApiProvider(h2hFn, undefined, undefined, teamTotalFn);
  const service = new OddsVerificationService(provider);

  const decision = await verifyPreviewFreshness(payload, TEST_SECRET, { oddsVerificationService: service });

  assert.deepEqual(decision, { kind: "ACCEPT" });
  assert.equal(teamTotalCalls.length, 1, "the TEAM_TOTAL leg must reach the team-total verifier exactly once");
  assert.equal(teamTotalCalls[0].participant, "Марсель");
  assert.equal(teamTotalCalls[0].direction, "OVER");
  assert.equal(teamTotalCalls[0].line, "1.5");
  assert.equal(h2hCalls.length, 1, "the plain MONEYLINE leg must still reach the h2h verifier exactly once");
  assert.equal(h2hCalls[0].event, "Real Madrid vs Barcelona");
});

// Test F — regression: TOTALS and SPREAD selections that ALSO carry
// canonical token fields (every token issued after this stage carries them
// for every market type, per this stage's own token-field inspection) still
// route to their own correct verifiers, never TEAM_TOTAL or MONEYLINE.
test("verifyPreviewFreshness (Stage 5A) regression: TOTALS with canonical fields present still routes to the totals verifier, not team-total or h2h", async () => {
  const payload = singlePayload({
    sport: "Football",
    event: "Arsenal — Chelsea",
    outcome: "Total Over 2.5",
    odds: 1.9,
    acceptedOdds: 1.9,
    canonicalMarketType: "TOTALS",
    canonicalSelectionType: "OVER",
    canonicalParticipant: null,
    canonicalLine: "2.5",
  });

  const { fn: h2hFn, calls: h2hCalls } = capturingVerifyOddsFn(verified(1.9, 1.9));
  const { fn: totalsFn, calls: totalsCalls } = capturingVerifyTotalsOddsFn(verified(1.9, 1.9));
  const { fn: teamTotalFn, calls: teamTotalCalls } = capturingVerifyTeamTotalsOddsFn(verified(1.9, 1.9));
  const provider = new TheOddsApiProvider(h2hFn, totalsFn, undefined, teamTotalFn);
  const service = new OddsVerificationService(provider);

  const decision = await verifyPreviewFreshness(payload, TEST_SECRET, { oddsVerificationService: service });

  assert.deepEqual(decision, { kind: "ACCEPT" });
  assert.equal(totalsCalls.length, 1);
  assert.equal(totalsCalls[0].line, "2.5");
  assert.equal(h2hCalls.length, 0);
  assert.equal(teamTotalCalls.length, 0);
});

test("verifyPreviewFreshness (Stage 5A) regression: SPREAD with canonical fields present still routes to the spread verifier, not team-total or h2h", async () => {
  const payload = singlePayload({
    sport: "Football",
    event: "Arsenal — Chelsea",
    outcome: "Arsenal -1.5",
    odds: 1.85,
    acceptedOdds: 1.85,
    canonicalMarketType: "SPREAD",
    canonicalSelectionType: "PARTICIPANT",
    canonicalParticipant: "Arsenal",
    canonicalLine: "-1.5",
  });

  const { fn: h2hFn, calls: h2hCalls } = capturingVerifyOddsFn(verified(1.85, 1.85));
  const { fn: spreadFn, calls: spreadCalls } = capturingVerifySpreadOddsFn(verified(1.85, 1.85));
  const { fn: teamTotalFn, calls: teamTotalCalls } = capturingVerifyTeamTotalsOddsFn(verified(1.85, 1.85));
  const provider = new TheOddsApiProvider(h2hFn, undefined, spreadFn, teamTotalFn);
  const service = new OddsVerificationService(provider);

  const decision = await verifyPreviewFreshness(payload, TEST_SECRET, { oddsVerificationService: service });

  assert.deepEqual(decision, { kind: "ACCEPT" });
  assert.equal(spreadCalls.length, 1);
  assert.equal(spreadCalls[0].participant, "Arsenal");
  assert.equal(spreadCalls[0].line, "-1.5");
  assert.equal(h2hCalls.length, 0);
  assert.equal(teamTotalCalls.length, 0);
});

// Regression: a token issued BEFORE this stage (no canonical fields at all,
// every field undefined) must fall through to the existing, unmodified
// legacy classification path — proving this fix is purely additive and
// changes nothing for old tokens / non-TEAM_TOTAL callers that never set
// these fields.
test("verifyPreviewFreshness (Stage 5A) regression: a pre-existing token with no canonical fields at all falls through to the unchanged legacy classification path", async () => {
  const payload = singlePayload({
    sport: "Football",
    event: "Real Madrid vs Barcelona",
    outcome: "Real Madrid",
    odds: 2.05,
    acceptedOdds: 2.05,
  });
  assert.equal(payload.canonicalMarketType, undefined);

  const decision = await verifyPreviewFreshness(payload, TEST_SECRET, {
    verifyOddsFn: fakeVerifyOddsFn({ "Real Madrid vs Barcelona": verified(2.05, 2.05) }),
  });

  assert.deepEqual(decision, { kind: "ACCEPT" });
});

// Direct unit proof (not just the integration path above) that
// reconstructParsedBetSlip itself threads the canonical fields through, for
// both SINGLE and EXPRESS — this is the exact function the diagnostic
// traced the original bug to.
test("reconstructParsedBetSlip: SINGLE payload's canonical fields are threaded onto the reconstructed selection unchanged", () => {
  const payload = singlePayload({
    canonicalMarketType: "TEAM_TOTAL",
    canonicalSelectionType: "OVER",
    canonicalParticipant: "Интер",
    canonicalLine: "1.5",
  });

  const slip = reconstructParsedBetSlip(payload);

  assert.equal(slip.selections[0].canonicalMarketType, "TEAM_TOTAL");
  assert.equal(slip.selections[0].canonicalSelectionType, "OVER");
  assert.equal(slip.selections[0].canonicalParticipant, "Интер");
});

test("reconstructParsedBetSlip: EXPRESS payload's per-leg canonical fields are threaded onto each reconstructed selection unchanged", () => {
  const payload = expressPayload({
    selections: [
      {
        ...expressPayload().selections[0],
        canonicalMarketType: "TEAM_TOTAL",
        canonicalSelectionType: "UNDER",
        canonicalParticipant: "Монца",
        canonicalLine: "0.5",
      },
      expressPayload().selections[1],
    ],
  });

  const slip = reconstructParsedBetSlip(payload);

  assert.equal(slip.selections[0].canonicalMarketType, "TEAM_TOTAL");
  assert.equal(slip.selections[0].canonicalSelectionType, "UNDER");
  assert.equal(slip.selections[0].canonicalParticipant, "Монца");
  assert.equal(slip.selections[1].canonicalMarketType, null);
});
