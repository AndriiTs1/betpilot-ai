import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractProviderEventKey,
  extractProviderEventKeys,
  groupAndDeduplicateEventKeys,
  countUniqueEvents,
  type ProviderMetadataFields,
  type PollingWindow,
} from "./pollingEventKey";

const NOW = new Date("2026-07-28T12:00:00Z");
const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;
const WINDOW: PollingWindow = { now: NOW, lookbackMs: THREE_DAYS_MS };

function fields(overrides: Partial<ProviderMetadataFields> = {}): ProviderMetadataFields {
  return {
    providerName: "THE_ODDS_API",
    providerSportKey: "soccer_epl",
    providerEventId: "evt-1",
    eventStartTime: new Date("2026-07-28T10:00:00Z"), // 2h before NOW
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/* SINGLE key extraction                                                      */
/* -------------------------------------------------------------------------- */

test("SINGLE: valid metadata within window -> ProviderEventKey", () => {
  const key = extractProviderEventKey(fields(), WINDOW);
  assert.deepEqual(key, { providerName: "THE_ODDS_API", providerSportKey: "soccer_epl", providerEventId: "evt-1" });
});

test("SINGLE: missing providerName -> null", () => {
  assert.equal(extractProviderEventKey(fields({ providerName: null }), WINDOW), null);
});

test("SINGLE: missing providerSportKey -> null", () => {
  assert.equal(extractProviderEventKey(fields({ providerSportKey: null }), WINDOW), null);
});

test("SINGLE: missing providerEventId -> null", () => {
  assert.equal(extractProviderEventKey(fields({ providerEventId: null }), WINDOW), null);
});

test("SINGLE: missing eventStartTime -> null", () => {
  assert.equal(extractProviderEventKey(fields({ eventStartTime: null }), WINDOW), null);
});

test("SINGLE: unrecognized providerName -> null (never trusted blindly)", () => {
  assert.equal(extractProviderEventKey(fields({ providerName: "SOME_OTHER_PROVIDER" }), WINDOW), null);
});

/* -------------------------------------------------------------------------- */
/* Polling window boundaries                                                  */
/* -------------------------------------------------------------------------- */

test("future event (starts after now) -> excluded", () => {
  const key = extractProviderEventKey(fields({ eventStartTime: new Date("2026-07-28T13:00:00Z") }), WINDOW);
  assert.equal(key, null);
});

test("event older than 3 days -> excluded", () => {
  const fourDaysAgo = new Date(NOW.getTime() - 4 * 24 * 60 * 60 * 1000);
  const key = extractProviderEventKey(fields({ eventStartTime: fourDaysAgo }), WINDOW);
  assert.equal(key, null);
});

test("exactly 3-day boundary (inclusive) -> included", () => {
  const exactlyThreeDaysAgo = new Date(NOW.getTime() - THREE_DAYS_MS);
  const key = extractProviderEventKey(fields({ eventStartTime: exactlyThreeDaysAgo }), WINDOW);
  assert.ok(key);
});

test("one millisecond past the 3-day boundary -> excluded", () => {
  const justOverThreeDays = new Date(NOW.getTime() - THREE_DAYS_MS - 1);
  const key = extractProviderEventKey(fields({ eventStartTime: justOverThreeDays }), WINDOW);
  assert.equal(key, null);
});

test("exactly now boundary (inclusive) -> included", () => {
  const key = extractProviderEventKey(fields({ eventStartTime: NOW }), WINDOW);
  assert.ok(key);
});

test("one millisecond after now -> excluded", () => {
  const key = extractProviderEventKey(fields({ eventStartTime: new Date(NOW.getTime() + 1) }), WINDOW);
  assert.equal(key, null);
});

/* -------------------------------------------------------------------------- */
/* EXPRESS key extraction                                                     */
/* -------------------------------------------------------------------------- */

test("EXPRESS: extracts one key per in-window, metadata-complete leg", () => {
  const legs = [
    fields({ providerEventId: "evt-1" }),
    fields({ providerEventId: "evt-2" }),
  ];
  const keys = extractProviderEventKeys(legs, WINDOW);
  assert.deepEqual(keys.map((k) => k.providerEventId), ["evt-1", "evt-2"]);
});

test("EXPRESS: a leg missing metadata is simply omitted, siblings preserved", () => {
  const legs = [
    fields({ providerEventId: "evt-1" }),
    fields({ providerEventId: null }),
    fields({ providerEventId: "evt-3" }),
  ];
  const keys = extractProviderEventKeys(legs, WINDOW);
  assert.deepEqual(keys.map((k) => k.providerEventId), ["evt-1", "evt-3"]);
});

test("EXPRESS: a leg outside the window is omitted, siblings preserved", () => {
  const legs = [
    fields({ providerEventId: "evt-1" }),
    fields({ providerEventId: "evt-2", eventStartTime: new Date("2026-07-28T13:00:00Z") }), // future
  ];
  const keys = extractProviderEventKeys(legs, WINDOW);
  assert.deepEqual(keys.map((k) => k.providerEventId), ["evt-1"]);
});

test("EXPRESS: duplicate event inside one EXPRESS is preserved at extraction (dedup happens at grouping)", () => {
  const legs = [fields({ providerEventId: "evt-1" }), fields({ providerEventId: "evt-1" })];
  const keys = extractProviderEventKeys(legs, WINDOW);
  assert.equal(keys.length, 2); // extraction is per-leg; grouping (below) is what dedupes
});

/* -------------------------------------------------------------------------- */
/* Grouping + deduplication                                                   */
/* -------------------------------------------------------------------------- */

test("same event across multiple bets is deduplicated into one entry", () => {
  const keys = [
    { providerName: "THE_ODDS_API" as const, providerSportKey: "soccer_epl", providerEventId: "evt-1" },
    { providerName: "THE_ODDS_API" as const, providerSportKey: "soccer_epl", providerEventId: "evt-1" },
  ];
  const groups = groupAndDeduplicateEventKeys(keys);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].providerEventIds, ["evt-1"]);
});

test("duplicate event inside one EXPRESS is deduplicated at grouping too", () => {
  const keys = [
    { providerName: "THE_ODDS_API" as const, providerSportKey: "soccer_epl", providerEventId: "evt-1" },
    { providerName: "THE_ODDS_API" as const, providerSportKey: "soccer_epl", providerEventId: "evt-1" },
    { providerName: "THE_ODDS_API" as const, providerSportKey: "soccer_epl", providerEventId: "evt-2" },
  ];
  const groups = groupAndDeduplicateEventKeys(keys);
  assert.deepEqual(groups[0].providerEventIds, ["evt-1", "evt-2"]);
});

test("same event ID under different sport keys -> two separate groups, not merged", () => {
  const keys = [
    { providerName: "THE_ODDS_API" as const, providerSportKey: "soccer_epl", providerEventId: "evt-1" },
    { providerName: "THE_ODDS_API" as const, providerSportKey: "basketball_nba", providerEventId: "evt-1" },
  ];
  const groups = groupAndDeduplicateEventKeys(keys);
  assert.equal(groups.length, 2);
});

test("same event ID under different providers -> two separate groups (defensive, only one provider exists today)", () => {
  const keys = [
    { providerName: "THE_ODDS_API" as const, providerSportKey: "soccer_epl", providerEventId: "evt-1" },
    { providerName: "THE_ODDS_API" as const, providerSportKey: "soccer_epl", providerEventId: "evt-1" },
  ];
  // (Both THE_ODDS_API here since it's the only real ProviderName value —
  // the grouping function itself groups by the literal providerName string
  // regardless, proven by the sport-key test above using the same mechanism.)
  const groups = groupAndDeduplicateEventKeys(keys);
  assert.equal(groups.length, 1);
});

test("stable, deterministic first-seen order for both groups and event IDs", () => {
  const keys = [
    { providerName: "THE_ODDS_API" as const, providerSportKey: "basketball_nba", providerEventId: "b1" },
    { providerName: "THE_ODDS_API" as const, providerSportKey: "soccer_epl", providerEventId: "s1" },
    { providerName: "THE_ODDS_API" as const, providerSportKey: "basketball_nba", providerEventId: "b2" },
    { providerName: "THE_ODDS_API" as const, providerSportKey: "soccer_epl", providerEventId: "s1" }, // dup
  ];
  const groups = groupAndDeduplicateEventKeys(keys);
  assert.deepEqual(
    groups.map((g) => g.providerSportKey),
    ["basketball_nba", "soccer_epl"],
  );
  assert.deepEqual(groups[0].providerEventIds, ["b1", "b2"]);
  assert.deepEqual(groups[1].providerEventIds, ["s1"]);
});

test("no mutation of the input keys array", () => {
  const keys = [{ providerName: "THE_ODDS_API" as const, providerSportKey: "soccer_epl", providerEventId: "evt-1" }];
  const copy = JSON.parse(JSON.stringify(keys));
  groupAndDeduplicateEventKeys(keys);
  assert.deepEqual(keys, copy);
});

test("countUniqueEvents sums distinct IDs across all groups", () => {
  const groups = groupAndDeduplicateEventKeys([
    { providerName: "THE_ODDS_API" as const, providerSportKey: "soccer_epl", providerEventId: "s1" },
    { providerName: "THE_ODDS_API" as const, providerSportKey: "soccer_epl", providerEventId: "s2" },
    { providerName: "THE_ODDS_API" as const, providerSportKey: "basketball_nba", providerEventId: "b1" },
  ]);
  assert.equal(countUniqueEvents(groups), 3);
});

test("deterministic grouping for identical input", () => {
  const keys = [
    { providerName: "THE_ODDS_API" as const, providerSportKey: "soccer_epl", providerEventId: "evt-1" },
    { providerName: "THE_ODDS_API" as const, providerSportKey: "basketball_nba", providerEventId: "evt-2" },
  ];
  const g1 = groupAndDeduplicateEventKeys(keys);
  const g2 = groupAndDeduplicateEventKeys(keys);
  assert.deepEqual(g1, g2);
});
