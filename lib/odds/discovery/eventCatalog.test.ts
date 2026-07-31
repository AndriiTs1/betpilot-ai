import { test } from "node:test";
import assert from "node:assert/strict";
import { createEventCatalog } from "./eventCatalog";
import { getSupportedSportKeys } from "./supportedCompetitions";
import type { LeagueCatalog, ValidateAllowlistResult } from "./leagueCatalog";
import type { EventsFetchResult } from "@/lib/odds/providers/theOddsApi/eventsAdapter";
import type { ProviderEventCandidate } from "@/lib/odds/oddsProvider";

// DI-only throughout — createEventCatalog()'s own `fetchEvents`/`leagueCatalog`
// options are the only seams these tests use. No global.fetch replacement
// anywhere in this file; the dedicated test at the bottom additionally
// proves that no code path here ever reaches the real network layer at all.

function candidate(
  overrides: Partial<{ eventId: string; sportKey: string; home: string; away: string; commenceTime: string }> = {},
): ProviderEventCandidate {
  const {
    eventId = "evt-1",
    sportKey = "soccer_epl",
    home = "Arsenal",
    away = "Chelsea",
    commenceTime = "2026-08-14T15:00:00Z",
  } = overrides;

  return {
    event: {
      sport: "FOOTBALL",
      league: { name: "Premier League" },
      name: `${home} vs ${away}`,
      participants: [{ name: home }, { name: away }],
      startTime: commenceTime,
      period: "FULL_GAME",
      homeParticipantIndex: 0,
      awayParticipantIndex: 1,
    },
    reference: { provider: "THE_ODDS_API", eventId, sportKey },
  };
}

function allowlistOk(): ValidateAllowlistResult {
  return { status: "SUCCESS", missingSportKeys: [], checkedAt: new Date().toISOString() };
}

function fakeLeagueCatalog(result: ValidateAllowlistResult): LeagueCatalog {
  return {
    getCatalog: async () => {
      throw new Error("eventCatalog.test.ts: getCatalog() is not exercised by these tests");
    },
    validateAllowlist: async () => result,
  };
}

// One successful, one-event result per supported sport_key by default —
// individual tests override specific keys to exercise failure/empty/
// duplicate scenarios.
function defaultSuccessMap(): Record<string, EventsFetchResult> {
  const map: Record<string, EventsFetchResult> = {};
  for (const key of getSupportedSportKeys()) {
    map[key] = { status: "SUCCESS", results: [candidate({ eventId: `evt-${key}`, sportKey: key })], rejectedEntries: 0 };
  }
  return map;
}

function fakeFetchEvents(resultsBySportKey: Record<string, EventsFetchResult>, callLog: string[] = []) {
  return async (input: { sportKey: string }): Promise<EventsFetchResult> => {
    callLog.push(input.sportKey);
    return resultsBySportKey[input.sportKey] ?? { status: "FAILED", reason: "HTTP_ERROR" };
  };
}

/* -------------------------------------------------------------------------- */
/* Successful load, multiple leagues                                        */
/* -------------------------------------------------------------------------- */

test("getCatalog(): successfully loads and combines events from every supported league", async () => {
  const catalog = createEventCatalog({
    fetchEvents: fakeFetchEvents(defaultSuccessMap()),
    leagueCatalog: fakeLeagueCatalog(allowlistOk()),
  });

  const result = await catalog.getCatalog();
  assert.equal(result.status, "SUCCESS");
  if (result.status !== "SUCCESS") return;
  assert.equal(result.entries.length, getSupportedSportKeys().length);
  assert.deepEqual(result.failedSportKeys, []);
  assert.deepEqual(result.skippedSportKeys, []);
  assert.equal(result.fromCache, false);
});

/* -------------------------------------------------------------------------- */
/* Partial failure                                                          */
/* -------------------------------------------------------------------------- */

test("getCatalog(): one failed league does not fail the whole catalog", async () => {
  const failingKey = getSupportedSportKeys()[0];
  const resultsMap = { ...defaultSuccessMap(), [failingKey]: { status: "FAILED", reason: "HTTP_ERROR" } as const };

  const catalog = createEventCatalog({
    fetchEvents: fakeFetchEvents(resultsMap),
    leagueCatalog: fakeLeagueCatalog(allowlistOk()),
  });

  const result = await catalog.getCatalog();
  assert.equal(result.status, "SUCCESS");
  if (result.status !== "SUCCESS") return;
  assert.equal(result.entries.length, getSupportedSportKeys().length - 1);
  assert.deepEqual(result.failedSportKeys, [failingKey]);
});

/* -------------------------------------------------------------------------- */
/* Total failure                                                            */
/* -------------------------------------------------------------------------- */

test("getCatalog(): every league failing returns a typed FAILED result", async () => {
  const allFailed: Record<string, EventsFetchResult> = {};
  for (const key of getSupportedSportKeys()) allFailed[key] = { status: "FAILED", reason: "TIMEOUT" };

  const catalog = createEventCatalog({
    fetchEvents: fakeFetchEvents(allFailed),
    leagueCatalog: fakeLeagueCatalog(allowlistOk()),
  });

  const result = await catalog.getCatalog();
  assert.deepEqual(result, { status: "FAILED", reason: "ALL_LEAGUES_UNAVAILABLE" });
});

/* -------------------------------------------------------------------------- */
/* Empty league                                                             */
/* -------------------------------------------------------------------------- */

test("getCatalog(): a league that succeeds with zero events counts as successful, not failed", async () => {
  const [emptyKey] = getSupportedSportKeys();
  const resultsMap = { ...defaultSuccessMap(), [emptyKey]: { status: "SUCCESS", results: [], rejectedEntries: 0 } as const };

  const catalog = createEventCatalog({
    fetchEvents: fakeFetchEvents(resultsMap),
    leagueCatalog: fakeLeagueCatalog(allowlistOk()),
  });

  const result = await catalog.getCatalog();
  assert.equal(result.status, "SUCCESS");
  if (result.status !== "SUCCESS") return;
  assert.deepEqual(result.failedSportKeys, []);
  assert.equal(result.entries.length, getSupportedSportKeys().length - 1); // every other key still contributes one
  assert.equal(catalog.getStats().competitionCount, getSupportedSportKeys().length);
});

/* -------------------------------------------------------------------------- */
/* Cache / forceRefresh / TTL / clearCache                                  */
/* -------------------------------------------------------------------------- */

test("getCatalog(): a second call within the TTL window is served from cache", async () => {
  const callLog: string[] = [];
  let clock = 1_000_000;
  const catalog = createEventCatalog({
    fetchEvents: fakeFetchEvents(defaultSuccessMap(), callLog),
    leagueCatalog: fakeLeagueCatalog(allowlistOk()),
    now: () => clock,
    ttlMs: 60_000,
  });

  await catalog.getCatalog();
  const firstCallCount = callLog.length;
  clock += 30_000;
  const second = await catalog.getCatalog();

  assert.equal(callLog.length, firstCallCount, "fetchEvents must not have been called again");
  assert.equal(second.status, "SUCCESS");
  if (second.status !== "SUCCESS") return;
  assert.equal(second.fromCache, true);
});

test("getCatalog({forceRefresh: true}): bypasses a still-fresh cache", async () => {
  const callLog: string[] = [];
  const catalog = createEventCatalog({
    fetchEvents: fakeFetchEvents(defaultSuccessMap(), callLog),
    leagueCatalog: fakeLeagueCatalog(allowlistOk()),
    ttlMs: 60_000,
  });

  await catalog.getCatalog();
  const firstCallCount = callLog.length;
  await catalog.getCatalog({ forceRefresh: true });

  assert.equal(callLog.length, firstCallCount * 2);
});

test("getCatalog(): once the TTL has elapsed, the next call reloads fresh", async () => {
  const callLog: string[] = [];
  let clock = 1_000_000;
  const catalog = createEventCatalog({
    fetchEvents: fakeFetchEvents(defaultSuccessMap(), callLog),
    leagueCatalog: fakeLeagueCatalog(allowlistOk()),
    now: () => clock,
    ttlMs: 60_000,
  });

  await catalog.getCatalog();
  const firstCallCount = callLog.length;
  clock += 60_001;
  const second = await catalog.getCatalog();

  assert.equal(callLog.length, firstCallCount * 2);
  assert.equal(second.status, "SUCCESS");
  if (second.status !== "SUCCESS") return;
  assert.equal(second.fromCache, false);
});

test("clearCache(): removes the cached catalog and resets stats to the initial empty state", async () => {
  const callLog: string[] = [];
  const catalog = createEventCatalog({
    fetchEvents: fakeFetchEvents(defaultSuccessMap(), callLog),
    leagueCatalog: fakeLeagueCatalog(allowlistOk()),
    ttlMs: 60_000,
  });

  await catalog.getCatalog();
  assert.ok(catalog.getStats().eventCount > 0);

  catalog.clearCache();
  assert.deepEqual(catalog.getStats(), { competitionCount: 0, eventCount: 0, lastUpdatedAt: null, failedLoadCount: 0 });

  const callCountBeforeReload = callLog.length;
  const afterClear = await catalog.getCatalog();
  assert.equal(afterClear.status, "SUCCESS");
  if (afterClear.status !== "SUCCESS") return;
  assert.equal(afterClear.fromCache, false, "a call right after clearCache() must reload, not reuse a cleared cache");
  assert.ok(callLog.length > callCountBeforeReload);
});

/* -------------------------------------------------------------------------- */
/* De-duplication                                                           */
/* -------------------------------------------------------------------------- */

test("getCatalog(): no duplicate providerEventId in the combined result, even across leagues", async () => {
  const [keyA, keyB] = getSupportedSportKeys();
  const resultsMap: Record<string, EventsFetchResult> = {
    ...defaultSuccessMap(),
    [keyA]: { status: "SUCCESS", results: [candidate({ eventId: "shared-id", sportKey: keyA })], rejectedEntries: 0 },
    [keyB]: { status: "SUCCESS", results: [candidate({ eventId: "shared-id", sportKey: keyB })], rejectedEntries: 0 },
  };

  const catalog = createEventCatalog({
    fetchEvents: fakeFetchEvents(resultsMap),
    leagueCatalog: fakeLeagueCatalog(allowlistOk()),
  });

  const result = await catalog.getCatalog();
  assert.equal(result.status, "SUCCESS");
  if (result.status !== "SUCCESS") return;
  const ids = result.entries.map((e) => e.reference.eventId);
  assert.equal(new Set(ids).size, ids.length, "every providerEventId must be unique");
  assert.equal(ids.filter((id) => id === "shared-id").length, 1, "the duplicate must be collapsed to exactly one entry");
});

/* -------------------------------------------------------------------------- */
/* Aggregation correctness                                                  */
/* -------------------------------------------------------------------------- */

test("getCatalog(): entries from every successful league are present in the aggregated result", async () => {
  const catalog = createEventCatalog({
    fetchEvents: fakeFetchEvents(defaultSuccessMap()),
    leagueCatalog: fakeLeagueCatalog(allowlistOk()),
  });

  const result = await catalog.getCatalog();
  assert.equal(result.status, "SUCCESS");
  if (result.status !== "SUCCESS") return;
  const ids = new Set(result.entries.map((e) => e.reference.eventId));
  for (const key of getSupportedSportKeys()) {
    assert.ok(ids.has(`evt-${key}`), `missing event for ${key}`);
  }
});

/* -------------------------------------------------------------------------- */
/* League Catalog integration — skipped keys, fail-open on outage           */
/* -------------------------------------------------------------------------- */

test("getCatalog(): a sport_key League Catalog reports missing is skipped, never sent to eventsAdapter", async () => {
  const [missingKey] = getSupportedSportKeys();
  const callLog: string[] = [];
  const catalog = createEventCatalog({
    fetchEvents: fakeFetchEvents(defaultSuccessMap(), callLog),
    leagueCatalog: fakeLeagueCatalog({ status: "SUCCESS", missingSportKeys: [missingKey], checkedAt: new Date().toISOString() }),
  });

  const result = await catalog.getCatalog();
  assert.equal(result.status, "SUCCESS");
  if (result.status !== "SUCCESS") return;
  assert.deepEqual(result.skippedSportKeys, [missingKey]);
  assert.equal(callLog.includes(missingKey), false, "eventsAdapter must never be called for a skipped sport_key");
});

test("getCatalog(): a League Catalog outage fails open — every supported key is still attempted directly", async () => {
  const callLog: string[] = [];
  const catalog = createEventCatalog({
    fetchEvents: fakeFetchEvents(defaultSuccessMap(), callLog),
    leagueCatalog: fakeLeagueCatalog({ status: "FAILED", reason: "TIMEOUT" }),
  });

  const result = await catalog.getCatalog();
  assert.equal(result.status, "SUCCESS");
  if (result.status !== "SUCCESS") return;
  assert.equal(result.entries.length, getSupportedSportKeys().length);
  for (const key of getSupportedSportKeys()) {
    assert.ok(callLog.includes(key));
  }
});

/* -------------------------------------------------------------------------- */
/* Stats                                                                    */
/* -------------------------------------------------------------------------- */

test("getStats(): reflects competitionCount/eventCount/failedLoadCount/lastUpdatedAt correctly after a partial-failure load", async () => {
  const failingKey = getSupportedSportKeys()[0];
  const resultsMap = { ...defaultSuccessMap(), [failingKey]: { status: "FAILED", reason: "HTTP_ERROR" } as const };
  const clock = 5_000_000;

  const catalog = createEventCatalog({
    fetchEvents: fakeFetchEvents(resultsMap),
    leagueCatalog: fakeLeagueCatalog(allowlistOk()),
    now: () => clock,
  });

  await catalog.getCatalog();
  const stats = catalog.getStats();

  assert.equal(stats.competitionCount, getSupportedSportKeys().length - 1);
  assert.equal(stats.eventCount, getSupportedSportKeys().length - 1);
  assert.equal(stats.failedLoadCount, 1);
  assert.equal(stats.lastUpdatedAt, new Date(clock).toISOString());
});

test("getStats(): before any load, returns the initial all-zero/null state", () => {
  const catalog = createEventCatalog({
    fetchEvents: fakeFetchEvents(defaultSuccessMap()),
    leagueCatalog: fakeLeagueCatalog(allowlistOk()),
  });

  assert.deepEqual(catalog.getStats(), { competitionCount: 0, eventCount: 0, lastUpdatedAt: null, failedLoadCount: 0 });
});

test("getStats(): a total failure does not overwrite the last known successful stats", async () => {
  const callLog: string[] = [];
  let currentMap = defaultSuccessMap();
  const catalog = createEventCatalog({
    fetchEvents: async (input: { sportKey: string }) => {
      callLog.push(input.sportKey);
      return currentMap[input.sportKey] ?? { status: "FAILED", reason: "HTTP_ERROR" };
    },
    leagueCatalog: fakeLeagueCatalog(allowlistOk()),
    ttlMs: 1, // effectively no cache reuse between the two calls below
  });

  await catalog.getCatalog();
  const statsAfterSuccess = catalog.getStats();
  assert.ok(statsAfterSuccess.eventCount > 0);

  const allFailed: Record<string, EventsFetchResult> = {};
  for (const key of getSupportedSportKeys()) allFailed[key] = { status: "FAILED", reason: "TIMEOUT" };
  currentMap = allFailed;

  const secondResult = await catalog.getCatalog({ forceRefresh: true });
  assert.equal(secondResult.status, "FAILED");
  assert.deepEqual(catalog.getStats(), statsAfterSuccess, "stats must remain the last successful snapshot after a total failure");
});

/* -------------------------------------------------------------------------- */
/* No real network calls                                                    */
/* -------------------------------------------------------------------------- */

test("no code path in getCatalog() ever reaches the real global fetch", async () => {
  const originalFetch = global.fetch;
  global.fetch = (() => {
    throw new Error("eventCatalog.test.ts: the real network layer must never be reached");
  }) as unknown as typeof fetch;

  try {
    const catalog = createEventCatalog({
      fetchEvents: fakeFetchEvents(defaultSuccessMap()),
      leagueCatalog: fakeLeagueCatalog(allowlistOk()),
    });
    const result = await catalog.getCatalog();
    assert.equal(result.status, "SUCCESS");
  } finally {
    global.fetch = originalFetch;
  }
});
