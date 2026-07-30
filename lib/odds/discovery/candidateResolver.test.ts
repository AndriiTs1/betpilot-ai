import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createCandidateResolver } from "./candidateResolver";
import type { TeamIndex, TeamIndexEntry, BuildTeamIndexResult } from "./teamIndex";
import type { TeamAliasIndex, BuildTeamAliasIndexResult } from "./teamAliasIndex";

// DI-only throughout — createCandidateResolver()'s own `teamIndex`/
// `teamAliasIndex` options (fakes satisfying narrow Pick<> shapes) are the
// only seams these tests use. No global.fetch replacement, no real Team
// Index/Team Alias Index/Event Catalog wiring anywhere in this file.

function entry(overrides: Partial<TeamIndexEntry> = {}): TeamIndexEntry {
  return {
    canonicalName: "Arsenal",
    normalizedName: "arsenal",
    provider: "THE_ODDS_API",
    providerEventId: "evt-1",
    sportKey: "soccer_epl",
    league: "Premier League",
    role: "HOME",
    ...overrides,
  };
}

function basicNormalize(s: string): string {
  return s.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
}

function fakeTeamIndex(
  entries: readonly TeamIndexEntry[],
  buildResult?: BuildTeamIndexResult,
): Pick<TeamIndex, "build" | "getAllTeams" | "findExact" | "findNormalized"> {
  return {
    build: async () =>
      buildResult ?? {
        status: "SUCCESS",
        stats: { uniqueTeamCount: 0, entryCount: entries.length, homeCount: 0, awayCount: 0, buildDurationMs: 0, dataSource: "EVENT_CATALOG" },
      },
    getAllTeams: () => entries,
    findExact: (name: string) => entries.filter((e) => e.canonicalName === name),
    findNormalized: (name: string) => entries.filter((e) => basicNormalize(e.canonicalName) === basicNormalize(name)),
  };
}

function fakeAliasIndex(
  aliasMap: Record<string, readonly TeamIndexEntry[]>,
  buildResult?: BuildTeamAliasIndexResult,
): Pick<TeamAliasIndex, "find" | "build"> {
  return {
    build: async () =>
      buildResult ?? {
        status: "SUCCESS",
        stats: { canonicalGeneratedAliasCount: 0, curatedAliasCount: 0, totalAliasCount: 0, aliasCollisionCount: 0, teamEntryReferenceCount: 0, builtAt: new Date().toISOString(), entryCount: 0, buildDurationMs: 0, dataSource: "TEAM_INDEX" },
      },
    find: (query: string) => aliasMap[basicNormalize(query)] ?? [],
  };
}

async function readyResolver(
  entries: readonly TeamIndexEntry[],
  aliasMap: Record<string, readonly TeamIndexEntry[]> = {},
) {
  const resolver = createCandidateResolver({ teamIndex: fakeTeamIndex(entries), teamAliasIndex: fakeAliasIndex(aliasMap) });
  const build = await resolver.buildDependencies();
  assert.equal(build.status, "SUCCESS");
  return resolver;
}

/* -------------------------------------------------------------------------- */
/* Team query                                                                */
/* -------------------------------------------------------------------------- */

test("team query: exact canonical name -> TEAM_RESOLVED", async () => {
  const arsenal = entry({ canonicalName: "Arsenal" });
  const resolver = await readyResolver([arsenal]);

  const result = resolver.resolveTeam("Arsenal");
  assert.equal(result.kind, "TEAM_RESOLVED");
  if (result.kind !== "TEAM_RESOLVED") return;
  assert.equal(result.candidate.matchMethod, "EXACT");
  assert.equal(result.candidate.score, 1);
  assert.equal(result.candidate.providerEventId, "evt-1");
});

test("team query: normalized name (case/whitespace) -> TEAM_RESOLVED via NORMALIZED", async () => {
  const arsenal = entry({ canonicalName: "Arsenal" });
  const resolver = await readyResolver([arsenal]);

  const result = resolver.resolveTeam("  ARSENAL  ");
  assert.equal(result.kind, "TEAM_RESOLVED");
  if (result.kind !== "TEAM_RESOLVED") return;
  assert.equal(result.candidate.matchMethod, "NORMALIZED");
});

test("team query: curated alias -> TEAM_RESOLVED via CURATED_ALIAS", async () => {
  const manUtd = entry({ canonicalName: "Manchester United" });
  const resolver = await readyResolver([manUtd], { "man utd": [manUtd], mu: [manUtd] });

  const result = resolver.resolveTeam("man utd");
  assert.equal(result.kind, "TEAM_RESOLVED");
  if (result.kind !== "TEAM_RESOLVED") return;
  assert.equal(result.candidate.matchMethod, "CURATED_ALIAS");
  assert.equal(result.candidate.homeTeam, "Manchester United");
});

test("team query: Russian-language alias -> TEAM_RESOLVED", async () => {
  const bayern = entry({ canonicalName: "Bayern Munich", sportKey: "soccer_germany_bundesliga", league: "Bundesliga" });
  const resolver = await readyResolver([bayern], { бавария: [bayern] });

  const result = resolver.resolveTeam("бавария");
  assert.equal(result.kind, "TEAM_RESOLVED");
  if (result.kind !== "TEAM_RESOLVED") return;
  assert.equal(result.candidate.matchMethod, "CURATED_ALIAS");
});

test("team query: fuzzy typo -> TEAM_RESOLVED via FUZZY with a real score", async () => {
  const arsenal = entry({ canonicalName: "Arsenal" });
  const resolver = await readyResolver([arsenal]);

  const result = resolver.resolveTeam("Arsenl"); // one missing letter
  assert.equal(result.kind, "TEAM_RESOLVED");
  if (result.kind !== "TEAM_RESOLVED") return;
  assert.equal(result.candidate.matchMethod, "FUZZY");
  assert.ok(result.candidate.score > 0 && result.candidate.score < 1);
});

test("team query: weak fuzzy match is not accepted -> NOT_FOUND", async () => {
  const arsenal = entry({ canonicalName: "Arsenal" });
  const resolver = await readyResolver([arsenal]);

  const result = resolver.resolveTeam("Qwzxplfoo");
  assert.equal(result.kind, "NOT_FOUND");
});

test("team query: short query below the fuzzy length gate never fuzzy-matches -> NOT_FOUND", async () => {
  const arsenal = entry({ canonicalName: "Arsenal" });
  const resolver = await readyResolver([arsenal]);

  const result = resolver.resolveTeam("Ars"); // 3 chars, below FUZZY_MIN_QUERY_LENGTH
  assert.equal(result.kind, "NOT_FOUND");
});

test("team query: a team in exactly one match -> TEAM_RESOLVED", async () => {
  const arsenal = entry({ canonicalName: "Arsenal", providerEventId: "evt-1" });
  const resolver = await readyResolver([arsenal]);

  const result = resolver.resolveTeam("Arsenal");
  assert.equal(result.kind, "TEAM_RESOLVED");
});

test("team query: a team in multiple current matches -> AMBIGUOUS", async () => {
  const arsenalA = entry({ canonicalName: "Arsenal", providerEventId: "evt-1" });
  const arsenalB = entry({ canonicalName: "Arsenal", providerEventId: "evt-2" });
  const resolver = await readyResolver([arsenalA, arsenalB]);

  const result = resolver.resolveTeam("Arsenal");
  assert.equal(result.kind, "AMBIGUOUS");
  if (result.kind !== "AMBIGUOUS") return;
  assert.equal(result.candidates.length, 2);
  assert.deepEqual(result.candidates.map((c) => c.providerEventId).sort(), ["evt-1", "evt-2"]);
});

test("team query: alias bucket spanning two different canonical teams -> AMBIGUOUS", async () => {
  const teamA = entry({ canonicalName: "Manchester United", providerEventId: "evt-1" });
  // Canonical name deliberately does NOT itself normalize to "mu" (unlike
  // e.g. a hypothetical club literally named "Mu") — otherwise Team
  // Index's own findNormalized() would resolve this team on its own,
  // before the alias level (under test here) is ever reached, hiding the
  // real collision this test exists to prove.
  const teamB = entry({ canonicalName: "Montpellier", providerEventId: "evt-2" });
  const resolver = await readyResolver([teamA, teamB], { mu: [teamA, teamB] });

  const result = resolver.resolveTeam("mu");
  assert.equal(result.kind, "AMBIGUOUS");
  if (result.kind !== "AMBIGUOUS") return;
  assert.equal(result.candidates.length, 2);
});

test("team query: not found returns NOT_FOUND, never throws", async () => {
  const resolver = await readyResolver([entry({ canonicalName: "Arsenal" })]);
  const result = resolver.resolveTeam("Nonexistent FC");
  assert.equal(result.kind, "NOT_FOUND");
});

/* -------------------------------------------------------------------------- */
/* Match query                                                               */
/* -------------------------------------------------------------------------- */

function matchFixture(homeName = "Real Madrid", awayName = "Barcelona", eventId = "evt-10") {
  return [
    entry({ canonicalName: homeName, providerEventId: eventId, role: "HOME", sportKey: "soccer_spain_la_liga", league: "La Liga" }),
    entry({ canonicalName: awayName, providerEventId: eventId, role: "AWAY", sportKey: "soccer_spain_la_liga", league: "La Liga" }),
  ];
}

test('match query: "A vs B" -> MATCH_RESOLVED', async () => {
  const resolver = await readyResolver(matchFixture());
  const result = resolver.resolve("Real Madrid vs Barcelona");
  assert.equal(result.kind, "MATCH_RESOLVED");
  if (result.kind !== "MATCH_RESOLVED") return;
  assert.equal(result.candidate.providerEventId, "evt-10");
  assert.equal(result.candidate.homeTeam, "Real Madrid");
  assert.equal(result.candidate.awayTeam, "Barcelona");
});

test('match query: "A v B" -> MATCH_RESOLVED', async () => {
  const resolver = await readyResolver(matchFixture());
  const result = resolver.resolve("Real Madrid v Barcelona");
  assert.equal(result.kind, "MATCH_RESOLVED");
});

test('match query: "A - B" (hyphen) -> MATCH_RESOLVED', async () => {
  const resolver = await readyResolver(matchFixture());
  const result = resolver.resolve("Real Madrid - Barcelona");
  assert.equal(result.kind, "MATCH_RESOLVED");
});

test('match query: em dash "A — B" -> MATCH_RESOLVED', async () => {
  const resolver = await readyResolver(matchFixture());
  const result = resolver.resolve("Real Madrid — Barcelona");
  assert.equal(result.kind, "MATCH_RESOLVED");
});

test('match query: en dash "A – B" -> MATCH_RESOLVED', async () => {
  const resolver = await readyResolver(matchFixture());
  const result = resolver.resolve("Real Madrid – Barcelona");
  assert.equal(result.kind, "MATCH_RESOLVED");
});

test('match query: "A против B" (Cyrillic) -> MATCH_RESOLVED', async () => {
  const resolver = await readyResolver(matchFixture("Интер", "Милан"), { интер: matchFixture("Интер", "Милан").filter((e) => e.canonicalName === "Интер") });
  const result = resolver.resolve("Интер против Милана".replace("Милана", "Милан")); // exact canonical form for determinism
  // Direct canonical names are used here (not the genitive "Милана") so
  // resolution goes through EXACT/NORMALIZED, matching this test's actual
  // purpose: proving the "против" separator itself splits correctly.
  assert.equal(result.kind, "MATCH_RESOLVED");
});

test("match query: reversed HOME/AWAY orientation still resolves to the same event", async () => {
  // Team A is AWAY, Team B is HOME — the query order need not match roles.
  const fixture = [
    entry({ canonicalName: "Barcelona", providerEventId: "evt-11", role: "HOME", sportKey: "soccer_spain_la_liga", league: "La Liga" }),
    entry({ canonicalName: "Real Madrid", providerEventId: "evt-11", role: "AWAY", sportKey: "soccer_spain_la_liga", league: "La Liga" }),
  ];
  const resolver = await readyResolver(fixture);
  const result = resolver.resolve("Real Madrid vs Barcelona");
  assert.equal(result.kind, "MATCH_RESOLVED");
  if (result.kind !== "MATCH_RESOLVED") return;
  assert.equal(result.candidate.providerEventId, "evt-11");
  assert.equal(result.candidate.homeTeam, "Barcelona");
  assert.equal(result.candidate.awayTeam, "Real Madrid");
});

test("match query: one side resolved via curated alias", async () => {
  const fixture = [
    entry({ canonicalName: "Manchester United", providerEventId: "evt-12", role: "HOME", sportKey: "soccer_epl", league: "Premier League" }),
    entry({ canonicalName: "Chelsea", providerEventId: "evt-12", role: "AWAY", sportKey: "soccer_epl", league: "Premier League" }),
  ];
  const resolver = await readyResolver(fixture, { mu: [fixture[0]] });

  const result = resolver.resolve("mu vs Chelsea");
  assert.equal(result.kind, "MATCH_RESOLVED");
  if (result.kind !== "MATCH_RESOLVED") return;
  assert.equal(result.candidate.matchMethod, "CURATED_ALIAS", "combined method reflects the exact-like side; both sides are exact-like here");
});

test("match query: one side resolved via fuzzy -> combined candidate reports FUZZY", async () => {
  const fixture = [
    entry({ canonicalName: "Arsenal", providerEventId: "evt-13", role: "HOME", sportKey: "soccer_epl", league: "Premier League" }),
    entry({ canonicalName: "Chelsea", providerEventId: "evt-13", role: "AWAY", sportKey: "soccer_epl", league: "Premier League" }),
  ];
  const resolver = await readyResolver(fixture);

  const result = resolver.resolve("Arsenl vs Chelsea"); // typo on the home side
  assert.equal(result.kind, "MATCH_RESOLVED");
  if (result.kind !== "MATCH_RESOLVED") return;
  assert.equal(result.candidate.matchMethod, "FUZZY", "the weaker side's method wins for the combined candidate");
  assert.ok(result.candidate.score < 1);
});

test("match query: exactly one common providerEventId -> MATCH_RESOLVED", async () => {
  const resolver = await readyResolver(matchFixture());
  const result = resolver.resolve("Real Madrid vs Barcelona");
  assert.equal(result.kind, "MATCH_RESOLVED");
});

test("match query: no common event -> NOT_FOUND", async () => {
  const fixture = [
    entry({ canonicalName: "Real Madrid", providerEventId: "evt-20", role: "HOME" }),
    entry({ canonicalName: "Barcelona", providerEventId: "evt-21", role: "HOME" }), // different event, never plays Real Madrid here
  ];
  const resolver = await readyResolver(fixture);
  const result = resolver.resolve("Real Madrid vs Barcelona");
  assert.equal(result.kind, "NOT_FOUND");
});

test("match query: multiple common events -> AMBIGUOUS", async () => {
  const fixture = [
    entry({ canonicalName: "Real Madrid", providerEventId: "evt-30", role: "HOME" }),
    entry({ canonicalName: "Barcelona", providerEventId: "evt-30", role: "AWAY" }),
    entry({ canonicalName: "Real Madrid", providerEventId: "evt-31", role: "AWAY" }),
    entry({ canonicalName: "Barcelona", providerEventId: "evt-31", role: "HOME" }),
  ];
  const resolver = await readyResolver(fixture);
  const result = resolver.resolve("Real Madrid vs Barcelona");
  assert.equal(result.kind, "AMBIGUOUS");
  if (result.kind !== "AMBIGUOUS") return;
  assert.equal(result.candidates.length, 2);
});

test("match query: empty side -> INVALID_QUERY", async () => {
  const resolver = await readyResolver(matchFixture());
  const result1 = resolver.resolve("Real Madrid vs ");
  assert.equal(result1.kind, "INVALID_QUERY");
  const result2 = resolver.resolveMatch("Real Madrid", "");
  assert.equal(result2.kind, "INVALID_QUERY");
});

test("match query: more than two team parts -> INVALID_QUERY", async () => {
  const resolver = await readyResolver(matchFixture());
  const result = resolver.resolve("Real Madrid vs Barcelona vs Atletico");
  assert.equal(result.kind, "INVALID_QUERY");
});

/* -------------------------------------------------------------------------- */
/* Fuzzy — dedicated behavior tests                                          */
/* -------------------------------------------------------------------------- */

test("fuzzy: score is deterministic across repeated calls", async () => {
  const resolver = await readyResolver([entry({ canonicalName: "Arsenal" })]);
  const first = resolver.resolveTeam("Arsenl");
  const second = resolver.resolveTeam("Arsenl");
  assert.equal(first.kind, "TEAM_RESOLVED");
  assert.equal(second.kind, "TEAM_RESOLVED");
  if (first.kind !== "TEAM_RESOLVED" || second.kind !== "TEAM_RESOLVED") return;
  assert.equal(first.candidate.score, second.candidate.score);
});

test("fuzzy: distance beyond the length-scaled threshold is rejected", async () => {
  // "Arsenal" (7 chars) allows floor(7*0.25)=1, capped at 2 -> 1. A 3-edit
  // difference must be rejected.
  const resolver = await readyResolver([entry({ canonicalName: "Arsenal" })]);
  const result = resolver.resolveTeam("Arsnxyz"); // several edits away
  assert.equal(result.kind, "NOT_FOUND");
});

test("fuzzy: shorter strings are held to a stricter (smaller) allowed distance", async () => {
  // "Nice" (4 chars) -> allowed = min(floor(4*0.25),2) = min(1,2) = 1.
  const resolver = await readyResolver([entry({ canonicalName: "Nice", sportKey: "soccer_france_ligue_one", league: "Ligue 1" })]);
  const oneEditAway = resolver.resolveTeam("Nica"); // 1 substitution
  const twoEditsAway = resolver.resolveTeam("Nixa"); // 2 substitutions
  assert.equal(oneEditAway.kind, "TEAM_RESOLVED");
  assert.equal(twoEditsAway.kind, "NOT_FOUND");
});

test("fuzzy: equal best score across different teams -> AMBIGUOUS, never picked arbitrarily", async () => {
  // Query "Tens" is exactly distance 1 from BOTH "Lens" (t->l) and the
  // hypothetical "Rens" (t->r) — a genuine, verifiable tie at the same
  // score, neither name being closer than the other.
  const teamA = entry({ canonicalName: "Lens", providerEventId: "evt-40", sportKey: "soccer_france_ligue_one", league: "Ligue 1" });
  const teamB = entry({ canonicalName: "Rens", providerEventId: "evt-41" });
  const resolver = await readyResolver([teamA, teamB]);

  const tie = resolver.resolveTeam("Tens");
  assert.equal(tie.kind, "AMBIGUOUS");
  if (tie.kind !== "AMBIGUOUS") return;
  const names = new Set(tie.candidates.map((c) => c.matchedTeamNames).flat());
  assert.ok(names.has("Lens") && names.has("Rens"));
});

test("fuzzy: an exact-like match always takes priority over fuzzy, even if a closer-looking fuzzy candidate exists elsewhere", async () => {
  const exactTeam = entry({ canonicalName: "Arsenal", providerEventId: "evt-50" });
  const decoyTeam = entry({ canonicalName: "Arsenol", providerEventId: "evt-51" }); // fuzzy-closer spelling, must never win over the real exact match
  const teamIndex = fakeTeamIndex([exactTeam, decoyTeam]);
  // A findNormalized/find that would throw if reached proves EXACT alone
  // satisfied the query and nothing past it was ever consulted.
  const aliasIndex: Pick<TeamAliasIndex, "find" | "build"> = {
    build: async () => ({ status: "SUCCESS", stats: { canonicalGeneratedAliasCount: 0, curatedAliasCount: 0, totalAliasCount: 0, aliasCollisionCount: 0, teamEntryReferenceCount: 0, builtAt: null, entryCount: 0, buildDurationMs: 0, dataSource: "TEAM_INDEX" } }),
    find: () => {
      throw new Error("Team Alias Index must never be consulted once EXACT already matched");
    },
  };
  const resolver = createCandidateResolver({ teamIndex, teamAliasIndex: aliasIndex });
  await resolver.buildDependencies();

  const result = resolver.resolveTeam("Arsenal");
  assert.equal(result.kind, "TEAM_RESOLVED");
  if (result.kind !== "TEAM_RESOLVED") return;
  assert.equal(result.candidate.matchMethod, "EXACT");
  assert.equal(result.candidate.providerEventId, "evt-50");
});

/* -------------------------------------------------------------------------- */
/* Infrastructure                                                            */
/* -------------------------------------------------------------------------- */

test("buildDependencies(): SUCCESS when both indexes build successfully", async () => {
  const resolver = createCandidateResolver({ teamIndex: fakeTeamIndex([entry()]), teamAliasIndex: fakeAliasIndex({}) });
  const result = await resolver.buildDependencies();
  assert.deepEqual(result, { status: "SUCCESS" });
});

test("buildDependencies(): Team Index failure -> FAILED with source TEAM_INDEX, resolve() returns FAILED too", async () => {
  const resolver = createCandidateResolver({
    teamIndex: fakeTeamIndex([], { status: "FAILED", reason: "ALL_LEAGUES_UNAVAILABLE" }),
    teamAliasIndex: fakeAliasIndex({}),
  });
  const build = await resolver.buildDependencies();
  assert.deepEqual(build, { status: "FAILED", source: "TEAM_INDEX", reason: "ALL_LEAGUES_UNAVAILABLE" });

  const result = resolver.resolveTeam("Arsenal");
  assert.deepEqual(result, { kind: "FAILED", source: "TEAM_INDEX", reason: "ALL_LEAGUES_UNAVAILABLE" });
});

test("buildDependencies(): Team Alias Index failure -> FAILED with source TEAM_ALIAS_INDEX", async () => {
  const resolver = createCandidateResolver({
    teamIndex: fakeTeamIndex([entry()]),
    teamAliasIndex: fakeAliasIndex({}, { status: "FAILED", reason: "ALL_LEAGUES_UNAVAILABLE" }),
  });
  const build = await resolver.buildDependencies();
  assert.deepEqual(build, { status: "FAILED", source: "TEAM_ALIAS_INDEX", reason: "ALL_LEAGUES_UNAVAILABLE" });
});

test("resolve() before buildDependencies() was ever called -> FAILED, source RESOLVER", () => {
  const resolver = createCandidateResolver({ teamIndex: fakeTeamIndex([entry()]), teamAliasIndex: fakeAliasIndex({}) });
  const result = resolver.resolve("Arsenal");
  assert.equal(result.kind, "FAILED");
  if (result.kind !== "FAILED") return;
  assert.equal(result.source, "RESOLVER");
});

test("clear(): resets readiness — a subsequent resolve() returns FAILED again until rebuilt", async () => {
  const resolver = await readyResolver([entry({ canonicalName: "Arsenal" })]);
  assert.equal(resolver.resolveTeam("Arsenal").kind, "TEAM_RESOLVED");

  resolver.clear();

  const result = resolver.resolveTeam("Arsenal");
  assert.equal(result.kind, "FAILED");
});

test("no code path ever reaches the real global fetch", async () => {
  const originalFetch = global.fetch;
  global.fetch = (() => {
    throw new Error("candidateResolver.test.ts: the real network layer must never be reached");
  }) as unknown as typeof fetch;

  try {
    const resolver = await readyResolver([entry({ canonicalName: "Arsenal" })]);
    const result = resolver.resolveTeam("Arsenal");
    assert.equal(result.kind, "TEAM_RESOLVED");
  } finally {
    global.fetch = originalFetch;
  }
});

test("the source file never imports lib/odds/providers, Event Catalog, League Catalog, or Supported Competitions directly", () => {
  const source = readFileSync(join(process.cwd(), "lib", "odds", "discovery", "candidateResolver.ts"), "utf8");
  const importLines = source.split("\n").filter((line) => /^\s*import\b/.test(line));

  assert.equal(importLines.some((l) => l.includes("lib/odds/providers")), false);
  assert.equal(importLines.some((l) => /["'](\.\/)?eventCatalog["']/.test(l)), false);
  assert.equal(importLines.some((l) => /["'](\.\/)?leagueCatalog["']/.test(l)), false);
  assert.equal(importLines.some((l) => /["'](\.\/)?supportedCompetitions["']/.test(l)), false);
  // Only allowed Discovery Engine imports: ./teamIndex and ./teamAliasIndex.
  const discoveryImports = importLines.filter((l) => /from ["']\.\//.test(l));
  for (const line of discoveryImports) {
    assert.ok(/\.\/(teamIndex|teamAliasIndex)["']/.test(line), `unexpected relative import: ${line.trim()}`);
  }
});

test("no AI, LLM, embeddings, or external fuzzy-matching library is imported", () => {
  const source = readFileSync(join(process.cwd(), "lib", "odds", "discovery", "candidateResolver.ts"), "utf8").toLowerCase();
  const importLines = source.split("\n").filter((line) => /^\s*import\b/.test(line));
  for (const forbidden of ["openai", "embedding", "anthropic", "claude", "fuse", "fastest-levenshtein", "string-similarity"]) {
    assert.equal(importLines.some((l) => l.includes(forbidden)), false, `must not import anything referencing "${forbidden}"`);
  }
});
