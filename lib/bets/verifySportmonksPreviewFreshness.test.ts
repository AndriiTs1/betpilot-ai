import { test } from "node:test";
import assert from "node:assert/strict";
import { verifySportmonksPreviewFreshness } from "./verifySportmonksPreviewFreshness";
import type { PreviewTokenPayload } from "@/lib/betPreview/previewToken";
import type { CandidateResolver, ResolvedEventCandidate } from "@/lib/odds/discovery/candidateResolver";
import type { SportmonksFixtureByIdResult } from "@/lib/odds/providers/sportmonks/sportmonksFixturesAdapter";
import type { SportmonksOddsFetchResult } from "@/lib/odds/providers/sportmonks/sportmonksOddsAdapter";

const SECRET = "test-freshness-secret";
const NOW_MS = Date.parse("2026-07-30T18:00:00Z");

function payload(overrides: Partial<PreviewTokenPayload> = {}): PreviewTokenPayload {
  return {
    v: 1,
    previewId: "preview-1",
    playerId: "player-1",
    type: "SINGLE",
    sport: "Football",
    event: "Juventus vs Nice",
    outcome: "Juventus победа",
    stake: 100,
    odds: 1.55,
    totalOdds: 1.55,
    oddsCheck: null,
    providerName: "SPORTMONKS",
    providerEventId: "19743018",
    providerSportKey: "sportmonks:1101",
    eventStartTime: "2026-07-31T16:00:00.000Z",
    canonicalMarketType: "MONEYLINE_3WAY",
    canonicalSelectionType: "HOME",
    canonicalParticipant: "Juventus",
    canonicalPeriod: "FULL_GAME",
    issuedAt: Math.floor(NOW_MS / 1000),
    expiresAt: Math.floor(NOW_MS / 1000) + 180,
    ...overrides,
  };
}

function candidate(overrides: Partial<ResolvedEventCandidate> = {}): ResolvedEventCandidate {
  return {
    provider: "SPORTMONKS",
    providerEventId: "19743018",
    sportKey: "sportmonks:1101",
    league: "Club Friendlies 1",
    commenceTime: null,
    homeTeam: "Juventus",
    awayTeam: "Nice",
    matchedTeamNames: ["Juventus"],
    matchMethod: "EXACT",
    score: 1,
    diagnostics: [],
    ...overrides,
  };
}

function fakeResolver(overrides: Partial<Pick<CandidateResolver, "buildDependencies" | "resolve">> = {}): Pick<CandidateResolver, "buildDependencies" | "resolve"> {
  return {
    buildDependencies: async () => ({ status: "SUCCESS" }),
    resolve: () => ({ kind: "TEAM_RESOLVED", candidate: candidate() }),
    ...overrides,
  };
}

function fakeFixtureById(stateId = 1, commenceTime = "2026-07-31T16:00:00.000Z"): (id: string) => Promise<SportmonksFixtureByIdResult> {
  return async () => ({
    status: "SUCCESS",
    fixture: {
      provider: "SPORTMONKS",
      providerEventId: "19743018",
      sport: "FOOTBALL",
      leagueId: 1101,
      leagueName: "Club Friendlies 1",
      stageName: "Regular Season",
      homeTeamId: "625",
      homeTeamName: "Juventus",
      awayTeamId: "450",
      awayTeamName: "Nice",
      commenceTime,
      stateId,
    },
  });
}

function fakeOdds(homeOdds = "1.55", drawOdds = "3.75", awayOdds = "5.00"): (id: string) => Promise<SportmonksOddsFetchResult> {
  return async () => ({
    status: "SUCCESS",
    snapshot: {
      provider: "SPORTMONKS",
      providerEventId: "19743018",
      bookmakerId: "13",
      bookmakerName: "Coral",
      marketId: 1,
      marketName: "Fulltime Result",
      homeOdds,
      drawOdds,
      awayOdds,
      updatedAt: "2026-07-30 16:47:15",
    },
  });
}

function opts(overrides: Record<string, unknown> = {}) {
  return {
    resolver: fakeResolver(),
    fetchFixtureById: fakeFixtureById(),
    fetchOdds: fakeOdds(),
    now: () => NOW_MS,
    ...overrides,
  };
}

test("verifySportmonksPreviewFreshness: unchanged odds -> ACCEPT", async () => {
  const result = await verifySportmonksPreviewFreshness(payload({ odds: 1.55 }), SECRET, { buildOptions: opts() });
  assert.deepEqual(result, { kind: "ACCEPT" });
});

test("verifySportmonksPreviewFreshness: odds within 3% tolerance -> ACCEPT", async () => {
  // 1.55 -> 1.58 is ~1.9% — within the existing 3% tolerance.
  const result = await verifySportmonksPreviewFreshness(payload({ odds: 1.55 }), SECRET, {
    buildOptions: opts({ fetchOdds: fakeOdds("1.58") }),
  });
  assert.deepEqual(result, { kind: "ACCEPT" });
});

test("verifySportmonksPreviewFreshness: odds change beyond 3% -> ODDS_CHANGED with a fresh, signed, reconfirmable token", async () => {
  // 1.55 -> 2.00 is ~22.5% — well outside tolerance.
  const result = await verifySportmonksPreviewFreshness(payload({ odds: 1.55 }), SECRET, {
    buildOptions: opts({ fetchOdds: fakeOdds("2.00") }),
  });
  assert.equal(result.kind, "ODDS_CHANGED");
  if (result.kind !== "ODDS_CHANGED") return;
  assert.equal(result.refreshedPreview.selections[0].currentOdds, 2.0);
  assert.equal(typeof result.refreshedPreviewToken, "string");
  assert.ok(result.refreshedPreviewToken.length > 0);
});

test("verifySportmonksPreviewFreshness: fixture already started (state_id=2) -> SELECTION_UNAVAILABLE, no Bet-eligible ACCEPT", async () => {
  const result = await verifySportmonksPreviewFreshness(payload(), SECRET, {
    buildOptions: opts({ fetchFixtureById: fakeFixtureById(2) }),
  });
  assert.deepEqual(result, { kind: "SELECTION_UNAVAILABLE" });
});

test("verifySportmonksPreviewFreshness: kickoff has passed 'now' -> SELECTION_UNAVAILABLE", async () => {
  const result = await verifySportmonksPreviewFreshness(payload(), SECRET, {
    buildOptions: opts({ fetchFixtureById: fakeFixtureById(1, "2026-07-30T10:00:00.000Z") }),
  });
  assert.deepEqual(result, { kind: "SELECTION_UNAVAILABLE" });
});

test("verifySportmonksPreviewFreshness: odds now empty -> VERIFICATION_UNAVAILABLE", async () => {
  const result = await verifySportmonksPreviewFreshness(payload(), SECRET, {
    buildOptions: opts({ fetchOdds: async () => ({ status: "EMPTY" }) }),
  });
  assert.deepEqual(result, { kind: "VERIFICATION_UNAVAILABLE" });
});

test("verifySportmonksPreviewFreshness: team no longer resolvable -> SELECTION_UNAVAILABLE", async () => {
  const result = await verifySportmonksPreviewFreshness(payload(), SECRET, {
    buildOptions: opts({ resolver: fakeResolver({ resolve: () => ({ kind: "NOT_FOUND", reason: "x" }) }) }),
  });
  assert.deepEqual(result, { kind: "SELECTION_UNAVAILABLE" });
});

test("verifySportmonksPreviewFreshness: resolver technical failure -> VERIFICATION_UNAVAILABLE", async () => {
  const result = await verifySportmonksPreviewFreshness(payload(), SECRET, {
    buildOptions: opts({ resolver: fakeResolver({ buildDependencies: async () => ({ status: "FAILED", source: "TEAM_INDEX", reason: "ALL_LEAGUES_UNAVAILABLE" }) }) }),
  });
  assert.deepEqual(result, { kind: "VERIFICATION_UNAVAILABLE" });
});

test("verifySportmonksPreviewFreshness: DRAW selection compares against fresh drawOdds", async () => {
  const drawPayload = payload({ odds: 3.75, outcome: "Ничья", canonicalSelectionType: "DRAW", canonicalParticipant: null });
  const result = await verifySportmonksPreviewFreshness(drawPayload, SECRET, { buildOptions: opts() });
  assert.deepEqual(result, { kind: "ACCEPT" });
});

test("verifySportmonksPreviewFreshness: AWAY selection compares against fresh awayOdds", async () => {
  const awayPayload = payload({ odds: 5.0, outcome: "Nice победа", canonicalSelectionType: "AWAY", canonicalParticipant: "Nice" });
  const result = await verifySportmonksPreviewFreshness(awayPayload, SECRET, { buildOptions: opts() });
  assert.deepEqual(result, { kind: "ACCEPT" });
});
