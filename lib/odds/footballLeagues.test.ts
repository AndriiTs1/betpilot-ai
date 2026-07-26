import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveFootballLeague, FOOTBALL_LEAGUES, FOOTBALL_FALLBACK_LEGACY_SPORT_STRINGS } from "./footballLeagues";

// Step 16A — the single centralized football-league alias table. Every
// consumer (legacyOddsBridge.ts's legacyFootballLeagueFromSportString,
// theOddsApiProvider.ts's league-support check, oddsVerifier.ts's football
// fallback set) reads from this one table — these tests are the
// authoritative coverage for the alias recognition itself.

test("resolveFootballLeague: recognizes every supported league by its canonical display name", () => {
  assert.deepEqual(resolveFootballLeague("Premier League"), { displayName: "Premier League", legacySportString: "premier league" });
  assert.deepEqual(resolveFootballLeague("La Liga"), { displayName: "La Liga", legacySportString: "la liga" });
  assert.deepEqual(resolveFootballLeague("Serie A"), { displayName: "Serie A", legacySportString: "serie a" });
  assert.deepEqual(resolveFootballLeague("Bundesliga"), { displayName: "Bundesliga", legacySportString: "bundesliga" });
  assert.deepEqual(resolveFootballLeague("Ligue 1"), { displayName: "Ligue 1", legacySportString: "ligue 1" });
  assert.deepEqual(resolveFootballLeague("UEFA Champions League"), {
    displayName: "UEFA Champions League",
    legacySportString: "champions league",
  });
});

test("resolveFootballLeague: common aliases all resolve to the correct league", () => {
  const cases: Array<[string, string]> = [
    ["Serie A", "Serie A"],
    ["serie a", "Serie A"],
    ["SERIE A", "Serie A"],
    ["UEFA Champions League", "UEFA Champions League"],
    ["Champions League", "UEFA Champions League"],
    ["UCL", "UEFA Champions League"],
    ["ucl", "UEFA Champions League"],
    ["Premier League", "Premier League"],
    ["EPL", "Premier League"],
    ["epl", "Premier League"],
    ["English Premier League", "Premier League"],
    ["La Liga", "La Liga"],
    ["LaLiga", "La Liga"],
  ];

  for (const [input, expectedDisplayName] of cases) {
    const resolved = resolveFootballLeague(input);
    assert.ok(resolved, `"${input}" must resolve to a known league`);
    assert.equal(resolved?.displayName, expectedDisplayName, `"${input}" must resolve to ${expectedDisplayName}`);
  }
});

test("resolveFootballLeague: case-insensitive and whitespace-tolerant", () => {
  assert.equal(resolveFootballLeague("  SERIE   A  ")?.displayName, "Serie A");
  assert.equal(resolveFootballLeague("serie a")?.displayName, "Serie A");
  assert.equal(resolveFootballLeague("Serie A")?.displayName, "Serie A");
});

test("resolveFootballLeague: an unrecognized league returns null, never fabricated or substituted", () => {
  assert.equal(resolveFootballLeague("Eredivisie"), null);
  assert.equal(resolveFootballLeague("Europa League"), null);
  assert.equal(resolveFootballLeague("Championship"), null);
  assert.equal(resolveFootballLeague(""), null);
});

test("resolveFootballLeague: generic football/soccer aliases are never recognized as a league name", () => {
  for (const generic of ["football", "soccer", "футбол"]) {
    assert.equal(resolveFootballLeague(generic), null, `"${generic}" must never resolve to a specific league`);
  }
});

test("FOOTBALL_LEAGUES / FOOTBALL_FALLBACK_LEGACY_SPORT_STRINGS: exactly the six supported competitions, in sync with each other", () => {
  assert.equal(FOOTBALL_LEAGUES.length, 6);
  assert.deepEqual(
    FOOTBALL_FALLBACK_LEGACY_SPORT_STRINGS,
    FOOTBALL_LEAGUES.map((league) => league.legacySportString),
  );
  assert.deepEqual(
    [...FOOTBALL_FALLBACK_LEGACY_SPORT_STRINGS].sort(),
    ["premier league", "la liga", "serie a", "bundesliga", "ligue 1", "champions league"].sort(),
  );
});
