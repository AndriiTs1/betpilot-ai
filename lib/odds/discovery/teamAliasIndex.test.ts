import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createTeamAliasIndex } from "./teamAliasIndex";
import type { TeamIndex, TeamIndexEntry, BuildTeamIndexResult } from "./teamIndex";

// DI-only throughout — createTeamAliasIndex()'s own `teamIndex` option (a
// fake satisfying Pick<TeamIndex, "build" | "getAllTeams">) is the only
// seam these tests use. No global.fetch replacement anywhere in this file.
// Curated aliases (Stage 7.1) come from the REAL lib/odds/discovery/teamAliases.ts
// registry — these tests deliberately use its real, live-verified entries
// (Manchester United, Paris Saint Germain, Bayern Munich, ...) rather than
// a fake registry, so the tests double as a live-schedule-independent
// proof that the shipped curated table actually works end-to-end.

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

function fakeTeamIndex(entries: readonly TeamIndexEntry[], buildResult?: BuildTeamIndexResult): Pick<TeamIndex, "build" | "getAllTeams"> {
  return {
    build: async () => buildResult ?? { status: "SUCCESS", stats: { uniqueTeamCount: 0, entryCount: entries.length, homeCount: 0, awayCount: 0, buildDurationMs: 0, dataSource: "EVENT_CATALOG" } },
    getAllTeams: () => entries,
  };
}

/* -------------------------------------------------------------------------- */
/* build() — canonical-generated aliases (Stage 7, unchanged behavior)       */
/* -------------------------------------------------------------------------- */

test("build(): indexes every Team Index entry by its generated alias", async () => {
  const index = createTeamAliasIndex({ teamIndex: fakeTeamIndex([entry({ canonicalName: "Wolves" }), entry({ canonicalName: "Burnley", role: "AWAY" })]) });

  const result = await index.build();
  assert.equal(result.status, "SUCCESS");
  if (result.status !== "SUCCESS") return;
  assert.equal(result.stats.entryCount, 2);
  assert.equal(result.stats.canonicalGeneratedAliasCount, 2);
  assert.deepEqual([...index.getAliases()].sort(), ["burnley", "wolves"]);
});

test("build(): applies exactly the permitted transformation pipeline", async () => {
  const cases: Array<[string, string]> = [
    ["St. Pauli", "st pauli"],
    ["Sheffield-United", "sheffield united"],
    ["AC & Milan", "ac and milan"],
    ["  Real   Sociedad  ", "real sociedad"],
  ];

  for (const [canonicalName, expectedAlias] of cases) {
    const index = createTeamAliasIndex({ teamIndex: fakeTeamIndex([entry({ canonicalName })]) });
    await index.build();
    assert.ok(index.getAliases().includes(expectedAlias), `"${canonicalName}" -> "${expectedAlias}"`);
  }
});

test("build(): never strips club-name tokens (FC/CF/AC/SSC/AFC/SC/Sporting/Club)", async () => {
  const names = ["Sporting CP", "SSC Napoli", "AFC Bournemouth", "FC Copenhagen", "Club Brugge"];
  for (const canonicalName of names) {
    const index = createTeamAliasIndex({ teamIndex: fakeTeamIndex([entry({ canonicalName })]) });
    await index.build();
    assert.ok(index.getAliases().includes(canonicalName.toLowerCase()));
  }
});

/* -------------------------------------------------------------------------- */
/* Curated aliases (Stage 7.1) — using the real shipped registry             */
/* -------------------------------------------------------------------------- */

test("curated alias finds an existing team: 'man utd' -> Manchester United", async () => {
  const manUtd = entry({ canonicalName: "Manchester United", sportKey: "soccer_epl", league: "Premier League" });
  const index = createTeamAliasIndex({ teamIndex: fakeTeamIndex([manUtd]) });
  await index.build();

  assert.deepEqual(index.find("man utd"), [manUtd]);
});

test("PSG-style alias: 'psg' -> Paris Saint Germain", async () => {
  const psg = entry({ canonicalName: "Paris Saint Germain", sportKey: "soccer_france_ligue_one", league: "Ligue 1" });
  const index = createTeamAliasIndex({ teamIndex: fakeTeamIndex([psg]) });
  await index.build();

  assert.deepEqual(index.find("psg"), [psg]);
  assert.deepEqual(index.find("PSG"), [psg]);
});

test("Man Utd-style aliases: 'mu' and 'man united' both resolve to Manchester United", async () => {
  const manUtd = entry({ canonicalName: "Manchester United" });
  const index = createTeamAliasIndex({ teamIndex: fakeTeamIndex([manUtd]) });
  await index.build();

  assert.deepEqual(index.find("mu"), [manUtd]);
  assert.deepEqual(index.find("man united"), [manUtd]);
});

test("Russian-language curated alias: 'бавария' -> Bayern Munich, 'псж' -> Paris Saint Germain", async () => {
  const bayern = entry({ canonicalName: "Bayern Munich", sportKey: "soccer_germany_bundesliga", league: "Bundesliga" });
  const psg = entry({ canonicalName: "Paris Saint Germain", providerEventId: "evt-2", sportKey: "soccer_france_ligue_one", league: "Ligue 1" });
  const index = createTeamAliasIndex({ teamIndex: fakeTeamIndex([bayern, psg]) });
  await index.build();

  assert.deepEqual(index.find("бавария"), [bayern]);
  assert.deepEqual(index.find("псж"), [psg]);
});

test("curated alias for a team NOT currently in Team Index does not activate", async () => {
  // Team Index only has Everton today (a real EPL club with no curated
  // registry entry) — none of the curated registry's teams (Manchester
  // United, PSG, Bayern, ...) are present.
  const index = createTeamAliasIndex({ teamIndex: fakeTeamIndex([entry({ canonicalName: "Everton" })]) });
  const result = await index.build();

  assert.equal(result.status, "SUCCESS");
  if (result.status !== "SUCCESS") return;
  assert.equal(result.stats.curatedAliasCount, 0);
  assert.deepEqual(index.find("man utd"), []);
  assert.deepEqual(index.find("psg"), []);
  assert.deepEqual(index.find("бавария"), []);
  // Everton itself has no curated entry in the registry at all, and
  // canonical generation alone must still work.
  assert.equal(index.find("everton").length, 1);
});

test("curated aliases return direct references to the original TeamIndexEntry, not copies", async () => {
  const original = entry({ canonicalName: "Manchester United" });
  const index = createTeamAliasIndex({ teamIndex: fakeTeamIndex([original]) });
  await index.build();

  const [found] = index.find("mu");
  assert.equal(found, original, "must be the same object reference");
});

test("one curated-aliased team appearing in multiple matches returns multiple entries via the alias", async () => {
  const first = entry({ canonicalName: "Manchester United", providerEventId: "evt-1" });
  const second = entry({ canonicalName: "Manchester United", providerEventId: "evt-2", role: "AWAY" });
  const index = createTeamAliasIndex({ teamIndex: fakeTeamIndex([first, second]) });
  await index.build();

  assert.deepEqual(index.find("mu"), [first, second]);
});

test("a curated alias colliding with a different real team's alias returns the full bucket, no ranking", async () => {
  // Artificial but structurally honest collision: a curated alias for team
  // A happens to normalize identically to team B's own canonical-generated
  // alias. Neither is preferred — both come back together.
  const teamA = entry({ canonicalName: "Manchester United", providerEventId: "evt-1" });
  const teamB = entry({ canonicalName: "Mu", providerEventId: "evt-2", role: "AWAY" }); // hypothetical club whose real name IS "Mu"
  const index = createTeamAliasIndex({ teamIndex: fakeTeamIndex([teamA, teamB]) });

  const result = await index.build();
  assert.equal(result.status, "SUCCESS");
  if (result.status !== "SUCCESS") return;
  assert.equal(result.stats.aliasCollisionCount, 1);
  const found = index.find("mu");
  assert.equal(found.length, 2);
  assert.ok(found.includes(teamA));
  assert.ok(found.includes(teamB));
});

/* -------------------------------------------------------------------------- */
/* Statistics distinguish canonical vs curated                               */
/* -------------------------------------------------------------------------- */

test("getStats(): distinguishes canonicalGeneratedAliasCount from curatedAliasCount and totalAliasCount", async () => {
  const manUtd = entry({ canonicalName: "Manchester United", providerEventId: "evt-1" });
  const everton = entry({ canonicalName: "Everton", providerEventId: "evt-1", role: "AWAY" }); // no curated entry
  const index = createTeamAliasIndex({ teamIndex: fakeTeamIndex([manUtd, everton]) });

  const result = await index.build();
  assert.equal(result.status, "SUCCESS");
  if (result.status !== "SUCCESS") return;

  assert.equal(result.stats.canonicalGeneratedAliasCount, 2); // "manchester united", "everton"
  assert.equal(result.stats.curatedAliasCount, 4); // "man utd", "man united", "mu", "манчестер юнайтед"
  assert.equal(result.stats.totalAliasCount, 6);
  assert.equal(result.stats.entryCount, 2);
  assert.ok(result.stats.teamEntryReferenceCount >= result.stats.entryCount, "each entry is reachable via at least its own canonical alias");
  assert.ok(result.stats.builtAt !== null && !Number.isNaN(Date.parse(result.stats.builtAt)));
});

/* -------------------------------------------------------------------------- */
/* Failure propagation from Team Index (Stage 7, unchanged behavior)         */
/* -------------------------------------------------------------------------- */

test("build(): a FAILED Team Index returns a typed failure, never a silently empty alias index", async () => {
  const index = createTeamAliasIndex({
    teamIndex: fakeTeamIndex([], { status: "FAILED", reason: "ALL_LEAGUES_UNAVAILABLE" }),
  });

  const result = await index.build();
  assert.deepEqual(result, { status: "FAILED", reason: "ALL_LEAGUES_UNAVAILABLE" });
  assert.deepEqual(index.getAliases(), []);
});

test("build(): a FAILED rebuild leaves a previously-built alias index (including curated aliases) completely untouched", async () => {
  let buildResult: BuildTeamIndexResult = {
    status: "SUCCESS",
    stats: { uniqueTeamCount: 1, entryCount: 1, homeCount: 1, awayCount: 0, buildDurationMs: 0, dataSource: "EVENT_CATALOG" },
  };
  let entries: readonly TeamIndexEntry[] = [entry({ canonicalName: "Manchester United" })];
  const index = createTeamAliasIndex({
    teamIndex: { build: async () => buildResult, getAllTeams: () => entries },
  });

  const first = await index.build();
  assert.equal(first.status, "SUCCESS");
  const aliasesAfterFirst = index.getAliases();
  const statsAfterFirst = index.getStats();
  assert.ok(index.find("mu").length === 1);

  buildResult = { status: "FAILED", reason: "ALL_LEAGUES_UNAVAILABLE" };
  entries = [];
  const second = await index.build();

  assert.equal(second.status, "FAILED");
  assert.deepEqual(index.getAliases(), aliasesAfterFirst);
  assert.deepEqual(index.getStats(), statsAfterFirst);
  assert.equal(index.find("mu").length, 1, "curated bucket must survive a failed rebuild too");
});

test("build(): a legitimately empty Team Index produces a valid, empty alias index (not a failure)", async () => {
  const index = createTeamAliasIndex({ teamIndex: fakeTeamIndex([]) });
  const result = await index.build();

  assert.equal(result.status, "SUCCESS");
  if (result.status !== "SUCCESS") return;
  assert.equal(result.stats.totalAliasCount, 0);
  assert.equal(result.stats.curatedAliasCount, 0);
});

/* -------------------------------------------------------------------------- */
/* clear() / rebuild                                                         */
/* -------------------------------------------------------------------------- */

test("clear(): empties the alias index (canonical and curated alike) and resets stats", async () => {
  const index = createTeamAliasIndex({ teamIndex: fakeTeamIndex([entry({ canonicalName: "Manchester United" })]) });
  await index.build();
  assert.ok(index.getAliases().length > 0);
  assert.equal(index.find("mu").length, 1);

  index.clear();

  assert.deepEqual(index.getAliases(), []);
  assert.deepEqual(index.getStats(), {
    canonicalGeneratedAliasCount: 0,
    curatedAliasCount: 0,
    totalAliasCount: 0,
    aliasCollisionCount: 0,
    teamEntryReferenceCount: 0,
    builtAt: null,
    entryCount: 0,
    buildDurationMs: 0,
    dataSource: "TEAM_INDEX",
  });
  assert.deepEqual(index.find("mu"), []);
});

test("rebuild refreshes curated buckets when the underlying team set changes", async () => {
  let entries: readonly TeamIndexEntry[] = [entry({ canonicalName: "Manchester United" })];
  const index = createTeamAliasIndex({
    teamIndex: {
      build: async () => ({ status: "SUCCESS", stats: { uniqueTeamCount: 1, entryCount: 1, homeCount: 1, awayCount: 0, buildDurationMs: 0, dataSource: "EVENT_CATALOG" } }),
      getAllTeams: () => entries,
    },
  });

  await index.build();
  assert.equal(index.find("mu").length, 1);
  assert.equal(index.find("psg").length, 0);

  // Underlying Team Index "changes" — must not affect the index until an
  // explicit rebuild.
  entries = [entry({ canonicalName: "Paris Saint Germain" })];
  assert.equal(index.find("mu").length, 1, "stale index must still reflect old data before rebuild");

  await index.build();
  assert.equal(index.find("mu").length, 0, "Manchester United's curated bucket must be gone after rebuild");
  assert.equal(index.find("psg").length, 1, "PSG's curated bucket must now be active");
});

/* -------------------------------------------------------------------------- */
/* No HTTP, no providers/EventCatalog import, no AI                          */
/* -------------------------------------------------------------------------- */

test("no code path in build() ever reaches the real global fetch", async () => {
  const originalFetch = global.fetch;
  global.fetch = (() => {
    throw new Error("teamAliasIndex.test.ts: the real network layer must never be reached");
  }) as unknown as typeof fetch;

  try {
    const index = createTeamAliasIndex({ teamIndex: fakeTeamIndex([entry({ canonicalName: "Manchester United" })]) });
    const result = await index.build();
    assert.equal(result.status, "SUCCESS");
  } finally {
    global.fetch = originalFetch;
  }
});

test("neither teamAliasIndex.ts nor teamAliases.ts imports lib/odds/providers or lib/odds/discovery/eventCatalog", () => {
  for (const relativePath of ["teamAliasIndex.ts", "teamAliases.ts"]) {
    const source = readFileSync(join(process.cwd(), "lib", "odds", "discovery", relativePath), "utf8");
    const importLines = source.split("\n").filter((line) => /^\s*import\b/.test(line));
    const importsFromProviders = importLines.some((line) => line.includes("lib/odds/providers"));
    const importsFromEventCatalog = importLines.some((line) => /["'](\.\/)?eventCatalog["']/.test(line) || line.includes("/eventCatalog\""));

    assert.equal(importsFromProviders, false, `${relativePath} must never import a provider adapter directly`);
    assert.equal(importsFromEventCatalog, false, `${relativePath} must never import from Event Catalog directly`);
  }
});

test("no AI, LLM, embeddings, or fuzzy-matching library is IMPORTED anywhere in Stage 7/7.1 source", () => {
  // Checks only actual import statements (a real dependency), not prose —
  // both files' own header comments legitimately explain "no AI/embeddings
  // are used here" using those exact words, which a whole-file substring
  // check would misread as a violation (the same false-positive class
  // already fixed once above for "eventCatalog").
  for (const relativePath of ["teamAliasIndex.ts", "teamAliases.ts"]) {
    const source = readFileSync(join(process.cwd(), "lib", "odds", "discovery", relativePath), "utf8").toLowerCase();
    const importLines = source.split("\n").filter((line) => /^\s*import\b/.test(line));
    for (const forbidden of ["openai", "embedding", "levenshtein", "fuzzy", "llm", "anthropic", "claude", "@anthropic-ai"]) {
      assert.equal(
        importLines.some((line) => line.includes(forbidden)),
        false,
        `${relativePath} must not import anything referencing "${forbidden}"`,
      );
    }
  }
});

/* -------------------------------------------------------------------------- */
/* Curated registry itself — shape sanity (informational, not exhaustive)    */
/* -------------------------------------------------------------------------- */

test("the curated registry stays small and controlled (not hundreds of teams)", async () => {
  const { CURATED_TEAM_ALIASES } = await import("./teamAliases");
  assert.ok(CURATED_TEAM_ALIASES.length > 0);
  assert.ok(CURATED_TEAM_ALIASES.length <= 30, "registry must stay small and curated, not grow into a full team database");
});

test("the curated registry contains no forbidden bare generic single words", async () => {
  const { CURATED_TEAM_ALIASES } = await import("./teamAliases");
  const FORBIDDEN_BARE_WORDS = new Set(["united", "city", "sporting", "real", "athletic", "inter"]);
  for (const curated of CURATED_TEAM_ALIASES) {
    for (const alias of curated.aliases) {
      assert.equal(FORBIDDEN_BARE_WORDS.has(alias.trim().toLowerCase()), false, `"${alias}" is a forbidden bare generic word`);
    }
  }
});
