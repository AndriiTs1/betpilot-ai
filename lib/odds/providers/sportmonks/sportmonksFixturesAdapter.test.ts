import { test } from "node:test";
import assert from "node:assert/strict";
import {
  fetchSportmonksFixtures,
  fetchSportmonksFixtureById,
  toProviderEventCandidate,
  parseSportmonksUtcTimestamp,
  type SportmonksFixture,
} from "./sportmonksFixturesAdapter";

const originalEnv = { ...process.env };

test.beforeEach(() => {
  process.env.SPORTMONKS_API_TOKEN = "test-sportmonks-token";
});

test.afterEach(() => {
  process.env = { ...originalEnv };
});

const NOW_MS = Date.parse("2026-07-30T18:00:00Z");

function rawFixture(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 19743018,
    name: "Juventus vs Nice",
    league_id: 1101,
    starting_at: "2026-07-31 16:00:00",
    state_id: 1,
    participants: [
      { id: 625, name: "Juventus", meta: { location: "home" } },
      { id: 450, name: "Nice", meta: { location: "away" } },
    ],
    league: { id: 1101, name: "Club Friendlies 1" },
    stage: { name: "Regular Season" },
    ...overrides,
  };
}

function fakeFetch(status: number, body: unknown): typeof fetch {
  return (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
}

test("fetchSportmonksFixtures: MISSING_API_TOKEN when the token is unset", async () => {
  delete process.env.SPORTMONKS_API_TOKEN;
  const result = await fetchSportmonksFixtures({ fetchImpl: fakeFetch(200, { data: [] }) });
  assert.deepEqual(result, { status: "FAILED", reason: "MISSING_API_TOKEN" });
});

test("fetchSportmonksFixtures: maps a raw fixture into the SportmonksFixture shape", async () => {
  const result = await fetchSportmonksFixtures({
    now: () => NOW_MS,
    fetchImpl: fakeFetch(200, { data: [rawFixture()] }),
  });

  assert.equal(result.status, "SUCCESS");
  if (result.status !== "SUCCESS") return;
  assert.equal(result.results.length, 1);
  const fixture = result.results[0];
  assert.equal(fixture.provider, "SPORTMONKS");
  assert.equal(fixture.providerEventId, "19743018");
  assert.equal(fixture.sport, "FOOTBALL");
  assert.equal(fixture.leagueId, 1101);
  assert.equal(fixture.leagueName, "Club Friendlies 1");
  assert.equal(fixture.stageName, "Regular Season");
  assert.equal(fixture.homeTeamId, "625");
  assert.equal(fixture.homeTeamName, "Juventus");
  assert.equal(fixture.awayTeamId, "450");
  assert.equal(fixture.awayTeamName, "Nice");
  assert.equal(fixture.stateId, 1);
  assert.equal(fixture.commenceTime, new Date(parseSportmonksUtcTimestamp("2026-07-31 16:00:00")).toISOString());
});

test("fetchSportmonksFixtures: qualification stage name is preserved (2nd Qualifying Round)", async () => {
  const result = await fetchSportmonksFixtures({
    now: () => NOW_MS,
    fetchImpl: fakeFetch(200, {
      data: [rawFixture({ league_id: 5, league: { id: 5, name: "Europa League" }, stage: { name: "2nd Qualifying Round" } })],
    }),
  });
  assert.equal(result.status, "SUCCESS");
  if (result.status !== "SUCCESS") return;
  assert.equal(result.results[0].stageName, "2nd Qualifying Round");
  assert.equal(result.results[0].leagueName, "Europa League");
});

test("fetchSportmonksFixtures: a future, not-started fixture is included", async () => {
  const future = rawFixture({ starting_at: "2026-07-31 16:00:00", state_id: 1 });
  const result = await fetchSportmonksFixtures({ now: () => NOW_MS, fetchImpl: fakeFetch(200, { data: [future] }) });
  assert.equal(result.status, "SUCCESS");
  if (result.status !== "SUCCESS") return;
  assert.equal(result.results.length, 1);
});

test("fetchSportmonksFixtures: an already-started fixture (state_id=2) is excluded", async () => {
  const started = rawFixture({ id: 2, starting_at: "2026-07-30 16:00:00", state_id: 2 });
  const result = await fetchSportmonksFixtures({ now: () => NOW_MS, fetchImpl: fakeFetch(200, { data: [started] }) });
  assert.equal(result.status, "SUCCESS");
  if (result.status !== "SUCCESS") return;
  assert.equal(result.results.length, 0);
});

test("fetchSportmonksFixtures: a not-started fixture whose kickoff is already in the past is excluded", async () => {
  // state_id=1 but starting_at before `now` — defensive: never trust
  // state_id alone, commenceTime > now is enforced independently.
  const stale = rawFixture({ id: 3, starting_at: "2026-07-29 16:00:00", state_id: 1 });
  const result = await fetchSportmonksFixtures({ now: () => NOW_MS, fetchImpl: fakeFetch(200, { data: [stale] }) });
  assert.equal(result.status, "SUCCESS");
  if (result.status !== "SUCCESS") return;
  assert.equal(result.results.length, 0);
});

test("fetchSportmonksFixtures: a malformed entry (missing participants) is rejected, not thrown", async () => {
  const malformed = rawFixture({ id: 4, participants: [] });
  const result = await fetchSportmonksFixtures({ now: () => NOW_MS, fetchImpl: fakeFetch(200, { data: [malformed] }) });
  assert.equal(result.status, "SUCCESS");
  if (result.status !== "SUCCESS") return;
  assert.equal(result.results.length, 0);
  assert.equal(result.rejectedEntries, 1);
});

test("fetchSportmonksFixtures: HTTP 401/403/429 map to typed failures", async () => {
  const unauthorized = await fetchSportmonksFixtures({ fetchImpl: fakeFetch(401, {}) });
  assert.deepEqual(unauthorized, { status: "FAILED", reason: "HTTP_UNAUTHORIZED" });

  const forbidden = await fetchSportmonksFixtures({ fetchImpl: fakeFetch(403, {}) });
  assert.deepEqual(forbidden, { status: "FAILED", reason: "HTTP_FORBIDDEN" });

  const rateLimited = await fetchSportmonksFixtures({ fetchImpl: fakeFetch(429, {}) });
  assert.deepEqual(rateLimited, { status: "FAILED", reason: "HTTP_RATE_LIMITED" });
});

test("fetchSportmonksFixtures: never sends a request for an unsupported league_id", async () => {
  let called = false;
  const spyFetch = (async () => {
    called = true;
    return new Response(JSON.stringify({ data: [] }), { status: 200 });
  }) as unknown as typeof fetch;

  const result = await fetchSportmonksFixtures({ leagueIds: [999999], fetchImpl: spyFetch });
  assert.equal(result.status, "SUCCESS");
  assert.equal(called, false, "an unsupported league_id must never reach the network");
});

test("fetchSportmonksFixtures: follows pagination (has_more) to reach a fixture on page 2", async () => {
  // Live-confirmed bug (Stage 10): a single page can be entirely filled by
  // earlier-kickoff fixtures, silently hiding a later, still-in-window
  // fixture unless every page is fetched.
  let requestedPage = 0;
  const page1 = rawFixture({ id: 1, name: "Early Kickoff" });
  const page2 = rawFixture({ id: 2, name: "Later Kickoff" });

  const spyFetch = (async (url: string | URL) => {
    requestedPage += 1;
    const isPage2 = String(url).includes("page=2");
    return new Response(
      JSON.stringify({
        data: [isPage2 ? page2 : page1],
        pagination: { has_more: !isPage2, current_page: isPage2 ? 2 : 1 },
      }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;

  const result = await fetchSportmonksFixtures({ now: () => NOW_MS, fetchImpl: spyFetch });
  assert.equal(result.status, "SUCCESS");
  if (result.status !== "SUCCESS") return;
  assert.equal(requestedPage, 2, "must fetch page 2 when has_more is true");
  assert.equal(result.results.length, 2);
  assert.ok(result.results.some((f) => f.providerEventId === "2"), "fixture only present on page 2 must still be found");
});

test("fetchSportmonksFixtures: stops paging once has_more is false, never fetches an extra page", async () => {
  let requestCount = 0;
  const spyFetch = (async () => {
    requestCount += 1;
    return new Response(JSON.stringify({ data: [rawFixture()], pagination: { has_more: false } }), { status: 200 });
  }) as unknown as typeof fetch;

  await fetchSportmonksFixtures({ now: () => NOW_MS, fetchImpl: spyFetch });
  assert.equal(requestCount, 1);
});

test("fetchSportmonksFixtureById: SUCCESS maps a single fixture", async () => {
  const result = await fetchSportmonksFixtureById("19743018", { fetchImpl: fakeFetch(200, { data: rawFixture() }) });
  assert.equal(result.status, "SUCCESS");
  if (result.status !== "SUCCESS") return;
  assert.equal(result.fixture.providerEventId, "19743018");
  assert.equal(result.fixture.provider, "SPORTMONKS");
});

test("fetchSportmonksFixtureById: NOT_FOUND when data is absent", async () => {
  const result = await fetchSportmonksFixtureById("999", { fetchImpl: fakeFetch(200, {}) });
  assert.equal(result.status, "NOT_FOUND");
});

test("toProviderEventCandidate: carries provider and providerEventId through to the shared shape", () => {
  const fixture: SportmonksFixture = {
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
  };

  const candidate = toProviderEventCandidate(fixture);
  assert.equal(candidate.reference.provider, "SPORTMONKS");
  assert.equal(candidate.reference.eventId, "19743018");
  assert.equal(candidate.event.participants[0].name, "Juventus");
  assert.equal(candidate.event.participants[1].name, "Nice");
  assert.equal(candidate.event.startTime, "2026-07-31T16:00:00.000Z");
});
