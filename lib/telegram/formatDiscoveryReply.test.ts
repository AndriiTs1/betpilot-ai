import { test } from "node:test";
import assert from "node:assert/strict";

import { formatDiscoveryReply } from "./formatDiscoveryReply";
import type { ResolveQueryResult, ResolvedEventCandidate } from "@/lib/odds/discovery/candidateResolver";

function makeCandidate(overrides: Partial<ResolvedEventCandidate> = {}): ResolvedEventCandidate {
  return {
    providerEventId: "secret-provider-event-id-12345",
    sportKey: "soccer_epl",
    league: "English Premier League",
    commenceTime: null,
    homeTeam: "Arsenal",
    awayTeam: "Coventry City",
    matchedTeamNames: ["Arsenal"],
    matchMethod: "EXACT",
    score: 1,
    diagnostics: ["internal diagnostic detail that must never reach the player"],
    ...overrides,
  };
}

test("formatDiscoveryReply: TEAM_RESOLVED shows home/away and league, no time", () => {
  const result: ResolveQueryResult = { kind: "TEAM_RESOLVED", candidate: makeCandidate() };
  const text = formatDiscoveryReply(result);

  assert.match(text, /Найден матч/);
  assert.match(text, /Arsenal/);
  assert.match(text, /Coventry City/);
  assert.match(text, /English Premier League/);
});

test("formatDiscoveryReply: MATCH_RESOLVED shows home/away and league", () => {
  const result: ResolveQueryResult = {
    kind: "MATCH_RESOLVED",
    candidate: makeCandidate({ homeTeam: "Real Madrid", awayTeam: "Barcelona", league: "La Liga" }),
  };
  const text = formatDiscoveryReply(result);

  assert.match(text, /Real Madrid/);
  assert.match(text, /Barcelona/);
  assert.match(text, /La Liga/);
});

test("formatDiscoveryReply: TEAM_RESOLVED never leaks providerEventId, matchMethod, score, or diagnostics", () => {
  const result: ResolveQueryResult = { kind: "TEAM_RESOLVED", candidate: makeCandidate() };
  const text = formatDiscoveryReply(result);

  assert.doesNotMatch(text, /secret-provider-event-id/);
  assert.doesNotMatch(text, /EXACT|NORMALIZED|CURATED_ALIAS|FUZZY/);
  assert.doesNotMatch(text, /internal diagnostic detail/);
});

test("formatDiscoveryReply: AMBIGUOUS lists every candidate and does not pick the first automatically", () => {
  const candidates = [
    makeCandidate({ providerEventId: "e1", homeTeam: "Inter", awayTeam: "Milan", league: "Serie A" }),
    makeCandidate({ providerEventId: "e2", homeTeam: "Inter Miami", awayTeam: "LA Galaxy", league: "MLS" }),
  ];
  const result: ResolveQueryResult = { kind: "AMBIGUOUS", candidates, reason: "internal reason text" };
  const text = formatDiscoveryReply(result);

  assert.match(text, /Найдено несколько матчей/);
  assert.match(text, /1\..*Inter.*Milan/);
  assert.match(text, /2\..*Inter Miami.*LA Galaxy/);
  assert.match(text, /Уточните запрос/);
  // Must not silently resolve to a single match the way TEAM_RESOLVED/MATCH_RESOLVED does.
  assert.doesNotMatch(text, /^Найден матч/);
});

test("formatDiscoveryReply: AMBIGUOUS caps the displayed list at 5 candidates", () => {
  const candidates = Array.from({ length: 8 }, (_, i) =>
    makeCandidate({ providerEventId: `e${i}`, homeTeam: `Team${i}`, awayTeam: `Opponent${i}` }),
  );
  const result: ResolveQueryResult = { kind: "AMBIGUOUS", candidates, reason: "8 matches" };
  const text = formatDiscoveryReply(result);

  assert.match(text, /Team0/);
  assert.match(text, /Team4/);
  assert.doesNotMatch(text, /Team5/);
  assert.doesNotMatch(text, /Team7/);
});

test("formatDiscoveryReply: AMBIGUOUS never leaks the internal reason string", () => {
  const candidates = [makeCandidate({ providerEventId: "e1" }), makeCandidate({ providerEventId: "e2" })];
  const result: ResolveQueryResult = {
    kind: "AMBIGUOUS",
    candidates,
    reason: "SECRET_INTERNAL_REASON_TOKEN",
  };
  const text = formatDiscoveryReply(result);

  assert.doesNotMatch(text, /SECRET_INTERNAL_REASON_TOKEN/);
});

test("formatDiscoveryReply: NOT_FOUND is a generic message with no internal reason", () => {
  const result: ResolveQueryResult = { kind: "NOT_FOUND", reason: "SECRET_INTERNAL_REASON_TOKEN" };
  const text = formatDiscoveryReply(result);

  assert.match(text, /не найдены/);
  assert.doesNotMatch(text, /SECRET_INTERNAL_REASON_TOKEN/);
});

test("formatDiscoveryReply: INVALID_QUERY shows usage instructions, no internal reason", () => {
  const result: ResolveQueryResult = { kind: "INVALID_QUERY", reason: "SECRET_INTERNAL_REASON_TOKEN" };
  const text = formatDiscoveryReply(result);

  assert.match(text, /Использование/);
  assert.match(text, /\/find/);
  assert.doesNotMatch(text, /SECRET_INTERNAL_REASON_TOKEN/);
});

test("formatDiscoveryReply: FAILED is a generic message with no source or reason", () => {
  const result: ResolveQueryResult = { kind: "FAILED", source: "TEAM_INDEX", reason: "SECRET_INTERNAL_REASON_TOKEN" };
  const text = formatDiscoveryReply(result);

  assert.match(text, /временно недоступен/);
  assert.doesNotMatch(text, /SECRET_INTERNAL_REASON_TOKEN/);
  assert.doesNotMatch(text, /TEAM_INDEX/);
});
