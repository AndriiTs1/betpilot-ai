import { test } from "node:test";
import assert from "node:assert/strict";
import { buildBetSlipPreview, BetSlipValidationError, BuildBetSlipPreviewConfigError } from "./buildBetSlipPreview";
import { normalizeSelectionToEnglish } from "./normalizeSelectionToEnglish";
import type { ParsedBetSlip } from "./betSlip";
import type { OddsVerificationInput, TotalsVerificationInput } from "@/lib/odds/oddsVerifier";
import type { OddsCheckResult } from "@/types/oddsSnapshot";
import { verifyPreviewToken, verifyExpressPreviewToken } from "@/lib/betPreview/previewToken";
import { OddsVerificationService } from "@/lib/odds/oddsVerificationService";
import { TheOddsApiProvider } from "@/lib/odds/theOddsApiProvider";
import { createVerifiedResult, createOddsChangedResult, createFailedResult } from "@/lib/odds/verification";
import type { VerificationResult } from "@/lib/odds/verification";
import type { OddsProvider, ProviderHealthResult, VerifySelectionRequest } from "@/lib/odds/oddsProvider";
import { canConfirmBetSlip } from "@/components/miniapp/canConfirmBetSlip";
import type { BetPreview } from "@/components/miniapp/betPreviewApi";
import { SCREENSHOT_QA1_DIAGNOSTIC_MARKER } from "@/lib/logging/screenshotQa1Diagnostic";

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
    // Stage 4.2B1 — matches the exact shape lib/odds/oddsVerifier.ts's real
    // verifyOdds() produces (`No matching event found for "X" in Y`), so
    // TheOddsApiProvider's classifyLegacyFailureNote() classifies this as a
    // genuine EVENT_NOT_FOUND, not its defensive PROVIDER_UNAVAILABLE
    // fallback for an unrecognized note shape — this fixture is meant to
    // simulate a real "not found", not a provider failure.
    note: 'No matching event found for "Test Event" in soccer_epl',
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

// Betting Markets V1, Phase 3.3 — same keyed-by-event-name fake shape as
// fakeVerifyOddsFn above, for the independent totals verification seam.
// Wired in via a real TheOddsApiProvider (constructor's second argument),
// passed to buildBetSlipPreview through the existing
// options.oddsVerificationService seam — no new option needed, since that
// seam already accepts any OddsVerificationService-shaped dependency.
function fakeVerifyTotalsOddsFn(byEvent: Record<string, OddsCheckResult | "reject">) {
  return async (input: TotalsVerificationInput): Promise<OddsCheckResult> => {
    const outcome = byEvent[input.event];
    if (outcome === undefined) throw new Error(`No fake totals outcome configured for event "${input.event}"`);
    if (outcome === "reject") throw new Error(`Simulated totals odds-check failure for "${input.event}"`);
    return outcome;
  };
}

function totalsAwareVerificationService(
  h2hByEvent: Record<string, OddsCheckResult | "reject">,
  totalsByEvent: Record<string, OddsCheckResult | "reject">,
): OddsVerificationService {
  return new OddsVerificationService(
    new TheOddsApiProvider(fakeVerifyOddsFn(h2hByEvent), fakeVerifyTotalsOddsFn(totalsByEvent)),
  );
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
  // SCREENSHOT ODDS QA-2 — leg 2's selection was originally "Over 2.5", a
  // real TOTALS-shorthand phrase (classifyOnce/shorthandClassifier.ts
  // recognizes it independent of any test wiring) — which always routes to
  // TheOddsApiProvider's own verifyTotalsOddsFn, never to the verifyOddsFn
  // this test injects. In this test environment that leg's odds check was
  // therefore ALWAYS silently failing (PROVIDER_UNAVAILABLE, a real,
  // un-mocked network call), a pre-existing gap this test never caught
  // because potentialWin used to trust *submitted* odds regardless of
  // verification outcome — exactly the bug this stage fixes. Changed to a
  // bare participant name so BOTH legs genuinely verify through the same
  // injected fixture, making this test honestly exercise the "both legs
  // verified" acceptance criteria its own name promises.
  const slip: ParsedBetSlip = {
    type: "EXPRESS",
    stake: 50,
    selections: [
      { sport: "Football", event: "Real Madrid vs Barcelona", market: null, selection: "Real Madrid Win", submittedOdds: 1.8 },
      { sport: "Football", event: "Inter vs Juventus", market: null, selection: "Juventus", submittedOdds: 1.7 },
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
      { sport: "Tennis", event: "Inter vs Juventus", market: null, selection: "Juventus", submittedOdds: 1.7 },
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

test("buildBetSlipPreview: a selection whose odds check never resolved has currentOdds null in the PREVIEW, and — since SCREENSHOT ODDS QA-2 — an EXPRESS with any such leg no longer signs a token at all (fail-closed, not merely 'null inside a signed token')", async () => {
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

  // The rejected odds check means no sourceOdds was ever obtained — null,
  // not a stale or fabricated value — and the status reflects that too.
  // This is still visible in the PREVIEW response itself (built
  // unconditionally, independent of whether a token ends up signed).
  assert.equal(result.preview.selections[0].currentOdds, 2);
  assert.equal(result.preview.selections[0].oddsStatus, "VERIFIED");
  assert.equal(result.preview.selections[1].currentOdds, null);
  assert.equal(result.preview.selections[1].oddsStatus, "UNAVAILABLE");

  // SCREENSHOT ODDS QA-2 — totalOdds/potentialWin (and therefore the
  // EXPRESS token, which is only ever signed when both are known) now
  // require every leg's odds to be PROVIDER-VERIFIED, not merely
  // player-submitted. One genuinely unresolved leg means the whole slip's
  // potential win can never be honestly quoted, so no token is signed —
  // preserving the existing EXPRESS fail-closed confirmation policy, just
  // triggered by verification instead of submission.
  assert.equal(result.preview.totalOdds, null);
  assert.equal(result.preview.potentialWin, null);
  assert.equal(result.previewToken, null);
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

test("buildBetSlipPreview: EXPRESS with a leg the provider can't resolve a price for still has no token (nothing valid to sign)", async () => {
  // Step 17 — "Unknown Odds" IS now sent to the provider (auto-lookup
  // applies to EXPRESS too), but the lookup genuinely fails to find a price
  // for it, so totals/token stay null exactly as before this fix.
  const slip: ParsedBetSlip = {
    type: "EXPRESS",
    stake: 40,
    selections: [
      { sport: "Football", event: "Known Odds", market: null, selection: "A Win", submittedOdds: 2.0 },
      { sport: "Football", event: "Unknown Odds", market: null, selection: "B Win", submittedOdds: null },
    ],
  };

  const result = await buildBetSlipPreview(slip, "player-1", TEST_SECRET, {
    verifyOddsFn: fakeVerifyOddsFn({
      "Known Odds": verified(2.0, 2.0),
      // A real Step 15G verifyOdds() failed lookup never fabricates a
      // price — submittedOdds stays null, matching the null input odds.
      "Unknown Odds": { matched: false, withinTolerance: null, sourceOdds: null, submittedOdds: null, discrepancyPercent: null, bookmaker: null, note: 'No matching event found for "Unknown Odds" in soccer_epl' },
    }),
  });

  assert.equal(result.preview.selections[1].oddsStatus, "NOT_FOUND");
  assert.equal(result.preview.selections[1].submittedOdds, null);
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
      { sport: "Football", event: "Inter vs Juventus", market: null, selection: "Juventus", submittedOdds: 1.7 },
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
  // SCREENSHOT ODDS QA-2 — totalOdds/potentialWin now require every leg's
  // odds to be PROVIDER-VERIFIED, never merely submitted — a rejected odds
  // check means this slip's real payout can never be honestly quoted, so
  // both become null (and, per the EXPRESS-token gate, no token is signed
  // either) even though the preview response itself still succeeds and
  // still reports each leg's own status/currentOdds independently.
  assert.equal(result.preview.totalOdds, null);
  assert.equal(result.preview.potentialWin, null);
  assert.equal(result.previewToken, null);
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

  // SCREENSHOT ODDS QA-2 — two of these four legs never matched a real
  // provider price at all (NOT_FOUND/UNAVAILABLE), so totalOdds/potentialWin
  // are null and — per the EXPRESS token gate — no token is signed for this
  // mixed slip at all; there is no longer a token to carry the same four
  // statuses into for this exact scenario. The "signed token carries the
  // same per-leg oddsStatus/currentOdds as the preview" property is still
  // covered, on an all-VERIFIED EXPRESS where a token genuinely gets
  // signed, by the "EXPRESS token is redeemable via verifyExpressPreviewToken..."
  // test above.
  assert.equal(result.previewToken, null);
});

test("buildBetSlipPreview: a null-odds selection whose provider lookup throws maps to UNAVAILABLE (attempted, not skipped) and totals become null", async () => {
  // Step 17 — "Unknown Odds" IS now sent to the provider; fakeVerifyOddsFn
  // throws for it (no fixture configured), exercising the "attempted but
  // the check itself failed" path, distinct from an attempted-but-genuinely-
  // unmatched NOT_FOUND (see the "provider can't resolve a price" test
  // above).
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

// ---------------------------------------------------------------------
// Stage 14.4A security cleanup — a not-matched odds check and a rejected
// odds check used to console.log/console.error selection.event directly
// (plus, on the rejected path, the raw rejection reason, which can carry
// upstream provider error text — see lib/odds/oddsVerifier.ts). Both are
// now metadata-only structured events (lib/logging/structuredLog.ts).
// This test proves the fix at the actual boundary that matters: every
// console.log call made during a real buildBetSlipPreview() run, for both
// failure paths at once, in a slip built with deliberately identifiable
// event/selection names.
// ---------------------------------------------------------------------

test("buildBetSlipPreview: odds check failures never log selection.event, selection, market, or provider note/reason content", async () => {
  const originalConsoleLog = console.log;
  const originalConsoleError = console.error;
  const loggedCalls: unknown[][] = [];
  console.log = (...args: unknown[]) => loggedCalls.push(args);
  console.error = (...args: unknown[]) => loggedCalls.push(args);

  const secretEventNotMatched = "SECRET_EVENT_NOT_MATCHED_Barcelona_vs_RealMadrid";
  const secretEventRejected = "SECRET_EVENT_REJECTED_Inter_vs_Juventus";
  const secretProviderNote = "SECRET_PROVIDER_NOTE_sport_key_soccer_epl_12345";
  const secretRejectReason = "SECRET_REJECT_REASON_upstream_500_detail";

  try {
    const slip: ParsedBetSlip = {
      type: "EXPRESS",
      stake: 25,
      selections: [
        {
          sport: "Football",
          event: secretEventNotMatched,
          market: "SECRET_MARKET_Over_Under",
          selection: "SECRET_SELECTION_Over_2_5",
          submittedOdds: 1.8,
        },
        { sport: "Football", event: secretEventRejected, market: null, selection: "Inter Win", submittedOdds: 1.7 },
      ],
    };

    const result = await buildBetSlipPreview(slip, "player-1", TEST_SECRET, {
      verifyOddsFn: async (input) => {
        if (input.event === secretEventNotMatched) {
          return {
            matched: false,
            withinTolerance: null,
            sourceOdds: null,
            submittedOdds: input.odds,
            discrepancyPercent: null,
            bookmaker: null,
            note: secretProviderNote,
          };
        }
        throw new Error(secretRejectReason);
      },
    });

    // Sanity: both failure paths actually ran (otherwise this test would
    // trivially "pass" by never exercising the code under test). The first
    // leg's note doesn't match any recognized classifyLegacyFailureNote()
    // pattern (it's a synthetic secret string, not a real oddsVerifier.ts
    // note shape), so it lands on the defensive PROVIDER_UNAVAILABLE
    // fallback (Stage 4.2B1) rather than NOT_FOUND — the exact status isn't
    // this test's point, only that both failure paths ran and nothing
    // secret leaked into logs (checked below).
    assert.equal(result.preview.selections[0].oddsStatus, "UNAVAILABLE");
    assert.equal(result.preview.selections[1].oddsStatus, "UNAVAILABLE");
    assert.ok(loggedCalls.length >= 2, "expected both odds_check_not_matched and odds_check_rejected to log");

    const rawLoggedText = JSON.stringify(loggedCalls);
    for (const forbidden of [
      secretEventNotMatched,
      secretEventRejected,
      secretProviderNote,
      secretRejectReason,
      "SECRET_MARKET",
      "SECRET_SELECTION",
    ]) {
      assert.equal(rawLoggedText.includes(forbidden), false, `logs must never contain: ${forbidden}`);
    }

    // Every logged line must be our own flat, metadata-only structured
    // event — never a raw Error object or arbitrary nested content.
    for (const call of loggedCalls) {
      assert.equal(call.length, 1, "structured log calls pass exactly one JSON.stringify'd argument");
      const parsed = JSON.parse(String(call[0]));
      assert.equal(typeof parsed.event, "string");
      for (const [key, value] of Object.entries(parsed)) {
        assert.ok(
          typeof value === "string" || typeof value === "number",
          `log field "${key}" must be a string or number, got ${typeof value}`,
        );
      }
    }
  } finally {
    console.log = originalConsoleLog;
    console.error = originalConsoleError;
  }
});

// ---------------------------------------------------------------------
// Step 7 — buildBetSlipPreview now runs odds verification through
// OddsVerificationService + TheOddsApiProvider instead of calling
// verifyOdds() directly. Every test above this line is UNCHANGED from
// before this migration and passes unmodified against the new
// implementation — that is the primary output-parity proof. The tests
// below add: composition/DI coverage, direct request-mapping/batching
// assertions, and additional scenarios from the migration's parity
// checklist not already exercised above (provider timeout/unavailable as
// *returned* legacy failures, out-of-order completion, bookmaker
// preservation, ambiguous DI rejection).
// ---------------------------------------------------------------------

const CHECKED_AT = "2026-07-24T00:00:00.000Z";

function fakeProvider(verifySelection: OddsProvider["verifySelection"]): OddsProvider {
  return {
    name: "THE_ODDS_API",
    getCapabilities: () => ({
      provider: "THE_ODDS_API",
      supportedSports: [],
      supportedMarketTypes: [],
      leagueSelectionSupported: false,
      livePrematchSupport: "PREMATCH_ONLY",
      eventSearchSupported: false,
      eventByIdLookupSupported: false,
      regions: [],
      notes: [],
    }),
    findEvents: async () => ({ ok: true, value: [] }),
    getEventMarkets: async () => ({ ok: true, value: [] }),
    verifySelection,
    healthCheck: async (): Promise<ProviderHealthResult> => ({ healthy: true, provider: "THE_ODDS_API", checkedAt: CHECKED_AT }),
  };
}

/* -------------------------------------------------------------------------- */
/* Group A/B — composition and dependency injection                          */
/* -------------------------------------------------------------------------- */

test("DI: TheOddsApiProvider can be built around an injected fake verifyOddsFn and used via oddsVerificationService", async () => {
  const provider = new TheOddsApiProvider(async (input) => ({
    matched: true,
    withinTolerance: true,
    sourceOdds: input.odds,
    submittedOdds: input.odds,
    discrepancyPercent: 0,
    bookmaker: "Pinnacle",
    note: null,
  }));
  const service = new OddsVerificationService(provider);

  const result = await buildBetSlipPreview(singleSlip(1.95), "player-1", TEST_SECRET, { oddsVerificationService: service });

  assert.equal(result.preview.selections[0].oddsStatus, "VERIFIED");
});

test("DI: an injected OddsVerificationService-shaped dependency is called exactly once, with one request per selection (including null-odds legs), in order", async () => {
  const calls: readonly VerifySelectionRequest[][] = [];
  const fakeService = {
    verifyMany: async (requests: readonly VerifySelectionRequest[]): Promise<readonly VerificationResult[]> => {
      (calls as VerifySelectionRequest[][]).push([...requests]);
      return requests.map(() => createVerifiedResult({ submittedOdds: "2.0", currentOdds: "2.0", provider: "THE_ODDS_API", checkedAt: CHECKED_AT }));
    },
  };

  const slip: ParsedBetSlip = {
    type: "EXPRESS",
    stake: 30,
    selections: [
      { sport: "Football", event: "Match A", market: null, selection: "1", submittedOdds: 2.0 },
      // Step 17 — no submitted odds no longer excludes this leg from the
      // batch: EXPRESS auto-lookup is now identical to SINGLE.
      { sport: "Football", event: "Match B", market: null, selection: "Win", submittedOdds: null },
      { sport: "Football", event: "Match C", market: null, selection: "2", submittedOdds: 1.9 },
    ],
  };

  await buildBetSlipPreview(slip, "player-1", TEST_SECRET, { oddsVerificationService: fakeService });

  assert.equal(calls.length, 1, "verifyMany is called exactly once for the whole batch");
  assert.equal(calls[0].length, 3, "every selection is included, regardless of submitted odds");
  assert.equal(calls[0][0].selection.event.name, "Match A");
  assert.equal(calls[0][1].selection.event.name, "Match B");
  assert.equal(calls[0][2].selection.event.name, "Match C");
});

test("DI: supplying both oddsVerificationService and verifyOddsFn is rejected as ambiguous", async () => {
  const service = new OddsVerificationService(new TheOddsApiProvider());
  const verifyOddsFn = async (): Promise<OddsCheckResult> => verified(2.0, 2.0);

  await assert.rejects(
    () => buildBetSlipPreview(singleSlip(1.95), "player-1", TEST_SECRET, { oddsVerificationService: service, verifyOddsFn }),
    (err: unknown) => err instanceof BuildBetSlipPreviewConfigError && err.code === "AMBIGUOUS_ODDS_DEPENDENCY",
  );
});

/* -------------------------------------------------------------------------- */
/* Additional parity scenarios                                                */
/* -------------------------------------------------------------------------- */

// Stage 4.2B1 — root cause fix (Stage 4.2A audit): a technical provider
// failure returned (not thrown) by verifyOddsFn now classifies through
// TheOddsApiProvider's classifyLegacyFailureNote() and survives
// lib/odds/legacyOddsBridge.ts as reasonCode PROVIDER_TIMEOUT/
// PROVIDER_UNAVAILABLE, which mapOddsStatus.ts now maps to UNAVAILABLE —
// no longer indistinguishable from a genuine NOT_FOUND. These two tests
// used to be named "...maps to NOT_FOUND, same as today", documenting the
// exact bug this stage fixes; renamed to document the corrected behavior.
test("PROVIDER_TIMEOUT as a normal RETURNED legacy failure (not a throw) now maps to UNAVAILABLE, not NOT_FOUND", async () => {
  const result = await buildBetSlipPreview(singleSlip(2.0), "player-1", TEST_SECRET, {
    verifyOddsFn: async (): Promise<OddsCheckResult> => ({
      matched: false,
      withinTolerance: null,
      sourceOdds: null,
      submittedOdds: 2.0,
      discrepancyPercent: null,
      bookmaker: null,
      note: "The Odds API request timed out after 8000ms",
    }),
  });

  assert.equal(result.preview.selections[0].oddsStatus, "UNAVAILABLE");
});

test("PROVIDER_UNAVAILABLE as a normal RETURNED legacy failure (not a throw) now maps to UNAVAILABLE, not NOT_FOUND", async () => {
  const result = await buildBetSlipPreview(singleSlip(2.0), "player-1", TEST_SECRET, {
    verifyOddsFn: async (): Promise<OddsCheckResult> => ({
      matched: false,
      withinTolerance: null,
      sourceOdds: null,
      submittedOdds: 2.0,
      discrepancyPercent: null,
      bookmaker: null,
      note: "ODDS_API_KEY is not configured",
    }),
  });

  assert.equal(result.preview.selections[0].oddsStatus, "UNAVAILABLE");
});

test("parity: a genuinely thrown (unexpected) provider exception still maps to UNAVAILABLE, distinct from a returned provider failure", async () => {
  const provider = fakeProvider(async () => {
    throw new Error("simulated crash");
  });
  const service = new OddsVerificationService(provider);

  const result = await buildBetSlipPreview(singleSlip(2.0), "player-1", TEST_SECRET, { oddsVerificationService: service });

  assert.equal(result.preview.selections[0].oddsStatus, "UNAVAILABLE");
});

test("parity: bookmaker is preserved exactly through the new path", async () => {
  const result = await buildBetSlipPreview(singleSlip(1.95), "player-1", TEST_SECRET, {
    verifyOddsFn: async () => verified(1.95, 1.95, "Bet365"),
  });

  assert.equal(result.preview.selections[0].bookmaker, "Bet365");
});

test("parity: out-of-order provider completion does not change preview selection order", async () => {
  // Selections resolve in REVERSED order (last selection's provider call
  // finishes first) — the merge-by-original-index logic in
  // buildBetSlipPreview.ts must still place each result at its correct
  // position regardless of completion timing.
  const provider = fakeProvider(async (request) => {
    const odds = request.selection.submittedOdds ?? "0";
    const delayTicks = odds === "2.00" ? 3 : odds === "2.01" ? 2 : 1;
    for (let i = 0; i < delayTicks; i++) await Promise.resolve();
    return createVerifiedResult({ submittedOdds: odds, currentOdds: odds, provider: "THE_ODDS_API", checkedAt: CHECKED_AT });
  });
  const service = new OddsVerificationService(provider, { concurrency: 3 });

  const slip: ParsedBetSlip = {
    type: "EXPRESS",
    stake: 10,
    selections: ["2.00", "2.01", "2.02"].map((odds, i) => ({
      sport: "Football",
      event: `Match ${i}`,
      market: null,
      selection: "1",
      submittedOdds: Number(odds),
    })),
  };

  const result = await buildBetSlipPreview(slip, "player-1", TEST_SECRET, { oddsVerificationService: service });

  assert.deepEqual(
    result.preview.selections.map((s) => s.submittedOdds),
    [2.0, 2.01, 2.02],
  );
  assert.ok(result.preview.selections.every((s) => s.oddsStatus === "VERIFIED"));
});

test("parity: duplicate-looking selections (same event/selection text) are each verified independently", async () => {
  let callCount = 0;
  const slip: ParsedBetSlip = {
    type: "EXPRESS",
    stake: 20,
    selections: [
      { sport: "Football", event: "Same Match", market: null, selection: "1", submittedOdds: 2.0 },
      { sport: "Football", event: "Same Match", market: null, selection: "1", submittedOdds: 2.0 },
    ],
  };

  const result = await buildBetSlipPreview(slip, "player-1", TEST_SECRET, {
    verifyOddsFn: async () => {
      callCount += 1;
      return verified(2.0, 2.0);
    },
  });

  assert.equal(callCount, 2);
  assert.equal(result.preview.selections.length, 2);
  assert.equal(result.preview.selections[0].oddsStatus, "VERIFIED");
  assert.equal(result.preview.selections[1].oddsStatus, "VERIFIED");
});

test("parity: one provider exception does not cancel sibling verifications in a larger EXPRESS", async () => {
  const slip: ParsedBetSlip = {
    type: "EXPRESS",
    stake: 20,
    selections: [
      { sport: "Football", event: "Match A", market: null, selection: "1", submittedOdds: 2.0 },
      { sport: "Football", event: "Match B", market: null, selection: "1", submittedOdds: 2.0 },
      { sport: "Football", event: "Match C", market: null, selection: "1", submittedOdds: 2.0 },
    ],
  };

  const result = await buildBetSlipPreview(slip, "player-1", TEST_SECRET, {
    verifyOddsFn: async (input) => {
      if (input.event === "Match B") throw new Error("simulated crash");
      return verified(2.0, 2.0);
    },
  });

  assert.equal(result.preview.selections[0].oddsStatus, "VERIFIED");
  assert.equal(result.preview.selections[1].oddsStatus, "UNAVAILABLE");
  assert.equal(result.preview.selections[2].oddsStatus, "VERIFIED");
});

test("parity: mixed EXPRESS via a directly-injected OddsProvider (VERIFIED/ODDS_CHANGED/FAILED/exception) matches the equivalent verifyOddsFn-based outcome", async () => {
  const provider = fakeProvider(async (request) => {
    const event = request.selection.event.name;
    if (event === "Verified Match") return createVerifiedResult({ submittedOdds: "2.0", currentOdds: "2.0", provider: "THE_ODDS_API", checkedAt: CHECKED_AT });
    if (event === "Changed Match") return createOddsChangedResult({ submittedOdds: "1.9", currentOdds: "2.5", provider: "THE_ODDS_API", checkedAt: CHECKED_AT });
    if (event === "Not Found Match") return createFailedResult({ submittedOdds: "1.5", provider: "THE_ODDS_API", checkedAt: CHECKED_AT, reasonCode: "EVENT_NOT_FOUND" });
    throw new Error("simulated crash for Rejected Match");
  });
  const service = new OddsVerificationService(provider);

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

  const result = await buildBetSlipPreview(slip, "player-1", TEST_SECRET, { oddsVerificationService: service });

  assert.deepEqual(
    result.preview.selections.map((s) => s.oddsStatus),
    ["VERIFIED", "ODDS_CHANGED", "NOT_FOUND", "UNAVAILABLE"],
  );
});

/* -------------------------------------------------------------------------- */
/* Step 7A — football-league compatibility fix, at the buildBetSlipPreview    */
/* level: the exact same legacy sport string that reached verifyOddsFn        */
/* before the Step 7 migration must still reach it today, for each of the     */
/* five pre-existing league-specific aliases plus Premier League.             */
/* -------------------------------------------------------------------------- */

test("Step 7A parity: each football-league-specific sport string reaches verifyOddsFn unchanged, and preview output is VERIFIED as before", async () => {
  const displaySportByLegacy: Record<string, string> = {
    "la liga": "La Liga",
    "serie a": "Serie A",
    bundesliga: "Bundesliga",
    "ligue 1": "Ligue 1",
    "champions league": "Champions League",
    "premier league": "Premier League",
  };

  for (const leagueSport of ["la liga", "serie a", "bundesliga", "ligue 1", "champions league", "premier league"]) {
    const slip: ParsedBetSlip = {
      type: "SINGLE",
      stake: 75,
      selections: [
        {
          sport: displaySportByLegacy[leagueSport],
          event: "Manchester City vs Chelsea",
          market: null,
          selection: "Manchester City Win",
          submittedOdds: 1.95,
        },
      ],
    };

    let capturedSport: string | undefined;
    const result = await buildBetSlipPreview(slip, "player-1", TEST_SECRET, {
      verifyOddsFn: async (input) => {
        capturedSport = input.sport;
        return verified(1.95, 1.95);
      },
    });

    assert.equal(capturedSport, leagueSport, `expected verifyOddsFn to receive sport "${leagueSport}"`);
    assert.equal(result.preview.selections[0].oddsStatus, "VERIFIED");
    assert.equal(result.preview.selections[0].currentOdds, 1.95);
  }
});

test("Step 7A parity: a League-specific SINGLE slip produces the exact same preview shape as before the migration", async () => {
  const slip: ParsedBetSlip = {
    type: "SINGLE",
    stake: 75,
    selections: [{ sport: "Serie A", event: "Juventus vs Inter", market: null, selection: "1", submittedOdds: 2.1 }],
  };

  let capturedInput: OddsVerificationInput | undefined;
  const result = await buildBetSlipPreview(slip, "player-1", TEST_SECRET, {
    verifyOddsFn: async (input) => {
      capturedInput = input;
      return verified(2.1, 2.1);
    },
  });

  assert.equal(capturedInput?.sport, "serie a");
  assert.equal(capturedInput?.event, "Juventus vs Inter");
  assert.equal(capturedInput?.selection, "home");
  assert.equal(result.preview.selections[0].sport, "Serie A"); // original legacy sport string, display-only, unaffected
  assert.equal(result.preview.selections[0].oddsStatus, "VERIFIED");
  assert.equal(result.preview.selections[0].currentOdds, 2.1);
  assert.equal(typeof result.previewToken, "string");
});

test("Step 7A parity: Premier League is represented honestly but still resolves through the same legacy alias as generic football", async () => {
  const premierLeagueSlip: ParsedBetSlip = {
    type: "SINGLE",
    stake: 50,
    selections: [{ sport: "Premier League", event: "Arsenal vs Chelsea", market: null, selection: "1", submittedOdds: 2.2 }],
  };

  let capturedSport: string | undefined;
  const result = await buildBetSlipPreview(premierLeagueSlip, "player-1", TEST_SECRET, {
    verifyOddsFn: async (input) => {
      capturedSport = input.sport;
      return verified(2.2, 2.2);
    },
  });

  assert.equal(capturedSport, "premier league");
  assert.equal(result.preview.selections[0].oddsStatus, "VERIFIED");
});

test("Step 7A parity: an EXPRESS mixing generic football and a specific league still verifies each leg against its own correct legacy sport string", async () => {
  const slip: ParsedBetSlip = {
    type: "EXPRESS",
    stake: 30,
    selections: [
      { sport: "Football", event: "Man City vs Liverpool", market: null, selection: "1", submittedOdds: 1.8 },
      { sport: "La Liga", event: "Real Madrid vs Barcelona", market: null, selection: "1", submittedOdds: 1.9 },
    ],
  };

  const capturedSports: string[] = [];
  const result = await buildBetSlipPreview(slip, "player-1", TEST_SECRET, {
    verifyOddsFn: async (input) => {
      capturedSports.push(input.sport);
      // This test's slip always sets submittedOdds — real narrowing (not an
      // assertion) since OddsVerificationInput.odds widened to
      // `number | null` in Step 15G for an unrelated, not-yet-wired-in
      // capability that doesn't affect this test's own fixtures.
      if (input.odds === null) throw new Error("test slip always sets submittedOdds");
      return verified(input.odds, input.odds);
    },
  });

  assert.deepEqual(capturedSports.sort(), ["football", "la liga"]);
  assert.equal(result.preview.selections[0].oddsStatus, "VERIFIED");
  assert.equal(result.preview.selections[1].oddsStatus, "VERIFIED");
});

// ---------------------------------------------------------------------
// Step 15I — automatic provider odds lookup for SINGLE, activated only
// when the player submitted no odds at all (submittedOdds: null).
// ---------------------------------------------------------------------

test("Step 15I (A): SINGLE + null odds + provider success — provider is called, submittedOdds is promoted, status VERIFIED, token carries the promoted odds, totalOdds equals the promoted odds", async () => {
  const slip = singleSlip(null);

  let providerCallCount = 0;
  const result = await buildBetSlipPreview(slip, "player-1", TEST_SECRET, {
    verifyOddsFn: async (input) => {
      providerCallCount += 1;
      assert.equal(input.odds, null, "the SINGLE null-odds selection must reach the provider with odds:null, not a fabricated value");
      return verified(2.1, 2.1);
    },
  });

  assert.equal(providerCallCount, 1, "provider lookup must run exactly once for the null-odds SINGLE selection");
  assert.equal(result.preview.selections[0].submittedOdds, 2.1, "submittedOdds must be promoted to the provider's price, not stay null");
  assert.equal(result.preview.selections[0].currentOdds, 2.1);
  assert.equal(result.preview.selections[0].oddsStatus, "VERIFIED");
  assert.equal(result.preview.totalOdds, 2.1, "totalOdds must be computed from the promoted odds, not stay null");
  assert.equal(result.preview.potentialWin, 157.5); // 75 * 2.1

  assert.ok(result.previewToken !== null);
  const verified_ = verifyPreviewToken(result.previewToken!, TEST_SECRET);
  assert.equal(verified_.ok, true);
  if (!verified_.ok) return;
  assert.equal(verified_.payload.odds, 2.1, "the signed token's odds must be the promoted provider price, not null");
  assert.equal(verified_.payload.totalOdds, 2.1);
});

test("Step 15I (B): SINGLE + null odds + provider failure — no odds are fabricated, submittedOdds stays null, existing failure status is preserved", async () => {
  const slip = singleSlip(null);

  let providerCallCount = 0;
  const result = await buildBetSlipPreview(slip, "player-1", TEST_SECRET, {
    verifyOddsFn: async (input) => {
      providerCallCount += 1;
      assert.equal(input.odds, null);
      // A real Step 15G verifyOdds() failed lookup (event/selection/market
      // not found, provider unavailable, etc.) reports submittedOdds: null
      // too — it never fabricates a price just because matching failed.
      return { matched: false, withinTolerance: null, sourceOdds: null, submittedOdds: null, discrepancyPercent: null, bookmaker: null, note: 'No matching event found for "Manchester City vs Chelsea" in soccer_epl' };
    },
  });

  assert.equal(providerCallCount, 1);
  assert.equal(result.preview.selections[0].submittedOdds, null, "a failed lookup must never fabricate a submittedOdds value");
  assert.equal(result.preview.selections[0].oddsStatus, "NOT_FOUND");
  assert.equal(result.preview.totalOdds, null);
  assert.equal(result.preview.potentialWin, null);
});

test("Step 15I (C): SINGLE + real numeric odds — unchanged, byte-for-byte regression", async () => {
  const slip = singleSlip(1.95);

  let providerCallCount = 0;
  const result = await buildBetSlipPreview(slip, "player-1", TEST_SECRET, {
    verifyOddsFn: async (input) => {
      providerCallCount += 1;
      assert.equal(input.odds, 1.95, "a real player-submitted number must reach the provider unchanged, exactly as before this step");
      return verified(1.95, 1.95);
    },
  });

  assert.equal(providerCallCount, 1);
  assert.equal(result.preview.selections[0].submittedOdds, 1.95);
  assert.equal(result.preview.totalOdds, 1.95);
  assert.equal(result.preview.potentialWin, 146.25);
  assert.equal(result.preview.selections[0].oddsStatus, "VERIFIED");
});

test("Step 17: EXPRESS + null odds — provider lookup IS now activated for the null-odds leg, same as SINGLE", async () => {
  const slip: ParsedBetSlip = {
    type: "EXPRESS",
    stake: 40,
    selections: [
      { sport: "Football", event: "Known Odds", market: null, selection: "A Win", submittedOdds: 2.0 },
      { sport: "Football", event: "Unknown Odds", market: null, selection: "B Win", submittedOdds: null },
    ],
  };

  const calledEvents: string[] = [];
  const result = await buildBetSlipPreview(slip, "player-1", TEST_SECRET, {
    verifyOddsFn: async (input) => {
      calledEvents.push(input.event);
      if (input.event === "Known Odds") return verified(input.odds!, input.odds!);
      // "Unknown Odds" — a real, live provider match for a leg the player
      // never typed a price for; the auto-lookup promotes this price.
      return verified(1.65, 1.65);
    },
  });

  assert.deepEqual(calledEvents, ["Known Odds", "Unknown Odds"], "both legs must now reach the provider, including the null-odds one");
  assert.equal(result.preview.selections[1].submittedOdds, 1.65, "the null-odds leg's submittedOdds must be promoted from the provider match");
  assert.equal(result.preview.selections[1].oddsStatus, "VERIFIED");
  assert.equal(result.preview.totalOdds, 3.3); // 2.0 * 1.65
  assert.equal(result.preview.potentialWin, 132); // 40 * 3.3
});

// ---------------------------------------------------------------------
// Step 17 — EXPRESS auto-lookup: removes the Step 15I SINGLE-only
// restriction so a null-submittedOdds EXPRESS leg goes through the exact
// same buildBetSlipPreview() -> oddsVerificationService.verifyMany() ->
// provider.verifySelection() -> verifyOdds() path SINGLE already used.
// Reproduces the diagnosed real-world case: two individually-VERIFIED-as-
// SINGLE events ("Dinamo Zagreb vs Thun", "KuPS vs Sabah Baku"), combined
// into an EXPRESS, neither with a player-submitted price.
// ---------------------------------------------------------------------

function dinamoKupsExpressSlip(): ParsedBetSlip {
  return {
    type: "EXPRESS",
    stake: 100,
    selections: [
      { sport: "Football", event: "Dinamo Zagreb vs Thun", market: "Match Winner", selection: "Dinamo Zagreb", submittedOdds: null },
      { sport: "Football", event: "KuPS vs Sabah Baku", market: "Match Winner", selection: "KuPS", submittedOdds: null },
    ],
  };
}

test("Step 17 (1): EXPRESS of two null-odds legs — both legs are sent to provider verification (verifyMany receives two requests, not zero)", async () => {
  const calledEvents: string[] = [];
  await buildBetSlipPreview(dinamoKupsExpressSlip(), "player-1", TEST_SECRET, {
    verifyOddsFn: async (input) => {
      calledEvents.push(input.event);
      return verified(1.65, 1.65);
    },
  });

  assert.deepEqual(
    calledEvents.sort(),
    ["Dinamo Zagreb vs Thun", "KuPS vs Sabah Baku"].sort(),
    "both null-odds EXPRESS legs must reach the provider",
  );
});

test("Step 17 (1b): DI-level proof — an injected OddsVerificationService.verifyMany() receives exactly two requests for this slip, never an empty batch", async () => {
  const calls: readonly VerifySelectionRequest[][] = [];
  const fakeService = {
    verifyMany: async (requests: readonly VerifySelectionRequest[]): Promise<readonly VerificationResult[]> => {
      (calls as VerifySelectionRequest[][]).push([...requests]);
      return requests.map(() =>
        createVerifiedResult({ submittedOdds: "1.65", currentOdds: "1.65", provider: "THE_ODDS_API", checkedAt: CHECKED_AT }),
      );
    },
  };

  await buildBetSlipPreview(dinamoKupsExpressSlip(), "player-1", TEST_SECRET, { oddsVerificationService: fakeService });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].length, 2, "verifyMany must receive one request per leg, not an empty batch");
});

test("Step 17 (2): EXPRESS of two null-odds legs, both VERIFIED — each leg's currentOdds is filled, totalOdds/potentialWin are computed, Confirm becomes available (token signed)", async () => {
  const result = await buildBetSlipPreview(dinamoKupsExpressSlip(), "player-1", TEST_SECRET, {
    verifyOddsFn: async (input) => {
      if (input.event === "Dinamo Zagreb vs Thun") return verified(1.65, 1.65);
      return verified(2.0, 2.0);
    },
  });

  const [dinamo, kups] = result.preview.selections;
  assert.equal(dinamo.oddsStatus, "VERIFIED");
  assert.equal(dinamo.currentOdds, 1.65);
  assert.equal(dinamo.submittedOdds, 1.65, "auto-lookup must promote the provider price into submittedOdds");
  assert.equal(kups.oddsStatus, "VERIFIED");
  assert.equal(kups.currentOdds, 2.0);
  assert.equal(kups.submittedOdds, 2.0);

  assert.equal(result.preview.totalOdds, 3.3); // 1.65 * 2.0
  assert.equal(result.preview.potentialWin, 330); // 100 * 3.3

  // Confirm becomes available: an EXPRESS previewToken is only ever signed
  // once totalOdds/potentialWin are both known (buildBetSlipPreview.ts's
  // own EXPRESS token-signing condition, unchanged by this fix).
  assert.ok(typeof result.previewToken === "string" && result.previewToken.length > 0);
});

test("Step 17 (3): EXPRESS of two null-odds legs, one NOT_FOUND — that leg maps to NOT_FOUND per the existing mapping, the whole express stays unconfirmable (no token, no totals)", async () => {
  const result = await buildBetSlipPreview(dinamoKupsExpressSlip(), "player-1", TEST_SECRET, {
    verifyOddsFn: async (input) => {
      if (input.event === "Dinamo Zagreb vs Thun") return verified(1.65, 1.65);
      // KuPS vs Sabah Baku — provider genuinely cannot match this event, a
      // real Step 15G verifyOdds() failure never fabricates a price.
      return { matched: false, withinTolerance: null, sourceOdds: null, submittedOdds: null, discrepancyPercent: null, bookmaker: null, note: 'No matching event found for "KuPS vs Sabah Baku" in soccer_epl' };
    },
  });

  const [dinamo, kups] = result.preview.selections;
  assert.equal(dinamo.oddsStatus, "VERIFIED");
  assert.equal(kups.oddsStatus, "NOT_FOUND", "mapOddsCheckToSelectionStatus maps a non-matched-but-attempted check to NOT_FOUND, not UNAVAILABLE");
  assert.equal(kups.currentOdds, null);
  assert.equal(kups.submittedOdds, null, "a failed lookup never fabricates a price");

  // The whole EXPRESS stays unconfirmable: one leg's odds are unknown, so
  // totalOdds/potentialWin can't be computed and no token is signed —
  // downstream (Mini App canConfirmBetSlip.ts / confirm-time
  // verifyPreviewFreshness.ts, both untouched by this fix) already treat
  // NOT_FOUND identically to UNAVAILABLE as blocking.
  assert.equal(result.preview.totalOdds, null);
  assert.equal(result.preview.potentialWin, null);
  assert.equal(result.previewToken, null);
});

test("Step 17 (3b): EXPRESS of two null-odds legs, one provider exception (never attempted a real match) — UNAVAILABLE, still unconfirmable", async () => {
  const result = await buildBetSlipPreview(dinamoKupsExpressSlip(), "player-1", TEST_SECRET, {
    verifyOddsFn: async (input) => {
      if (input.event === "Dinamo Zagreb vs Thun") return verified(1.65, 1.65);
      throw new Error("simulated provider crash");
    },
  });

  const [dinamo, kups] = result.preview.selections;
  assert.equal(dinamo.oddsStatus, "VERIFIED");
  assert.equal(kups.oddsStatus, "UNAVAILABLE", "a genuinely thrown/never-completed check maps to UNAVAILABLE, distinct from an attempted-but-unmatched NOT_FOUND");
  assert.equal(result.preview.totalOdds, null);
  assert.equal(result.previewToken, null);
});

test("Step 17 (4): SINGLE null-odds regression — unaffected by the EXPRESS fix, byte-for-byte same as Step 15I (A)", async () => {
  const slip = singleSlip(null);

  let providerCallCount = 0;
  const result = await buildBetSlipPreview(slip, "player-1", TEST_SECRET, {
    verifyOddsFn: async (input) => {
      providerCallCount += 1;
      assert.equal(input.odds, null);
      return verified(2.1, 2.1);
    },
  });

  assert.equal(providerCallCount, 1);
  assert.equal(result.preview.selections[0].submittedOdds, 2.1);
  assert.equal(result.preview.selections[0].oddsStatus, "VERIFIED");
  assert.equal(result.preview.totalOdds, 2.1);
  assert.equal(result.preview.potentialWin, 157.5);
  assert.ok(result.previewToken !== null);
});

// ---------------------------------------------------------------------
// Step 16A (10, 11) — full-pipeline integration for the exact production
// scenario the league-routing/selection-normalization fix targets:
// "Inter Milan vs Juventus / Inter to win / Stake 10", with an explicit
// league so the request routes correctly regardless of provider data
// availability at any given moment (see Step 16's own root-cause report).
// ---------------------------------------------------------------------

function interVsJuventusSlip(): ParsedBetSlip {
  return {
    type: "SINGLE",
    stake: 10,
    selections: [
      { sport: "Football", league: "Serie A", event: "Inter Milan vs Juventus", market: null, selection: "Inter to win", submittedOdds: null },
    ],
  };
}

test("Step 16A (10): Inter Milan vs Juventus / Inter to win / Stake 10 — provider match produces a confirmable preview with matched odds", async () => {
  const capturedInputs: OddsVerificationInput[] = [];

  const result = await buildBetSlipPreview(interVsJuventusSlip(), "player-1", TEST_SECRET, {
    verifyOddsFn: async (input) => {
      capturedInputs.push(input);
      return verified(2.1, 2.1);
    },
  });

  assert.equal(capturedInputs.length, 1, "the provider must have been called exactly once");
  const capturedInput = capturedInputs[0];
  assert.equal(capturedInput.sport, "serie a", "the explicit Serie A league must route to the 'serie a' legacy sport string, not generic football");
  assert.equal(capturedInput.selection, "Inter", "'Inter to win' must strip to the searchable participant 'Inter'");
  assert.equal(capturedInput.odds, null, "no odds were submitted — the provider must be asked to find/verify a price, not compare against a fabricated one");

  assert.equal(result.preview.selections[0].oddsStatus, "VERIFIED");
  assert.equal(result.preview.selections[0].submittedOdds, 2.1, "the effective submitted odds must be populated from the provider-matched price");
  assert.equal(result.preview.totalOdds, 2.1);
  assert.equal(result.preview.potentialWin, 21, "10 stake * 2.1 odds");

  // Confirmation allowed under the existing Step 15J guard: a real,
  // finite, positive effective odds means a signed, confirmable token.
  assert.ok(result.previewToken !== null);
});

test("Step 16A (11): a correctly routed but absent fixture still returns NOT_FOUND and never fabricates odds", async () => {
  const result = await buildBetSlipPreview(interVsJuventusSlip(), "player-1", TEST_SECRET, {
    verifyOddsFn: async (input) => {
      assert.equal(input.sport, "serie a", "still correctly routed to Serie A even though no fixture exists right now");
      // A real Step 15G verifyOdds() failed lookup never fabricates a
      // price just because the event couldn't be matched.
      return {
        matched: false,
        withinTolerance: null,
        sourceOdds: null,
        submittedOdds: null,
        discrepancyPercent: null,
        bookmaker: null,
        note: 'No matching event found for "Inter Milan vs Juventus" in soccer_italy_serie_a',
      };
    },
  });

  assert.equal(result.preview.selections[0].oddsStatus, "NOT_FOUND");
  assert.equal(result.preview.selections[0].submittedOdds, null, "no odds may ever be fabricated for a fixture the provider genuinely could not find");
  assert.equal(result.preview.totalOdds, null);
  assert.equal(result.preview.potentialWin, null);
});

// ---------------------------------------------------------------------
// Stage 3.1 — provider event references + canonical market/selection
// identity, threaded through the signed previewToken end to end via the
// real production path: verifyOddsFn -> TheOddsApiProvider.verifySelection()
// -> VerificationResult.matchedEvent -> legacyOddsBridge's round-trip back
// into OddsCheckResult -> buildBetSlipPreview's buildProviderTokenFields().
// ---------------------------------------------------------------------

function verifiedWithProviderMetadata(
  sourceOdds: number,
  submittedOdds: number,
  providerEventId: string,
  providerSportKey: string,
  eventStartTime: string,
): OddsCheckResult {
  return { ...verified(sourceOdds, submittedOdds), providerEventId, providerSportKey, eventStartTime };
}

test("Stage 3.1 SINGLE: previewToken carries provider event references and canonical market/selection identity when the provider resolved a real event", async () => {
  const slip = singleSlip(2.15);
  const result = await buildBetSlipPreview(slip, "player-1", TEST_SECRET, {
    verifyOddsFn: fakeVerifyOddsFn({
      "Manchester City vs Chelsea": verifiedWithProviderMetadata(2.15, 2.15, "evt-single-abc", "soccer_epl", "2026-08-15T18:00:00.000Z"),
    }),
  });

  assert.ok(result.previewToken !== null);
  const verified_ = verifyPreviewToken(result.previewToken!, TEST_SECRET);
  assert.equal(verified_.ok, true);
  if (!verified_.ok) return;

  assert.equal(verified_.payload.providerEventId, "evt-single-abc");
  assert.equal(verified_.payload.providerSportKey, "soccer_epl");
  assert.equal(verified_.payload.eventStartTime, "2026-08-15T18:00:00.000Z");
  assert.equal(verified_.payload.canonicalMarketType, "MONEYLINE_2WAY", "the fixture's selection ('Manchester City Win') classifies as PARTICIPANT/MONEYLINE_2WAY");
  assert.equal(verified_.payload.canonicalSelectionType, "PARTICIPANT");
  // Step 16A's winner-phrase stripping (legacySelectionTextToCanonical)
  // normalizes "Manchester City Win" -> participant name "Manchester City"
  // — this is existing, pre-Stage-3.1 behavior, not something this stage
  // changes.
  assert.equal(verified_.payload.canonicalParticipant, "Manchester City");
  assert.equal(verified_.payload.canonicalPeriod, "FULL_GAME");
});

test("Stage 3.1 SINGLE: previewToken's provider metadata comes from the VERIFIED provider result, never from the player's own raw text", async () => {
  // Deliberately different displayed event/selection text than what the
  // provider actually resolved metadata for — proves the token's
  // providerEventId isn't derived from or fabricated out of selection.event.
  const slip = singleSlip(1.33);
  const result = await buildBetSlipPreview(slip, "player-1", TEST_SECRET, {
    verifyOddsFn: fakeVerifyOddsFn({
      "Manchester City vs Chelsea": verifiedWithProviderMetadata(1.33, 1.33, "totally-opaque-provider-id-999", "soccer_epl", "2026-09-01T12:00:00.000Z"),
    }),
  });

  const verified_ = verifyPreviewToken(result.previewToken!, TEST_SECRET);
  assert.equal(verified_.ok, true);
  if (!verified_.ok) return;
  assert.equal(verified_.payload.providerEventId, "totally-opaque-provider-id-999");
});

test("Stage 3.1 SINGLE: previewToken's provider metadata stays null when the odds check never resolved a provider event (NOT_FOUND)", async () => {
  const slip = singleSlip(1.95);
  const result = await buildBetSlipPreview(slip, "player-1", TEST_SECRET, {
    verifyOddsFn: fakeVerifyOddsFn({ "Manchester City vs Chelsea": notFound(1.95) }),
  });

  assert.equal(result.preview.selections[0].oddsStatus, "NOT_FOUND");
  // No token is signed at all once a SINGLE selection is NOT_FOUND-blocking,
  // per the existing (unrelated to this stage) confirmation-blocking rules —
  // nothing further to assert about the token here since none exists; this
  // test documents that fact rather than assuming a token always exists.
});

test("Stage 3.1 EXPRESS: each leg's previewToken selection carries its OWN provider event references — different legs never share or mix IDs", async () => {
  const slip: ParsedBetSlip = {
    type: "EXPRESS",
    stake: 50,
    selections: [
      { sport: "Football", event: "Real Madrid vs Barcelona", market: null, selection: "Real Madrid Win", submittedOdds: 1.8 },
      { sport: "Football", event: "Inter vs Juventus", market: null, selection: "Juventus", submittedOdds: 1.7 },
    ],
  };

  const result = await buildBetSlipPreview(slip, "player-1", TEST_SECRET, {
    verifyOddsFn: fakeVerifyOddsFn({
      "Real Madrid vs Barcelona": verifiedWithProviderMetadata(1.8, 1.8, "evt-express-leg-1", "soccer_spain_la_liga", "2026-08-20T19:00:00.000Z"),
      "Inter vs Juventus": verifiedWithProviderMetadata(1.7, 1.7, "evt-express-leg-2", "soccer_italy_serie_a", "2026-08-21T20:00:00.000Z"),
    }),
  });

  assert.ok(result.previewToken !== null);
  const verified_ = verifyExpressPreviewToken(result.previewToken!, TEST_SECRET);
  assert.equal(verified_.ok, true);
  if (!verified_.ok) return;

  const [leg1, leg2] = verified_.payload.selections;
  assert.equal(leg1.providerEventId, "evt-express-leg-1");
  assert.equal(leg1.providerSportKey, "soccer_spain_la_liga");
  assert.equal(leg1.eventStartTime, "2026-08-20T19:00:00.000Z");
  assert.equal(leg2.providerEventId, "evt-express-leg-2");
  assert.equal(leg2.providerSportKey, "soccer_italy_serie_a");
  assert.equal(leg2.eventStartTime, "2026-08-21T20:00:00.000Z");
  assert.notEqual(leg1.providerEventId, leg2.providerEventId, "different legs' provider event ids must never be mixed up");
});

test("Stage 3.1 EXPRESS: a leg whose provider check failed carries null provider metadata, without affecting a sibling leg's real metadata", async () => {
  const slip: ParsedBetSlip = {
    type: "EXPRESS",
    stake: 50,
    selections: [
      { sport: "Football", event: "Real Madrid vs Barcelona", market: null, selection: "Real Madrid Win", submittedOdds: 1.8 },
      { sport: "Football", event: "Inter vs Juventus", market: null, selection: "Juventus", submittedOdds: 1.7 },
    ],
  };

  const result = await buildBetSlipPreview(slip, "player-1", TEST_SECRET, {
    verifyOddsFn: fakeVerifyOddsFn({
      "Real Madrid vs Barcelona": verifiedWithProviderMetadata(1.8, 1.8, "evt-express-leg-1", "soccer_spain_la_liga", "2026-08-20T19:00:00.000Z"),
      "Inter vs Juventus": notFound(1.7),
    }),
  });

  // No token is signed (one leg is NOT_FOUND, a blocking status), same
  // existing rule as before this stage — nothing token-related to assert.
  assert.equal(result.preview.selections[1].oddsStatus, "NOT_FOUND");
});

/* ============================================================================
 * Betting Markets V1, Phase 3.3 — Totals verification wired into the shared
 * preview pipeline. No separate preview implementation: every test below
 * goes through the exact same buildBetSlipPreview() function every other
 * test in this file does.
 * ============================================================================ */

test("buildBetSlipPreview: SINGLE Over 2.5 preview shows full fixture, direction, line, verified odds, stake, and potential win", async () => {
  const slip: ParsedBetSlip = {
    type: "SINGLE",
    stake: 20,
    selections: [
      { sport: "Football", event: "Arsenal vs Chelsea", market: "Total Goals", selection: "Over 2.5", line: "2.5", submittedOdds: 1.9 },
    ],
  };

  const result = await buildBetSlipPreview(slip, "player-1", TEST_SECRET, {
    oddsVerificationService: totalsAwareVerificationService({}, {
      "Arsenal vs Chelsea": {
        ...verifiedWithProviderMetadata(1.9, 1.9, "evt-totals-single", "soccer_epl", "2026-08-15T18:00:00.000Z"),
        homeTeamName: "Arsenal",
        awayTeamName: "Chelsea",
      },
    }),
  });

  const selection = result.preview.selections[0];
  assert.equal(selection.event, "Arsenal — Chelsea", "full resolved fixture, from the provider's own team names");
  assert.equal(selection.selection, "Over 2.5", "the player's Over/Under intent");
  assert.equal(selection.line, "2.5");
  assert.equal(selection.oddsStatus, "VERIFIED");
  assert.equal(selection.currentOdds, 1.9);
  assert.equal(result.preview.stake, 20);
  assert.equal(result.preview.potentialWin, 38); // 20 * 1.9
  assert.equal(typeof result.previewToken, "string");
  assert.ok(result.previewToken && result.previewToken.length > 0);
});

test("buildBetSlipPreview: SINGLE Under 2.5 VERIFIED", async () => {
  const slip: ParsedBetSlip = {
    type: "SINGLE",
    stake: 20,
    selections: [
      { sport: "Football", event: "Arsenal vs Chelsea", market: null, selection: "Under 2.5", line: "2.5", submittedOdds: 2.0 },
    ],
  };

  const result = await buildBetSlipPreview(slip, "player-1", TEST_SECRET, {
    oddsVerificationService: totalsAwareVerificationService({}, { "Arsenal vs Chelsea": verified(2.0, 2.0) }),
  });

  assert.equal(result.preview.selections[0].oddsStatus, "VERIFIED");
  assert.equal(result.preview.selections[0].line, "2.5");
});

test("buildBetSlipPreview: SINGLE Totals ODDS_CHANGED when the provider's current price differs beyond tolerance", async () => {
  const slip: ParsedBetSlip = {
    type: "SINGLE",
    stake: 20,
    selections: [
      { sport: "Football", event: "Arsenal vs Chelsea", market: null, selection: "Over 2.5", line: "2.5", submittedOdds: 1.9 },
    ],
  };

  const result = await buildBetSlipPreview(slip, "player-1", TEST_SECRET, {
    oddsVerificationService: totalsAwareVerificationService({}, { "Arsenal vs Chelsea": oddsChanged(2.5, 1.9) }),
  });

  assert.equal(result.preview.selections[0].oddsStatus, "ODDS_CHANGED");
});

test("buildBetSlipPreview: SINGLE Totals token carries canonicalMarketType/canonicalSelectionType/canonicalLine", async () => {
  const slip: ParsedBetSlip = {
    type: "SINGLE",
    stake: 20,
    selections: [
      { sport: "Football", event: "Arsenal vs Chelsea", market: null, selection: "Over 2.5", line: "2.5", submittedOdds: 1.9 },
    ],
  };

  const result = await buildBetSlipPreview(slip, "player-1", TEST_SECRET, {
    oddsVerificationService: totalsAwareVerificationService({}, { "Arsenal vs Chelsea": verifiedWithProviderMetadata(1.9, 1.9, "evt-token-totals", "soccer_epl", "2026-08-15T18:00:00.000Z") }),
  });

  assert.ok(result.previewToken);
  const verified_ = verifyPreviewToken(result.previewToken!, TEST_SECRET);
  assert.equal(verified_.ok, true);
  if (!verified_.ok) return;

  assert.equal(verified_.payload.canonicalMarketType, "TOTALS");
  assert.equal(verified_.payload.canonicalSelectionType, "OVER");
  assert.equal(verified_.payload.canonicalLine, "2.5");
});

test("buildBetSlipPreview: EXPRESS with two Totals legs — both verify through the same shared pipeline", async () => {
  const slip: ParsedBetSlip = {
    type: "EXPRESS",
    stake: 30,
    selections: [
      { sport: "Football", event: "Arsenal vs Chelsea", market: null, selection: "Over 2.5", line: "2.5", submittedOdds: 1.9 },
      { sport: "Football", event: "Inter vs Juventus", market: null, selection: "Under 3.5", line: "3.5", submittedOdds: 1.8 },
    ],
  };

  const result = await buildBetSlipPreview(slip, "player-1", TEST_SECRET, {
    oddsVerificationService: totalsAwareVerificationService({}, {
      // providerEventId must be present for the canonical fields to enter
      // the token at all — buildProviderTokenFields' own "gated as one
      // atomic unit" rule (buildBetSlipPreview.ts).
      "Arsenal vs Chelsea": verifiedWithProviderMetadata(1.9, 1.9, "evt-express-totals-1", "soccer_epl", "2026-08-15T18:00:00.000Z"),
      "Inter vs Juventus": verifiedWithProviderMetadata(1.8, 1.8, "evt-express-totals-2", "soccer_italy_serie_a", "2026-08-16T20:00:00.000Z"),
    }),
  });

  assert.equal(result.preview.selections[0].oddsStatus, "VERIFIED");
  assert.equal(result.preview.selections[0].line, "2.5");
  assert.equal(result.preview.selections[1].oddsStatus, "VERIFIED");
  assert.equal(result.preview.selections[1].line, "3.5");
  assert.ok(result.previewToken);

  const verified_ = verifyExpressPreviewToken(result.previewToken!, TEST_SECRET);
  assert.equal(verified_.ok, true);
  if (!verified_.ok) return;
  assert.equal(verified_.payload.selections[0].canonicalMarketType, "TOTALS");
  assert.equal(verified_.payload.selections[0].canonicalLine, "2.5");
  assert.equal(verified_.payload.selections[1].canonicalMarketType, "TOTALS");
  assert.equal(verified_.payload.selections[1].canonicalLine, "3.5");
});

test("buildBetSlipPreview: mixed EXPRESS with MONEYLINE + TOTALS legs — each routes through its own provider seam correctly", async () => {
  const slip: ParsedBetSlip = {
    type: "EXPRESS",
    stake: 30,
    selections: [
      { sport: "Football", event: "Real Madrid vs Barcelona", market: null, selection: "Real Madrid Win", submittedOdds: 1.8 },
      { sport: "Football", event: "Arsenal vs Chelsea", market: null, selection: "Over 2.5", line: "2.5", submittedOdds: 1.9 },
    ],
  };

  const result = await buildBetSlipPreview(slip, "player-1", TEST_SECRET, {
    oddsVerificationService: totalsAwareVerificationService(
      { "Real Madrid vs Barcelona": verifiedWithProviderMetadata(1.8, 1.8, "evt-mixed-moneyline", "soccer_spain_la_liga", "2026-08-20T19:00:00.000Z") },
      { "Arsenal vs Chelsea": verifiedWithProviderMetadata(1.9, 1.9, "evt-mixed-totals", "soccer_epl", "2026-08-15T18:00:00.000Z") },
    ),
  });

  assert.equal(result.preview.selections[0].oddsStatus, "VERIFIED");
  assert.equal(result.preview.selections[0].line, null, "MONEYLINE leg has no line");
  assert.equal(result.preview.selections[1].oddsStatus, "VERIFIED");
  assert.equal(result.preview.selections[1].line, "2.5");

  const verified_ = verifyExpressPreviewToken(result.previewToken!, TEST_SECRET);
  assert.equal(verified_.ok, true);
  if (!verified_.ok) return;
  assert.equal(verified_.payload.selections[0].canonicalMarketType, "MONEYLINE_2WAY");
  assert.equal(verified_.payload.selections[0].canonicalLine, null);
  assert.equal(verified_.payload.selections[1].canonicalMarketType, "TOTALS");
  assert.equal(verified_.payload.selections[1].canonicalLine, "2.5");
});

test("buildBetSlipPreview: Totals FAILED (line not offered) never becomes a misleading VERIFIED", async () => {
  const slip: ParsedBetSlip = {
    type: "SINGLE",
    stake: 20,
    selections: [
      { sport: "Football", event: "Arsenal vs Chelsea", market: null, selection: "Over 2.5", line: "2.5", submittedOdds: 1.9 },
    ],
  };

  const result = await buildBetSlipPreview(slip, "player-1", TEST_SECRET, {
    oddsVerificationService: totalsAwareVerificationService({}, {
      "Arsenal vs Chelsea": {
        matched: false,
        withinTolerance: null,
        sourceOdds: null,
        submittedOdds: 1.9,
        discrepancyPercent: null,
        bookmaker: null,
        note: 'Could not match totals selection "OVER 2.5" for "Arsenal vs Chelsea" (LINE_NOT_AVAILABLE)',
      },
    }),
  });

  assert.notEqual(result.preview.selections[0].oddsStatus, "VERIFIED");
  assert.equal(result.preview.selections[0].oddsStatus, "NOT_FOUND");
});

/* -------------------------------------------------------------------------- */
/* H5-A4.1 — full preview-path proof for the live-proven TOTALS bookmaker    */
/* fallback bug (Arsenal vs Coventry City). oddsVerifier.ts's own            */
/* findTotalsOutcome() tests (lib/odds/oddsVerifier.test.ts) already prove   */
/* the fallback resolves to the correct bookmaker/price at the provider      */
/* layer; these two tests instead prove that same resolved price/bookmaker   */
/* actually flows, unmodified, all the way through buildBetSlipPreview() to  */
/* a confirmable VERIFIED preview — using the fake totals verifier seam      */
/* (no live network dependency), since the fake stands in for whatever the   */
/* real provider/findTotalsOutcome() returns.                                */
/* -------------------------------------------------------------------------- */

test("H5-A4.1 preview path: Arsenal vs Coventry City 'Over 2.5' stake 10 -> VERIFIED at the 1xBet fallback price (1.64), confirmable", async () => {
  const slip: ParsedBetSlip = {
    type: "SINGLE",
    stake: 10,
    selections: [
      { sport: "Football", event: "Arsenal vs Coventry City", market: null, selection: "Over 2.5", line: "2.5", submittedOdds: 1.64 },
    ],
  };

  const result = await buildBetSlipPreview(slip, "player-1", TEST_SECRET, {
    oddsVerificationService: totalsAwareVerificationService({}, {
      "Arsenal vs Coventry City": verified(1.64, 1.64, "1xBet"),
    }),
  });

  assert.equal(result.preview.selections[0].oddsStatus, "VERIFIED");
  assert.equal(result.preview.selections[0].line, "2.5");
  assert.equal(result.preview.totalOdds, 1.64);
  assert.ok(result.previewToken && result.previewToken.length > 0);

  const confirmable = canConfirmBetSlip(true, {
    preview: result.preview as unknown as BetPreview,
    previewToken: result.previewToken,
  });
  assert.equal(confirmable, true, "a VERIFIED single with a signed token must be confirmable");
});

test("H5-A4.1 preview path: Arsenal vs Coventry City 'Under 2.5' stake 10 -> VERIFIED at the 1xBet fallback price (2.47), confirmable", async () => {
  const slip: ParsedBetSlip = {
    type: "SINGLE",
    stake: 10,
    selections: [
      { sport: "Football", event: "Arsenal vs Coventry City", market: null, selection: "Under 2.5", line: "2.5", submittedOdds: 2.47 },
    ],
  };

  const result = await buildBetSlipPreview(slip, "player-1", TEST_SECRET, {
    oddsVerificationService: totalsAwareVerificationService({}, {
      "Arsenal vs Coventry City": verified(2.47, 2.47, "1xBet"),
    }),
  });

  assert.equal(result.preview.selections[0].oddsStatus, "VERIFIED");
  assert.equal(result.preview.selections[0].line, "2.5");
  assert.equal(result.preview.totalOdds, 2.47);
  assert.ok(result.previewToken && result.previewToken.length > 0);

  const confirmable = canConfirmBetSlip(true, {
    preview: result.preview as unknown as BetPreview,
    previewToken: result.previewToken,
  });
  assert.equal(confirmable, true, "a VERIFIED single with a signed token must be confirmable");
});

/* -------------------------------------------------------------------------- */
/* Handicap Stage H2 — SPREAD preview display normalization                   */
/*                                                                            */
/* buildBetSlipPreview.ts itself never reconstructs a display label (the     */
/* `selection` field always stays the player's raw text) — these tests prove */
/* the additive marketType/participant fields it now threads through are     */
/* exactly what lib/bets/normalizeSelectionToEnglish.ts needs to render the  */
/* correct "Arsenal -1.5" label, without buildBetSlipPreview.ts itself doing */
/* any formatting. See lib/bets/normalizeSelectionToEnglish.test.ts for the  */
/* formatter's own unit coverage (sign rules, multi-team cases, etc).        */
/* -------------------------------------------------------------------------- */

function fakeVerifySpreadOddsFn(
  byEvent: Record<string, OddsCheckResult | "reject">,
  onCall?: (input: { sport: string; event: string; participant: string; line: string; odds: number | null }) => void,
) {
  return async (input: {
    sport: string;
    event: string;
    participant: string;
    line: string;
    odds: number | null;
  }): Promise<OddsCheckResult> => {
    onCall?.(input);
    const outcome = byEvent[input.event];
    if (outcome === undefined) throw new Error(`No fake spread outcome configured for event "${input.event}"`);
    if (outcome === "reject") throw new Error(`Simulated spread odds-check failure for "${input.event}"`);
    return outcome;
  };
}

test("Handicap Stage H2 (mandatory preview integration): raw 'Arsenal F1(-1.5)' selection round-trips through buildBetSlipPreview with canonical SPREAD/Arsenal/-1.5, and normalizeSelectionToEnglish renders 'Arsenal -1.5' from those exact preview fields — odds/currentOdds/bookmaker are unchanged by this addition", async () => {
  const slip: ParsedBetSlip = {
    type: "SINGLE",
    stake: 10,
    selections: [
      { sport: "Football", event: "Arsenal vs Coventry City", market: null, selection: "Arsenal F1(-1.5)", submittedOdds: 1.91 },
    ],
  };

  let capturedSpreadInput: { participant: string; line: string } | null = null;
  const provider = new TheOddsApiProvider(
    fakeVerifyOddsFn({}),
    undefined,
    fakeVerifySpreadOddsFn(
      { "Arsenal vs Coventry City": verified(1.91, 1.91, "MyBookie.ag") },
      (input) => {
        capturedSpreadInput = { participant: input.participant, line: input.line };
      },
    ),
  );
  const service = new OddsVerificationService(provider);

  const result = await buildBetSlipPreview(slip, "player-1", TEST_SECRET, { oddsVerificationService: service });
  const previewSelection = result.preview.selections[0];

  // The odds check was actually verified through the SPREAD seam, with the
  // exact participant/line pair the canonical classifier extracted — never
  // MONEYLINE/h2h.
  assert.deepEqual(capturedSpreadInput, { participant: "Arsenal", line: "-1.5" });

  // Canonical display fields are exactly what was classified — never
  // reconstructed or altered.
  assert.equal(previewSelection.marketType, "SPREAD");
  assert.equal(previewSelection.participant, "Arsenal");
  assert.equal(previewSelection.line, "-1.5");
  // Raw AI text is preserved verbatim on `selection` — buildBetSlipPreview.ts
  // itself does no display formatting, matching layer semantics unchanged.
  assert.equal(previewSelection.selection, "Arsenal F1(-1.5)");
  // Odds/provider metadata are unaffected by this display-only addition.
  assert.equal(previewSelection.oddsStatus, "VERIFIED");
  assert.equal(previewSelection.currentOdds, 1.91);
  assert.equal(previewSelection.submittedOdds, 1.91);
  assert.equal(previewSelection.bookmaker, "MyBookie.ag");

  // The actual display seam (what components/miniapp/BetPreviewCard.tsx
  // calls) — proves the full chain end-to-end, not just the formatter
  // tested in isolation against hand-built input.
  const displayLabel = normalizeSelectionToEnglish({
    selection: previewSelection.selection,
    sport: previewSelection.sport,
    event: previewSelection.event,
    market: previewSelection.market,
    marketType: previewSelection.marketType,
    participant: previewSelection.participant,
    line: previewSelection.line,
  });
  assert.equal(displayLabel, "Arsenal -1.5");
});

test("Handicap Stage H2: a positive-line SPREAD selection ('Coventry City F2(+1.5)') threads participant/line/marketType through the preview and renders 'Coventry City +1.5'", async () => {
  const slip: ParsedBetSlip = {
    type: "SINGLE",
    stake: 10,
    selections: [
      {
        sport: "Football",
        event: "Arsenal vs Coventry City",
        market: null,
        selection: "Coventry City F2(+1.5)",
        submittedOdds: 1.91,
      },
    ],
  };

  const provider = new TheOddsApiProvider(
    fakeVerifyOddsFn({}),
    undefined,
    fakeVerifySpreadOddsFn({ "Arsenal vs Coventry City": verified(1.91, 1.91, "Pinnacle") }),
  );
  const service = new OddsVerificationService(provider);

  const result = await buildBetSlipPreview(slip, "player-1", TEST_SECRET, { oddsVerificationService: service });
  const previewSelection = result.preview.selections[0];

  assert.equal(previewSelection.marketType, "SPREAD");
  assert.equal(previewSelection.participant, "Coventry City");
  assert.equal(previewSelection.line, "1.5");

  const displayLabel = normalizeSelectionToEnglish({
    selection: previewSelection.selection,
    marketType: previewSelection.marketType,
    participant: previewSelection.participant,
    line: previewSelection.line,
  });
  assert.equal(displayLabel, "Coventry City +1.5");
});

/* -------------------------------------------------------------------------- */
/* H4-B5, Section 12 — real preview/confirmability path for a quarter-line   */
/* SPREAD selection, through the REAL buildBetSlipPreview -> classifier ->   */
/* TheOddsApiProvider chain (not a hand-built canonical selection).          */
/* -------------------------------------------------------------------------- */

test("H4-B5 CASE A: 'Arsenal F1(-1.25)' stake 10 — exact quarter line offered by the provider — VERIFIED, confirmable (real spread price, signed token)", async () => {
  const slip: ParsedBetSlip = {
    type: "SINGLE",
    stake: 10,
    selections: [{ sport: "Football", event: "Arsenal vs Coventry City", market: null, selection: "Arsenal F1(-1.25)", submittedOdds: 1.91 }],
  };

  let capturedSpreadInput: { participant: string; line: string } | null = null;
  const provider = new TheOddsApiProvider(
    fakeVerifyOddsFn({}),
    undefined,
    fakeVerifySpreadOddsFn({ "Arsenal vs Coventry City": verified(1.91, 1.91, "MyBookie.ag") }, (input) => {
      capturedSpreadInput = { participant: input.participant, line: input.line };
    }),
  );
  const service = new OddsVerificationService(provider);

  const result = await buildBetSlipPreview(slip, "player-1", TEST_SECRET, { oddsVerificationService: service });
  const previewSelection = result.preview.selections[0];

  assert.deepEqual(capturedSpreadInput, { participant: "Arsenal", line: "-1.25" }, "the exact quarter line must reach the real spread verifier unchanged");
  assert.equal(previewSelection.marketType, "SPREAD");
  assert.equal(previewSelection.line, "-1.25");
  assert.equal(previewSelection.oddsStatus, "VERIFIED");
  assert.equal(previewSelection.currentOdds, 1.91);
  assert.equal(previewSelection.bookmaker, "MyBookie.ag");
  assert.notEqual(result.previewToken, null, "a VERIFIED quarter-line SPREAD selection must be confirmable — a signed preview token is produced");
});

test("H4-B5 CASE B: 'Arsenal -1.25 stake 10' — exact quarter line UNAVAILABLE from the provider (only -1.0/-1.5 offered) — NOT confirmable (real canConfirmBetSlip gate), no substitution, no fabricated odds", async () => {
  // Confirmability for a real bet is decided by the SAME function the Mini
  // App UI actually uses (components/miniapp/canConfirmBetSlip.ts), never
  // re-derived here — that function's own oddsStatus gate
  // (NOT_FOUND/UNAVAILABLE/PENDING all block, regardless of whether a
  // previewToken happens to exist) is buildBetSlipPreview's real, existing,
  // unrelated-to-this-stage confirmability rule for a SINGLE bet: a token
  // can exist from the player's own self-reported odds even when
  // unverified (see betPreviewApi.ts's own "Always a real token for
  // SINGLE" comment) — oddsStatus, not token presence, is what actually
  // blocks the Confirm button.
  const slip: ParsedBetSlip = {
    type: "SINGLE",
    stake: 10,
    selections: [{ sport: "Football", event: "Arsenal vs Coventry City", market: null, selection: "Arsenal F1(-1.25)", submittedOdds: 1.9 }],
  };

  const provider = new TheOddsApiProvider(
    fakeVerifyOddsFn({}),
    undefined,
    fakeVerifySpreadOddsFn({
      "Arsenal vs Coventry City": {
        matched: false,
        withinTolerance: null,
        sourceOdds: null,
        submittedOdds: 1.9,
        discrepancyPercent: null,
        bookmaker: null,
        note: 'Could not match spread selection "Arsenal -1.25" for "Arsenal vs Coventry City" (LINE_NOT_AVAILABLE)',
      },
    }),
  );
  const service = new OddsVerificationService(provider);

  const result = await buildBetSlipPreview(slip, "player-1", TEST_SECRET, { oddsVerificationService: service });
  const previewSelection = result.preview.selections[0];

  assert.equal(previewSelection.marketType, "SPREAD");
  assert.equal(previewSelection.line, "-1.25", "the requested line is still preserved exactly in the preview even though it couldn't be verified — never rounded/substituted");
  assert.equal(previewSelection.oddsStatus, "NOT_FOUND");
  assert.notEqual(previewSelection.oddsStatus, "VERIFIED", "the player's own stated odds must never be silently treated as a real provider match");
  assert.equal(previewSelection.currentOdds, null, "no fabricated/substituted provider odds");
  assert.equal(previewSelection.bookmaker, null, "no invented bookmaker for an unmatched line");

  const confirmable = canConfirmBetSlip(true, {
    preview: result.preview as unknown as BetPreview,
    previewToken: result.previewToken,
  });
  assert.equal(confirmable, false, "an unverified quarter-line SPREAD selection must NOT be confirmable, via the real Mini App confirmability gate");
});

test("H4-B5 CASE B (no odds stated): 'Arsenal -1.25 stake 10' with no self-reported odds at all — also NOT confirmable, no token needed to prove it", async () => {
  const slip: ParsedBetSlip = {
    type: "SINGLE",
    stake: 10,
    selections: [{ sport: "Football", event: "Arsenal vs Coventry City", market: null, selection: "Arsenal F1(-1.25)", submittedOdds: null }],
  };

  const provider = new TheOddsApiProvider(
    fakeVerifyOddsFn({}),
    undefined,
    fakeVerifySpreadOddsFn({
      "Arsenal vs Coventry City": {
        matched: false,
        withinTolerance: null,
        sourceOdds: null,
        submittedOdds: null,
        discrepancyPercent: null,
        bookmaker: null,
        note: 'Could not match spread selection "Arsenal -1.25" for "Arsenal vs Coventry City" (LINE_NOT_AVAILABLE)',
      },
    }),
  );
  const service = new OddsVerificationService(provider);

  const result = await buildBetSlipPreview(slip, "player-1", TEST_SECRET, { oddsVerificationService: service });

  const confirmable = canConfirmBetSlip(true, {
    preview: result.preview as unknown as BetPreview,
    previewToken: result.previewToken,
  });
  assert.equal(confirmable, false);
});

/* -------------------------------------------------------------------------- */
/* H4-B5.1 — event-metadata preservation on a FAILED exact-line lookup. Live */
/* forensic audit proved lib/odds/oddsVerifier.ts's verifySpreadOdds() ALWAYS */
/* spreads the resolved event's provider metadata into its result even when  */
/* the specific requested line has no bookmaker price (LINE_NOT_AVAILABLE) — */
/* the two CASE B tests above never actually proved this, because their fake */
/* verifySpreadOddsFn stub replaces oddsVerifier.ts's real behavior wholesale */
/* and never included homeTeamName/awayTeamName in its canned response. These */
/* two tests close that gap: standard (C) and quarter (D) SPREAD lines alike */
/* must both retain the real, resolved event display fields on the preview   */
/* even when oddsStatus ends up NOT_FOUND — this is what keeps the preview   */
/* showing "Arsenal — Coventry City" rather than a bare fallback, and is the */
/* exact invariant Section 6/7 of the H4-B5.1 audit required be proven, not  */
/* merely assumed.                                                           */
/* -------------------------------------------------------------------------- */

test("H4-B5.1 Section 11(A): standard SPREAD VERIFIED preserves the resolved event's homeTeamName/awayTeamName/competitionName/event display field", async () => {
  const slip: ParsedBetSlip = {
    type: "SINGLE",
    stake: 10,
    selections: [{ sport: "Football", event: "Arsenal", market: null, selection: "Arsenal -1.5", submittedOdds: null }],
  };

  const provider = new TheOddsApiProvider(
    fakeVerifyOddsFn({}),
    undefined,
    fakeVerifySpreadOddsFn({
      Arsenal: {
        matched: true,
        withinTolerance: true,
        sourceOdds: 1.63,
        submittedOdds: 1.63,
        discrepancyPercent: 0,
        bookmaker: "1xBet",
        note: null,
        providerEventId: "evt-arsenal-coventry",
        providerSportKey: "soccer_epl",
        eventStartTime: "2026-08-21T19:00:00.000Z",
        homeTeamName: "Arsenal",
        awayTeamName: "Coventry City",
        competitionName: "Premier League",
      },
    }),
  );
  const service = new OddsVerificationService(provider);

  const result = await buildBetSlipPreview(slip, "player-1", TEST_SECRET, { oddsVerificationService: service });
  const previewSelection = result.preview.selections[0];

  assert.equal(previewSelection.oddsStatus, "VERIFIED");
  assert.equal(previewSelection.event, "Arsenal — Coventry City");
  assert.equal(previewSelection.homeTeamName, "Arsenal");
  assert.equal(previewSelection.awayTeamName, "Coventry City");
  assert.equal(previewSelection.competitionName, "Premier League");
});

test("H4-B5.1 Section 11(B): quarter SPREAD VERIFIED preserves the resolved event's homeTeamName/awayTeamName/competitionName/event display field", async () => {
  const slip: ParsedBetSlip = {
    type: "SINGLE",
    stake: 10,
    selections: [{ sport: "Football", event: "Arsenal", market: null, selection: "Arsenal -1.25", submittedOdds: null }],
  };

  const provider = new TheOddsApiProvider(
    fakeVerifyOddsFn({}),
    undefined,
    fakeVerifySpreadOddsFn({
      Arsenal: {
        matched: true,
        withinTolerance: true,
        sourceOdds: 1.91,
        submittedOdds: 1.91,
        discrepancyPercent: 0,
        bookmaker: "MyBookie.ag",
        note: null,
        providerEventId: "evt-arsenal-coventry",
        providerSportKey: "soccer_epl",
        eventStartTime: "2026-08-21T19:00:00.000Z",
        homeTeamName: "Arsenal",
        awayTeamName: "Coventry City",
        competitionName: "Premier League",
      },
    }),
  );
  const service = new OddsVerificationService(provider);

  const result = await buildBetSlipPreview(slip, "player-1", TEST_SECRET, { oddsVerificationService: service });
  const previewSelection = result.preview.selections[0];

  assert.equal(previewSelection.marketType, "SPREAD");
  assert.equal(previewSelection.line, "-1.25");
  assert.equal(previewSelection.oddsStatus, "VERIFIED");
  assert.equal(previewSelection.event, "Arsenal — Coventry City");
  assert.equal(previewSelection.homeTeamName, "Arsenal");
  assert.equal(previewSelection.awayTeamName, "Coventry City");
  assert.equal(previewSelection.competitionName, "Premier League");
});

test("H4-B5.1 Section 11(C): standard SPREAD line unavailable (-2.5, e.g.) still preserves the resolved event's homeTeamName/awayTeamName/competitionName/event display field — never <UNKNOWN>, never dropped", async () => {
  const slip: ParsedBetSlip = {
    type: "SINGLE",
    stake: 10,
    selections: [{ sport: "Football", event: "Arsenal", market: null, selection: "Arsenal -2.5", submittedOdds: null }],
  };

  const provider = new TheOddsApiProvider(
    fakeVerifyOddsFn({}),
    undefined,
    fakeVerifySpreadOddsFn({
      Arsenal: {
        matched: false,
        withinTolerance: null,
        sourceOdds: null,
        submittedOdds: null,
        discrepancyPercent: null,
        bookmaker: null,
        note: 'Could not match spread selection "Arsenal -2.5" for "Arsenal" (LINE_NOT_AVAILABLE)',
        providerEventId: "evt-arsenal-coventry",
        providerSportKey: "soccer_epl",
        eventStartTime: "2026-08-21T19:00:00.000Z",
        homeTeamName: "Arsenal",
        awayTeamName: "Coventry City",
        competitionName: "Premier League",
      },
    }),
  );
  const service = new OddsVerificationService(provider);

  const result = await buildBetSlipPreview(slip, "player-1", TEST_SECRET, { oddsVerificationService: service });
  const previewSelection = result.preview.selections[0];

  assert.equal(previewSelection.oddsStatus, "NOT_FOUND");
  assert.equal(previewSelection.currentOdds, null, "no fabricated odds");
  assert.equal(previewSelection.event, "Arsenal — Coventry City", "the resolved event must still display, never fall back to the bare single-team text");
  assert.equal(previewSelection.homeTeamName, "Arsenal");
  assert.equal(previewSelection.awayTeamName, "Coventry City");
  assert.equal(previewSelection.competitionName, "Premier League");
});

test("H4-B5.1 Section 11(D): quarter SPREAD line unavailable (-0.75) still preserves the resolved event's homeTeamName/awayTeamName/competitionName/event display field — never <UNKNOWN>, never dropped (the exact production scenario this audit investigated)", async () => {
  const slip: ParsedBetSlip = {
    type: "SINGLE",
    stake: 10,
    selections: [{ sport: "Football", event: "Arsenal", market: null, selection: "Arsenal -0.75", submittedOdds: null }],
  };

  const provider = new TheOddsApiProvider(
    fakeVerifyOddsFn({}),
    undefined,
    fakeVerifySpreadOddsFn({
      Arsenal: {
        matched: false,
        withinTolerance: null,
        sourceOdds: null,
        submittedOdds: null,
        discrepancyPercent: null,
        bookmaker: null,
        note: 'Could not match spread selection "Arsenal -0.75" for "Arsenal" (LINE_NOT_AVAILABLE)',
        providerEventId: "evt-arsenal-coventry",
        providerSportKey: "soccer_epl",
        eventStartTime: "2026-08-21T19:00:00.000Z",
        homeTeamName: "Arsenal",
        awayTeamName: "Coventry City",
        competitionName: "Premier League",
      },
    }),
  );
  const service = new OddsVerificationService(provider);

  const result = await buildBetSlipPreview(slip, "player-1", TEST_SECRET, { oddsVerificationService: service });
  const previewSelection = result.preview.selections[0];

  assert.equal(previewSelection.marketType, "SPREAD");
  assert.equal(previewSelection.line, "-0.75", "the requested quarter line is preserved exactly, never rounded/substituted");
  assert.equal(previewSelection.oddsStatus, "NOT_FOUND");
  assert.equal(previewSelection.currentOdds, null, "no fabricated odds");
  assert.equal(previewSelection.event, "Arsenal — Coventry City", "the resolved event must still display, never fall back to the bare single-team text or <UNKNOWN>");
  assert.equal(previewSelection.homeTeamName, "Arsenal");
  assert.equal(previewSelection.awayTeamName, "Coventry City");
  assert.equal(previewSelection.competitionName, "Premier League");

  const confirmable = canConfirmBetSlip(true, {
    preview: result.preview as unknown as BetPreview,
    previewToken: result.previewToken,
  });
  assert.equal(confirmable, false, "event display recovering must never make an unverified line confirmable");
});

test("H4-B5.4: the EXACT real production shape (event: '<UNKNOWN>', selection: 'Arsenal', market hint 'Handicap', line '-0.75' — proven live via the H4-B5.3 diagnostic) now resolves to Event 'Arsenal — Coventry City' end-to-end through buildBetSlipPreview, instead of staying <UNKNOWN>", async () => {
  const slip: ParsedBetSlip = {
    type: "SINGLE",
    stake: 10,
    // This mirrors the real production RawBetSlipFields shape observed via
    // the H4-B5.3 [BET_PREVIEW_DIAGNOSTIC] log: event was the literal AI
    // placeholder "<UNKNOWN>", selection was the bare participant name
    // "Arsenal" (the line was carried separately, not embedded in the
    // selection text), and the final preview's marketType/participant came
    // out SPREAD/"Arsenal" — only reachable if a market hint like "Handicap"
    // combined with "Arsenal" via classifyBettingSelectionTextWithMarketHint's
    // own H3 reconstruction rule (lib/odds/shorthandClassifier.ts).
    selections: [{ sport: "Football", event: "<UNKNOWN>", market: "Handicap", marketRawText: "Handicap", selection: "Arsenal", line: "-0.75", submittedOdds: null }],
  };

  let capturedSpreadEvent: string | null = null;
  const provider = new TheOddsApiProvider(
    fakeVerifyOddsFn({}),
    undefined,
    fakeVerifySpreadOddsFn(
      {
        // Keyed by "Arsenal" — the RECOVERED search hint — never by the
        // literal "<UNKNOWN>" text. If the fix regressed and the raw
        // placeholder text were still sent as the query, this fake would
        // throw "no fake spread outcome configured for event" and the test
        // would fail loudly rather than silently passing.
        Arsenal: {
          matched: false,
          withinTolerance: null,
          sourceOdds: null,
          submittedOdds: null,
          discrepancyPercent: null,
          bookmaker: null,
          note: 'Could not match spread selection "Arsenal -0.75" for "Arsenal" (LINE_NOT_AVAILABLE)',
          providerEventId: "evt-arsenal-coventry",
          providerSportKey: "soccer_epl",
          eventStartTime: "2026-08-21T19:00:00.000Z",
          homeTeamName: "Arsenal",
          awayTeamName: "Coventry City",
          competitionName: "Premier League",
        },
      },
      (input) => {
        capturedSpreadEvent = input.event;
      },
    ),
  );
  const service = new OddsVerificationService(provider);

  const result = await buildBetSlipPreview(slip, "player-1", TEST_SECRET, { oddsVerificationService: service });
  const previewSelection = result.preview.selections[0];

  assert.equal(capturedSpreadEvent, "Arsenal", "the provider must be queried with the recovered participant name, never the literal '<UNKNOWN>' placeholder");
  assert.equal(previewSelection.marketType, "SPREAD");
  assert.equal(previewSelection.participant, "Arsenal");
  assert.equal(previewSelection.line, "-0.75");
  assert.equal(previewSelection.oddsStatus, "NOT_FOUND");
  assert.equal(previewSelection.currentOdds, null, "no fabricated odds — the line is still genuinely unavailable");
  assert.equal(
    previewSelection.event,
    "Arsenal — Coventry City",
    "this is the actual production bug fix: the event must now resolve and display correctly instead of staying '<UNKNOWN>'",
  );
  assert.equal(previewSelection.homeTeamName, "Arsenal");
  assert.equal(previewSelection.awayTeamName, "Coventry City");
});

test("H4-B5.6: the full preview path for the exact live production bug — 'Arsenal -2.0 stake 10' against a deterministic provider fixture whose point is -2/price 1.93 — resolves VERIFIED and confirmable, with the request canonicalized to '-2' before it ever reaches the provider", async () => {
  const slip: ParsedBetSlip = {
    type: "SINGLE",
    stake: 10,
    selections: [{ sport: "Football", event: "Arsenal", market: null, selection: "Arsenal -2.0", line: "-2.0", submittedOdds: null }],
  };

  let capturedSpreadLine: string | null = null;
  const provider = new TheOddsApiProvider(
    fakeVerifyOddsFn({}),
    undefined,
    fakeVerifySpreadOddsFn(
      {
        // Keyed by the participant search text ("Arsenal") — this fake
        // stands in for a real oddsVerifier.ts result against a provider
        // fixture whose point is the JS number -2, price 1.93 (see
        // oddsVerifier.test.ts's own full fetch->match pipeline proof of
        // this exact fixture, including homeTeamName/awayTeamName/
        // competitionName exactly as the real, unmodified verifySpreadOdds
        // would return them). This test's own job is to prove
        // buildBetSlipPreview's DISPLAY/confirmability behavior once
        // matching succeeds, not to re-prove the matching algorithm itself.
        Arsenal: {
          matched: true,
          withinTolerance: true,
          sourceOdds: 1.93,
          submittedOdds: 1.93,
          discrepancyPercent: 0,
          bookmaker: "Pinnacle",
          note: null,
          providerEventId: "evt-arsenal-coventry-h4b56",
          providerSportKey: "soccer_epl",
          eventStartTime: "2026-08-21T19:00:00.000Z",
          homeTeamName: "Arsenal",
          awayTeamName: "Coventry City",
          competitionName: "Premier League",
        },
      },
      (input) => {
        capturedSpreadLine = input.line;
      },
    ),
  );
  const service = new OddsVerificationService(provider);

  const result = await buildBetSlipPreview(slip, "player-1", TEST_SECRET, { oddsVerificationService: service });
  const previewSelection = result.preview.selections[0];

  assert.equal(capturedSpreadLine, "-2", "the request must be canonicalized to '-2' before reaching the provider — never the raw '-2.0' text");
  assert.equal(previewSelection.marketType, "SPREAD");
  assert.equal(previewSelection.participant, "Arsenal");
  assert.equal(previewSelection.line, "-2", "the canonical/display line is the trailing-zero-stripped form — this is the accepted display normalization, not a UI change");
  assert.equal(previewSelection.oddsStatus, "VERIFIED");
  assert.equal(previewSelection.currentOdds, 1.93);
  assert.equal(previewSelection.bookmaker, "Pinnacle");
  assert.equal(previewSelection.event, "Arsenal — Coventry City");

  const confirmable = canConfirmBetSlip(true, {
    preview: result.preview as unknown as BetPreview,
    previewToken: result.previewToken,
  });
  assert.equal(confirmable, true, "a VERIFIED matched line must be confirmable");
});

test("Handicap Stage H2: MONEYLINE and TOTALS previews carry marketType/participant but normalizeSelectionToEnglish's SPREAD branch never fires for them (existing display unchanged)", async () => {
  const slip: ParsedBetSlip = {
    type: "EXPRESS",
    stake: 20,
    selections: [
      { sport: "Football", event: "Real Madrid vs Barcelona", market: null, selection: "Real Madrid Win", submittedOdds: 1.8 },
      { sport: "Football", event: "Arsenal vs Chelsea", market: null, selection: "Over 2.5", line: "2.5", submittedOdds: 1.9 },
    ],
  };

  const result = await buildBetSlipPreview(slip, "player-1", TEST_SECRET, {
    oddsVerificationService: totalsAwareVerificationService(
      { "Real Madrid vs Barcelona": verified(1.8, 1.8) },
      { "Arsenal vs Chelsea": verified(1.9, 1.9) },
    ),
  });

  const [moneyline, totals] = result.preview.selections;
  assert.equal(moneyline.marketType, "MONEYLINE_2WAY");
  assert.equal(totals.marketType, "TOTALS");

  // SPREAD branch is strictly gated on marketType === "SPREAD" — passing
  // these fields through never changes MONEYLINE/TOTALS display.
  assert.equal(
    normalizeSelectionToEnglish({
      selection: moneyline.selection,
      marketType: moneyline.marketType,
      participant: moneyline.participant,
      line: moneyline.line,
    }),
    "Real Madrid Win",
  );
  assert.equal(
    normalizeSelectionToEnglish({
      selection: totals.selection,
      sport: totals.sport,
      marketType: totals.marketType,
      participant: totals.participant,
      line: totals.line,
    }),
    "Over 2.5 Goals",
  );
});

/* -------------------------------------------------------------------------- */
/* H3 Production Fix — full preview-construction proof. The formerly         */
/* dangerous shape (AI splits market="Фора"/selection="Арсенал") must never  */
/* verify/confirm as MONEYLINE odds through the REAL buildBetSlipPreview()   */
/* pipeline — the same function every real preview route calls.             */
/* -------------------------------------------------------------------------- */

test("H3 production fix: buildBetSlipPreview — bare 'Арсенал' + marketRawText 'Фора' + line '-1.5' verifies as SPREAD, never as MONEYLINE odds (h2h primed with the exact real production price 1.16, proven never called)", async () => {
  const slip: ParsedBetSlip = {
    type: "SINGLE",
    stake: 10,
    selections: [
      {
        sport: "Football",
        event: "Арсенал vs Ковентрі",
        market: null,
        marketRawText: "Фора",
        selection: "Арсенал",
        submittedOdds: null,
        line: "-1.5",
      },
    ],
  };

  let h2hCallCount = 0;
  const provider = new TheOddsApiProvider(
    async () => {
      h2hCallCount += 1;
      // Primed with the exact real production price — if this is ever
      // reached, the bug has reappeared.
      return verified(1.16, 1.16, "Pinnacle");
    },
    undefined,
    fakeVerifySpreadOddsFn({ "Арсенал vs Ковентрі": verified(1.91, 1.91, "MyBookie.ag") }),
  );
  const service = new OddsVerificationService(provider);

  const result = await buildBetSlipPreview(slip, "player-1", TEST_SECRET, { oddsVerificationService: service });
  const previewSelection = result.preview.selections[0];

  assert.equal(h2hCallCount, 0, "must never reach h2h — this is the exact second production incident and must never be priced as 'Arsenal Win' at 1.16");
  assert.equal(previewSelection.marketType, "SPREAD");
  assert.notEqual(previewSelection.marketType, "MONEYLINE_2WAY");
  assert.equal(previewSelection.participant, "Арсенал");
  assert.equal(previewSelection.line, "-1.5");
  assert.equal(previewSelection.oddsStatus, "VERIFIED");
  assert.equal(previewSelection.currentOdds, 1.91);
  assert.notEqual(previewSelection.currentOdds, 1.16, "must never surface the moneyline price as if it were the spread price");
  assert.equal(previewSelection.bookmaker, "MyBookie.ag");
});

test("H3 production fix: buildBetSlipPreview — if the exact spread line genuinely isn't offered, the selection safely stays non-VERIFIED rather than falling back to MONEYLINE odds", async () => {
  const slip: ParsedBetSlip = {
    type: "SINGLE",
    stake: 10,
    selections: [
      {
        sport: "Football",
        event: "Арсенал vs Ковентрі",
        market: null,
        marketRawText: "Фора",
        selection: "Арсенал",
        submittedOdds: null,
        line: "-1.5",
      },
    ],
  };

  let h2hCallCount = 0;
  const provider = new TheOddsApiProvider(
    async () => {
      h2hCallCount += 1;
      return verified(1.16, 1.16, "Pinnacle");
    },
    undefined,
    fakeVerifySpreadOddsFn({
      "Арсенал vs Ковентрі": {
        matched: false,
        withinTolerance: null,
        sourceOdds: null,
        submittedOdds: null,
        discrepancyPercent: null,
        bookmaker: null,
        note: 'Could not match spread selection "Арсенал -1.5" for "Арсенал vs Ковентрі" (LINE_NOT_AVAILABLE)',
      },
    }),
  );
  const service = new OddsVerificationService(provider);

  const result = await buildBetSlipPreview(slip, "player-1", TEST_SECRET, { oddsVerificationService: service });
  const previewSelection = result.preview.selections[0];

  assert.equal(h2hCallCount, 0, "must never fall back to h2h when the exact spread line is unavailable");
  assert.notEqual(previewSelection.oddsStatus, "VERIFIED");
  assert.equal(previewSelection.marketType, "SPREAD");
  assert.notEqual(previewSelection.currentOdds, 1.16);
});

test("H3 production fix: buildBetSlipPreview — RU 'с формой', UA 'азійська фора', and EN 'handicap'/'spread' market-hint shapes all verify as SPREAD end-to-end, never MONEYLINE", async () => {
  const cases: Array<{ label: string; market: string; selection: string; line: string; event: string }> = [
    { label: "RU 'с форой'", market: "Фора", selection: "Арсенал", line: "-1.5", event: "Арсенал vs Ковентрі" },
    { label: "UA 'азійська фора' (quarter line, canonical only)", market: "Азійська фора", selection: "Арсенал", line: "-1.25", event: "Арсенал vs Ковентрі" },
    { label: "EN 'handicap'", market: "Handicap", selection: "Arsenal", line: "-1.5", event: "Arsenal vs Coventry" },
    { label: "EN 'spread'", market: "Spread", selection: "Arsenal", line: "-1.5", event: "Arsenal vs Coventry" },
  ];

  for (const c of cases) {
    const slip: ParsedBetSlip = {
      type: "SINGLE",
      stake: 10,
      selections: [
        { sport: "Football", event: c.event, market: null, marketRawText: c.market, selection: c.selection, submittedOdds: null, line: c.line },
      ],
    };

    let h2hCallCount = 0;
    const provider = new TheOddsApiProvider(
      async () => {
        h2hCallCount += 1;
        return verified(1.16, 1.16);
      },
      undefined,
      fakeVerifySpreadOddsFn({ [c.event]: verified(1.9, 1.9) }),
    );
    const service = new OddsVerificationService(provider);

    const result = await buildBetSlipPreview(slip, "player-1", TEST_SECRET, { oddsVerificationService: service });
    const previewSelection = result.preview.selections[0];

    assert.equal(previewSelection.marketType, "SPREAD", c.label);
    assert.equal(h2hCallCount, 0, `${c.label}: must never reach h2h`);
  }
});

test("H3 production fix: buildBetSlipPreview — 'Arsenal Win' + marketRawText 'Handicap' still verifies as MONEYLINE (h2h), the market hint never overrides a real selection-derived claim", async () => {
  const slip: ParsedBetSlip = {
    type: "SINGLE",
    stake: 10,
    selections: [
      {
        sport: "Football",
        event: "Arsenal vs Coventry",
        market: null,
        marketRawText: "Handicap",
        selection: "Arsenal Win",
        submittedOdds: 1.16,
        line: null,
      },
    ],
  };

  const result = await buildBetSlipPreview(slip, "player-1", TEST_SECRET, {
    verifyOddsFn: async () => verified(1.16, 1.16),
  });
  const previewSelection = result.preview.selections[0];

  assert.equal(previewSelection.marketType, "MONEYLINE_2WAY");
  assert.equal(previewSelection.oddsStatus, "VERIFIED");
  assert.equal(previewSelection.currentOdds, 1.16);
});

/* ============================================================================
 * SCREENSHOT QA-1.6 — event-aware 1X2/participant reconciliation.
 * betParser.ts defers (never rejects) the one narrow, proven-real case where
 * OCR text evidence is explicit 1X2 shorthand (HOME/AWAY) but Claude's claim
 * normalized to a bare participant name — this is the ONLY place that
 * decision is ever finished, once the real provider-resolved event exists.
 * ============================================================================ */

// providerEventId/providerSportKey are required alongside homeTeamName/
// awayTeamName — theOddsApiProvider.ts's buildMatchedEvent only derives
// matchedEvent (and therefore homeTeamName/awayTeamName survive the
// legacy-bridge round-trip at all) when BOTH provider identifiers are also
// present; a legacy OddsCheckResult with team names but no provider event
// id is treated the same as one with neither.
function verifiedWithTeams(sourceOdds: number, submittedOdds: number, homeTeamName: string, awayTeamName: string): OddsCheckResult {
  return {
    ...verified(sourceOdds, submittedOdds),
    homeTeamName,
    awayTeamName,
    providerEventId: "evt-qa16",
    providerSportKey: "soccer_epl",
    eventStartTime: "2026-08-28T20:30:00.000Z",
  };
}

function pendingSlip(
  requiredSide: "HOME" | "AWAY",
  claimedParticipant: string,
  overrides: Partial<{ event: string; submittedOdds: number | null; stake: number }> = {},
): ParsedBetSlip {
  return {
    type: "SINGLE",
    stake: overrides.stake ?? 100,
    selections: [
      {
        sport: "Football",
        event: overrides.event ?? "Bayern Munich vs VfB Stuttgart",
        market: "1X2",
        selection: claimedParticipant,
        submittedOdds: overrides.submittedOdds ?? 1.42,
        pendingMarketReconciliation: { requiredSide, claimedParticipant },
      },
    ],
  };
}

test("QA-1.6 A (HOME positive): claimed participant matches the real home team — accepted, canonical meaning becomes MONEYLINE_3WAY/HOME", async () => {
  const slip = pendingSlip("HOME", "Bayern Munich");

  const result = await buildBetSlipPreview(slip, "player-1", TEST_SECRET, {
    verifyOddsFn: async () => verifiedWithTeams(1.42, 1.42, "Bayern Munich", "VfB Stuttgart"),
  });

  const previewSelection = result.preview.selections[0];
  assert.equal(previewSelection.oddsStatus, "VERIFIED");
  assert.equal(previewSelection.marketType, "MONEYLINE_3WAY");
  assert.equal(previewSelection.participant, null, "HOME/AWAY carry no participant field");

  assert.ok(result.previewToken !== null);
  const verifiedToken = verifyPreviewToken(result.previewToken!, TEST_SECRET);
  assert.equal(verifiedToken.ok, true);
  if (!verifiedToken.ok) return;
  assert.equal(verifiedToken.payload.canonicalMarketType, "MONEYLINE_3WAY");
  assert.equal(verifiedToken.payload.canonicalSelectionType, "HOME");
});

test("QA-1.6 B (AWAY positive): claimed participant matches the real away team — accepted, canonical meaning becomes MONEYLINE_3WAY/AWAY", async () => {
  const slip = pendingSlip("AWAY", "VfB Stuttgart");

  const result = await buildBetSlipPreview(slip, "player-1", TEST_SECRET, {
    verifyOddsFn: async () => verifiedWithTeams(3.8, 3.8, "Bayern Munich", "VfB Stuttgart"),
  });

  const previewSelection = result.preview.selections[0];
  assert.equal(previewSelection.oddsStatus, "VERIFIED");
  assert.equal(previewSelection.marketType, "MONEYLINE_3WAY");

  assert.ok(result.previewToken !== null);
  const verifiedToken = verifyPreviewToken(result.previewToken!, TEST_SECRET);
  assert.equal(verifiedToken.ok, true);
  if (!verifiedToken.ok) return;
  assert.equal(verifiedToken.payload.canonicalMarketType, "MONEYLINE_3WAY");
  assert.equal(verifiedToken.payload.canonicalSelectionType, "AWAY");
});

/* ============================================================================
 * MASTER STAGE M2 / M3 Phase 9 — the real production case that motivated
 * M2's decisive-margin fix, proven end-to-end (parse defer -> provider
 * event match -> resolveParticipantSide reconciliation -> accept), not just
 * at the isolated matcher-function level (already covered directly in
 * teamNameMatcher.test.ts). Before M2, this exact shape — claim "Real
 * Madrid" against a real event whose HOME team is literally "Real Madrid"
 * and AWAY team is "Real Sociedad" — reached this reconciliation stage with
 * a real, already-matched provider event and STILL got rejected
 * (MARKET_INTENT_UNRECONCILED) purely because resolveParticipantSide
 * returned AMBIGUOUS. M2 fixed the matcher; this test proves the fix reaches
 * all the way through to a real accepted preview.
 * ============================================================================ */

test("M2 real production case, end-to-end: claim 'Real Madrid' against HOME 'Real Madrid' / AWAY 'Real Sociedad' — provider event already matched, reconciliation now resolves HOME instead of AMBIGUOUS", async () => {
  const slip = pendingSlip("HOME", "Real Madrid", { event: "Real Madrid vs Real Sociedad", submittedOdds: 1.85 });

  const result = await buildBetSlipPreview(slip, "player-1", TEST_SECRET, {
    verifyOddsFn: async () => verifiedWithTeams(1.85, 1.85, "Real Madrid", "Real Sociedad"),
  });

  const previewSelection = result.preview.selections[0];
  assert.equal(previewSelection.oddsStatus, "VERIFIED");
  assert.equal(previewSelection.marketType, "MONEYLINE_3WAY");

  assert.ok(result.previewToken !== null, "the bet must now reach a signed preview token instead of being rejected as MARKET_INTENT_UNRECONCILED");
  const verifiedToken = verifyPreviewToken(result.previewToken!, TEST_SECRET);
  assert.equal(verifiedToken.ok, true);
  if (!verifiedToken.ok) return;
  assert.equal(verifiedToken.payload.canonicalMarketType, "MONEYLINE_3WAY");
  assert.equal(verifiedToken.payload.canonicalSelectionType, "HOME");
});

test("QA-1.6 C: 'Home win' normalized to the home participant, provider confirms HOME — accepted", async () => {
  const slip = pendingSlip("HOME", "Arsenal", { event: "Arsenal vs Chelsea", submittedOdds: 1.5 });

  const result = await buildBetSlipPreview(slip, "player-1", TEST_SECRET, {
    verifyOddsFn: async () => verifiedWithTeams(1.5, 1.5, "Arsenal", "Chelsea"),
  });

  assert.equal(result.preview.selections[0].oddsStatus, "VERIFIED");
  assert.equal(result.preview.selections[0].marketType, "MONEYLINE_3WAY");
});

test("QA-1.6 D: 'Away win' normalized to the away participant, provider confirms AWAY — accepted", async () => {
  const slip = pendingSlip("AWAY", "Chelsea", { event: "Arsenal vs Chelsea", submittedOdds: 4.2 });

  const result = await buildBetSlipPreview(slip, "player-1", TEST_SECRET, {
    verifyOddsFn: async () => verifiedWithTeams(4.2, 4.2, "Arsenal", "Chelsea"),
  });

  assert.equal(result.preview.selections[0].oddsStatus, "VERIFIED");
  assert.equal(result.preview.selections[0].marketType, "MONEYLINE_3WAY");
});

test("QA-1.6 E: HOME evidence but the claimed participant resolves to the AWAY team — rejected (MARKET_INTENT_UNRECONCILED)", async () => {
  const slip = pendingSlip("HOME", "VfB Stuttgart");

  await assert.rejects(
    () =>
      buildBetSlipPreview(slip, "player-1", TEST_SECRET, {
        verifyOddsFn: async () => verifiedWithTeams(1.42, 1.42, "Bayern Munich", "VfB Stuttgart"),
      }),
    (err: unknown) => err instanceof BetSlipValidationError && err.code === "MARKET_INTENT_UNRECONCILED",
  );
});

test("QA-1.6 F: AWAY evidence but the claimed participant resolves to the HOME team — rejected (MARKET_INTENT_UNRECONCILED)", async () => {
  const slip = pendingSlip("AWAY", "Bayern Munich");

  await assert.rejects(
    () =>
      buildBetSlipPreview(slip, "player-1", TEST_SECRET, {
        verifyOddsFn: async () => verifiedWithTeams(1.42, 1.42, "Bayern Munich", "VfB Stuttgart"),
      }),
    (err: unknown) => err instanceof BetSlipValidationError && err.code === "MARKET_INTENT_UNRECONCILED",
  );
});

test("QA-1.6 H: claimed participant matches neither real team (NO_MATCH) — rejected", async () => {
  const slip = pendingSlip("HOME", "Real Madrid");

  await assert.rejects(
    () =>
      buildBetSlipPreview(slip, "player-1", TEST_SECRET, {
        verifyOddsFn: async () => verifiedWithTeams(1.42, 1.42, "Bayern Munich", "VfB Stuttgart"),
      }),
    (err: unknown) => err instanceof BetSlipValidationError && err.code === "MARKET_INTENT_UNRECONCILED",
  );
});

test("QA-1.6 I: claimed participant matches both real teams ambiguously — rejected, never silently picks a side", async () => {
  // "Manchester" fuzzy-overlaps both "Manchester United" and "Manchester
  // City" well past resolveParticipantSide's own threshold — a genuine
  // AMBIGUOUS case, unrelated to which team is home/away.
  const slip = pendingSlip("HOME", "Manchester", { event: "Manchester United vs Manchester City" });

  await assert.rejects(
    () =>
      buildBetSlipPreview(slip, "player-1", TEST_SECRET, {
        verifyOddsFn: async () => verifiedWithTeams(1.42, 1.42, "Manchester United", "Manchester City"),
      }),
    (err: unknown) => err instanceof BetSlipValidationError && err.code === "MARKET_INTENT_UNRECONCILED",
  );
});

test("QA-1.6: the event never resolves (no homeTeamName/awayTeamName) — rejected rather than silently accepted", async () => {
  const slip = pendingSlip("HOME", "Bayern Munich");

  await assert.rejects(
    () =>
      buildBetSlipPreview(slip, "player-1", TEST_SECRET, {
        verifyOddsFn: async () => notFound(1.42),
      }),
    (err: unknown) => err instanceof BetSlipValidationError && err.code === "MARKET_INTENT_UNRECONCILED",
  );
});

test("QA-1.6: genuine MONEYLINE_2WAY selections (no pendingMarketReconciliation) are completely unaffected", async () => {
  const slip: ParsedBetSlip = {
    type: "SINGLE",
    stake: 10,
    selections: [
      { sport: "Tennis", event: "Djokovic vs Alcaraz", market: null, selection: "Djokovic", submittedOdds: 1.5 },
    ],
  };

  const result = await buildBetSlipPreview(slip, "player-1", TEST_SECRET, {
    verifyOddsFn: async () => verifiedWithTeams(1.5, 1.5, "Djokovic", "Alcaraz"),
  });

  assert.equal(result.preview.selections[0].oddsStatus, "VERIFIED");
  assert.equal(result.preview.selections[0].marketType, "MONEYLINE_2WAY");
});

test("QA-1.6 real rrrr.png incident regression: Bayern/Stuttgart SINGLE reaches a successful preview, no numeric_mismatch, no market_mismatch, canonical MONEYLINE_3WAY/HOME, stake 100, odds 1.42", async () => {
  // Exactly the shape QA-1.2 through QA-1.5 traced from real production
  // diagnostics: OCR evidence "П1" (HOME), Claude normalizes the selection
  // to the team's real name, stake/odds already corroborated by QA-1.3.
  const slip = pendingSlip("HOME", "Bayern Munich", {
    event: "Bayern Munich vs VfB Stuttgart",
    submittedOdds: 1.42,
    stake: 100,
  });

  const result = await buildBetSlipPreview(slip, "player-1", TEST_SECRET, {
    verifyOddsFn: async () => verifiedWithTeams(1.42, 1.42, "Bayern Munich", "VfB Stuttgart"),
  });

  const previewSelection = result.preview.selections[0];
  assert.equal(previewSelection.oddsStatus, "VERIFIED");
  assert.equal(previewSelection.marketType, "MONEYLINE_3WAY");
  assert.equal(previewSelection.submittedOdds, 1.42);
  assert.equal(result.preview.stake, 100);
  assert.equal(result.preview.potentialWin, 142); // 100 * 1.42

  assert.ok(result.previewToken !== null, "provider verification continues normally — a real previewToken is signed");
  const verifiedToken = verifyPreviewToken(result.previewToken!, TEST_SECRET);
  assert.equal(verifiedToken.ok, true);
  if (!verifiedToken.ok) return;
  assert.equal(verifiedToken.payload.canonicalMarketType, "MONEYLINE_3WAY");
  assert.equal(verifiedToken.payload.canonicalSelectionType, "HOME");
  assert.equal(verifiedToken.payload.stake, 100);
  assert.equal(verifiedToken.payload.odds, 1.42);
});

/* ============================================================================
 * SCREENSHOT QA-CORE S1 — end-to-end proof: the ACTUAL claimedParticipant
 * lib/ai/betParser.ts's OCR-mode normalization now produces for the real
 * rrrr.png incident ("Bayern") — not a hand-cleaned "Bayern Munich" — still
 * reconciles successfully. Before S1, production's real claimedParticipant
 * was "Bayern Win (П1)" (the unmodified selection display text), which
 * failed with resolutionKind NO_MATCH (word-overlap score 0.333, below the
 * 0.4 threshold) — confirmed by the QA-3 fresh reconciliation diagnostic.
 * This test proves the fix at the actual boundary that matters: the exact
 * string S1 hands to reconcile1X2ParticipantClaim, not an idealized one.
 * ============================================================================ */

test("S1 real fixture regression: claimedParticipant 'Bayern' (S1's actual normalized output, not a hand-cleaned 'Bayern Munich') reconciles to MONEYLINE_3WAY/HOME against the real provider event", async () => {
  const slip = pendingSlip("HOME", "Bayern", {
    event: "Bayern Munich vs VfB Stuttgart",
    submittedOdds: 1.42,
    stake: 100,
  });

  const result = await buildBetSlipPreview(slip, "player-1", TEST_SECRET, {
    verifyOddsFn: async () => verifiedWithTeams(1.42, 1.42, "Bayern Munich", "VfB Stuttgart"),
  });

  const previewSelection = result.preview.selections[0];
  assert.equal(previewSelection.oddsStatus, "VERIFIED");
  assert.equal(previewSelection.marketType, "MONEYLINE_3WAY");

  assert.ok(result.previewToken !== null);
  const verifiedToken = verifyPreviewToken(result.previewToken!, TEST_SECRET);
  assert.equal(verifiedToken.ok, true);
  if (!verifiedToken.ok) return;
  assert.equal(verifiedToken.payload.canonicalMarketType, "MONEYLINE_3WAY");
  assert.equal(verifiedToken.payload.canonicalSelectionType, "HOME");
});

/* ============================================================================
 * SCREENSHOT QA-2.1 — reconciliation-boundary diagnostic. Extends
 * [SCREENSHOT_QA1_DIAGNOSTIC] (lib/logging/screenshotQa1Diagnostic.ts) with a
 * "reconciliation" stage so a future MARKET_INTENT_UNRECONCILED reproduction
 * can tell branch A (no real event/team names — resolutionKind stays null,
 * resolveParticipantSide never even runs) apart from branch B (event
 * resolved, but resolveParticipantSide returned NO_MATCH/AMBIGUOUS/the wrong
 * side). Gated behind logQa1ReconciliationDiagnostic (default off) — every
 * test in this file above this line already proves the reconciliation
 * DECISION itself (accept/reject) is byte-for-byte unchanged; these tests
 * only add coverage for the new diagnostic log line itself.
 * ============================================================================ */

function captureConsoleLog(): { loggedCalls: unknown[][]; restore: () => void } {
  const originalConsoleLog = console.log;
  const loggedCalls: unknown[][] = [];
  console.log = (...args: unknown[]) => loggedCalls.push(args);
  return {
    loggedCalls,
    restore: () => {
      console.log = originalConsoleLog;
    },
  };
}

function reconciliationDiagnostics(loggedCalls: unknown[][]): Array<Record<string, unknown>> {
  const results: Array<Record<string, unknown>> = [];
  for (const call of loggedCalls) {
    if (call[0] === SCREENSHOT_QA1_DIAGNOSTIC_MARKER && typeof call[1] === "string") {
      const parsed = JSON.parse(call[1]) as Record<string, unknown>;
      if (parsed.stage === "reconciliation") results.push(parsed);
    }
  }
  return results;
}

test("QA-2.1 diagnostic 1: no event match — oddsCheckMatched false, no team names, resolutionKind null (branch A, resolution never attempted), reconciled false", async () => {
  const { loggedCalls, restore } = captureConsoleLog();
  try {
    const slip = pendingSlip("HOME", "Bayern Munich");

    await assert.rejects(() =>
      buildBetSlipPreview(slip, "player-1", TEST_SECRET, {
        verifyOddsFn: async () => notFound(1.42),
        logQa1ReconciliationDiagnostic: true,
      }),
    );

    const diagnostics = reconciliationDiagnostics(loggedCalls);
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0].claimedParticipant, "Bayern Munich");
    assert.equal(diagnostics[0].requiredSide, "HOME");
    assert.equal(diagnostics[0].oddsCheckMatched, false);
    assert.equal(diagnostics[0].providerEventIdPresent, false);
    assert.equal(diagnostics[0].homeTeamName, null);
    assert.equal(diagnostics[0].awayTeamName, null);
    assert.equal(diagnostics[0].resolutionKind, null, "branch A: resolveParticipantSide is never called without both team names");
    assert.equal(diagnostics[0].reconciled, false);
  } finally {
    restore();
  }
});

test("QA-2.1 diagnostic 2: matched event + HOME — resolutionKind HOME, reconciled true", async () => {
  const { loggedCalls, restore } = captureConsoleLog();
  try {
    const slip = pendingSlip("HOME", "Bayern Munich");

    await buildBetSlipPreview(slip, "player-1", TEST_SECRET, {
      verifyOddsFn: async () => verifiedWithTeams(1.42, 1.42, "Bayern Munich", "VfB Stuttgart"),
      logQa1ReconciliationDiagnostic: true,
    });

    const diagnostics = reconciliationDiagnostics(loggedCalls);
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0].oddsCheckMatched, true);
    assert.equal(diagnostics[0].providerEventIdPresent, true);
    assert.equal(diagnostics[0].homeTeamName, "Bayern Munich");
    assert.equal(diagnostics[0].awayTeamName, "VfB Stuttgart");
    assert.equal(diagnostics[0].resolutionKind, "HOME");
    assert.equal(diagnostics[0].reconciled, true);
    assert.equal(diagnostics[0].marketTypeBefore, "MONEYLINE_2WAY");
    assert.equal(diagnostics[0].selectionTypeBefore, "PARTICIPANT");
  } finally {
    restore();
  }
});

test("QA-2.1 diagnostic 3: matched event + AWAY — resolutionKind AWAY, reconciled true", async () => {
  const { loggedCalls, restore } = captureConsoleLog();
  try {
    const slip = pendingSlip("AWAY", "VfB Stuttgart");

    await buildBetSlipPreview(slip, "player-1", TEST_SECRET, {
      verifyOddsFn: async () => verifiedWithTeams(3.8, 3.8, "Bayern Munich", "VfB Stuttgart"),
      logQa1ReconciliationDiagnostic: true,
    });

    const diagnostics = reconciliationDiagnostics(loggedCalls);
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0].resolutionKind, "AWAY");
    assert.equal(diagnostics[0].reconciled, true);
  } finally {
    restore();
  }
});

test("QA-2.1 diagnostic 4: NO_MATCH — event resolved but claimed participant matches neither real team, resolutionKind NO_MATCH, reconciled false (branch B)", async () => {
  const { loggedCalls, restore } = captureConsoleLog();
  try {
    const slip = pendingSlip("HOME", "Real Madrid");

    await assert.rejects(() =>
      buildBetSlipPreview(slip, "player-1", TEST_SECRET, {
        verifyOddsFn: async () => verifiedWithTeams(1.42, 1.42, "Bayern Munich", "VfB Stuttgart"),
        logQa1ReconciliationDiagnostic: true,
      }),
    );

    const diagnostics = reconciliationDiagnostics(loggedCalls);
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0].oddsCheckMatched, true, "branch B requires a real matched event, unlike branch A");
    assert.equal(diagnostics[0].homeTeamName, "Bayern Munich");
    assert.equal(diagnostics[0].awayTeamName, "VfB Stuttgart");
    assert.equal(diagnostics[0].resolutionKind, "NO_MATCH");
    assert.equal(diagnostics[0].reconciled, false);
  } finally {
    restore();
  }
});

test("QA-2.1 diagnostic 5: AMBIGUOUS — claimed participant fuzzy-matches both real teams, resolutionKind AMBIGUOUS, reconciled false (branch B)", async () => {
  const { loggedCalls, restore } = captureConsoleLog();
  try {
    const slip = pendingSlip("HOME", "Manchester", { event: "Manchester United vs Manchester City" });

    await assert.rejects(() =>
      buildBetSlipPreview(slip, "player-1", TEST_SECRET, {
        verifyOddsFn: async () => verifiedWithTeams(1.42, 1.42, "Manchester United", "Manchester City"),
        logQa1ReconciliationDiagnostic: true,
      }),
    );

    const diagnostics = reconciliationDiagnostics(loggedCalls);
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0].oddsCheckMatched, true);
    assert.equal(diagnostics[0].resolutionKind, "AMBIGUOUS");
    assert.equal(diagnostics[0].reconciled, false);
  } finally {
    restore();
  }
});

test("QA-2.1 diagnostic: the flag defaults to off — no reconciliation diagnostic is logged unless a caller explicitly opts in (proves text preview/confirm are unaffected)", async () => {
  const { loggedCalls, restore } = captureConsoleLog();
  try {
    const slip = pendingSlip("HOME", "Bayern Munich");

    // No logQa1ReconciliationDiagnostic set at all — same call shape every
    // existing production caller (text preview/confirm, dashboard debug
    // preview) already uses today.
    await buildBetSlipPreview(slip, "player-1", TEST_SECRET, {
      verifyOddsFn: async () => verifiedWithTeams(1.42, 1.42, "Bayern Munich", "VfB Stuttgart"),
    });

    assert.equal(reconciliationDiagnostics(loggedCalls).length, 0, "diagnostic must stay silent by default");
  } finally {
    restore();
  }
});

test("QA-2.1 diagnostic 8: no secret leakage — never Telegram initData, player id, auth headers, tokens, DB URL, or raw OCR/image content", async () => {
  const { loggedCalls, restore } = captureConsoleLog();
  try {
    const secretPlayerId = "SECRET_PLAYER_ID_do_not_leak";
    const slip = pendingSlip("HOME", "Bayern Munich");

    await buildBetSlipPreview(slip, secretPlayerId, TEST_SECRET, {
      verifyOddsFn: async () => verifiedWithTeams(1.42, 1.42, "Bayern Munich", "VfB Stuttgart"),
      logQa1ReconciliationDiagnostic: true,
    });

    const diagnostics = reconciliationDiagnostics(loggedCalls);
    assert.equal(diagnostics.length, 1);

    const rawLoggedText = JSON.stringify(loggedCalls);
    for (const forbidden of [secretPlayerId, TEST_SECRET, "initData", "authorization", "Bearer", "postgres://", "DATABASE_URL"]) {
      assert.equal(rawLoggedText.includes(forbidden), false, `reconciliation diagnostic must never contain: ${forbidden}`);
    }

    // Field-shape check — every value is a string/number/boolean/null, never
    // a nested object or raw Error, matching this module's own "booleans/
    // enums/numbers/already-disclosed content only" contract.
    for (const [key, value] of Object.entries(diagnostics[0])) {
      assert.ok(
        value === null || ["string", "number", "boolean"].includes(typeof value),
        `reconciliation diagnostic field "${key}" must be a primitive or null, got ${typeof value}`,
      );
    }
  } finally {
    restore();
  }
});

/* ============================================================================
 * SCREENSHOT ODDS QA-2 — screenshot betting must use the CURRENT PROVIDER
 * ODDS for potentialWin, exactly like typed text betting already does.
 * Screenshot-submitted odds are reference-only, never authoritative.
 *
 * FIRST DIVERGENCE FOUND (Phase 1, code-traced not guessed): buildBetSlipPreview.ts
 * built its odds-verification request from `selection.selection` VERBATIM —
 * the same raw display text S1 already knew could carry 1X2-shorthand
 * pollution ("Bayern Win (П1)") for reconciliation, but this is a SEPARATE
 * consumer (legacySelectionToCanonicalRequest's own participant-fallback
 * classification, which feeds the provider's own team-name search) that S1
 * never touched. A typed "Bayern Munich" claim reaches the provider clean;
 * a screenshot's "Bayern Win (П1)" claim did not — fixed below by
 * normalizeSelectionTextForCanonicalization (see that function's own header
 * for why it is deliberately narrower than S1's normalizeOcrParticipantClaim).
 *
 * SECOND, INDEPENDENT DEFECT FOUND: even once canonicalization succeeded,
 * totalOdds/potentialWin were computed from previewSelections[i].submittedOdds
 * (the EFFECTIVE submitted value — the player's/screenshot's own number)
 * regardless of whether the provider ever verified it. Text betting never
 * exposed this (players are told odds are optional, so submittedOdds is
 * almost always null there, at which point the auto-lookup promotion
 * already made submitted===current); a screenshot's OCR'd odds is almost
 * always non-null, so this silently won every time. Fixed by keying
 * totalOdds/potentialWin on each leg's oddsCheck.matched (VERIFIED or
 * ODDS_CHANGED — both have a real current price) instead.
 * ============================================================================ */

test("SCREENSHOT ODDS QA-2 Bayern control — TEXT: no submitted odds (player never states one), provider verifies at 1.28, preview's current odds and potential win both come from 1.28", async () => {
  const slip: ParsedBetSlip = {
    type: "SINGLE",
    stake: 100,
    selections: [
      { sport: "Football", event: "Bayern Munich vs VfB Stuttgart", market: null, selection: "Bayern Munich", submittedOdds: null },
    ],
  };

  const result = await buildBetSlipPreview(slip, "player-1", TEST_SECRET, {
    verifyOddsFn: async () => verified(1.28, 1.28),
  });

  const selection = result.preview.selections[0];
  // No 1X2-shorthand evidence exists in typed text, so there is nothing to
  // reconcile — the bare participant claim reaches the provider directly,
  // exactly as it always has (QA-1.6's own "genuine MONEYLINE_2WAY...
  // unaffected" contract, untouched by this stage).
  assert.equal(selection.marketType, "MONEYLINE_2WAY");
  assert.equal(selection.oddsStatus, "VERIFIED");
  assert.equal(selection.submittedOdds, 1.28); // auto-promoted from the provider — the player stated none
  assert.equal(selection.currentOdds, 1.28);
  assert.equal(result.preview.totalOdds, 1.28);
  assert.equal(result.preview.potentialWin, 128);
});

// SCREENSHOT ODDS QA-2 — pendingSlip()'s own two-argument shape uses the
// SAME string for both the displayed `selection` text and
// pendingMarketReconciliation.claimedParticipant, which is exactly what a
// PRE-S1 raw parse produced. Post-S1, these are two genuinely DIFFERENT
// values (see betParser.ts's own OCR-mode normalization): the raw display
// text stays polluted ("Bayern Win (П1)"), only claimedParticipant is
// cleaned ("Bayern"). This builds that real, post-S1 shape directly, rather
// than reusing pendingSlip() and accidentally testing the pre-S1 one.
function postS1PendingSlip(
  requiredSide: "HOME" | "AWAY",
  rawSelectionText: string,
  claimedParticipant: string,
  overrides: Partial<{ event: string; submittedOdds: number | null; stake: number }> = {},
): ParsedBetSlip {
  return {
    type: "SINGLE",
    stake: overrides.stake ?? 100,
    selections: [
      {
        sport: "Football",
        event: overrides.event ?? "Bayern Munich vs VfB Stuttgart",
        market: "1X2",
        selection: rawSelectionText,
        submittedOdds: overrides.submittedOdds ?? 1.42,
        pendingMarketReconciliation: { requiredSide, claimedParticipant },
      },
    ],
  };
}

test("SCREENSHOT ODDS QA-2 Bayern control — SCREENSHOT: OCR submitted odds 1.42 (stale), provider verifies at 1.28 — reaches the SAME canonical MONEYLINE_3WAY/HOME shape as text, preview keeps submittedOdds=1.42 for reference but computes potential win from 1.28, not 142.00", async () => {
  const slip = postS1PendingSlip("HOME", "Bayern Win (П1)", "Bayern", {
    event: "Bayern Munich vs VfB Stuttgart",
    submittedOdds: 1.42,
    stake: 100,
  });

  const result = await buildBetSlipPreview(slip, "player-1", TEST_SECRET, {
    verifyOddsFn: async () => verifiedWithTeams(1.28, 1.42, "Bayern Munich", "VfB Stuttgart"),
  });

  const selection = result.preview.selections[0];
  // The same canonical shape text reaches provider verification with —
  // MONEYLINE_3WAY/HOME, via 1X2 reconciliation — proving Phase 1's
  // divergence is closed, not just that verification happened to succeed.
  assert.equal(selection.marketType, "MONEYLINE_3WAY");
  assert.equal(selection.oddsStatus, "VERIFIED");
  assert.equal(selection.submittedOdds, 1.42, "the screenshot's own odds stay visible for reference");
  assert.equal(selection.currentOdds, 1.28, "the provider's current price, not the screenshot's");
  assert.equal(result.preview.totalOdds, 1.28);
  assert.equal(result.preview.potentialWin, 128, "100 * 1.28 (provider), NOT 100 * 1.42 (screenshot) — the exact bug this stage fixes");
  assert.notEqual(result.preview.potentialWin, 142);

  const verifiedToken = verifyPreviewToken(result.previewToken!, TEST_SECRET);
  assert.equal(verifiedToken.ok, true);
  if (!verifiedToken.ok) return;
  assert.equal(verifiedToken.payload.canonicalMarketType, "MONEYLINE_3WAY");
  assert.equal(verifiedToken.payload.canonicalSelectionType, "HOME");
});

test("SCREENSHOT ODDS QA-2: ODDS_CHANGED (matched but outside tolerance) still uses the provider's current odds for potential win, not the screenshot's submitted odds", async () => {
  const slip = postS1PendingSlip("HOME", "Bayern Win (П1)", "Bayern", {
    event: "Bayern Munich vs VfB Stuttgart",
    submittedOdds: 1.42,
    stake: 100,
  });

  const result = await buildBetSlipPreview(slip, "player-1", TEST_SECRET, {
    verifyOddsFn: async () => ({ ...verifiedWithTeams(1.28, 1.42, "Bayern Munich", "VfB Stuttgart"), withinTolerance: false }),
  });

  assert.equal(result.preview.selections[0].oddsStatus, "ODDS_CHANGED");
  assert.equal(result.preview.selections[0].currentOdds, 1.28);
  assert.equal(result.preview.potentialWin, 128, "a moved-but-real provider price still prices the bet — ODDS_CHANGED only ever gates CONFIRM-time reconfirmation, never preview display");
});

test("SCREENSHOT ODDS QA-2: no submitted odds at all in the screenshot — provider verification still works, potential win comes from the provider", async () => {
  const slip: ParsedBetSlip = {
    type: "SINGLE",
    stake: 100,
    selections: [{ sport: "Football", event: "Bayern Munich vs VfB Stuttgart", market: null, selection: "Bayern Munich", submittedOdds: null }],
  };

  const result = await buildBetSlipPreview(slip, "player-1", TEST_SECRET, {
    verifyOddsFn: async () => verified(1.28, 1.28),
  });

  assert.equal(result.preview.selections[0].submittedOdds, 1.28);
  assert.equal(result.preview.selections[0].currentOdds, 1.28);
  assert.equal(result.preview.potentialWin, 128);
});

test("SCREENSHOT ODDS QA-2: provider unavailable — screenshot odds are never promoted to authoritative; potential win stays null, oddsStatus is honest", async () => {
  // A genuine MONEYLINE_2WAY claim (no pendingMarketReconciliation) — that
  // is a separate, already-covered concern (QA-2.1's own tests); this test
  // is purely about odds authority, so it isolates that from reconciliation
  // entirely rather than combining two concerns in one fixture.
  const plainSlip: ParsedBetSlip = {
    type: "SINGLE",
    stake: 100,
    selections: [{ sport: "Football", event: "Bayern Munich vs VfB Stuttgart", market: null, selection: "Bayern Munich", submittedOdds: 1.42 }],
  };
  const plainResult = await buildBetSlipPreview(plainSlip, "player-1", TEST_SECRET, {
    verifyOddsFn: async () => notFound(1.42),
  });
  assert.equal(plainResult.preview.selections[0].oddsStatus, "NOT_FOUND");
  assert.equal(plainResult.preview.selections[0].submittedOdds, 1.42, "still shown, but never labeled current/verified");
  assert.equal(plainResult.preview.selections[0].currentOdds, null, "never fabricated from the submitted value");
  assert.equal(plainResult.preview.potentialWin, null, "never silently computed from an unverified screenshot price");
  // Note: SINGLE (unlike EXPRESS) still signs a previewToken here — that is
  // pre-existing, deliberately UNTOUCHED behavior (client-side
  // canConfirmBetSlip already gates the Confirm button on oddsStatus; this
  // stage's scope is odds authority, not the confirm-gating policy itself).
  assert.equal(typeof plainResult.previewToken, "string");
});

/* ---------------------------------------------------------------------
 * Section 9 — other markets: SPREAD, TOTALS, quarter SPREAD, quarter TOTALS.
 * Provider odds are source of truth in every case; no market-specific
 * special-casing anywhere in the fix itself.
 * --------------------------------------------------------------------- */

// SCREENSHOT ODDS QA-2 — a SPREAD/TOTALS selection always routes through
// TheOddsApiProvider's own verifySpreadOddsFn/verifyTotalsOddsFn seams, NOT
// the plain verifyOddsFn buildBetSlipPreview's options expose — injecting
// options.oddsVerificationService directly (the same DI seam this file's
// own "DI: an injected OddsVerificationService-shaped dependency..." tests
// already use) bypasses that market-type routing entirely, so these tests
// isolate the odds-authority behavior under test from routing mechanics.
function fakeOddsService(results: readonly VerificationResult[]): Pick<OddsVerificationService, "verifyMany"> {
  return {
    verifyMany: async (requests: readonly VerifySelectionRequest[]): Promise<readonly VerificationResult[]> => {
      assert.equal(requests.length, results.length, "test fixture mismatch: one result per request expected");
      return results;
    },
  };
}

test("SCREENSHOT ODDS QA-2 SPREAD: RB Leipzig -1, screenshot odds != provider odds — potential win uses the provider's current price", async () => {
  const slip: ParsedBetSlip = {
    type: "SINGLE",
    stake: 100,
    selections: [
      { sport: "Football", event: "RB Leipzig vs Borussia Mönchengladbach", market: "Handicap", selection: "RB Leipzig -1", line: "-1", submittedOdds: 2.2 },
    ],
  };

  const result = await buildBetSlipPreview(slip, "player-1", TEST_SECRET, {
    oddsVerificationService: fakeOddsService([
      createVerifiedResult({ submittedOdds: "2.2", currentOdds: "1.95", provider: "THE_ODDS_API", checkedAt: CHECKED_AT }),
    ]),
  });

  const selection = result.preview.selections[0];
  assert.equal(selection.marketType, "SPREAD");
  assert.equal(selection.line, "-1");
  assert.equal(selection.submittedOdds, 2.2);
  assert.equal(selection.currentOdds, 1.95);
  assert.equal(result.preview.potentialWin, 195); // 100 * 1.95, not 220
});

test("SCREENSHOT ODDS QA-2 TOTALS: Over 2.5, screenshot odds != provider odds — potential win uses the provider's current price", async () => {
  const slip: ParsedBetSlip = {
    type: "SINGLE",
    stake: 100,
    selections: [{ sport: "Football", event: "Arsenal vs Chelsea", market: "Totals", selection: "Over 2.5", line: "2.5", submittedOdds: 2.05 }],
  };

  const result = await buildBetSlipPreview(slip, "player-1", TEST_SECRET, {
    oddsVerificationService: fakeOddsService([
      createVerifiedResult({ submittedOdds: "2.05", currentOdds: "1.9", provider: "THE_ODDS_API", checkedAt: CHECKED_AT }),
    ]),
  });

  const selection = result.preview.selections[0];
  assert.equal(selection.marketType, "TOTALS");
  assert.equal(selection.line, "2.5");
  assert.equal(selection.submittedOdds, 2.05);
  assert.equal(selection.currentOdds, 1.9);
  assert.equal(result.preview.potentialWin, 190); // 100 * 1.9, not 205
});

test("SCREENSHOT ODDS QA-2 quarter SPREAD (-1.25): screenshot odds != provider odds — potential win uses the provider's current price", async () => {
  const slip: ParsedBetSlip = {
    type: "SINGLE",
    stake: 100,
    selections: [
      { sport: "Football", event: "Real Madrid vs Barcelona", market: "Handicap", selection: "Real Madrid -1.25", line: "-1.25", submittedOdds: 2.15 },
    ],
  };

  const result = await buildBetSlipPreview(slip, "player-1", TEST_SECRET, {
    oddsVerificationService: fakeOddsService([
      createVerifiedResult({ submittedOdds: "2.15", currentOdds: "1.98", provider: "THE_ODDS_API", checkedAt: CHECKED_AT }),
    ]),
  });

  const selection = result.preview.selections[0];
  assert.equal(selection.marketType, "SPREAD");
  assert.equal(selection.line, "-1.25");
  assert.equal(selection.submittedOdds, 2.15);
  assert.equal(selection.currentOdds, 1.98);
  assert.equal(result.preview.potentialWin, 198); // 100 * 1.98, not 215
});

test("SCREENSHOT ODDS QA-2 quarter TOTALS (2.25): screenshot odds != provider odds — potential win uses the provider's current price", async () => {
  const slip: ParsedBetSlip = {
    type: "SINGLE",
    stake: 100,
    selections: [
      { sport: "Football", event: "RB Leipzig vs Borussia Mönchengladbach", market: "Totals", selection: "Over 2.25", line: "2.25", submittedOdds: 2.3 },
    ],
  };

  const result = await buildBetSlipPreview(slip, "player-1", TEST_SECRET, {
    oddsVerificationService: fakeOddsService([
      createVerifiedResult({ submittedOdds: "2.3", currentOdds: "2.05", provider: "THE_ODDS_API", checkedAt: CHECKED_AT }),
    ]),
  });

  const selection = result.preview.selections[0];
  assert.equal(selection.marketType, "TOTALS");
  assert.equal(selection.line, "2.25");
  assert.equal(selection.submittedOdds, 2.3);
  assert.equal(selection.currentOdds, 2.05);
  assert.equal(result.preview.potentialWin, 205); // 100 * 2.05, not 230
});

/* ---------------------------------------------------------------------
 * Section 10 — EXPRESS. Each leg's current odds come from provider
 * verification; the overall total is computed from provider-verified leg
 * odds, never from a screenshot's own accumulator price. A screenshot's
 * total is not even a field ParsedBetSlip carries — there is nothing to
 * trust in the first place, only genuinely per-leg submittedOdds.
 * --------------------------------------------------------------------- */

test("SCREENSHOT ODDS QA-2 EXPRESS: every leg's current odds and the overall total come from provider verification, never from screenshot-submitted per-leg odds", async () => {
  const slip: ParsedBetSlip = {
    type: "EXPRESS",
    stake: 50,
    selections: [
      { sport: "Football", event: "Bayern Munich vs VfB Stuttgart", market: null, selection: "Bayern Munich", submittedOdds: 1.42 },
      { sport: "Football", event: "Arsenal vs Chelsea", market: "Totals", selection: "Over 2.5", line: "2.5", submittedOdds: 2.05 },
    ],
  };

  const result = await buildBetSlipPreview(slip, "player-1", TEST_SECRET, {
    oddsVerificationService: fakeOddsService([
      createVerifiedResult({ submittedOdds: "1.42", currentOdds: "1.28", provider: "THE_ODDS_API", checkedAt: CHECKED_AT }),
      createVerifiedResult({ submittedOdds: "2.05", currentOdds: "1.9", provider: "THE_ODDS_API", checkedAt: CHECKED_AT }),
    ]),
  });

  assert.equal(result.preview.selections[0].submittedOdds, 1.42);
  assert.equal(result.preview.selections[0].currentOdds, 1.28);
  assert.equal(result.preview.selections[1].submittedOdds, 2.05);
  assert.equal(result.preview.selections[1].currentOdds, 1.9);

  // 1.28 * 1.9 = 2.432, rounded to computeTotalOdds's own 2-decimal-place
  // precision -> 2.43 (provider-verified), never 1.42 * 2.05 = 2.911/2.91
  // (screenshot-submitted).
  assert.equal(result.preview.totalOdds, 2.43);
  assert.equal(result.preview.potentialWin, 121.5); // 50 * 2.43
  assert.ok(result.previewToken !== null);
});

/* ============================================================================
 * MASTER STAGE M3.1, Phase F — explicit CURRENT-ODDS-INVARIANT proofs using
 * the task's own exact example numbers, for direct traceability. The
 * invariant itself was already proven (with different numbers) by the
 * SCREENSHOT ODDS QA-2 tests above and below — these two tests exist purely
 * so "screenshot 2.34 -> provider 2.10" and "screenshot 2.00x1.80 -> provider
 * 1.90x1.70" are each a literal, findable regression, not just implied by
 * other fixtures' own numbers.
 * ============================================================================ */

test("MASTER STAGE M3.1 Phase F — SINGLE: screenshot odds 2.34 != offered odds 2.10; potential win uses 2.10 only", async () => {
  const slip: ParsedBetSlip = {
    type: "SINGLE",
    stake: 100,
    selections: [{ sport: "Football", event: "Arsenal vs Chelsea", market: null, selection: "Arsenal", submittedOdds: 2.34 }],
  };

  const result = await buildBetSlipPreview(slip, "player-1", TEST_SECRET, {
    oddsVerificationService: fakeOddsService([createVerifiedResult({ submittedOdds: "2.34", currentOdds: "2.10", provider: "THE_ODDS_API", checkedAt: CHECKED_AT })]),
  });

  const selection = result.preview.selections[0];
  assert.equal(selection.submittedOdds, 2.34, "screenshot/submitted odds preserved as reference only");
  assert.equal(selection.currentOdds, 2.1, "offered odds is the provider's current price");
  assert.equal(result.preview.potentialWin, 210, "100 * 2.10, never 100 * 2.34");
});

test("MASTER STAGE M3.1 Phase F — EXPRESS: screenshot leg odds 2.00x1.80 != offered odds 1.90x1.70; total/potential win derive from 1.90x1.70 only", async () => {
  const slip: ParsedBetSlip = {
    type: "EXPRESS",
    stake: 100,
    selections: [
      { sport: "Football", event: "Arsenal vs Chelsea", market: null, selection: "Arsenal", submittedOdds: 2.0 },
      { sport: "Football", event: "Bayern Munich vs VfB Stuttgart", market: null, selection: "Bayern Munich", submittedOdds: 1.8 },
    ],
  };

  const result = await buildBetSlipPreview(slip, "player-1", TEST_SECRET, {
    oddsVerificationService: fakeOddsService([
      createVerifiedResult({ submittedOdds: "2.0", currentOdds: "1.9", provider: "THE_ODDS_API", checkedAt: CHECKED_AT }),
      createVerifiedResult({ submittedOdds: "1.8", currentOdds: "1.7", provider: "THE_ODDS_API", checkedAt: CHECKED_AT }),
    ]),
  });

  assert.equal(result.preview.selections[0].submittedOdds, 2.0);
  assert.equal(result.preview.selections[0].currentOdds, 1.9);
  assert.equal(result.preview.selections[1].submittedOdds, 1.8);
  assert.equal(result.preview.selections[1].currentOdds, 1.7);

  // 1.90 * 1.70 = 3.23 exactly — never 2.00 * 1.80 = 3.60 (screenshot).
  assert.equal(result.preview.totalOdds, 3.23);
  assert.equal(result.preview.potentialWin, 323); // 100 * 3.23
});

test("SCREENSHOT ODDS QA-2 EXPRESS: one leg unverified — fail-closed, no token, exactly the existing EXPRESS confirmation policy, unchanged in kind by this stage", async () => {
  const slip: ParsedBetSlip = {
    type: "EXPRESS",
    stake: 50,
    selections: [
      { sport: "Football", event: "Bayern Munich vs VfB Stuttgart", market: null, selection: "Bayern Munich", submittedOdds: 1.42 },
      { sport: "Football", event: "Unknown Match", market: "Totals", selection: "Over 2.5", line: "2.5", submittedOdds: 2.05 },
    ],
  };

  const result = await buildBetSlipPreview(slip, "player-1", TEST_SECRET, {
    oddsVerificationService: fakeOddsService([
      createVerifiedResult({ submittedOdds: "1.42", currentOdds: "1.28", provider: "THE_ODDS_API", checkedAt: CHECKED_AT }),
      createFailedResult({ submittedOdds: "2.05", provider: "THE_ODDS_API", checkedAt: CHECKED_AT, reasonCode: "EVENT_NOT_FOUND" }),
    ]),
  });

  assert.equal(result.preview.selections[0].oddsStatus, "VERIFIED");
  assert.equal(result.preview.selections[1].oddsStatus, "NOT_FOUND");
  assert.equal(result.preview.totalOdds, null);
  assert.equal(result.preview.potentialWin, null);
  assert.equal(result.previewToken, null);
});
