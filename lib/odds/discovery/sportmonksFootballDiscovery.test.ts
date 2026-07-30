import { test } from "node:test";
import assert from "node:assert/strict";
import { createSportmonksFootballCandidateResolver, createSportmonksEventSource } from "./sportmonksFootballDiscovery";
import { toProviderEventCandidate, type SportmonksFixture } from "@/lib/odds/providers/sportmonks/sportmonksFixturesAdapter";
import type { EventCatalogResult } from "./eventCatalog";

// DI-only — every test injects a fake eventSource (Pick<SportmonksEventSource,
// "getCatalog">), never the real fetchSportmonksFixtures/network. Proves
// this is a fresh instance of the EXISTING Team Index/Team Alias
// Index/Candidate Resolver factories, not a new resolver implementation.

function fixture(overrides: Partial<SportmonksFixture> = {}): SportmonksFixture {
  return {
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
  };
}

function fakeEventSource(fixtures: SportmonksFixture[]): { getCatalog: () => Promise<EventCatalogResult> } {
  return {
    getCatalog: async () => ({
      status: "SUCCESS",
      entries: fixtures.map(toProviderEventCandidate),
      failedSportKeys: [],
      skippedSportKeys: [],
      fromCache: false,
    }),
  };
}

test("createSportmonksFootballCandidateResolver: 'Juventus' resolves to Juventus vs Nice", async () => {
  const resolver = createSportmonksFootballCandidateResolver({ eventSource: fakeEventSource([fixture()]) });
  const build = await resolver.buildDependencies();
  assert.equal(build.status, "SUCCESS");

  const result = resolver.resolve("Juventus");
  assert.equal(result.kind, "TEAM_RESOLVED");
  if (result.kind !== "TEAM_RESOLVED") return;
  assert.equal(result.candidate.homeTeam, "Juventus");
  assert.equal(result.candidate.awayTeam, "Nice");
  assert.equal(result.candidate.provider, "SPORTMONKS");
  assert.equal(result.candidate.providerEventId, "19743018");
});

test("createSportmonksFootballCandidateResolver: 'Nice' resolves to the same fixture", async () => {
  const resolver = createSportmonksFootballCandidateResolver({ eventSource: fakeEventSource([fixture()]) });
  await resolver.buildDependencies();

  const result = resolver.resolve("Nice");
  assert.equal(result.kind, "TEAM_RESOLVED");
  if (result.kind !== "TEAM_RESOLVED") return;
  assert.equal(result.candidate.providerEventId, "19743018");
  assert.equal(result.candidate.provider, "SPORTMONKS");
});

test("createSportmonksFootballCandidateResolver: candidate identity is provider-aware, not just providerEventId", async () => {
  const resolver = createSportmonksFootballCandidateResolver({ eventSource: fakeEventSource([fixture()]) });
  await resolver.buildDependencies();

  const result = resolver.resolve("Juventus");
  assert.equal(result.kind, "TEAM_RESOLVED");
  if (result.kind !== "TEAM_RESOLVED") return;
  assert.equal(result.candidate.provider, "SPORTMONKS");
  assert.ok("provider" in result.candidate, "ResolvedEventCandidate must carry a provider field");
});

test("createSportmonksFootballCandidateResolver: an ambiguous query is surfaced as AMBIGUOUS, never guessed", async () => {
  const fixtures = [
    fixture({ providerEventId: "1", homeTeamName: "Real", awayTeamName: "Team A" }),
    fixture({ providerEventId: "2", homeTeamName: "Real", awayTeamName: "Team B" }),
  ];
  const resolver = createSportmonksFootballCandidateResolver({ eventSource: fakeEventSource(fixtures) });
  await resolver.buildDependencies();

  const result = resolver.resolve("Real");
  assert.equal(result.kind, "AMBIGUOUS");
});

test("createSportmonksEventSource: caches within TTL, does not re-fetch", async () => {
  let callCount = 0;
  const source = createSportmonksEventSource({
    now: () => 1000,
    fetchFixtures: async () => {
      callCount += 1;
      return { status: "SUCCESS", results: [fixture()], rejectedEntries: 0 };
    },
  });

  await source.getCatalog();
  await source.getCatalog();
  assert.equal(callCount, 1, "second call within TTL must not re-fetch");
});

test("createSportmonksEventSource: FAILED upstream fetch is surfaced, not silently emptied", async () => {
  const source = createSportmonksEventSource({
    fetchFixtures: async () => ({ status: "FAILED", reason: "HTTP_FORBIDDEN" }),
  });
  const result = await source.getCatalog();
  assert.deepEqual(result, { status: "FAILED", reason: "ALL_LEAGUES_UNAVAILABLE" });
});
