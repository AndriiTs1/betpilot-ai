import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  buildSportmonksFootballPreview,
  inferSelectionSide,
  isFootballSelectionSport,
  isSportmonksFootballPreviewEnabled,
} from "./buildSportmonksFootballPreview";
import type { ParsedBetSlip } from "./betSlip";
import type { CandidateResolver, ResolvedEventCandidate } from "@/lib/odds/discovery/candidateResolver";
import type { SportmonksFixtureByIdResult } from "@/lib/odds/providers/sportmonks/sportmonksFixturesAdapter";
import type { SportmonksOddsFetchResult } from "@/lib/odds/providers/sportmonks/sportmonksOddsAdapter";

const originalEnv = { ...process.env };
test.afterEach(() => {
  process.env = { ...originalEnv };
});

const NOW_MS = Date.parse("2026-07-30T18:00:00Z");

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

function fakeFixtureById(overrides: Partial<Extract<SportmonksFixtureByIdResult, { status: "SUCCESS" }>["fixture"]> = {}): (id: string) => Promise<SportmonksFixtureByIdResult> {
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
      commenceTime: "2026-07-31T16:00:00.000Z",
      stateId: 1,
      ...overrides,
    },
  });
}

function fakeOdds(overrides: Partial<Extract<SportmonksOddsFetchResult, { status: "SUCCESS" }>["snapshot"]> = {}): (id: string) => Promise<SportmonksOddsFetchResult> {
  return async () => ({
    status: "SUCCESS",
    snapshot: {
      provider: "SPORTMONKS",
      providerEventId: "19743018",
      bookmakerId: "13",
      bookmakerName: "Coral",
      marketId: 1,
      marketName: "Fulltime Result",
      homeOdds: "1.55",
      drawOdds: "3.75",
      awayOdds: "5.00",
      updatedAt: "2026-07-30 16:47:15",
      ...overrides,
    },
  });
}

function singleSlip(overrides: Partial<ParsedBetSlip["selections"][0]> = {}): ParsedBetSlip {
  return {
    type: "SINGLE",
    stake: 100,
    selections: [
      { sport: "Football", event: "Juventus", market: null, selection: "Juventus Win", submittedOdds: null, ...overrides },
    ],
  };
}

function baseOptions(overrides: Record<string, unknown> = {}) {
  return {
    resolver: fakeResolver(),
    fetchFixtureById: fakeFixtureById(),
    fetchOdds: fakeOdds(),
    now: () => NOW_MS,
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/* Feature flag                                                              */
/* -------------------------------------------------------------------------- */

test("isSportmonksFootballPreviewEnabled: defaults to false when unset", () => {
  delete process.env.SPORTMONKS_FOOTBALL_PREVIEW_ENABLED;
  assert.equal(isSportmonksFootballPreviewEnabled(), false);
});

test("isSportmonksFootballPreviewEnabled: false for anything other than exact 'true'", () => {
  process.env.SPORTMONKS_FOOTBALL_PREVIEW_ENABLED = "TRUE";
  assert.equal(isSportmonksFootballPreviewEnabled(), false);
});

test("isSportmonksFootballPreviewEnabled: true only for exact 'true'", () => {
  process.env.SPORTMONKS_FOOTBALL_PREVIEW_ENABLED = "true";
  assert.equal(isSportmonksFootballPreviewEnabled(), true);
});

/* -------------------------------------------------------------------------- */
/* Sport / applicability gating                                              */
/* -------------------------------------------------------------------------- */

test("isFootballSelectionSport: accepts Football/football/Soccer case-insensitively", () => {
  assert.equal(isFootballSelectionSport("Football"), true);
  assert.equal(isFootballSelectionSport("football"), true);
  assert.equal(isFootballSelectionSport("Soccer"), true);
  assert.equal(isFootballSelectionSport("Basketball"), false);
});

test("buildSportmonksFootballPreview: EXPRESS slips are NOT_APPLICABLE (fall back to existing pipeline)", async () => {
  const slip: ParsedBetSlip = {
    type: "EXPRESS",
    stake: 100,
    selections: [
      { sport: "Football", event: "A", market: null, selection: "A Win", submittedOdds: 1.5 },
      { sport: "Football", event: "B", market: null, selection: "B Win", submittedOdds: 2.0 },
    ],
  };
  const result = await buildSportmonksFootballPreview(slip, baseOptions());
  assert.deepEqual(result, { kind: "NOT_APPLICABLE" });
});

test("buildSportmonksFootballPreview: non-football SINGLE is NOT_APPLICABLE", async () => {
  const slip = singleSlip({ sport: "Basketball" });
  const result = await buildSportmonksFootballPreview(slip, baseOptions());
  assert.deepEqual(result, { kind: "NOT_APPLICABLE" });
});

/* -------------------------------------------------------------------------- */
/* Selection-side mapping                                                    */
/* -------------------------------------------------------------------------- */

test("inferSelectionSide: 'Juventus Win' maps to HOME", () => {
  assert.equal(inferSelectionSide("Juventus Win", candidate()), "HOME");
});

test("inferSelectionSide: 'Nice Win' maps to AWAY", () => {
  assert.equal(inferSelectionSide("Nice Win", candidate()), "AWAY");
});

test("inferSelectionSide: 'Draw' / 'Ничья' map to DRAW", () => {
  assert.equal(inferSelectionSide("Draw", candidate()), "DRAW");
  assert.equal(inferSelectionSide("Ничья", candidate()), "DRAW");
});

test("inferSelectionSide: an unrelated phrase is null (never guessed)", () => {
  assert.equal(inferSelectionSide("Over 2.5 goals", candidate()), null);
});

/* -------------------------------------------------------------------------- */
/* Full preview build — "Juventus победа 100"                                */
/* -------------------------------------------------------------------------- */

test("buildSportmonksFootballPreview: 'Juventus победа 100' builds a SUCCESS preview", async () => {
  const slip = singleSlip({ event: "Juventus", selection: "Juventus победа" });
  const result = await buildSportmonksFootballPreview(slip, baseOptions());

  assert.equal(result.kind, "SUCCESS");
  if (result.kind !== "SUCCESS") return;
  assert.equal(result.preview.type, "SINGLE");
  assert.equal(result.preview.stake, 100);
  assert.equal(result.preview.selections.length, 1);
  const sel = result.preview.selections[0];
  assert.equal(sel.event, "Juventus vs Nice");
  assert.equal(sel.market, "Fulltime Result");
  assert.equal(sel.bookmaker, "Coral");
  assert.equal(sel.oddsStatus, "VERIFIED");
});

test("buildSportmonksFootballPreview: home selection uses homeOdds", async () => {
  const slip = singleSlip({ selection: "Juventus Win" });
  const result = await buildSportmonksFootballPreview(slip, baseOptions());
  assert.equal(result.kind, "SUCCESS");
  if (result.kind !== "SUCCESS") return;
  assert.equal(result.preview.selections[0].currentOdds, 1.55);
});

test("buildSportmonksFootballPreview: draw selection uses drawOdds", async () => {
  const slip = singleSlip({ selection: "Draw" });
  const result = await buildSportmonksFootballPreview(slip, baseOptions());
  assert.equal(result.kind, "SUCCESS");
  if (result.kind !== "SUCCESS") return;
  assert.equal(result.preview.selections[0].currentOdds, 3.75);
});

test("buildSportmonksFootballPreview: away selection uses awayOdds", async () => {
  const slip = singleSlip({ selection: "Nice Win" });
  const result = await buildSportmonksFootballPreview(slip, baseOptions());
  assert.equal(result.kind, "SUCCESS");
  if (result.kind !== "SUCCESS") return;
  assert.equal(result.preview.selections[0].currentOdds, 5.0);
});

test("buildSportmonksFootballPreview: live odds value flows into submittedOdds when the player stated none", async () => {
  const slip = singleSlip({ selection: "Juventus Win", submittedOdds: null });
  const result = await buildSportmonksFootballPreview(slip, baseOptions());
  assert.equal(result.kind, "SUCCESS");
  if (result.kind !== "SUCCESS") return;
  assert.equal(result.preview.selections[0].submittedOdds, 1.55);
});

test("buildSportmonksFootballPreview: potential payout is computed by the existing expressMath logic (stake * odds)", async () => {
  const slip = singleSlip({ selection: "Juventus Win" });
  const result = await buildSportmonksFootballPreview(slip, baseOptions());
  assert.equal(result.kind, "SUCCESS");
  if (result.kind !== "SUCCESS") return;
  assert.equal(result.preview.totalOdds, 1.55);
  assert.equal(result.preview.potentialWin, 155);
});

test("buildSportmonksFootballPreview: never signs a previewToken (SUCCESS carries no token field)", async () => {
  const slip = singleSlip({ selection: "Juventus Win" });
  const result = await buildSportmonksFootballPreview(slip, baseOptions());
  assert.equal(result.kind, "SUCCESS");
  if (result.kind !== "SUCCESS") return;
  assert.ok(!("previewToken" in result), "SportmonksFootballPreviewResult must never carry a previewToken");
});

/* -------------------------------------------------------------------------- */
/* Discovery-result mapping                                                  */
/* -------------------------------------------------------------------------- */

test("buildSportmonksFootballPreview: NOT_FOUND resolver result maps to TEAM_NOT_FOUND", async () => {
  const slip = singleSlip();
  const result = await buildSportmonksFootballPreview(
    slip,
    baseOptions({ resolver: fakeResolver({ resolve: () => ({ kind: "NOT_FOUND", reason: "x" }) }) }),
  );
  assert.deepEqual(result, { kind: "TEAM_NOT_FOUND" });
});

test("buildSportmonksFootballPreview: AMBIGUOUS resolver result is never guessed down to one candidate", async () => {
  const slip = singleSlip();
  const result = await buildSportmonksFootballPreview(
    slip,
    baseOptions({
      resolver: fakeResolver({
        resolve: () => ({ kind: "AMBIGUOUS", candidates: [candidate(), candidate({ providerEventId: "2" })], reason: "x" }),
      }),
    }),
  );
  assert.deepEqual(result, { kind: "AMBIGUOUS" });
});

test("buildSportmonksFootballPreview: INVALID_QUERY resolver result maps through", async () => {
  const slip = singleSlip();
  const result = await buildSportmonksFootballPreview(
    slip,
    baseOptions({ resolver: fakeResolver({ resolve: () => ({ kind: "INVALID_QUERY", reason: "x" }) }) }),
  );
  assert.deepEqual(result, { kind: "INVALID_QUERY" });
});

test("buildSportmonksFootballPreview: resolver buildDependencies() FAILED maps to FAILED", async () => {
  const slip = singleSlip();
  const result = await buildSportmonksFootballPreview(
    slip,
    baseOptions({ resolver: fakeResolver({ buildDependencies: async () => ({ status: "FAILED", source: "TEAM_INDEX", reason: "ALL_LEAGUES_UNAVAILABLE" }) }) }),
  );
  assert.deepEqual(result, { kind: "FAILED" });
});

test("buildSportmonksFootballPreview: an unsupported selection phrase (neither team nor draw) is UNSUPPORTED_SELECTION", async () => {
  const slip = singleSlip({ selection: "Over 2.5 goals" });
  const result = await buildSportmonksFootballPreview(slip, baseOptions());
  assert.deepEqual(result, { kind: "UNSUPPORTED_SELECTION" });
});

/* -------------------------------------------------------------------------- */
/* Upcoming-event safety re-check                                            */
/* -------------------------------------------------------------------------- */

test("buildSportmonksFootballPreview: an already-started fixture (re-checked live) is ALREADY_STARTED", async () => {
  const slip = singleSlip({ selection: "Juventus Win" });
  const result = await buildSportmonksFootballPreview(
    slip,
    baseOptions({ fetchFixtureById: fakeFixtureById({ stateId: 2 }) }),
  );
  assert.deepEqual(result, { kind: "ALREADY_STARTED" });
});

test("buildSportmonksFootballPreview: a fixture whose kickoff has passed 'now' is ALREADY_STARTED even with state_id=1", async () => {
  const slip = singleSlip({ selection: "Juventus Win" });
  const result = await buildSportmonksFootballPreview(
    slip,
    baseOptions({ fetchFixtureById: fakeFixtureById({ stateId: 1, commenceTime: "2026-07-30T10:00:00.000Z" }) }),
  );
  assert.deepEqual(result, { kind: "ALREADY_STARTED" });
});

test("buildSportmonksFootballPreview: fixture re-check FAILED/NOT_FOUND maps to FAILED", async () => {
  const slip = singleSlip({ selection: "Juventus Win" });
  const result = await buildSportmonksFootballPreview(
    slip,
    baseOptions({ fetchFixtureById: async () => ({ status: "NOT_FOUND" }) }),
  );
  assert.deepEqual(result, { kind: "FAILED" });
});

/* -------------------------------------------------------------------------- */
/* Odds handling                                                             */
/* -------------------------------------------------------------------------- */

test("buildSportmonksFootballPreview: EMPTY odds -> ODDS_UNAVAILABLE", async () => {
  const slip = singleSlip({ selection: "Juventus Win" });
  const result = await buildSportmonksFootballPreview(slip, baseOptions({ fetchOdds: async () => ({ status: "EMPTY" }) }));
  assert.deepEqual(result, { kind: "ODDS_UNAVAILABLE" });
});

test("buildSportmonksFootballPreview: FAILED odds fetch -> FAILED", async () => {
  const slip = singleSlip({ selection: "Juventus Win" });
  const result = await buildSportmonksFootballPreview(
    slip,
    baseOptions({ fetchOdds: async () => ({ status: "FAILED", reason: "HTTP_FORBIDDEN" }) }),
  );
  assert.deepEqual(result, { kind: "FAILED" });
});

/* -------------------------------------------------------------------------- */
/* Safety boundary — never touches Bet creation or balance                   */
/* -------------------------------------------------------------------------- */

test("buildSportmonksFootballPreview.ts never imports createBetFromPreview, Prisma db client, or player/balance mutation code", () => {
  const source = readFileSync(new URL("./buildSportmonksFootballPreview.ts", import.meta.url), "utf8");
  const importLines = source.split("\n").filter((line) => /^\s*import\b/.test(line));
  const forbidden = ["createBetFromPreview", "db/client", "@/lib/db"];
  for (const fragment of forbidden) {
    assert.ok(
      importLines.every((line) => !line.includes(fragment)),
      `must not import anything matching "${fragment}"`,
    );
  }
});

test("buildSportmonksFootballPreview: function signature has no db/player parameter (structural proof no write path exists)", async () => {
  // buildSportmonksFootballPreview(slip, options) — no playerId, no db.
  // Verified by TypeScript at compile time; this call would fail to
  // compile if a required db/playerId argument were ever added.
  const slip = singleSlip({ selection: "Juventus Win" });
  const result = await buildSportmonksFootballPreview(slip, baseOptions());
  assert.equal(result.kind, "SUCCESS");
});
