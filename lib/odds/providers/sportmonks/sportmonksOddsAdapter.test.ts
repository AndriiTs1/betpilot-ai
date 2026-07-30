import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchSportmonksPreMatchOdds } from "./sportmonksOddsAdapter";

const originalEnv = { ...process.env };

test.beforeEach(() => {
  process.env.SPORTMONKS_API_TOKEN = "test-sportmonks-token";
});

test.afterEach(() => {
  process.env = { ...originalEnv };
});

function oddsEntry(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    market_id: 1,
    market_description: "Fulltime Result",
    bookmaker_id: 13,
    bookmaker: { name: "Coral" },
    label: "Home",
    value: "1.55",
    latest_bookmaker_update: "2026-07-30 16:47:15",
    updated_at: "2026-07-30 16:47:15",
    ...overrides,
  };
}

function fakeFetch(status: number, body: unknown): typeof fetch {
  return (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
}

function fullSet(bookmakerId: number, ts: string, values: { home: string; draw: string; away: string }) {
  return [
    oddsEntry({ bookmaker_id: bookmakerId, label: "Home", value: values.home, latest_bookmaker_update: ts, updated_at: ts }),
    oddsEntry({ bookmaker_id: bookmakerId, label: "Draw", value: values.draw, latest_bookmaker_update: ts, updated_at: ts }),
    oddsEntry({ bookmaker_id: bookmakerId, label: "Away", value: values.away, latest_bookmaker_update: ts, updated_at: ts }),
  ];
}

test("fetchSportmonksPreMatchOdds: full Home/Draw/Away from one bookmaker", async () => {
  const data = fullSet(13, "2026-07-30 16:47:15", { home: "1.55", draw: "3.75", away: "5.00" });
  const result = await fetchSportmonksPreMatchOdds("19743018", { fetchImpl: fakeFetch(200, { data }) });

  assert.equal(result.status, "SUCCESS");
  if (result.status !== "SUCCESS") return;
  assert.equal(result.snapshot.provider, "SPORTMONKS");
  assert.equal(result.snapshot.providerEventId, "19743018");
  assert.equal(result.snapshot.bookmakerId, "13");
  assert.equal(result.snapshot.bookmakerName, "Coral");
  assert.equal(result.snapshot.marketId, 1);
  assert.equal(result.snapshot.marketName, "Fulltime Result");
  assert.equal(result.snapshot.homeOdds, "1.55");
  assert.equal(result.snapshot.drawOdds, "3.75");
  assert.equal(result.snapshot.awayOdds, "5.00");
  assert.equal(result.snapshot.updatedAt, "2026-07-30 16:47:15");
});

test("fetchSportmonksPreMatchOdds: freshest complete bookmaker is chosen over an older one", async () => {
  const older = fullSet(20, "2026-07-30 10:00:00", { home: "1.60", draw: "3.60", away: "4.80" });
  const newer = fullSet(13, "2026-07-30 16:47:15", { home: "1.55", draw: "3.75", away: "5.00" });
  const result = await fetchSportmonksPreMatchOdds("19743018", { fetchImpl: fakeFetch(200, { data: [...older, ...newer] }) });

  assert.equal(result.status, "SUCCESS");
  if (result.status !== "SUCCESS") return;
  assert.equal(result.snapshot.bookmakerId, "13");
  assert.equal(result.snapshot.homeOdds, "1.55");
});

test("fetchSportmonksPreMatchOdds: equal timestamps tie-break on the lowest bookmaker_id", async () => {
  const ts = "2026-07-30 16:47:15";
  const bookmakerA = fullSet(20, ts, { home: "1.60", draw: "3.60", away: "4.80" });
  const bookmakerB = fullSet(5, ts, { home: "1.50", draw: "3.80", away: "5.20" });
  const result = await fetchSportmonksPreMatchOdds("19743018", { fetchImpl: fakeFetch(200, { data: [...bookmakerA, ...bookmakerB] }) });

  assert.equal(result.status, "SUCCESS");
  if (result.status !== "SUCCESS") return;
  assert.equal(result.snapshot.bookmakerId, "5");
});

test("fetchSportmonksPreMatchOdds: never mixes Home/Draw/Away from different bookmakers", async () => {
  // Bookmaker 20 has only Home+Draw; bookmaker 13 has all three. The
  // returned snapshot must come entirely from bookmaker 13, never a
  // Home from 20 combined with a Draw/Away from 13.
  const incomplete20 = [
    oddsEntry({ bookmaker_id: 20, label: "Home", value: "1.10" }),
    oddsEntry({ bookmaker_id: 20, label: "Draw", value: "9.00" }),
  ];
  const complete13 = fullSet(13, "2026-07-30 16:47:15", { home: "1.55", draw: "3.75", away: "5.00" });
  const result = await fetchSportmonksPreMatchOdds("19743018", { fetchImpl: fakeFetch(200, { data: [...incomplete20, ...complete13] }) });

  assert.equal(result.status, "SUCCESS");
  if (result.status !== "SUCCESS") return;
  assert.equal(result.snapshot.bookmakerId, "13");
  assert.equal(result.snapshot.homeOdds, "1.55");
  assert.notEqual(result.snapshot.homeOdds, "1.10");
});

test("fetchSportmonksPreMatchOdds: empty data array -> EMPTY", async () => {
  const result = await fetchSportmonksPreMatchOdds("19743018", { fetchImpl: fakeFetch(200, { data: [] }) });
  assert.deepEqual(result, { status: "EMPTY" });
});

test("fetchSportmonksPreMatchOdds: incomplete 1X2 (missing Away for every bookmaker) -> EMPTY", async () => {
  const data = [
    oddsEntry({ bookmaker_id: 13, label: "Home", value: "1.55" }),
    oddsEntry({ bookmaker_id: 13, label: "Draw", value: "3.75" }),
  ];
  const result = await fetchSportmonksPreMatchOdds("19743018", { fetchImpl: fakeFetch(200, { data }) });
  assert.deepEqual(result, { status: "EMPTY" });
});

test("fetchSportmonksPreMatchOdds: invalid/non-decimal odds value is rejected (not treated as a valid bookmaker)", async () => {
  const badBookmaker = [
    oddsEntry({ bookmaker_id: 13, label: "Home", value: "not-a-number" }),
    oddsEntry({ bookmaker_id: 13, label: "Draw", value: "3.75" }),
    oddsEntry({ bookmaker_id: 13, label: "Away", value: "5.00" }),
  ];
  const result = await fetchSportmonksPreMatchOdds("19743018", { fetchImpl: fakeFetch(200, { data: badBookmaker }) });
  assert.deepEqual(result, { status: "EMPTY" });
});

test("fetchSportmonksPreMatchOdds: zero or negative odds are rejected", async () => {
  const zeroOdds = fullSet(13, "2026-07-30 16:47:15", { home: "0", draw: "3.75", away: "5.00" });
  const result = await fetchSportmonksPreMatchOdds("19743018", { fetchImpl: fakeFetch(200, { data: zeroOdds }) });
  assert.deepEqual(result, { status: "EMPTY" });
});

test("fetchSportmonksPreMatchOdds: only market_id=1 entries are considered (other markets ignored)", async () => {
  const otherMarket = [
    oddsEntry({ market_id: 80, bookmaker_id: 99, label: "Over", value: "1.90" }),
    oddsEntry({ market_id: 80, bookmaker_id: 99, label: "Under", value: "1.90" }),
  ];
  const result = await fetchSportmonksPreMatchOdds("19743018", { fetchImpl: fakeFetch(200, { data: otherMarket }) });
  assert.deepEqual(result, { status: "EMPTY" });
});

test("fetchSportmonksPreMatchOdds: MISSING_API_TOKEN when unset", async () => {
  delete process.env.SPORTMONKS_API_TOKEN;
  const result = await fetchSportmonksPreMatchOdds("19743018", { fetchImpl: fakeFetch(200, { data: [] }) });
  assert.deepEqual(result, { status: "FAILED", reason: "MISSING_API_TOKEN" });
});

test("fetchSportmonksPreMatchOdds: HTTP 403 maps to a typed failure (plan restriction)", async () => {
  const result = await fetchSportmonksPreMatchOdds("19743018", { fetchImpl: fakeFetch(403, { message: "forbidden" }) });
  assert.deepEqual(result, { status: "FAILED", reason: "HTTP_FORBIDDEN" });
});
