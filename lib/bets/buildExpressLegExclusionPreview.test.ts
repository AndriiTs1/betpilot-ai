import { test } from "node:test";
import assert from "node:assert/strict";
import { buildExpressLegExclusionPreview, ExpressLegExclusionError } from "./buildExpressLegExclusionPreview";
import { buildBetSlipPreview } from "./buildBetSlipPreview";
import type { ParsedBetSlip } from "./betSlip";
import { verifyExpressPreviewToken, type ExpressPreviewTokenPayload, type PreviewTokenPayload } from "@/lib/betPreview/previewToken";
import type { OddsVerificationInput } from "@/lib/odds/oddsVerifier";
import type { OddsCheckResult } from "@/types/oddsSnapshot";

// Sector 1 (ADR-0002) — EXPRESS per-leg unavailable recovery. Same
// fixture/fake conventions as lib/bets/verifyPreviewFreshness.test.ts (the
// closest existing sibling: it also reconstructs a ParsedBetSlip from a
// signed token payload and re-runs it through buildBetSlipPreview() for a
// fresh live re-verification) — small, local, duplicated helpers rather
// than importing that file's own module-private ones.

const TEST_SECRET = "test-preview-token-secret-exclusion";

function verified(sourceOdds: number, submittedOdds: number, bookmaker = "Pinnacle"): OddsCheckResult {
  const discrepancyPercent = Number((((submittedOdds - sourceOdds) / sourceOdds) * 100).toFixed(2));
  return { matched: true, withinTolerance: true, sourceOdds, submittedOdds, discrepancyPercent, bookmaker, note: null };
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

interface LegFixture {
  event: string;
  outcome: string;
  submittedOdds: string | null;
  currentOdds: string | null;
  oddsStatus: ExpressPreviewTokenPayload["selections"][number]["oddsStatus"];
}

function leg(overrides: Partial<LegFixture> = {}): ExpressPreviewTokenPayload["selections"][number] {
  return {
    sport: "Football",
    event: "Event",
    outcome: "Outcome",
    market: null,
    submittedOdds: "1.80",
    currentOdds: "1.80",
    oddsStatus: "VERIFIED",
    ...overrides,
  };
}

function expressPayload(
  selections: ExpressPreviewTokenPayload["selections"],
  overrides: Partial<ExpressPreviewTokenPayload> = {},
): ExpressPreviewTokenPayload {
  const issuedAt = nowSeconds();
  return {
    v: 1,
    previewId: "preview-express-exclusion-1",
    playerId: "player-1",
    type: "EXPRESS",
    stake: "30",
    totalOdds: "9.99",
    potentialWin: "299.7",
    selections,
    issuedAt,
    expiresAt: issuedAt + 180,
    ...overrides,
  };
}

function singlePayload(): PreviewTokenPayload {
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
  };
}

/* -------------------------------------------------------------------------- */
/* Core recovery behavior                                                     */
/* -------------------------------------------------------------------------- */

test("excluding one NOT_FOUND leg from a 5-leg EXPRESS produces a 4-leg EXPRESS preview with a fresh previewToken", async () => {
  const payload = expressPayload([
    leg({ event: "Arsenal vs Coventry", outcome: "Arsenal", currentOdds: "1.72", oddsStatus: "VERIFIED" }),
    leg({ event: "Inter vs Juventus", outcome: "Inter", currentOdds: "1.61", oddsStatus: "VERIFIED" }),
    leg({ event: "AC Milan vs Roma", outcome: "AC Milan", currentOdds: null, oddsStatus: "NOT_FOUND" }),
    leg({ event: "Bayern vs Dortmund", outcome: "Bayern", currentOdds: "1.48", oddsStatus: "VERIFIED" }),
    leg({ event: "PSG vs Lyon", outcome: "PSG", currentOdds: "1.55", oddsStatus: "VERIFIED" }),
  ]);

  const result = await buildExpressLegExclusionPreview(payload, [2], TEST_SECRET, {
    verifyOddsFn: fakeVerifyOddsFn({
      "Arsenal vs Coventry": verified(1.72, 1.72),
      "Inter vs Juventus": verified(1.61, 1.61),
      "Bayern vs Dortmund": verified(1.48, 1.48),
      "PSG vs Lyon": verified(1.55, 1.55),
    }),
  });

  assert.equal(result.preview.type, "EXPRESS");
  assert.equal(result.preview.selections.length, 4);
  assert.deepEqual(
    result.preview.selections.map((s) => s.event),
    ["Arsenal vs Coventry", "Inter vs Juventus", "Bayern vs Dortmund", "PSG vs Lyon"],
  );
  assert.ok(result.previewToken !== null);
  assert.notEqual(result.previewToken, "the original token" /* never equal to any real prior token string */);
});

test("totalOdds is recalculated from scratch from remaining legs' fresh live odds — never a subtraction of the old total", async () => {
  // Old (stale) token totalOdds was signed as "9.99" (an arbitrary, now-
  // irrelevant figure — see expressPayload's default). The two remaining
  // legs' CURRENT live prices (1.72 * 1.61 = 2.7692, rounded per
  // expressMath.ts) must be exactly what totalOdds reflects — proving the
  // computation is fresh, not derived from the old 3-leg total at all.
  const payload = expressPayload([
    leg({ event: "Arsenal vs Coventry", outcome: "Arsenal", currentOdds: "1.72", oddsStatus: "VERIFIED" }),
    leg({ event: "Inter vs Juventus", outcome: "Inter", currentOdds: "1.61", oddsStatus: "VERIFIED" }),
    leg({ event: "AC Milan vs Roma", outcome: "AC Milan", currentOdds: null, oddsStatus: "UNAVAILABLE" }),
  ]);

  const result = await buildExpressLegExclusionPreview(payload, [2], TEST_SECRET, {
    verifyOddsFn: fakeVerifyOddsFn({
      "Arsenal vs Coventry": verified(1.72, 1.72),
      "Inter vs Juventus": verified(1.61, 1.61),
    }),
  });

  assert.equal(result.preview.totalOdds, 2.77);
  assert.notEqual(result.preview.totalOdds, 9.99);
});

test("a remaining leg's price is re-verified live, not reused from the token's own stale currentOdds — proves no OCR/submitted odds is ever final", async () => {
  // The token's own currentOdds for the remaining leg is "1.80" (what the
  // player last saw), but the LIVE price has since moved to 1.75 — the
  // resulting preview's totalOdds must reflect 1.75, never 1.80, and
  // submittedOdds/currentOdds in the fresh preview must come from this
  // call's own live verification, not from the stale token field.
  const payload = expressPayload([
    leg({ event: "Real Madrid vs Barcelona", outcome: "Real Madrid", submittedOdds: "1.80", currentOdds: "1.80", oddsStatus: "VERIFIED" }),
    leg({ event: "Bayern vs Dortmund", outcome: "Bayern", submittedOdds: "1.48", currentOdds: "1.48", oddsStatus: "VERIFIED" }),
    leg({ event: "AC Milan vs Roma", outcome: "AC Milan", currentOdds: null, oddsStatus: "NOT_FOUND" }),
  ]);

  const result = await buildExpressLegExclusionPreview(payload, [2], TEST_SECRET, {
    verifyOddsFn: fakeVerifyOddsFn({
      "Real Madrid vs Barcelona": verified(1.75, 1.8),
      "Bayern vs Dortmund": verified(1.48, 1.48),
    }),
  });

  const realMadridLeg = result.preview.selections.find((s) => s.event.includes("Real Madrid"));
  assert.ok(realMadridLeg);
  assert.equal(realMadridLeg.currentOdds, 1.75);
  assert.notEqual(realMadridLeg.currentOdds, 1.8);
  // 1.75 * 1.48 = 2.59
  assert.equal(result.preview.totalOdds, 2.59);
});

test("3-leg EXPRESS with one NOT_FOUND excluded stays a valid 2-leg EXPRESS (the minimum), not SINGLE", async () => {
  const payload = expressPayload([
    leg({ event: "Arsenal vs Coventry", outcome: "Arsenal", currentOdds: "1.72", oddsStatus: "VERIFIED" }),
    leg({ event: "Inter vs Juventus", outcome: "Inter", currentOdds: null, oddsStatus: "UNAVAILABLE" }),
    leg({ event: "Bayern vs Dortmund", outcome: "Bayern", currentOdds: "1.48", oddsStatus: "VERIFIED" }),
  ]);

  const result = await buildExpressLegExclusionPreview(payload, [1], TEST_SECRET, {
    verifyOddsFn: fakeVerifyOddsFn({
      "Arsenal vs Coventry": verified(1.72, 1.72),
      "Bayern vs Dortmund": verified(1.48, 1.48),
    }),
  });

  assert.equal(result.preview.type, "EXPRESS");
  assert.equal(result.preview.selections.length, 2);
});

test("2-leg EXPRESS with one NOT_FOUND excluded converts to a SINGLE preview for the one remaining leg — never an invalid 1-leg EXPRESS", async () => {
  const payload = expressPayload([
    leg({ event: "Arsenal vs Coventry", outcome: "Arsenal", currentOdds: "1.72", oddsStatus: "VERIFIED" }),
    leg({ event: "Inter vs Juventus", outcome: "Inter", currentOdds: null, oddsStatus: "NOT_FOUND" }),
  ]);

  const result = await buildExpressLegExclusionPreview(payload, [1], TEST_SECRET, {
    verifyOddsFn: fakeVerifyOddsFn({
      "Arsenal vs Coventry": verified(1.72, 1.72),
    }),
  });

  assert.equal(result.preview.type, "SINGLE");
  assert.equal(result.preview.selections.length, 1);
  assert.equal(result.preview.selections[0].event, "Arsenal vs Coventry");
});

test("excluding multiple unavailable legs at once from a 5-leg EXPRESS produces a 3-leg EXPRESS", async () => {
  const payload = expressPayload([
    leg({ event: "Arsenal vs Coventry", outcome: "Arsenal", currentOdds: "1.72", oddsStatus: "VERIFIED" }),
    leg({ event: "Inter vs Juventus", outcome: "Inter", currentOdds: null, oddsStatus: "NOT_FOUND" }),
    leg({ event: "AC Milan vs Roma", outcome: "AC Milan", currentOdds: null, oddsStatus: "UNAVAILABLE" }),
    leg({ event: "Bayern vs Dortmund", outcome: "Bayern", currentOdds: "1.48", oddsStatus: "VERIFIED" }),
    leg({ event: "PSG vs Lyon", outcome: "PSG", currentOdds: "1.55", oddsStatus: "VERIFIED" }),
  ]);

  const result = await buildExpressLegExclusionPreview(payload, [1, 2], TEST_SECRET, {
    verifyOddsFn: fakeVerifyOddsFn({
      "Arsenal vs Coventry": verified(1.72, 1.72),
      "Bayern vs Dortmund": verified(1.48, 1.48),
      "PSG vs Lyon": verified(1.55, 1.55),
    }),
  });

  assert.equal(result.preview.type, "EXPRESS");
  assert.equal(result.preview.selections.length, 3);
  assert.deepEqual(
    result.preview.selections.map((s) => s.event),
    ["Arsenal vs Coventry", "Bayern vs Dortmund", "PSG vs Lyon"],
  );
});

/* -------------------------------------------------------------------------- */
/* Rejections — all fail before any provider call                            */
/* -------------------------------------------------------------------------- */

test("excluding every leg throws ALL_LEGS_EXCLUDED", async () => {
  const payload = expressPayload([
    leg({ event: "A", currentOdds: null, oddsStatus: "NOT_FOUND" }),
    leg({ event: "B", currentOdds: null, oddsStatus: "UNAVAILABLE" }),
  ]);

  await assert.rejects(
    buildExpressLegExclusionPreview(payload, [0, 1], TEST_SECRET),
    (err: unknown) => err instanceof ExpressLegExclusionError && err.code === "ALL_LEGS_EXCLUDED",
  );
});

test("excluding zero legs throws NO_LEGS_EXCLUDED", async () => {
  const payload = expressPayload([leg({ event: "A" }), leg({ event: "B" })]);

  await assert.rejects(
    buildExpressLegExclusionPreview(payload, [], TEST_SECRET),
    (err: unknown) => err instanceof ExpressLegExclusionError && err.code === "NO_LEGS_EXCLUDED",
  );
});

test("an out-of-range leg index throws INVALID_LEG_INDEX", async () => {
  const payload = expressPayload([leg({ event: "A" }), leg({ event: "B" })]);

  await assert.rejects(
    buildExpressLegExclusionPreview(payload, [5], TEST_SECRET),
    (err: unknown) => err instanceof ExpressLegExclusionError && err.code === "INVALID_LEG_INDEX",
  );
});

test("a negative or non-integer leg index throws INVALID_LEG_INDEX", async () => {
  const payload = expressPayload([leg({ event: "A" }), leg({ event: "B" })]);

  await assert.rejects(
    buildExpressLegExclusionPreview(payload, [-1], TEST_SECRET),
    (err: unknown) => err instanceof ExpressLegExclusionError && err.code === "INVALID_LEG_INDEX",
  );
  await assert.rejects(
    buildExpressLegExclusionPreview(payload, [1.5], TEST_SECRET),
    (err: unknown) => err instanceof ExpressLegExclusionError && err.code === "INVALID_LEG_INDEX",
  );
});

test("a duplicate leg index throws DUPLICATE_LEG_INDEX", async () => {
  const payload = expressPayload([
    leg({ event: "A", currentOdds: null, oddsStatus: "NOT_FOUND" }),
    leg({ event: "B" }),
    leg({ event: "C" }),
  ]);

  await assert.rejects(
    buildExpressLegExclusionPreview(payload, [0, 0], TEST_SECRET),
    (err: unknown) => err instanceof ExpressLegExclusionError && err.code === "DUPLICATE_LEG_INDEX",
  );
});

test("excluding a VERIFIED leg is rejected server-side with LEG_NOT_RECOVERABLE — defense-in-depth, never trusts the client's own gating", async () => {
  const payload = expressPayload([
    leg({ event: "A", currentOdds: "1.72", oddsStatus: "VERIFIED" }),
    leg({ event: "B", currentOdds: "1.61", oddsStatus: "VERIFIED" }),
    leg({ event: "C", currentOdds: null, oddsStatus: "NOT_FOUND" }),
  ]);

  await assert.rejects(
    buildExpressLegExclusionPreview(payload, [0], TEST_SECRET),
    (err: unknown) => err instanceof ExpressLegExclusionError && err.code === "LEG_NOT_RECOVERABLE",
  );
});

test("excluding an ODDS_CHANGED leg is also rejected with LEG_NOT_RECOVERABLE — Sector 1 only recovers NOT_FOUND/UNAVAILABLE", async () => {
  const payload = expressPayload([
    leg({ event: "A", currentOdds: "1.90", oddsStatus: "ODDS_CHANGED" }),
    leg({ event: "B", currentOdds: null, oddsStatus: "NOT_FOUND" }),
  ]);

  await assert.rejects(
    buildExpressLegExclusionPreview(payload, [0], TEST_SECRET),
    (err: unknown) => err instanceof ExpressLegExclusionError && err.code === "LEG_NOT_RECOVERABLE",
  );
});

test("a SINGLE-type payload is rejected with NOT_EXPRESS_TOKEN", async () => {
  const payload = singlePayload();

  await assert.rejects(
    buildExpressLegExclusionPreview(payload as unknown as ExpressPreviewTokenPayload, [0], TEST_SECRET),
    (err: unknown) => err instanceof ExpressLegExclusionError && err.code === "NOT_EXPRESS_TOKEN",
  );
});

/* -------------------------------------------------------------------------- */
/* Sector 1 architecture correction (ADR-0002) — real production-path        */
/* integration test. No ExpressPreviewTokenPayload is ever hand-built here;  */
/* the token consumed by buildExpressLegExclusionPreview is exactly the one  */
/* buildBetSlipPreview() itself produced, exercising the fix this correction */
/* was made for: an unavailable-leg EXPRESS previously never produced a      */
/* token at all, making this whole flow structurally unreachable — the gap   */
/* the practical Telegram QA found and unit tests (built on hand-crafted     */
/* payloads) missed.                                                        */
/* -------------------------------------------------------------------------- */

test("real production-path integration: EXPRESS parse -> buildBetSlipPreview -> one NOT_FOUND leg -> real previewToken exists -> Confirm blocked -> exclusion consumes that real token -> fresh re-verification -> new token -> fully verified EXPRESS becomes confirmable", async () => {
  const slip: ParsedBetSlip = {
    type: "EXPRESS",
    stake: 40,
    selections: [
      { sport: "Football", event: "Arsenal vs Coventry", market: null, selection: "Arsenal Win", submittedOdds: 1.72 },
      { sport: "Football", event: "Bayern vs Dortmund", market: null, selection: "Bayern Win", submittedOdds: 1.48 },
      { sport: "Football", event: "Atletico Mars vs Dynamo Jupiter", market: null, selection: "Atletico Mars Win", submittedOdds: 2.0 },
    ],
  };

  // Step 1: the real preview-building pipeline — no hand-built token.
  const initialResult = await buildBetSlipPreview(slip, "player-1", TEST_SECRET, {
    verifyOddsFn: fakeVerifyOddsFn({
      "Arsenal vs Coventry": verified(1.72, 1.72),
      "Bayern vs Dortmund": verified(1.48, 1.48),
      // "Atletico Mars vs Dynamo Jupiter" deliberately has no fake outcome
      // configured — fakeVerifyOddsFn throws, which OddsVerificationService
      // converts into a real matched:false result, mapping to NOT_FOUND/
      // UNAVAILABLE exactly as a genuine provider miss would.
    }),
  });

  // Sector 1 correction proof #1: a real, non-null previewToken exists even
  // though one leg is unresolved.
  assert.ok(initialResult.previewToken !== null, "buildBetSlipPreview must sign a reference token even with an unavailable leg");
  assert.equal(initialResult.preview.totalOdds, null);
  assert.equal(initialResult.preview.potentialWin, null);

  const thirdLeg = initialResult.preview.selections[2];
  assert.ok(
    thirdLeg.oddsStatus === "NOT_FOUND" || thirdLeg.oddsStatus === "UNAVAILABLE",
    `expected the unresolved leg to be NOT_FOUND/UNAVAILABLE, got ${thirdLeg.oddsStatus}`,
  );

  // Confirm gate proof: this is exactly the condition
  // components/miniapp/canConfirmBetSlip.ts's hasUnverifiedOddsStatus
  // blocks Confirm for — checked directly here (not by importing UI code
  // into lib/bets) since that's the same oddsStatus this test already
  // has in hand.
  const isConfirmable = initialResult.preview.selections.every((s) => s.oddsStatus === "VERIFIED" || s.oddsStatus === "ODDS_CHANGED");
  assert.equal(isConfirmable, false, "the initial preview must remain unconfirmable — a token existing is not a confirmability signal");

  // Step 2: decode the REAL token (not a fixture) to find the failing leg's
  // real index, exactly as the exclude-legs route does after
  // verifyExpressPreviewToken.
  const verified1 = verifyExpressPreviewToken(initialResult.previewToken!, TEST_SECRET);
  assert.equal(verified1.ok, true);
  if (!verified1.ok) return;
  assert.equal(verified1.payload.totalOdds, null);
  assert.equal(verified1.payload.selections.length, 3);

  // Step 3: Sector 1 exclusion, fed the REAL signed payload — no manual
  // ExpressPreviewTokenPayload construction anywhere in this test.
  const exclusionResult = await buildExpressLegExclusionPreview(verified1.payload, [2], TEST_SECRET, {
    verifyOddsFn: fakeVerifyOddsFn({
      "Arsenal vs Coventry": verified(1.72, 1.72),
      "Bayern vs Dortmund": verified(1.48, 1.48),
    }),
  });

  // Step 4: fresh provider re-verification produced a new, fully
  // confirmable EXPRESS with a NEW token.
  assert.equal(exclusionResult.preview.type, "EXPRESS");
  assert.equal(exclusionResult.preview.selections.length, 2);
  assert.deepEqual(
    exclusionResult.preview.selections.map((s) => s.event),
    ["Arsenal vs Coventry", "Bayern vs Dortmund"],
  );
  assert.equal(exclusionResult.preview.totalOdds, 2.55); // 1.72 * 1.48, rounded
  assert.ok(exclusionResult.previewToken !== null);
  assert.notEqual(exclusionResult.previewToken, initialResult.previewToken, "the old token must never be reused — a genuinely new one is issued");

  const isFinallyConfirmable = exclusionResult.preview.selections.every(
    (s) => s.oddsStatus === "VERIFIED" || s.oddsStatus === "ODDS_CHANGED",
  );
  assert.equal(isFinallyConfirmable, true, "after exclusion and fresh re-verification, the remaining EXPRESS must be confirmable");

  // Decode the new token too, proving it's real and independently valid —
  // not a copy or a mutation of the old one.
  const verified2 = verifyExpressPreviewToken(exclusionResult.previewToken!, TEST_SECRET);
  assert.equal(verified2.ok, true);
  if (!verified2.ok) return;
  assert.notEqual(verified2.payload.previewId, verified1.payload.previewId);
  assert.equal(verified2.payload.totalOdds, "2.55");
});
