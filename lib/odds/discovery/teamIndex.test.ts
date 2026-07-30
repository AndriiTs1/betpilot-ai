import { test } from "node:test";
import assert from "node:assert/strict";
import { createTeamIndex } from "./teamIndex";
import type { EventCatalog, EventCatalogResult } from "./eventCatalog";
import type { ProviderEventCandidate } from "@/lib/odds/oddsProvider";

// DI-only throughout — createTeamIndex()'s own `eventCatalog` option (a
// fake satisfying Pick<EventCatalog, "getCatalog">) is the only seam these
// tests use. No global.fetch replacement anywhere in this file; the
// dedicated test at the bottom additionally proves no code path here ever
// reaches the real network layer, and none of these tests import anything
// from lib/odds/providers/theOddsApi at all — Team Index has no way to
// reach The Odds API even indirectly.

function candidate(
  overrides: Partial<{ eventId: string; sportKey: string; league: string; home: string; away: string }> = {},
): ProviderEventCandidate {
  const { eventId = "evt-1", sportKey = "soccer_epl", league = "Premier League", home = "Arsenal", away = "Chelsea" } = overrides;

  return {
    event: {
      sport: "FOOTBALL",
      league: { name: league },
      name: `${home} vs ${away}`,
      participants: [{ name: home }, { name: away }],
      startTime: "2026-08-14T15:00:00Z",
      period: "FULL_GAME",
      homeParticipantIndex: 0,
      awayParticipantIndex: 1,
    },
    reference: { provider: "THE_ODDS_API", eventId, sportKey },
  };
}

function fakeEventCatalog(result: EventCatalogResult): Pick<EventCatalog, "getCatalog"> {
  return { getCatalog: async () => result };
}

function successResult(entries: readonly ProviderEventCandidate[]): EventCatalogResult {
  return { status: "SUCCESS", entries, failedSportKeys: [], skippedSportKeys: [], fromCache: false };
}

/* -------------------------------------------------------------------------- */
/* build()                                                                    */
/* -------------------------------------------------------------------------- */

test("build(): populates the index from Event Catalog's current entries", async () => {
  const index = createTeamIndex({ eventCatalog: fakeEventCatalog(successResult([candidate()])) });

  const result = await index.build();
  assert.equal(result.status, "SUCCESS");
  if (result.status !== "SUCCESS") return;
  assert.equal(result.stats.entryCount, 2); // one home + one away entry
  assert.equal(index.getAllTeams().length, 2);
});

test("build(): each entry carries the minimum required fields", async () => {
  const index = createTeamIndex({
    eventCatalog: fakeEventCatalog(successResult([candidate({ eventId: "evt-42", sportKey: "soccer_epl", league: "Premier League", home: "Arsenal", away: "Chelsea" })])),
  });
  await index.build();

  const [home, away] = index.getAllTeams();
  assert.deepEqual(home, {
    canonicalName: "Arsenal",
    normalizedName: "arsenal",
    providerEventId: "evt-42",
    sportKey: "soccer_epl",
    league: "Premier League",
    role: "HOME",
  });
  assert.deepEqual(away, {
    canonicalName: "Chelsea",
    normalizedName: "chelsea",
    providerEventId: "evt-42",
    sportKey: "soccer_epl",
    league: "Premier League",
    role: "AWAY",
  });
});

/* -------------------------------------------------------------------------- */
/* findExact / findNormalized                                                */
/* -------------------------------------------------------------------------- */

test("findExact(): matches only the exact, unmodified provider spelling", async () => {
  const index = createTeamIndex({ eventCatalog: fakeEventCatalog(successResult([candidate({ home: "Arsenal" })])) });
  await index.build();

  assert.equal(index.findExact("Arsenal").length, 1);
  assert.equal(index.findExact("arsenal").length, 0, "findExact must be case-sensitive, no normalization applied");
  assert.equal(index.findExact(" Arsenal ").length, 0, "findExact must not trim either");
});

test("findNormalized(): matches regardless of case/whitespace via the same normalization rules", async () => {
  const index = createTeamIndex({ eventCatalog: fakeEventCatalog(successResult([candidate({ home: "Arsenal" })])) });
  await index.build();

  assert.equal(index.findNormalized("arsenal").length, 1);
  assert.equal(index.findNormalized("  ARSENAL  ").length, 1);
  assert.equal(index.findNormalized("Arsenal").length, 1);
});

test("findNormalized(): collapses internal multiple spaces on both the query and the index", async () => {
  const index = createTeamIndex({ eventCatalog: fakeEventCatalog(successResult([candidate({ home: "Real   Madrid" })])) });
  await index.build();

  assert.equal(index.findNormalized("real madrid").length, 1);
  assert.equal(index.findNormalized("real     madrid").length, 1);
});

test("findNormalized(): never strips club-name tokens like FC/CF/AC/SSC", async () => {
  const index = createTeamIndex({ eventCatalog: fakeEventCatalog(successResult([candidate({ home: "AC Milan" })])) });
  await index.build();

  assert.equal(index.findNormalized("ac milan").length, 1);
  assert.equal(index.findNormalized("milan").length, 0, "the FC/AC/CF/SSC token must never be silently removed");
});

test("findExact()/findNormalized() return an empty array for an unknown team, never throw", async () => {
  const index = createTeamIndex({ eventCatalog: fakeEventCatalog(successResult([candidate()])) });
  await index.build();

  assert.deepEqual(index.findExact("Nonexistent FC"), []);
  assert.deepEqual(index.findNormalized("nonexistent fc"), []);
});

/* -------------------------------------------------------------------------- */
/* Duplicates / one team across multiple matches                             */
/* -------------------------------------------------------------------------- */

test("the same team name appearing in multiple matches produces multiple entries, not one merged entry", async () => {
  const index = createTeamIndex({
    eventCatalog: fakeEventCatalog(
      successResult([
        candidate({ eventId: "evt-1", home: "Arsenal", away: "Chelsea" }),
        candidate({ eventId: "evt-2", home: "Arsenal", away: "Liverpool" }),
      ]),
    ),
  });
  const result = await index.build();

  assert.equal(result.status, "SUCCESS");
  if (result.status !== "SUCCESS") return;
  const arsenalEntries = index.findExact("Arsenal");
  assert.equal(arsenalEntries.length, 2);
  assert.deepEqual(
    arsenalEntries.map((e) => e.providerEventId).sort(),
    ["evt-1", "evt-2"],
  );
  assert.equal(result.stats.uniqueTeamCount, 3); // Arsenal, Chelsea, Liverpool
  assert.equal(result.stats.entryCount, 4); // 2 matches x 2 sides
});

/* -------------------------------------------------------------------------- */
/* home/away                                                                  */
/* -------------------------------------------------------------------------- */

test("home and away roles are recorded correctly and independently searchable", async () => {
  const index = createTeamIndex({ eventCatalog: fakeEventCatalog(successResult([candidate({ home: "Arsenal", away: "Chelsea" })])) });
  await index.build();

  const [arsenal] = index.findExact("Arsenal");
  const [chelsea] = index.findExact("Chelsea");
  assert.equal(arsenal.role, "HOME");
  assert.equal(chelsea.role, "AWAY");
});

/* -------------------------------------------------------------------------- */
/* Empty catalog                                                             */
/* -------------------------------------------------------------------------- */

test("build(): a legitimately empty Event Catalog produces a valid, empty index (not a failure)", async () => {
  const index = createTeamIndex({ eventCatalog: fakeEventCatalog(successResult([])) });
  const result = await index.build();

  assert.equal(result.status, "SUCCESS");
  if (result.status !== "SUCCESS") return;
  assert.deepEqual(result.stats, {
    uniqueTeamCount: 0,
    entryCount: 0,
    homeCount: 0,
    awayCount: 0,
    buildDurationMs: result.stats.buildDurationMs,
    dataSource: "EVENT_CATALOG",
  });
  assert.deepEqual(index.getAllTeams(), []);
});

/* -------------------------------------------------------------------------- */
/* Failed Event Catalog                                                      */
/* -------------------------------------------------------------------------- */

test("build(): a FAILED Event Catalog returns a typed failure, never a silently empty index", async () => {
  const index = createTeamIndex({
    eventCatalog: fakeEventCatalog({ status: "FAILED", reason: "ALL_LEAGUES_UNAVAILABLE" }),
  });
  const result = await index.build();

  assert.deepEqual(result, { status: "FAILED", reason: "ALL_LEAGUES_UNAVAILABLE" });
  assert.deepEqual(index.getAllTeams(), [], "an index that was never successfully built must stay empty, not crash");
});

test("build(): a FAILED rebuild leaves a previously-built index completely untouched", async () => {
  let currentResult: EventCatalogResult = successResult([candidate({ home: "Arsenal", away: "Chelsea" })]);
  const index = createTeamIndex({ eventCatalog: { getCatalog: async () => currentResult } });

  const first = await index.build();
  assert.equal(first.status, "SUCCESS");
  const teamsAfterFirstBuild = index.getAllTeams();
  const statsAfterFirstBuild = index.getStats();

  currentResult = { status: "FAILED", reason: "ALL_LEAGUES_UNAVAILABLE" };
  const second = await index.build();

  assert.equal(second.status, "FAILED");
  assert.deepEqual(index.getAllTeams(), teamsAfterFirstBuild);
  assert.deepEqual(index.getStats(), statsAfterFirstBuild);
});

/* -------------------------------------------------------------------------- */
/* clear() / rebuild                                                         */
/* -------------------------------------------------------------------------- */

test("clear(): empties the index and resets stats to the initial state", async () => {
  const index = createTeamIndex({ eventCatalog: fakeEventCatalog(successResult([candidate()])) });
  await index.build();
  assert.ok(index.getAllTeams().length > 0);

  index.clear();

  assert.deepEqual(index.getAllTeams(), []);
  assert.deepEqual(index.getStats(), { uniqueTeamCount: 0, entryCount: 0, homeCount: 0, awayCount: 0, buildDurationMs: 0, dataSource: "EVENT_CATALOG" });
  assert.deepEqual(index.findExact("Arsenal"), []);
});

test("Team Index does not auto-refresh when Event Catalog's underlying data changes — only build() rebuilds it", async () => {
  let currentResult: EventCatalogResult = successResult([candidate({ home: "Arsenal", away: "Chelsea" })]);
  const index = createTeamIndex({ eventCatalog: { getCatalog: async () => currentResult } });

  await index.build();
  assert.equal(index.findExact("Arsenal").length, 1);
  assert.equal(index.findExact("Liverpool").length, 0);

  // Underlying Event Catalog "changes" — Team Index must not know this
  // happened until build() is explicitly called again.
  currentResult = successResult([candidate({ home: "Liverpool", away: "Everton" })]);
  assert.equal(index.findExact("Arsenal").length, 1, "stale index must still reflect the old data before rebuild");
  assert.equal(index.findExact("Liverpool").length, 0);

  const rebuildResult = await index.build();
  assert.equal(rebuildResult.status, "SUCCESS");
  assert.equal(index.findExact("Arsenal").length, 0, "rebuild must fully replace the previous index content");
  assert.equal(index.findExact("Liverpool").length, 1);
});

/* -------------------------------------------------------------------------- */
/* Statistics                                                                */
/* -------------------------------------------------------------------------- */

test("getStats(): reports correct counts for a multi-match, multi-league catalog", async () => {
  const index = createTeamIndex({
    eventCatalog: fakeEventCatalog(
      successResult([
        candidate({ eventId: "evt-1", sportKey: "soccer_epl", home: "Arsenal", away: "Chelsea" }),
        candidate({ eventId: "evt-2", sportKey: "soccer_spain_la_liga", home: "Real Madrid", away: "Barcelona" }),
      ]),
    ),
  });

  const result = await index.build();
  assert.equal(result.status, "SUCCESS");
  if (result.status !== "SUCCESS") return;
  assert.equal(result.stats.entryCount, 4);
  assert.equal(result.stats.uniqueTeamCount, 4);
  assert.equal(result.stats.homeCount, 2);
  assert.equal(result.stats.awayCount, 2);
  assert.equal(result.stats.dataSource, "EVENT_CATALOG");
  assert.ok(result.stats.buildDurationMs >= 0);
  assert.deepEqual(index.getStats(), result.stats);
});

test("getStats(): before any build, returns the initial all-zero state", () => {
  const index = createTeamIndex({ eventCatalog: fakeEventCatalog(successResult([candidate()])) });
  assert.deepEqual(index.getStats(), { uniqueTeamCount: 0, entryCount: 0, homeCount: 0, awayCount: 0, buildDurationMs: 0, dataSource: "EVENT_CATALOG" });
});

/* -------------------------------------------------------------------------- */
/* No real network / no reference to The Odds API                           */
/* -------------------------------------------------------------------------- */

test("no code path in build() ever reaches the real global fetch", async () => {
  const originalFetch = global.fetch;
  global.fetch = (() => {
    throw new Error("teamIndex.test.ts: the real network layer must never be reached");
  }) as unknown as typeof fetch;

  try {
    const index = createTeamIndex({ eventCatalog: fakeEventCatalog(successResult([candidate()])) });
    const result = await index.build();
    assert.equal(result.status, "SUCCESS");
  } finally {
    global.fetch = originalFetch;
  }
});
