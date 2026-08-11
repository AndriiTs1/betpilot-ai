import { test } from "node:test";
import assert from "node:assert/strict";
import {
  verifyOdds,
  fetchTotalsOddsForSport,
  findTotalsOutcome,
  verifyTotalsOdds,
  fetchSpreadOddsForSport,
  findSpreadOutcome,
  verifySpreadOdds,
  resolveSpreadEventMetadata,
  type OddsVerificationInput,
  type OddsApiEvent,
  type OddsApiBookmaker,
  type OddsApiOutcome,
} from "./oddsVerifier";
import { normalizeTeamName } from "./teamNameMatcher";

// Same fetch-indirection technique as lib/ocr/claudeOcrProvider.test.ts and
// lib/ai/betParser.test.ts — global.fetch is replaced exactly once with a
// stable wrapper delegating to a mutable `currentHandler`, reassigned per
// test. No real network request is made anywhere in this file.

const originalFetch = global.fetch;
const originalApiKey = process.env.ODDS_API_KEY;

let currentHandler: (url: string) => Promise<Response> = async () => {
  throw new Error("oddsVerifier.test.ts: no fetch handler set for this test");
};

global.fetch = (((url: string | URL) => currentHandler(String(url))) as unknown) as typeof fetch;

// oddsVerifier.ts caches fetched events per sport_key for ODDS_CACHE_TTL_MS
// (45s), in a module-level Map that outlives any single test. Rather than
// touching that cache (explicitly out of scope for this task), each test
// advances a fake Date.now() by well over 45s before it runs, so every
// test's fetchOddsForSport() call is a guaranteed miss regardless of which
// sport alias — and therefore which cache key — it reuses. Nothing else in
// oddsVerifier.ts reads Date.now() (confirmed by inspection), so this only
// ever affects cache freshness, never any matching/scoring logic.
let fakeNow = Date.parse("2030-01-01T00:00:00Z");
const originalDateNow = Date.now;

test.beforeEach(() => {
  fakeNow += 10 * 60 * 1000; // +10 minutes, comfortably past the 45s TTL
  Date.now = () => fakeNow;
  process.env.ODDS_API_KEY = "test-odds-api-key";
  currentHandler = async () => {
    throw new Error("oddsVerifier.test.ts: no fetch handler set for this test");
  };
});

test.afterEach(() => {
  Date.now = originalDateNow;
});

test.after(() => {
  global.fetch = originalFetch;
  if (originalApiKey !== undefined) {
    process.env.ODDS_API_KEY = originalApiKey;
  } else {
    delete process.env.ODDS_API_KEY;
  }
});

interface OutcomeFixture {
  name: string;
  price: number;
}

function h2hEvent(homeTeam: string, awayTeam: string, outcomes: OutcomeFixture[]): unknown {
  return {
    id: "evt-1",
    home_team: homeTeam,
    away_team: awayTeam,
    bookmakers: [
      {
        key: "pinnacle",
        title: "Pinnacle",
        markets: [{ key: "h2h", outcomes }],
      },
    ],
  };
}

function standardOutcomes(homeTeam: string, awayTeam: string, homePrice: number, awayPrice: number, drawPrice = 3.2): OutcomeFixture[] {
  return [
    { name: homeTeam, price: homePrice },
    { name: awayTeam, price: awayPrice },
    { name: "Draw", price: drawPrice },
  ];
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

function mockEvents(events: unknown[]): void {
  currentHandler = async () => jsonResponse(events);
}

function bet(overrides: Partial<OddsVerificationInput> = {}): OddsVerificationInput {
  return {
    sport: "football",
    event: "Manchester United vs Chelsea",
    selection: "1",
    odds: 2.15,
    ...overrides,
  };
}

// ---------------------------------------------------------------------
// 1 & 2. Forward order — parsed event matches provider home/away order
// ---------------------------------------------------------------------

test("verifyOdds: forward order, selection '1' resolves to the provider's home team price", async () => {
  mockEvents([h2hEvent("Manchester United", "Chelsea", standardOutcomes("Manchester United", "Chelsea", 2.15, 3.4))]);

  const result = await verifyOdds(bet({ event: "Manchester United vs Chelsea", selection: "1", odds: 2.15 }));

  assert.equal(result.matched, true);
  assert.equal(result.sourceOdds, 2.15);
});

test("verifyOdds: forward order, selection '2' resolves to the provider's away team price", async () => {
  mockEvents([h2hEvent("Manchester United", "Chelsea", standardOutcomes("Manchester United", "Chelsea", 2.15, 3.4))]);

  const result = await verifyOdds(bet({ event: "Manchester United vs Chelsea", selection: "2", odds: 3.4 }));

  assert.equal(result.matched, true);
  assert.equal(result.sourceOdds, 3.4);
});

// ---------------------------------------------------------------------
// 3 & 4. Reverse order — parsed event lists teams in the opposite order
// from the provider's home_team/away_team. The critical case from the
// task: "1" must NOT be treated as "provider home_team".
// ---------------------------------------------------------------------

test("verifyOdds: reverse order, selection '1' means the FIRST team in the parsed string, which is the provider's away team", async () => {
  // Parsed: "Chelsea vs Manchester United" — Chelsea is listed first.
  // Provider: home_team = Manchester United, away_team = Chelsea.
  mockEvents([h2hEvent("Manchester United", "Chelsea", standardOutcomes("Manchester United", "Chelsea", 2.15, 3.4))]);

  const result = await verifyOdds(bet({ event: "Chelsea vs Manchester United", selection: "1", odds: 3.4 }));

  assert.equal(result.matched, true);
  assert.equal(result.sourceOdds, 3.4, "selection '1' must resolve to Chelsea's price, not the provider's home_team");
});

test("verifyOdds: reverse order, selection '2' means the SECOND team in the parsed string, which is the provider's home team", async () => {
  mockEvents([h2hEvent("Manchester United", "Chelsea", standardOutcomes("Manchester United", "Chelsea", 2.15, 3.4))]);

  const result = await verifyOdds(bet({ event: "Chelsea vs Manchester United", selection: "2", odds: 2.15 }));

  assert.equal(result.matched, true);
  assert.equal(result.sourceOdds, 2.15, "selection '2' must resolve to Manchester United's price, not the provider's away_team");
});

// ---------------------------------------------------------------------
// 5 & 6. Draw — Latin "X" and Cyrillic "Х"
// ---------------------------------------------------------------------

test("verifyOdds: selection 'X' (Latin) resolves to the Draw outcome", async () => {
  mockEvents([h2hEvent("Juventus", "Inter", standardOutcomes("Juventus", "Inter", 2.5, 2.8, 3.2))]);

  const result = await verifyOdds(bet({ sport: "serie a", event: "Juventus vs Inter", selection: "X", odds: 3.2 }));

  assert.equal(result.matched, true);
  assert.equal(result.sourceOdds, 3.2);
});

test("verifyOdds: selection 'Х' (Cyrillic) resolves to the Draw outcome exactly like 'X'", async () => {
  mockEvents([h2hEvent("Juventus", "Inter", standardOutcomes("Juventus", "Inter", 2.5, 2.8, 3.2))]);

  const result = await verifyOdds(bet({ sport: "serie a", event: "Juventus vs Inter", selection: "Х", odds: 3.2 }));

  assert.equal(result.matched, true);
  assert.equal(result.sourceOdds, 3.2);
});

// ---------------------------------------------------------------------
// 7 & 8. П1/P1 and П2/P2
// ---------------------------------------------------------------------

test("verifyOdds: 'П1' (Cyrillic) resolves to the first parsed team, same as '1'", async () => {
  mockEvents([h2hEvent("Manchester United", "Chelsea", standardOutcomes("Manchester United", "Chelsea", 2.15, 3.4))]);
  const result = await verifyOdds(bet({ event: "Manchester United vs Chelsea", selection: "П1", odds: 2.15 }));
  assert.equal(result.matched, true);
  assert.equal(result.sourceOdds, 2.15);
});

test("verifyOdds: 'P1' (Latin) resolves to the first parsed team, same as '1'", async () => {
  mockEvents([h2hEvent("Manchester United", "Chelsea", standardOutcomes("Manchester United", "Chelsea", 2.15, 3.4))]);
  const result = await verifyOdds(bet({ event: "Manchester United vs Chelsea", selection: "P1", odds: 2.15 }));
  assert.equal(result.matched, true);
  assert.equal(result.sourceOdds, 2.15);
});

test("verifyOdds: 'П2' (Cyrillic) resolves to the second parsed team, same as '2'", async () => {
  mockEvents([h2hEvent("Manchester United", "Chelsea", standardOutcomes("Manchester United", "Chelsea", 2.15, 3.4))]);
  const result = await verifyOdds(bet({ event: "Manchester United vs Chelsea", selection: "П2", odds: 3.4 }));
  assert.equal(result.matched, true);
  assert.equal(result.sourceOdds, 3.4);
});

test("verifyOdds: 'P2' (Latin) resolves to the second parsed team, same as '2'", async () => {
  mockEvents([h2hEvent("Manchester United", "Chelsea", standardOutcomes("Manchester United", "Chelsea", 2.15, 3.4))]);
  const result = await verifyOdds(bet({ event: "Manchester United vs Chelsea", selection: "P2", odds: 3.4 }));
  assert.equal(result.matched, true);
  assert.equal(result.sourceOdds, 3.4);
});

// ---------------------------------------------------------------------
// 9. "home"/"away" follow the parsed event's own order, not a blind
// provider home_team/away_team read
// ---------------------------------------------------------------------

test("verifyOdds: 'home' and 'away' resolve against the parsed event's team order, not literally provider home/away", async () => {
  // Reverse order again: parsed lists Chelsea first, provider's real
  // home_team is Manchester United. "home" here must mean "the first team
  // in the parsed string" (Chelsea), matching '1's behavior above exactly
  // — a literal reading of provider home_team would wrongly return
  // Manchester United's price instead.
  mockEvents([h2hEvent("Manchester United", "Chelsea", standardOutcomes("Manchester United", "Chelsea", 2.15, 3.4))]);

  const homeResult = await verifyOdds(bet({ event: "Chelsea vs Manchester United", selection: "home", odds: 3.4 }));
  assert.equal(homeResult.matched, true);
  assert.equal(homeResult.sourceOdds, 3.4, "'home' must follow parsed order (Chelsea), not provider home_team (Man Utd)");

  const awayResult = await verifyOdds(bet({ event: "Chelsea vs Manchester United", selection: "away", odds: 2.15 }));
  assert.equal(awayResult.matched, true);
  assert.equal(awayResult.sourceOdds, 2.15, "'away' must follow parsed order (Man Utd), not provider away_team (Chelsea)");
});

// ---------------------------------------------------------------------
// 10. Full team name — existing fuzzy matching path is untouched
// ---------------------------------------------------------------------

test("verifyOdds: a selection with a full team name still resolves via the existing fuzzy name matching", async () => {
  mockEvents([h2hEvent("Manchester United", "Chelsea", standardOutcomes("Manchester United", "Chelsea", 2.15, 3.4))]);

  const result = await verifyOdds(bet({ event: "Manchester United vs Chelsea", selection: "Manchester United", odds: 2.15 }));

  assert.equal(result.matched, true);
  assert.equal(result.sourceOdds, 2.15);
});

// ---------------------------------------------------------------------
// 11. Combined-market notation ("1X", "X2", "12") must never be treated
// as a single outcome
// ---------------------------------------------------------------------

test("verifyOdds: '1X', 'X2', and '12' are never treated as single FIRST_TEAM/DRAW/SECOND_TEAM outcomes", async () => {
  const outcomes = standardOutcomes("Manchester United", "Chelsea", 2.15, 3.4);

  for (const doubleChance of ["1X", "X2", "12"]) {
    mockEvents([h2hEvent("Manchester United", "Chelsea", outcomes)]);
    const result = await verifyOdds(bet({ event: "Manchester United vs Chelsea", selection: doubleChance, odds: 1.3 }));
    assert.equal(result.matched, false, `"${doubleChance}" must not match any single outcome`);
  }
});

// ---------------------------------------------------------------------
// 12 & 13. h2h market missing / Draw outcome missing
// ---------------------------------------------------------------------

test("verifyOdds: no h2h market at all leaves '1' unmatched (existing behavior preserved)", async () => {
  mockEvents([
    {
      id: "evt-1",
      home_team: "Manchester United",
      away_team: "Chelsea",
      bookmakers: [{ key: "pinnacle", title: "Pinnacle", markets: [] }],
    },
  ]);

  const result = await verifyOdds(bet({ event: "Manchester United vs Chelsea", selection: "1", odds: 2.15 }));
  assert.equal(result.matched, false);
});

test("verifyOdds: h2h market present but no Draw outcome leaves 'X' unmatched", async () => {
  mockEvents([
    h2hEvent("Manchester United", "Chelsea", [
      { name: "Manchester United", price: 2.15 },
      { name: "Chelsea", price: 3.4 },
      // No "Draw" outcome at all.
    ]),
  ]);

  const result = await verifyOdds(bet({ event: "Manchester United vs Chelsea", selection: "X", odds: 3.2 }));
  assert.equal(result.matched, false);
});

// ---------------------------------------------------------------------
// 14. Team order cannot be confidently determined — never guess
// ---------------------------------------------------------------------

test("verifyOdds: when the parsed event can't be split into two teams, '1'/'2' are left unmatched rather than guessed", async () => {
  // No "vs"/"v"/"-" separator at all — splitEventTeams() returns null.
  // findMatchingEvent() can still find the right event via its own
  // fallback whole-string overlap (all three words present, in some
  // order), which is exactly the realistic case where an event is found
  // but per-team order genuinely cannot be recovered.
  mockEvents([h2hEvent("Manchester United", "Chelsea", standardOutcomes("Manchester United", "Chelsea", 2.15, 3.4))]);

  const result = await verifyOdds(bet({ event: "Manchester United Chelsea", selection: "1", odds: 2.15 }));
  assert.equal(result.matched, false);
});

// ---------------------------------------------------------------------
// 15. VERIFIED vs ODDS_CHANGED — tolerance is unchanged
// ---------------------------------------------------------------------

test("verifyOdds: submitted odds matching the source price are within tolerance (VERIFIED path)", async () => {
  mockEvents([h2hEvent("Manchester United", "Chelsea", standardOutcomes("Manchester United", "Chelsea", 2.15, 3.4))]);

  const result = await verifyOdds(bet({ event: "Manchester United vs Chelsea", selection: "1", odds: 2.15 }));

  assert.equal(result.matched, true);
  assert.equal(result.withinTolerance, true);
});

test("verifyOdds: submitted odds far from the source price exceed tolerance (ODDS_CHANGED path)", async () => {
  mockEvents([h2hEvent("Manchester United", "Chelsea", standardOutcomes("Manchester United", "Chelsea", 2.15, 3.4))]);

  // Source is 2.15; 2.50 is well over 3% away (~16% discrepancy).
  const result = await verifyOdds(bet({ event: "Manchester United vs Chelsea", selection: "1", odds: 2.5 }));

  assert.equal(result.matched, true);
  assert.equal(result.withinTolerance, false);
});

// ---------------------------------------------------------------------
// Step 15G — odds: null (provider-price lookup, domain primitive only)
// ---------------------------------------------------------------------

test("verifyOdds: odds null + event found + selection found + price found promotes the provider price as both sourceOdds and submittedOdds", async () => {
  mockEvents([h2hEvent("Manchester United", "Chelsea", standardOutcomes("Manchester United", "Chelsea", 2.15, 3.4))]);

  const result = await verifyOdds(bet({ event: "Manchester United vs Chelsea", selection: "1", odds: null }));

  assert.equal(result.matched, true);
  assert.equal(result.withinTolerance, true);
  assert.equal(result.sourceOdds, 2.15);
  assert.equal(result.submittedOdds, 2.15);
  assert.equal(result.discrepancyPercent, 0);
  assert.equal(result.bookmaker, "Pinnacle");
});

test("verifyOdds: odds null + event not found leaves the selection unmatched, no promoted or fabricated price", async () => {
  // No fixture at all matches this event string.
  mockEvents([h2hEvent("Real Madrid", "Barcelona", standardOutcomes("Real Madrid", "Barcelona", 1.9, 4.1))]);

  const result = await verifyOdds(bet({ event: "Manchester United vs Chelsea", selection: "1", odds: null }));

  assert.equal(result.matched, false);
  assert.equal(result.sourceOdds, null);
  assert.equal(result.submittedOdds, null);
  assert.equal(result.discrepancyPercent, null);
  assert.match(result.note ?? "", /No matching event found/);
});

test("verifyOdds: odds null + selection not found leaves the selection unmatched, no promoted or fabricated price", async () => {
  mockEvents([h2hEvent("Manchester United", "Chelsea", standardOutcomes("Manchester United", "Chelsea", 2.15, 3.4))]);

  // A selection string that cannot be matched to any outcome (event/market
  // are genuinely found — only the specific outcome lookup fails).
  const result = await verifyOdds(
    bet({ event: "Manchester United vs Chelsea", selection: "Some Completely Unrelated Outcome", odds: null }),
  );

  assert.equal(result.matched, false);
  assert.equal(result.sourceOdds, null);
  assert.equal(result.submittedOdds, null);
  assert.equal(result.discrepancyPercent, null);
  assert.match(result.note ?? "", /Could not match selection/);
});

test("verifyOdds: odds null + no bookmaker price leaves the selection unmatched, no promoted or fabricated price", async () => {
  mockEvents([
    {
      id: "evt-1",
      home_team: "Manchester United",
      away_team: "Chelsea",
      bookmakers: [], // event found, but no bookmaker offers odds on it at all
    },
  ]);

  const result = await verifyOdds(bet({ event: "Manchester United vs Chelsea", selection: "1", odds: null }));

  assert.equal(result.matched, false);
  assert.equal(result.sourceOdds, null);
  assert.equal(result.submittedOdds, null);
  assert.equal(result.discrepancyPercent, null);
  assert.match(result.note ?? "", /No bookmaker odds available/);
});

test("verifyOdds: odds null + provider fetch failure preserves the existing failure behavior unchanged", async () => {
  currentHandler = async () => new Response("boom", { status: 500 });

  const result = await verifyOdds(bet({ event: "Manchester United vs Chelsea", selection: "1", odds: null }));

  assert.equal(result.matched, false);
  assert.equal(result.sourceOdds, null);
  assert.equal(result.submittedOdds, null);
  assert.equal(result.discrepancyPercent, null);
  assert.match(result.note ?? "", /The Odds API request failed with status 500/);
});

test("verifyOdds: odds null + unmapped sport preserves the existing failure behavior unchanged (no provider call at all)", async () => {
  const result = await verifyOdds(bet({ sport: "curling", event: "Team A vs Team B", selection: "1", odds: null }));

  assert.equal(result.matched, false);
  assert.equal(result.sourceOdds, null);
  assert.equal(result.submittedOdds, null);
  assert.match(result.note ?? "", /is not mapped to a The Odds API sport_key/);
});

// ---------------------------------------------------------------------
// Step 15G — numeric-odds regression proof (byte-for-byte, full shape)
// ---------------------------------------------------------------------

test("verifyOdds: numeric odds within tolerance — full result shape unchanged (VERIFIED)", async () => {
  mockEvents([h2hEvent("Manchester United", "Chelsea", standardOutcomes("Manchester United", "Chelsea", 2.15, 3.4))]);

  const result = await verifyOdds(bet({ event: "Manchester United vs Chelsea", selection: "1", odds: 2.15 }));

  assert.deepEqual(result, {
    matched: true,
    withinTolerance: true,
    sourceOdds: 2.15,
    submittedOdds: 2.15,
    discrepancyPercent: 0,
    bookmaker: "Pinnacle",
    note: null,
  });
});

test("verifyOdds: numeric odds outside tolerance — full result shape unchanged (ODDS_CHANGED)", async () => {
  mockEvents([h2hEvent("Manchester United", "Chelsea", standardOutcomes("Manchester United", "Chelsea", 2.15, 3.4))]);

  const result = await verifyOdds(bet({ event: "Manchester United vs Chelsea", selection: "1", odds: 2.5 }));

  assert.deepEqual(result, {
    matched: true,
    withinTolerance: false,
    sourceOdds: 2.15,
    submittedOdds: 2.5,
    discrepancyPercent: 16.28,
    bookmaker: "Pinnacle",
    note: null,
  });
});

// ---------------------------------------------------------------------
// Step 16A — football league routing: explicit league (single sport_key),
// no-league fallback (merged multi-key, mirroring tennis), partial
// provider failure, full provider failure, dedup, and cross-league
// ambiguity. A per-sport_key-aware fetch handler is needed here (unlike
// mockEvents()'s single shared response) to prove exactly which
// competitions were actually queried.
// ---------------------------------------------------------------------

function h2hEventWithId(
  id: string,
  homeTeam: string,
  awayTeam: string,
  outcomes: OutcomeFixture[],
  commenceTime?: string,
): unknown {
  return {
    id,
    commence_time: commenceTime,
    home_team: homeTeam,
    away_team: awayTeam,
    bookmakers: [{ key: "pinnacle", title: "Pinnacle", markets: [{ key: "h2h", outcomes }] }],
  };
}

function sportKeyFromUrl(url: string): string {
  const match = /\/sports\/([^/]+)\/odds\//.exec(url);
  if (!match) throw new Error(`oddsVerifier.test.ts: could not extract sport_key from URL "${url}"`);
  return match[1];
}

// Records every sport_key actually requested (in request order) and
// dispatches a per-key fixture — "reject" simulates that one competition's
// request failing outright while others may still succeed.
function mockEventsBySportKey(bySportKey: Record<string, unknown[] | "reject">): { requestedSportKeys: string[] } {
  const requestedSportKeys: string[] = [];
  currentHandler = async (url: string) => {
    const sportKey = sportKeyFromUrl(url);
    requestedSportKeys.push(sportKey);
    const outcome = bySportKey[sportKey];
    if (outcome === undefined) {
      throw new Error(`oddsVerifier.test.ts: no fixture configured for sport_key "${sportKey}"`);
    }
    if (outcome === "reject") {
      throw new Error(`simulated provider failure for sport_key "${sportKey}"`);
    }
    return jsonResponse(outcome);
  };
  return { requestedSportKeys };
}

const ALL_FOOTBALL_SPORT_KEYS = [
  "soccer_epl",
  "soccer_spain_la_liga",
  "soccer_italy_serie_a",
  "soccer_germany_bundesliga",
  "soccer_france_ligue_one",
  "soccer_uefa_champs_league",
  "soccer_uefa_champs_league_qualification",
];

test("Step 16A (1): explicit Serie A propagation — only the Serie A provider key is requested", async () => {
  const { requestedSportKeys } = mockEventsBySportKey({
    soccer_italy_serie_a: [h2hEventWithId("evt-sa-1", "Inter Milan", "Juventus", standardOutcomes("Inter Milan", "Juventus", 2.1, 3.3))],
  });

  const result = await verifyOdds(bet({ sport: "serie a", event: "Inter Milan vs Juventus", selection: "Inter Milan", odds: 2.1 }));

  assert.deepEqual(requestedSportKeys, ["soccer_italy_serie_a"], "only Serie A's own sport_key may ever be requested for an explicit Serie A league");
  assert.equal(result.matched, true);
});

test("Step 16A (2): explicit EPL propagation — 'premier league' maps only to soccer_epl", async () => {
  const { requestedSportKeys } = mockEventsBySportKey({
    soccer_epl: [h2hEventWithId("evt-epl-1", "Arsenal", "Chelsea", standardOutcomes("Arsenal", "Chelsea", 1.9, 3.8))],
  });

  const result = await verifyOdds(bet({ sport: "premier league", event: "Arsenal vs Chelsea", selection: "Arsenal", odds: 1.9 }));

  assert.deepEqual(requestedSportKeys, ["soccer_epl"]);
  assert.equal(result.matched, true);
});

test("Step 16A (4): no-league football fallback searches more than one competition, not exclusively soccer_epl", async () => {
  const fixtures = Object.fromEntries(ALL_FOOTBALL_SPORT_KEYS.map((key) => [key, []])) as Record<string, unknown[]>;
  const { requestedSportKeys } = mockEventsBySportKey(fixtures);

  await verifyOdds(bet({ sport: "football", event: "Some Team vs Another Team", selection: "Some Team", odds: 2.0 }));

  assert.ok(requestedSportKeys.length > 1, "a no-league football lookup must search more than one competition");
  assert.deepEqual(requestedSportKeys.slice().sort(), ALL_FOOTBALL_SPORT_KEYS.slice().sort());
});

test("Step 16A (5): cross-league event discovery — EPL has no match, Serie A does; the Serie A event is found", async () => {
  const { requestedSportKeys } = mockEventsBySportKey({
    soccer_epl: [h2hEventWithId("evt-epl-2", "Arsenal", "Chelsea", standardOutcomes("Arsenal", "Chelsea", 1.9, 3.8))],
    soccer_spain_la_liga: [],
    soccer_italy_serie_a: [h2hEventWithId("evt-sa-2", "Inter Milan", "Juventus", standardOutcomes("Inter Milan", "Juventus", 2.1, 3.3))],
    soccer_germany_bundesliga: [],
    soccer_france_ligue_one: [],
    soccer_uefa_champs_league: [],
    soccer_uefa_champs_league_qualification: [],
  });

  const result = await verifyOdds(bet({ sport: "football", event: "Inter Milan vs Juventus", selection: "Inter Milan", odds: 2.1 }));

  assert.ok(requestedSportKeys.includes("soccer_italy_serie_a"));
  assert.equal(result.matched, true);
  assert.equal(result.sourceOdds, 2.1);
});

test("Step 16A (6): partial provider failure — one league request fails, another succeeds with a matching event; lookup still succeeds", async () => {
  mockEventsBySportKey({
    soccer_epl: "reject",
    soccer_spain_la_liga: [],
    soccer_italy_serie_a: [h2hEventWithId("evt-sa-3", "Inter Milan", "Juventus", standardOutcomes("Inter Milan", "Juventus", 2.1, 3.3))],
    soccer_germany_bundesliga: [],
    soccer_france_ligue_one: [],
    soccer_uefa_champs_league: [],
    soccer_uefa_champs_league_qualification: [],
  });

  const result = await verifyOdds(bet({ sport: "football", event: "Inter Milan vs Juventus", selection: "Inter Milan", odds: 2.1 }));

  assert.equal(result.matched, true, "one failed competition request must not fail the whole lookup when another succeeds");
});

test("Step 16A (7): every provider request fails — provider failure is preserved accurately, never misreported as NOT_FOUND", async () => {
  const fixtures = Object.fromEntries(ALL_FOOTBALL_SPORT_KEYS.map((key) => [key, "reject" as const]));
  mockEventsBySportKey(fixtures);

  const result = await verifyOdds(bet({ sport: "football", event: "Some Team vs Another Team", selection: "Some Team", odds: 2.0 }));

  assert.equal(result.matched, false);
  assert.ok(result.note?.includes("simulated provider failure"), `expected a provider-failure note, got: ${result.note}`);
  assert.doesNotMatch(result.note ?? "", /No matching event found/);
});

// Root cause of the production "single-team query works for SINGLE, stays
// Unavailable for EXPRESS" investigation: every fetch failed with a real
// HTTP 401 + error_code OUT_OF_USAGE_CREDITS (quota exhausted) — not a
// network-level throw like the "reject" fixture above. This proves the
// same guarantee (findMatchingEvent is never reached — no candidate event
// list ever existed to match against) for that exact real-world shape, and
// that the safe note format (status + short error_code, never a raw body)
// is what actually gets constructed.
test("provider HTTP failure (OUT_OF_USAGE_CREDITS) never reaches findMatchingEvent, and the note never embeds the raw response body", async () => {
  const rawBody = { message: "Usage quota has been reached. See usage plans at https://the-odds-api.com", error_code: "OUT_OF_USAGE_CREDITS" };
  currentHandler = async () =>
    new Response(JSON.stringify(rawBody), { status: 401, headers: { "Content-Type": "application/json" } });

  const result = await verifyOdds(bet({ sport: "football", event: "Arsenal", selection: "Arsenal", odds: null }));

  assert.equal(result.matched, false);
  assert.equal(result.note, "The Odds API request failed with status 401 (OUT_OF_USAGE_CREDITS)");
  // findMatchingEvent was never reached: neither of its two possible
  // failure templates appears, and no provider event metadata (which only
  // extractProviderEventMetadata, reachable only after a match, ever sets)
  // is present.
  assert.doesNotMatch(result.note ?? "", /No matching event found/);
  assert.doesNotMatch(result.note ?? "", /Ambiguous event match/);
  assert.equal(result.providerEventId, undefined);
  // The raw provider response body text must never appear anywhere in the
  // result — only the short, safe error_code.
  assert.doesNotMatch(result.note ?? "", /Usage quota has been reached/);
  assert.doesNotMatch(result.note ?? "", /usage plans/);
});

test("Step 16A (8): every request succeeds but no event matches — EVENT_NOT_FOUND, no fabricated odds", async () => {
  const fixtures = Object.fromEntries(ALL_FOOTBALL_SPORT_KEYS.map((key) => [key, []])) as Record<string, unknown[]>;
  mockEventsBySportKey(fixtures);

  const result = await verifyOdds(bet({ sport: "football", event: "Nonexistent FC vs Also Nonexistent FC", selection: "Nonexistent FC", odds: 2.0 }));

  assert.equal(result.matched, false);
  assert.equal(result.sourceOdds, null);
  assert.match(result.note ?? "", /No matching event found/);
});

test("Step 16A: the same fixture returned by more than one merged competition is deduped, not double-counted or flagged ambiguous", async () => {
  // Same event id "evt-dup" from two different sport_keys — a real-world
  // edge case (a friendly listed under more than one competition feed) —
  // must resolve as one single found event, never AMBIGUOUS.
  mockEventsBySportKey({
    soccer_epl: [h2hEventWithId("evt-dup", "Arsenal", "Chelsea", standardOutcomes("Arsenal", "Chelsea", 1.9, 3.8))],
    soccer_spain_la_liga: [],
    soccer_italy_serie_a: [h2hEventWithId("evt-dup", "Arsenal", "Chelsea", standardOutcomes("Arsenal", "Chelsea", 1.9, 3.8))],
    soccer_germany_bundesliga: [],
    soccer_france_ligue_one: [],
    soccer_uefa_champs_league: [],
    soccer_uefa_champs_league_qualification: [],
  });

  const result = await verifyOdds(bet({ sport: "football", event: "Arsenal vs Chelsea", selection: "Arsenal", odds: 1.9 }));

  assert.equal(result.matched, true);
  assert.doesNotMatch(result.note ?? "", /Ambiguous/);
});

test("Step 16A/16B: two genuinely different events tied at the same best score, kickoffs months apart, return an ambiguity result, never an arbitrary pick", async () => {
  // Two DIFFERENT ids, identical team names, in two different competitions,
  // with kickoff times MONTHS apart (a plausible real scenario: a genuine
  // home-and-away rematch, or a club and its reserve/B-team both registered
  // similarly) — far outside Step 16B's semantic-dedup time window, so
  // these must NOT be merged; neither may be silently preferred by league
  // order either.
  mockEventsBySportKey({
    soccer_epl: [
      h2hEventWithId("evt-a", "Sporting FC", "Athletic FC", standardOutcomes("Sporting FC", "Athletic FC", 2.0, 3.0), "2026-03-01T15:00:00Z"),
    ],
    soccer_spain_la_liga: [],
    soccer_italy_serie_a: [],
    soccer_germany_bundesliga: [],
    soccer_france_ligue_one: [],
    soccer_uefa_champs_league: [
      h2hEventWithId("evt-b", "Sporting FC", "Athletic FC", standardOutcomes("Sporting FC", "Athletic FC", 2.2, 2.8), "2026-09-01T15:00:00Z"),
    ],
    soccer_uefa_champs_league_qualification: [],
  });

  const result = await verifyOdds(bet({ sport: "football", event: "Sporting FC vs Athletic FC", selection: "Sporting FC", odds: 2.0 }));

  assert.equal(result.matched, false);
  assert.equal(result.sourceOdds, null, "an ambiguous match must never fabricate a source price from either candidate");
  assert.match(result.note ?? "", /Ambiguous event match/);
});

// ---------------------------------------------------------------------
// Step 16B — semantic dedup: the same real fixture can be listed twice by
// the provider under two DIFFERENT event ids (confirmed live: The Odds
// API's own Serie A feed listed "Torino vs AC Milan" twice, ~30 hours apart
// in stated kickoff time). Id-based dedup alone cannot catch this — must be
// collapsed before ambiguity detection, or a real, correctly-routed bet
// falsely reports AMBIGUOUS_EVENT/NOT_FOUND instead of the actual price.
// ---------------------------------------------------------------------

test("Step 16B: the same fixture listed twice under different ids, kickoffs close together, is treated as one event — no false AMBIGUOUS_EVENT", async () => {
  const { requestedSportKeys } = mockEventsBySportKey({
    soccer_italy_serie_a: [
      h2hEventWithId("evt-dup-a", "Torino", "AC Milan", standardOutcomes("Torino", "AC Milan", 4.2, 1.78), "2026-08-22T13:00:00Z"),
      h2hEventWithId("evt-dup-b", "Torino", "AC Milan", standardOutcomes("Torino", "AC Milan", 4.2, 1.78), "2026-08-23T18:45:00Z"),
    ],
  });

  const result = await verifyOdds(bet({ sport: "serie a", event: "Torino vs AC Milan", selection: "AC Milan Win", odds: null }));

  assert.deepEqual(requestedSportKeys, ["soccer_italy_serie_a"]);
  assert.equal(result.matched, true, "a same-fixture duplicate must never produce a false AMBIGUOUS_EVENT/NOT_FOUND");
  assert.equal(result.sourceOdds, 1.78);
  assert.doesNotMatch(result.note ?? "", /Ambiguous/);
});

test("Step 16B: bookmakers from both duplicate records are merged — a price present only on the second listing is still usable", async () => {
  mockEventsBySportKey({
    soccer_italy_serie_a: [
      {
        id: "evt-dup-c",
        commence_time: "2026-08-22T13:00:00Z",
        home_team: "Torino",
        away_team: "AC Milan",
        bookmakers: [{ key: "unibet_se", title: "Unibet", markets: [{ key: "h2h", outcomes: standardOutcomes("Torino", "AC Milan", 4.0, 1.9) }] }],
      },
      {
        id: "evt-dup-d",
        commence_time: "2026-08-23T18:45:00Z",
        home_team: "Torino",
        away_team: "AC Milan",
        // Pinnacle is only present on this second duplicate record.
        bookmakers: [{ key: "pinnacle", title: "Pinnacle", markets: [{ key: "h2h", outcomes: standardOutcomes("Torino", "AC Milan", 4.2, 1.78) }] }],
      },
    ],
  });

  const result = await verifyOdds(bet({ sport: "serie a", event: "Torino vs AC Milan", selection: "AC Milan Win", odds: null }));

  assert.equal(result.matched, true);
  assert.equal(result.bookmaker, "Pinnacle", "Pinnacle must still be picked even though it only appeared on the second duplicate record");
  assert.equal(result.sourceOdds, 1.78);
});

test("Step 16B: a genuine same-teams rematch (kickoffs months apart) is NOT semantically deduped", async () => {
  const { requestedSportKeys } = mockEventsBySportKey({
    soccer_italy_serie_a: [
      h2hEventWithId("evt-rematch-1", "Torino", "AC Milan", standardOutcomes("Torino", "AC Milan", 4.2, 1.78), "2026-03-01T13:00:00Z"),
      h2hEventWithId("evt-rematch-2", "AC Milan", "Torino", standardOutcomes("AC Milan", "Torino", 1.6, 5.5), "2026-09-01T13:00:00Z"),
    ],
  });

  const result = await verifyOdds(bet({ sport: "serie a", event: "Torino vs AC Milan", selection: "AC Milan Win", odds: null }));

  assert.deepEqual(requestedSportKeys, ["soccer_italy_serie_a"]);
  // Both are plausible matches for "Torino vs AC Milan" text (forward and
  // reversed order both score confidently) but are genuinely different
  // fixtures months apart — never merged, and never silently arbitrated.
  assert.equal(result.matched, false);
  assert.match(result.note ?? "", /Ambiguous event match/);
});

// ---------------------------------------------------------------------
// UEFA Champions League Qualification — a real, live gap found via
// diagnostic: The Odds API lists qualifying-round fixtures under a
// sport_key entirely separate from the main tournament
// (soccer_uefa_champs_league_qualification vs. soccer_uefa_champs_league),
// and the no-league fallback previously never queried it.
// ---------------------------------------------------------------------

test("UEFA CL Qualification: the new sport_key is included in the no-league football fallback set", async () => {
  const fixtures = Object.fromEntries(ALL_FOOTBALL_SPORT_KEYS.map((key) => [key, []])) as Record<string, unknown[]>;
  const { requestedSportKeys } = mockEventsBySportKey(fixtures);

  await verifyOdds(bet({ sport: "football", event: "Some Team vs Another Team", selection: "Some Team", odds: 2.0 }));

  assert.ok(
    requestedSportKeys.includes("soccer_uefa_champs_league_qualification"),
    "a no-league football lookup must also query the qualification sport_key",
  );
});

test("UEFA CL Qualification: explicit league propagation — only the qualification sport_key is requested, never the main tournament's", async () => {
  const { requestedSportKeys } = mockEventsBySportKey({
    soccer_uefa_champs_league_qualification: [
      h2hEventWithId("evt-clq-1", "Dinamo Zagreb", "FC Thun", standardOutcomes("Dinamo Zagreb", "FC Thun", 1.65, 5.2)),
    ],
  });

  const result = await verifyOdds(
    bet({ sport: "champions league qualification", event: "Dinamo Zagreb vs FC Thun", selection: "Dinamo Zagreb", odds: 1.65 }),
  );

  assert.deepEqual(requestedSportKeys, ["soccer_uefa_champs_league_qualification"]);
  assert.equal(result.matched, true);
});

test("UEFA CL Qualification: the mocked Dinamo Zagreb vs FC Thun fixture verifies for the diagnosed bet text (Match Winner / Dinamo Zagreb)", async () => {
  mockEventsBySportKey({
    soccer_uefa_champs_league_qualification: [
      h2hEventWithId("evt-clq-2", "Dinamo Zagreb", "FC Thun", standardOutcomes("Dinamo Zagreb", "FC Thun", 1.65, 5.2)),
    ],
  });

  // Exactly the diagnosed real-world bet: "Dinamo Zagreb vs Thun" (short
  // team name), submitted with no odds — mirroring how a player's provider
  // price gets promoted when no price was typed.
  const result = await verifyOdds(
    bet({ sport: "champions league qualification", event: "Dinamo Zagreb vs Thun", selection: "Dinamo Zagreb", odds: null }),
  );

  assert.equal(result.matched, true, "must no longer report NOT_FOUND for a real, live qualification-round event");
  assert.equal(result.sourceOdds, 1.65);
  assert.equal(result.bookmaker, "Pinnacle");
});

// ---------------------------------------------------------------------
// Stage 3.1 — provider event metadata (providerEventId/providerSportKey/
// eventStartTime), the persistence groundwork verified in this file's own
// return-value shape before it ever reaches theOddsApiProvider.ts/Prisma.
// ---------------------------------------------------------------------

const COMMENCE_TIME = "2026-08-15T18:00:00Z";

test("Stage 3.1: a matched event returns providerEventId matching the provider's own event.id", async () => {
  mockEvents([h2hEventWithId("evt-meta-1", "Manchester United", "Chelsea", standardOutcomes("Manchester United", "Chelsea", 2.15, 3.4), COMMENCE_TIME)]);

  const result = await verifyOdds(bet({ event: "Manchester United vs Chelsea", selection: "1", odds: 2.15 }));

  assert.equal(result.matched, true);
  assert.equal(result.providerEventId, "evt-meta-1");
});

test("Stage 3.1: a matched event returns the actual sport_key its own endpoint was fetched under", async () => {
  const { requestedSportKeys } = mockEventsBySportKey({
    soccer_italy_serie_a: [h2hEventWithId("evt-meta-2", "Inter Milan", "Juventus", standardOutcomes("Inter Milan", "Juventus", 2.1, 3.3), COMMENCE_TIME)],
  });

  const result = await verifyOdds(bet({ sport: "serie a", event: "Inter Milan vs Juventus", selection: "Inter Milan", odds: 2.1 }));

  assert.deepEqual(requestedSportKeys, ["soccer_italy_serie_a"]);
  assert.equal(result.providerSportKey, "soccer_italy_serie_a");
});

test("Stage 3.1: a matched event returns eventStartTime equal to the provider's commence_time, normalized to ISO", async () => {
  mockEvents([h2hEventWithId("evt-meta-3", "Manchester United", "Chelsea", standardOutcomes("Manchester United", "Chelsea", 2.15, 3.4), COMMENCE_TIME)]);

  const result = await verifyOdds(bet({ event: "Manchester United vs Chelsea", selection: "1", odds: 2.15 }));

  assert.equal(result.eventStartTime, new Date(COMMENCE_TIME).toISOString());
});

test("Stage 3.1: provider event metadata is preserved on the ODDS_CHANGED path (odds far from the source price)", async () => {
  mockEvents([h2hEventWithId("evt-meta-4", "Manchester United", "Chelsea", standardOutcomes("Manchester United", "Chelsea", 2.15, 3.4), COMMENCE_TIME)]);

  // Explicit single-league sport — avoids the no-league fallback merge
  // across all 7 football sport_keys, which would otherwise re-tag this
  // mockEvents() shared fixture under every key in turn (mockEvents(), unlike
  // mockEventsBySportKey(), returns the same response for every requested
  // key) and leave only the LAST-queried key's tag surviving id-based dedup
  // — a test-fixture artifact, not a real production scenario.
  //
  // Source is 2.15; 2.50 is well outside tolerance -> matched but not
  // withinTolerance (the "odds changed" case at this layer).
  const result = await verifyOdds(bet({ sport: "premier league", event: "Manchester United vs Chelsea", selection: "1", odds: 2.5 }));

  assert.equal(result.matched, true);
  assert.equal(result.withinTolerance, false);
  assert.equal(result.providerEventId, "evt-meta-4");
  assert.equal(result.providerSportKey, "soccer_epl");
  assert.equal(result.eventStartTime, new Date(COMMENCE_TIME).toISOString());
});

test("Stage 3.1: provider event metadata is preserved when the event is found but the selection can't be matched to a bookmaker outcome", async () => {
  mockEvents([h2hEventWithId("evt-meta-5", "Manchester United", "Chelsea", standardOutcomes("Manchester United", "Chelsea", 2.15, 3.4), COMMENCE_TIME)]);

  const result = await verifyOdds(
    bet({ sport: "premier league", event: "Manchester United vs Chelsea", selection: "Some Completely Unrelated Outcome", odds: 2.0 }),
  );

  assert.equal(result.matched, false);
  assert.match(result.note ?? "", /Could not match selection/);
  assert.equal(result.providerEventId, "evt-meta-5", "the event WAS found, even though the selection wasn't — metadata must still be present");
  assert.equal(result.providerSportKey, "soccer_epl");
  assert.equal(result.eventStartTime, new Date(COMMENCE_TIME).toISOString());
});

test("Stage 3.1: provider event metadata is preserved when the event is found but has no bookmaker odds at all", async () => {
  mockEvents([
    {
      id: "evt-meta-6",
      commence_time: COMMENCE_TIME,
      home_team: "Manchester United",
      away_team: "Chelsea",
      bookmakers: [],
    },
  ]);

  const result = await verifyOdds(bet({ sport: "premier league", event: "Manchester United vs Chelsea", selection: "1", odds: 2.15 }));

  assert.equal(result.matched, false);
  assert.match(result.note ?? "", /No bookmaker odds available/);
  assert.equal(result.providerEventId, "evt-meta-6");
  assert.equal(result.providerSportKey, "soccer_epl");
});

test("Stage 3.1: no event found never returns fabricated provider metadata", async () => {
  mockEvents([h2hEventWithId("evt-meta-7", "Real Madrid", "Barcelona", standardOutcomes("Real Madrid", "Barcelona", 1.9, 4.1), COMMENCE_TIME)]);

  const result = await verifyOdds(bet({ event: "Manchester United vs Chelsea", selection: "1", odds: 2.15 }));

  assert.equal(result.matched, false);
  assert.match(result.note ?? "", /No matching event found/);
  assert.equal(result.providerEventId, undefined);
  assert.equal(result.providerSportKey, undefined);
  assert.equal(result.eventStartTime, undefined);
});

test("Stage 3.1: an unmapped sport never returns fabricated provider metadata", async () => {
  const result = await verifyOdds(bet({ sport: "curling", event: "Team A vs Team B", selection: "1", odds: 2.0 }));

  assert.equal(result.matched, false);
  assert.equal(result.providerEventId, undefined);
  assert.equal(result.providerSportKey, undefined);
  assert.equal(result.eventStartTime, undefined);
});

test("Stage 3.1: a multi-key (no-league) football fallback never mixes sport keys — the matched event's providerSportKey is exactly the key it was actually fetched from", async () => {
  mockEventsBySportKey({
    soccer_epl: [h2hEventWithId("evt-epl-meta", "Arsenal", "Chelsea", standardOutcomes("Arsenal", "Chelsea", 1.9, 3.8), COMMENCE_TIME)],
    soccer_spain_la_liga: [],
    soccer_italy_serie_a: [h2hEventWithId("evt-sa-meta", "Inter Milan", "Juventus", standardOutcomes("Inter Milan", "Juventus", 2.1, 3.3), COMMENCE_TIME)],
    soccer_germany_bundesliga: [],
    soccer_france_ligue_one: [],
    soccer_uefa_champs_league: [],
    soccer_uefa_champs_league_qualification: [],
  });

  const result = await verifyOdds(bet({ sport: "football", event: "Inter Milan vs Juventus", selection: "Inter Milan", odds: 2.1 }));

  assert.equal(result.matched, true);
  assert.equal(result.providerEventId, "evt-sa-meta");
  assert.equal(result.providerSportKey, "soccer_italy_serie_a", "must report the key the WINNING event actually came from, never the EPL key merely because it was queried too");
});

test("Stage 3.1: a missing commence_time is handled safely — matched:true still, but no provider metadata at all (all-or-nothing)", async () => {
  mockEvents([
    {
      id: "evt-no-commence",
      // commence_time deliberately omitted entirely.
      home_team: "Manchester United",
      away_team: "Chelsea",
      bookmakers: [{ key: "pinnacle", title: "Pinnacle", markets: [{ key: "h2h", outcomes: standardOutcomes("Manchester United", "Chelsea", 2.15, 3.4) }] }],
    },
  ]);

  const result = await verifyOdds(bet({ event: "Manchester United vs Chelsea", selection: "1", odds: 2.15 }));

  assert.equal(result.matched, true, "the odds check itself must still succeed — missing commence_time is not a matching failure");
  assert.equal(result.providerEventId, undefined, "must not report an id without a trustworthy start time (all-or-nothing)");
  assert.equal(result.providerSportKey, undefined);
  assert.equal(result.eventStartTime, undefined);
});

test("Stage 3.1: an unparsable commence_time is handled safely — matched:true still, but no provider metadata at all", async () => {
  mockEvents([
    {
      id: "evt-bad-commence",
      commence_time: "not-a-real-date",
      home_team: "Manchester United",
      away_team: "Chelsea",
      bookmakers: [{ key: "pinnacle", title: "Pinnacle", markets: [{ key: "h2h", outcomes: standardOutcomes("Manchester United", "Chelsea", 2.15, 3.4) }] }],
    },
  ]);

  const result = await verifyOdds(bet({ event: "Manchester United vs Chelsea", selection: "1", odds: 2.15 }));

  assert.equal(result.matched, true, "an unparsable commence_time must not fail the odds check itself");
  assert.equal(result.providerEventId, undefined);
  assert.equal(result.providerSportKey, undefined);
  assert.equal(result.eventStartTime, undefined);
});

// ---------------------------------------------------------------------
// Cyrillic team name transliteration — root cause fix for "Гурник Забже —
// Фенербахче" reporting EVENT_NOT_FOUND ("Odds unavailable") even though
// the real event (The Odds API id b816383d03cae9b19b43bd2eabc30726,
// soccer_uefa_champs_league_qualification) genuinely existed. Cyrillic
// previously normalized to an empty string (everything outside [a-z0-9\s]
// was stripped with nothing to replace it), so overlapScore() always
// scored exactly 0. These tests exercise the general transliteration +
// bounded fuzzy-word-match layer, not a team-specific alias.
//
// normalizeTeamName() is asserted against ITS OWN actual deterministic
// output (computed once and hardcoded here), not against some external
// "correct" transliteration standard — there is no single correct Latin
// spelling of a Cyrillic name shared by every Slavic language (see this
// function's own comment on why Serbian's own "c" for "ц" was deliberately
// NOT special-cased). What matters for correctness is (a) it is never
// empty for non-empty Cyrillic input, and (b) it is stable/deterministic —
// exact matching against a provider's own spelling is the job of the
// bounded fuzzy word-match layer exercised further below, not this
// function alone.
// ---------------------------------------------------------------------

test("normalizeTeamName: Cyrillic input never collapses to an empty string", () => {
  assert.equal(normalizeTeamName("Гурник Забже"), "gurnik zabzhe");
  assert.equal(normalizeTeamName("Фенербахче"), "fenerbahche");
  assert.equal(normalizeTeamName("Динамо Загреб"), "dinamo zagreb");
  assert.equal(normalizeTeamName("Црвена Звезда"), "tsrvena zvezda");
  assert.equal(normalizeTeamName("Кайрат Алматы"), "kairat almaty");

  for (const name of ["Гурник Забже", "Фенербахче", "Динамо Загреб", "Црвена Звезда", "Кайрат Алматы"]) {
    assert.notEqual(normalizeTeamName(name), "", `"${name}" must not normalize to an empty string`);
  }
});

test("normalizeTeamName: already-Latin provider spellings are unaffected (no transliteration applied to non-Cyrillic input)", () => {
  assert.equal(normalizeTeamName("Górnik Zabrze"), "gornik zabrze");
  assert.equal(normalizeTeamName("Fenerbahce"), "fenerbahce");
});

test("normalizeTeamName: is deterministic — repeated calls on the same input always produce the same output", () => {
  const inputs = ["Гурник Забже", "Фенербахче", "Динамо Загреб"];
  for (const input of inputs) {
    assert.equal(normalizeTeamName(input), normalizeTeamName(input));
  }
});

test("normalizeTeamName: pre-existing popular Cyrillic TEAM_ALIASES entries still resolve exactly as before (regression)", () => {
  assert.equal(normalizeTeamName("Реал Мадрид"), "real madrid");
  assert.equal(normalizeTeamName("Барселона"), "barcelona");
});

test("normalizeTeamName: empty and punctuation-only input safely normalize to an empty string, never throw", () => {
  assert.equal(normalizeTeamName(""), "");
  assert.equal(normalizeTeamName("— ??? !!!"), "");
  assert.equal(normalizeTeamName("   "), "");
});

// ---------------------------------------------------------------------
// Event matching — the real diagnosed case: Cyrillic bet text against the
// provider's own (Latin/English) event listing.
// ---------------------------------------------------------------------

test("verifyOdds: Cyrillic event text 'Гурник Забже — Фенербахче' matches the provider's 'Górnik Zabrze vs Fenerbahce' listing", async () => {
  mockEvents([h2hEvent("Górnik Zabrze", "Fenerbahce", standardOutcomes("Górnik Zabrze", "Fenerbahce", 2.6, 2.75))]);

  const result = await verifyOdds(
    bet({ sport: "champions league qualification", event: "Гурник Забже — Фенербахче", selection: "1", odds: 2.6 }),
  );

  assert.equal(result.matched, true, `expected the Cyrillic event text to match; note: ${result.note}`);
  assert.equal(result.sourceOdds, 2.6, "selection '1' must resolve to Górnik Zabrze's price, confirming home/away order is preserved");
});

test("verifyOdds: Cyrillic event text home/away order is preserved even reversed against the provider's own listing", async () => {
  mockEvents([h2hEvent("Górnik Zabrze", "Fenerbahce", standardOutcomes("Górnik Zabrze", "Fenerbahce", 2.6, 2.75))]);

  // Player's text lists Fenerbahce first — the opposite of the provider's
  // home_team/away_team order.
  const result = await verifyOdds(
    bet({ sport: "champions league qualification", event: "Фенербахче — Гурник Забже", selection: "1", odds: 2.75 }),
  );

  assert.equal(result.matched, true);
  assert.equal(result.sourceOdds, 2.75, "selection '1' must resolve to Fenerbahce (listed first in the parsed text), not the provider's home_team");
});

test("verifyOdds: outcome matching — selection 'Фенербахче Win' correctly resolves to the provider's 'Fenerbahce' outcome", async () => {
  mockEvents([h2hEvent("Górnik Zabrze", "Fenerbahce", standardOutcomes("Górnik Zabrze", "Fenerbahce", 2.6, 2.75))]);

  const result = await verifyOdds(
    bet({
      sport: "champions league qualification",
      event: "Гурник Забже — Фенербахче",
      selection: "Фенербахче Win",
      odds: 2.75,
    }),
  );

  assert.equal(result.matched, true, `expected 'Фенербахче Win' to resolve to the Fenerbahce outcome; note: ${result.note}`);
  assert.equal(result.sourceOdds, 2.75);
});

test("verifyOdds: Cyrillic event text does not falsely match a genuinely unrelated event", async () => {
  mockEvents([h2hEvent("Real Madrid", "Barcelona", standardOutcomes("Real Madrid", "Barcelona", 1.9, 4.1))]);

  const result = await verifyOdds(
    bet({ sport: "champions league qualification", event: "Гурник Забже — Фенербахче", selection: "1", odds: 2.6 }),
  );

  assert.equal(result.matched, false);
  assert.match(result.note ?? "", /No matching event found/);
});

test("verifyOdds: an empty or punctuation-only event string safely resolves to no match, never throws", async () => {
  mockEvents([h2hEvent("Górnik Zabrze", "Fenerbahce", standardOutcomes("Górnik Zabrze", "Fenerbahce", 2.6, 2.75))]);

  const result = await verifyOdds(bet({ sport: "champions league qualification", event: "— ??? !!!", selection: "1", odds: 2.6 }));

  assert.equal(result.matched, false);
  assert.match(result.note ?? "", /No matching event found/);
});

test("verifyOdds: pre-existing Cyrillic TEAM_ALIASES entries still match the provider's event exactly as before (regression)", async () => {
  mockEvents([h2hEvent("Real Madrid", "Barcelona", standardOutcomes("Real Madrid", "Barcelona", 1.9, 4.1))]);

  const result = await verifyOdds(bet({ event: "Реал Мадрид vs Барселона", selection: "1", odds: 1.9 }));

  assert.equal(result.matched, true);
  assert.equal(result.sourceOdds, 1.9);
});

/* -------------------------------------------------------------------------- */
/* Production bugfix regression — single-team event matching                  */
/* -------------------------------------------------------------------------- */
// Root cause: findMatchingEvent()'s no-explicit-opponent branch used to score
// the query against the CONCATENATED "home away" string, so the opponent's
// own name words inflated the denominator and capped the score below
// EVENT_MATCH_THRESHOLD for any multi-word opponent — even for a perfect
// single-team match (e.g. "Arsenal" against "Arsenal vs Coventry City").
// Fixed by scoring the query against home/away separately (max of the two),
// plus an exact-match/future-preference ranking tier so multiple candidates
// are never silently guessed.

function footballFixtures(soccerEplEvents: unknown[]): Record<string, unknown[]> {
  const fixtures = Object.fromEntries(ALL_FOOTBALL_SPORT_KEYS.map((key) => [key, []])) as Record<string, unknown[]>;
  fixtures.soccer_epl = soccerEplEvents;
  return fixtures;
}

test("Regression: single-team query 'Arsenal' finds Arsenal vs Coventry City", async () => {
  mockEventsBySportKey(footballFixtures([h2hEventWithId("evt-arsenal-1", "Arsenal", "Coventry City", standardOutcomes("Arsenal", "Coventry City", 1.16, 15.98))]));

  const result = await verifyOdds(bet({ sport: "football", event: "Arsenal", selection: "Arsenal Win", odds: null }));

  assert.equal(result.matched, true, result.note ?? "expected a match");
  assert.equal(result.sourceOdds, 1.16);
});

test("Regression: single-team query 'Coventry' finds the same Arsenal vs Coventry City event", async () => {
  mockEventsBySportKey(footballFixtures([h2hEventWithId("evt-arsenal-2", "Arsenal", "Coventry City", standardOutcomes("Arsenal", "Coventry City", 1.16, 15.98))]));

  const result = await verifyOdds(bet({ sport: "football", event: "Coventry", selection: "Coventry City Win", odds: null }));

  assert.equal(result.matched, true, result.note ?? "expected a match");
  assert.equal(result.sourceOdds, 15.98);
});

test("Regression: a multi-word single-team query ('Manchester United') works, not only single-word team names", async () => {
  mockEventsBySportKey(footballFixtures([h2hEventWithId("evt-mu-1", "Manchester United", "Chelsea", standardOutcomes("Manchester United", "Chelsea", 2.0, 3.5))]));

  const result = await verifyOdds(bet({ sport: "football", event: "Manchester United", selection: "Manchester United Win", odds: null }));

  assert.equal(result.matched, true, result.note ?? "expected a match");
  assert.equal(result.sourceOdds, 2.0);
});

test("Regression: a weak/unrelated single-team query stays below threshold — NOT_FOUND, not guessed", async () => {
  mockEventsBySportKey(footballFixtures([h2hEventWithId("evt-arsenal-3", "Arsenal", "Coventry City", standardOutcomes("Arsenal", "Coventry City", 1.16, 15.98))]));

  const result = await verifyOdds(bet({ sport: "football", event: "West Ham", selection: "West Ham Win", odds: null }));

  assert.equal(result.matched, false);
  assert.match(result.note ?? "", /No matching event found/);
});

test("Regression: an exact single-team match wins over a weaker fuzzy candidate, never flagged ambiguous", async () => {
  mockEventsBySportKey(
    footballFixtures([
      // Exact match for "Arsenal".
      h2hEventWithId("evt-arsenal-exact", "Arsenal", "Coventry City", standardOutcomes("Arsenal", "Coventry City", 1.16, 15.98)),
      // A different, real club whose name merely CONTAINS "Arsenal" as one
      // of two words — a genuine fuzzy candidate (score 0.5, clears
      // threshold) but never a literal exact match.
      h2hEventWithId("evt-arsenal-sarandi", "Arsenal Sarandi", "River Plate", standardOutcomes("Arsenal Sarandi", "River Plate", 4.0, 1.8)),
    ]),
  );

  const result = await verifyOdds(bet({ sport: "football", event: "Arsenal", selection: "Arsenal Win", odds: null }));

  assert.equal(result.matched, true, result.note ?? "expected the exact match to win, not an ambiguity");
  assert.equal(result.sourceOdds, 1.16, "must resolve to the exact 'Arsenal' match, not 'Arsenal Sarandi'");
});

test("Regression: two equally exact future matches for the same team name return AMBIGUOUS, never guessed", async () => {
  const future1 = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const future2 = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();

  mockEventsBySportKey(
    footballFixtures([
      h2hEventWithId("evt-arsenal-friendly-1", "Arsenal", "Coventry City", standardOutcomes("Arsenal", "Coventry City", 1.16, 15.98), future1),
      h2hEventWithId("evt-arsenal-friendly-2", "Arsenal", "Girona", standardOutcomes("Arsenal", "Girona", 1.3, 9.0), future2),
    ]),
  );

  const result = await verifyOdds(bet({ sport: "football", event: "Arsenal", selection: "Arsenal Win", odds: null }));

  assert.equal(result.matched, false);
  assert.match(result.note ?? "", /Ambiguous event match/);
});

test("Regression: a past match never wins over a future match for the same team name", async () => {
  const past = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

  mockEventsBySportKey(
    footballFixtures([
      h2hEventWithId("evt-arsenal-past", "Arsenal", "Everton", standardOutcomes("Arsenal", "Everton", 1.5, 6.0), past),
      h2hEventWithId("evt-arsenal-future", "Arsenal", "Coventry City", standardOutcomes("Arsenal", "Coventry City", 1.16, 15.98), future),
    ]),
  );

  const result = await verifyOdds(bet({ sport: "football", event: "Arsenal", selection: "Arsenal Win", odds: null }));

  assert.equal(result.matched, true, result.note ?? "expected the future match to be selected");
  assert.equal(result.sourceOdds, 1.16, "must resolve to the FUTURE Arsenal vs Coventry City match, not the past Arsenal vs Everton one");
});

test("Regression: an explicit two-team query ('Team A vs Team B') is completely unaffected by the single-team fix", async () => {
  mockEventsBySportKey(footballFixtures([h2hEventWithId("evt-arsenal-4", "Arsenal", "Coventry City", standardOutcomes("Arsenal", "Coventry City", 1.16, 15.98))]));

  const result = await verifyOdds(bet({ sport: "football", event: "Arsenal vs Coventry City", selection: "Arsenal Win", odds: null }));

  assert.equal(result.matched, true, result.note ?? "expected a match");
  assert.equal(result.sourceOdds, 1.16);
});

/* ============================================================================
 * Betting Markets V1, Phase 3.1 — Totals fetch + pure outcome lookup.
 * fetchTotalsOddsForSport()/findTotalsOutcome() are not called by verifyOdds()
 * or anything else in the live pipeline yet (Phase 3.1 scope) — these tests
 * exercise them directly, the same fetch-stub/no-real-network discipline as
 * every test above.
 * ============================================================================ */

function marketsParamFromUrl(url: string): string {
  const match = /[?&]markets=([^&]+)/.exec(url);
  if (!match) throw new Error(`oddsVerifier.test.ts: could not extract markets= from URL "${url}"`);
  return match[1];
}

function totalsOutcome(name: string, price: number, point: number | undefined): OddsApiOutcome {
  return point === undefined ? { name, price } : { name, price, point };
}

function totalsEvent(
  homeTeam: string,
  awayTeam: string,
  bookmakers: OddsApiBookmaker[],
): OddsApiEvent {
  return { id: "evt-totals-1", home_team: homeTeam, away_team: awayTeam, bookmakers };
}

function pinnacleTotalsBookmaker(outcomes: OddsApiOutcome[]): OddsApiBookmaker {
  return { key: "pinnacle", title: "Pinnacle", markets: [{ key: "totals", outcomes }] };
}

test("Phase 3.1 fetch: fetchTotalsOddsForSport requests markets=totals, not h2h", async () => {
  let requestedUrl = "";
  currentHandler = async (url: string) => {
    requestedUrl = url;
    return jsonResponse([]);
  };

  await fetchTotalsOddsForSport("soccer_epl");

  assert.equal(marketsParamFromUrl(requestedUrl), "totals");
});

test("Phase 3.1 fetch: verifyOdds() (h2h) still requests exactly markets=h2h, unaffected by the totals path existing", async () => {
  let requestedUrl = "";
  currentHandler = async (url: string) => {
    requestedUrl = url;
    return jsonResponse([h2hEvent("Arsenal", "Chelsea", standardOutcomes("Arsenal", "Chelsea", 1.9, 3.8))]);
  };

  await verifyOdds(bet({ sport: "football", event: "Arsenal vs Chelsea", selection: "1", odds: 1.9 }));

  assert.equal(marketsParamFromUrl(requestedUrl), "h2h");
});

test("Phase 3.1 cache: an h2h response never satisfies a totals request for the same sport_key, or vice versa", async () => {
  let callCount = 0;
  currentHandler = async (url: string) => {
    callCount += 1;
    const market = marketsParamFromUrl(url);
    return jsonResponse([{ id: `evt-${market}`, home_team: "Arsenal", away_team: "Chelsea", bookmakers: [] }]);
  };

  // "premier league" (a single-sport_key alias, soccer_epl) rather than
  // generic "football" — the latter fans out across all 7 supported
  // competitions (Step 16A), which would make the "exactly once" assertion
  // below actually mean "exactly seven," obscuring the one thing this test
  // exists to prove: h2h and totals get separate cache entries.
  await verifyOdds(bet({ sport: "premier league", event: "Arsenal vs Chelsea", selection: "1", odds: 1.9 }));
  assert.equal(callCount, 1, "the h2h request itself must hit the network exactly once");

  const totalsEvents = await fetchTotalsOddsForSport("soccer_epl");
  assert.equal(callCount, 2, "a totals request for the same sport_key must NOT be served from the h2h cache entry — it must be a real second fetch");
  assert.equal(totalsEvents[0].id, "evt-totals", "must return the totals-specific payload, not the h2h one");

  // A second h2h-shaped call (via verifyOdds, still within the 45s TTL)
  // should now be served from ITS OWN cache entry, not force a third fetch.
  await verifyOdds(bet({ sport: "premier league", event: "Arsenal vs Chelsea", selection: "1", odds: 1.9 }));
  assert.equal(callCount, 2, "the h2h cache entry (separate key from totals) must still be warm and reused");
});

test("Phase 3.1 lookup: Over 2.5 exact match", () => {
  const event = totalsEvent("Arsenal", "Chelsea", [
    pinnacleTotalsBookmaker([totalsOutcome("Over", 1.85, 2.5), totalsOutcome("Under", 1.95, 2.5)]),
  ]);

  const result = findTotalsOutcome(event, "OVER", "2.5");

  assert.equal(result.kind, "MATCHED");
  if (result.kind !== "MATCHED") return;
  assert.equal(result.price, 1.85);
  assert.equal(result.point, "2.5");
  assert.equal(result.bookmaker, "Pinnacle");
  assert.equal(result.marketKey, "totals");
  assert.equal(result.isFallbackBookmaker, false);
});

test("Phase 3.1 lookup: Under 2.5 exact match", () => {
  const event = totalsEvent("Arsenal", "Chelsea", [
    pinnacleTotalsBookmaker([totalsOutcome("Over", 1.85, 2.5), totalsOutcome("Under", 1.95, 2.5)]),
  ]);

  const result = findTotalsOutcome(event, "UNDER", "2.5");

  assert.equal(result.kind, "MATCHED");
  if (result.kind !== "MATCHED") return;
  assert.equal(result.price, 1.95);
  assert.equal(result.point, "2.5");
});

test("Phase 3.1 lookup: multiple available lines — requested 2.5 does not match 3.5, never a closest-line fallback", () => {
  const event = totalsEvent("Arsenal", "Chelsea", [
    pinnacleTotalsBookmaker([
      totalsOutcome("Over", 1.7, 3.5),
      totalsOutcome("Under", 2.1, 3.5),
    ]),
  ]);

  const result = findTotalsOutcome(event, "OVER", "2.5");

  assert.equal(result.kind, "LINE_NOT_AVAILABLE");
});

test("Phase 3.1 lookup: a totals market with only the requested-but-absent single line still reports LINE_NOT_AVAILABLE (missing requested line)", () => {
  const event = totalsEvent("Arsenal", "Chelsea", [
    pinnacleTotalsBookmaker([totalsOutcome("Over", 1.7, 1.5), totalsOutcome("Under", 2.2, 1.5)]),
  ]);

  const result = findTotalsOutcome(event, "OVER", "4.5");

  assert.equal(result.kind, "LINE_NOT_AVAILABLE");
});

test("Phase 3.1 lookup: an Over outcome missing `point` entirely reports MISSING_POINT, never crashes or silently matches", () => {
  const event = totalsEvent("Arsenal", "Chelsea", [
    pinnacleTotalsBookmaker([totalsOutcome("Over", 1.85, undefined), totalsOutcome("Under", 1.95, 2.5)]),
  ]);

  const result = findTotalsOutcome(event, "OVER", "2.5");

  assert.equal(result.kind, "MISSING_POINT");
});

test("Phase 3.1 lookup: a malformed `point` (non-finite) reports MALFORMED_POINT, never coerced or crashed on", () => {
  const event = totalsEvent("Arsenal", "Chelsea", [
    pinnacleTotalsBookmaker([{ name: "Over", price: 1.85, point: NaN }, totalsOutcome("Under", 1.95, 2.5)]),
  ]);

  const result = findTotalsOutcome(event, "OVER", "2.5");

  assert.equal(result.kind, "MALFORMED_POINT");
});

test("Phase 3.1 lookup: no 'totals' market on the picked bookmaker reports MARKET_ABSENT", () => {
  const event = totalsEvent("Arsenal", "Chelsea", [
    { key: "pinnacle", title: "Pinnacle", markets: [{ key: "h2h", outcomes: [] }] },
  ]);

  const result = findTotalsOutcome(event, "OVER", "2.5");

  assert.equal(result.kind, "MARKET_ABSENT");
});

test("Phase 3.1 lookup: zero outcomes named Over/Under on an existing totals market reports OUTCOME_ABSENT", () => {
  const event = totalsEvent("Arsenal", "Chelsea", [
    pinnacleTotalsBookmaker([{ name: "Draw No Bet", price: 1.5, point: 0 }]),
  ]);

  const result = findTotalsOutcome(event, "OVER", "2.5");

  assert.equal(result.kind, "OUTCOME_ABSENT");
});

test("Phase 3.1 lookup: no bookmaker at all on the event reports NO_BOOKMAKER", () => {
  const event = totalsEvent("Arsenal", "Chelsea", []);

  const result = findTotalsOutcome(event, "OVER", "2.5");

  assert.equal(result.kind, "NO_BOOKMAKER");
});

test("Phase 3.1 lookup: a malformed requestedLine is rejected up front as INVALID_REQUESTED_LINE, before any bookmaker/market work", () => {
  const event = totalsEvent("Arsenal", "Chelsea", [
    pinnacleTotalsBookmaker([totalsOutcome("Over", 1.85, 2.5)]),
  ]);

  const result = findTotalsOutcome(event, "OVER", "not-a-number");

  assert.equal(result.kind, "INVALID_REQUESTED_LINE");
});

test("Phase 3.1 lookup: a '+2.5' requestedLine is accepted and canonicalized, matching the domain-wide line convention (Betting Markets V1 Phase 2 review fix)", () => {
  const event = totalsEvent("Arsenal", "Chelsea", [
    pinnacleTotalsBookmaker([totalsOutcome("Over", 1.85, 2.5)]),
  ]);

  const result = findTotalsOutcome(event, "OVER", "+2.5");

  assert.equal(result.kind, "MATCHED");
});

test("Phase 3.1 lookup: fallback bookmaker behavior remains correct — no Pinnacle present, uses the first bookmaker in provider order (H5-A4.1: via orderedBookmakersForFallback, both bookmakers here happen to share the same line so this doesn't exercise the multi-line fallback itself — see the dedicated H5-A4.1 section below for that)", () => {
  const event = totalsEvent("Arsenal", "Chelsea", [
    { key: "bet365", title: "Bet365", markets: [{ key: "totals", outcomes: [totalsOutcome("Over", 1.8, 2.5), totalsOutcome("Under", 2.0, 2.5)] }] },
    { key: "williamhill", title: "William Hill", markets: [{ key: "totals", outcomes: [totalsOutcome("Over", 1.75, 2.5), totalsOutcome("Under", 2.05, 2.5)] }] },
  ]);

  const result = findTotalsOutcome(event, "OVER", "2.5");

  assert.equal(result.kind, "MATCHED");
  if (result.kind !== "MATCHED") return;
  assert.equal(result.bookmaker, "Bet365", "must select the first bookmaker in provider response order");
  assert.equal(result.price, 1.8);
  assert.equal(result.isFallbackBookmaker, true);
});

/* -------------------------------------------------------------------------- */
/* H4-B5.6 — TOTALS regression: normalizeLineString is shared by             */
/* findTotalsOutcome too (via canonicalizeProviderPoint), so the same         */
/* trailing-zero equivalence must hold here, with the same exact-line        */
/* safety guarantee (2.25 must never equal 2.5; 2.75 must never equal 3).    */
/* This stage does not implement Asian Totals — only decimal-string          */
/* representation equivalence for the totals lines already supported.       */
/* -------------------------------------------------------------------------- */

test("H4-B5.6 TOTALS: requested '2.0' matches a provider point of 2 (whole-number trailing zero)", () => {
  const event = totalsEvent("Arsenal", "Chelsea", [pinnacleTotalsBookmaker([totalsOutcome("Over", 1.85, 2)])]);
  assert.equal(findTotalsOutcome(event, "OVER", "2.0").kind, "MATCHED");
});

test("H4-B5.6 TOTALS: requested '2.50' matches a provider point of 2.5 (half-line trailing zero)", () => {
  const event = totalsEvent("Arsenal", "Chelsea", [pinnacleTotalsBookmaker([totalsOutcome("Over", 1.85, 2.5)])]);
  assert.equal(findTotalsOutcome(event, "OVER", "2.50").kind, "MATCHED");
});

test("H4-B5.6 TOTALS: exact-line safety preserved — 2.25 never matches a provider point of 2.5, and 2.75 never matches 3", () => {
  const quarterEvent = totalsEvent("Arsenal", "Chelsea", [pinnacleTotalsBookmaker([totalsOutcome("Over", 1.85, 2.5)])]);
  assert.equal(findTotalsOutcome(quarterEvent, "OVER", "2.25").kind, "LINE_NOT_AVAILABLE");

  const threeEvent = totalsEvent("Arsenal", "Chelsea", [pinnacleTotalsBookmaker([totalsOutcome("Over", 1.85, 3)])]);
  assert.equal(findTotalsOutcome(threeEvent, "OVER", "2.75").kind, "LINE_NOT_AVAILABLE");
});

/* ============================================================================
 * H5-A4.1 — TOTALS bookmaker fallback fix. Live-proven production bug
 * (H5-A4's audit, real Arsenal vs Coventry City fixture): findTotalsOutcome
 * used to commit to a single bookmaker (pickBookmaker()) before checking
 * whether it had the requested line — Pinnacle only listed 3.0, so 2.5
 * (offered by 1xBet/William Hill/others in the SAME response) and 3.5
 * (offered by Tipico) were reported LINE_NOT_AVAILABLE even though they
 * genuinely existed. Now uses orderedBookmakersForFallback() — the exact
 * same shared helper findSpreadOutcome() already used since Handicap Stage
 * H1.1 — mirroring that fix's own test structure one-for-one.
 * ============================================================================ */

function totalsBookmaker(key: string, title: string, outcomes: OddsApiOutcome[]): OddsApiBookmaker {
  return { key, title, markets: [{ key: "totals", outcomes }] };
}

test("H5-A4.1 PRODUCTION REGRESSION: Arsenal — Coventry City — Pinnacle only has 3.0, 1xBet has the exact 2.5 the player requested -> 1xBet is selected, never Pinnacle, never a failure", () => {
  const event = totalsEvent("Arsenal", "Coventry City", [
    totalsBookmaker("pinnacle", "Pinnacle", [totalsOutcome("Over", 1.95, 3), totalsOutcome("Under", 1.88, 3)]),
    totalsBookmaker("onexbet", "1xBet", [totalsOutcome("Over", 1.64, 2.5), totalsOutcome("Under", 2.47, 2.5)]),
  ]);

  const result = findTotalsOutcome(event, "OVER", "2.5");

  assert.equal(result.kind, "MATCHED");
  if (result.kind !== "MATCHED") return;
  assert.equal(result.bookmaker, "1xBet");
  assert.equal(result.price, 1.64);
  assert.equal(result.point, "2.5");
  assert.equal(result.isFallbackBookmaker, true);
});

test("H5-A4.1 PRODUCTION REGRESSION, full pipeline: verifyTotalsOdds end-to-end reproduces the same exact result via the fetch layer", async () => {
  mockEvents([
    totalsFetchEvent("evt-arsenal-coventry-totals", "Arsenal", "Coventry City", [
      totalsBookmaker("pinnacle", "Pinnacle", [totalsOutcome("Over", 1.95, 3), totalsOutcome("Under", 1.88, 3)]),
      totalsBookmaker("onexbet", "1xBet", [totalsOutcome("Over", 1.64, 2.5), totalsOutcome("Under", 2.47, 2.5)]),
    ]),
  ]);

  const result = await verifyTotalsOdds({ sport: "premier league", event: "Arsenal vs Coventry City", direction: "OVER", line: "2.5", odds: null });

  assert.equal(result.matched, true, result.note ?? "expected a match");
  assert.equal(result.sourceOdds, 1.64);
  assert.equal(result.bookmaker, "1xBet");
});

/* --- A. Preferred bookmaker has the exact line --------------------------- */

test("H5-A4.1 (A): Pinnacle has the requested line -> Pinnacle used, no fallback needed", () => {
  const event = totalsEvent("Arsenal", "Coventry City", [
    totalsBookmaker("pinnacle", "Pinnacle", [totalsOutcome("Over", 1.9, 2.5), totalsOutcome("Under", 1.95, 2.5)]),
    totalsBookmaker("onexbet", "1xBet", [totalsOutcome("Over", 1.95, 2.5), totalsOutcome("Under", 1.9, 2.5)]),
  ]);

  const result = findTotalsOutcome(event, "OVER", "2.5");

  assert.equal(result.kind, "MATCHED");
  if (result.kind !== "MATCHED") return;
  assert.equal(result.bookmaker, "Pinnacle", "preferred bookmaker must win when it has the exact line, even though 1xBet's price (1.95) is HIGHER — this is availability fallback, not best-price shopping");
  assert.equal(result.price, 1.9);
  assert.equal(result.isFallbackBookmaker, false);
});

/* --- B/C/D. Pinnacle lacks the line, exact fallback to 1xBet (2.5) ------- */

test("H5-A4.1 (B/C): Pinnacle lacks the exact line, fallback bookmaker (1xBet) has exact 2.5 -> fallback succeeds, OVER 2.5 uses 1xBet", () => {
  const event = totalsEvent("Arsenal", "Coventry City", [
    totalsBookmaker("pinnacle", "Pinnacle", [totalsOutcome("Over", 1.95, 3), totalsOutcome("Under", 1.88, 3)]),
    totalsBookmaker("onexbet", "1xBet", [totalsOutcome("Over", 1.64, 2.5), totalsOutcome("Under", 2.47, 2.5)]),
  ]);

  const result = findTotalsOutcome(event, "OVER", "2.5");

  assert.equal(result.kind, "MATCHED");
  if (result.kind !== "MATCHED") return;
  assert.equal(result.bookmaker, "1xBet");
  assert.equal(result.price, 1.64);
  assert.equal(result.isFallbackBookmaker, true);
});

test("H5-A4.1 (D): same fixture, UNDER 2.5 also falls back to 1xBet", () => {
  const event = totalsEvent("Arsenal", "Coventry City", [
    totalsBookmaker("pinnacle", "Pinnacle", [totalsOutcome("Over", 1.95, 3), totalsOutcome("Under", 1.88, 3)]),
    totalsBookmaker("onexbet", "1xBet", [totalsOutcome("Over", 1.64, 2.5), totalsOutcome("Under", 2.47, 2.5)]),
  ]);

  const result = findTotalsOutcome(event, "UNDER", "2.5");

  assert.equal(result.kind, "MATCHED");
  if (result.kind !== "MATCHED") return;
  assert.equal(result.bookmaker, "1xBet");
  assert.equal(result.price, 2.47);
  assert.equal(result.isFallbackBookmaker, true);
});

/* --- E/F. Pinnacle lacks the line, exact fallback to Tipico (3.5) -------- */

test("H5-A4.1 (E): Pinnacle has 3.0, Tipico has the exact 3.5 the player requested -> Tipico used for OVER 3.5", () => {
  const event = totalsEvent("Arsenal", "Coventry City", [
    totalsBookmaker("pinnacle", "Pinnacle", [totalsOutcome("Over", 1.95, 3), totalsOutcome("Under", 1.88, 3)]),
    totalsBookmaker("tipico_de", "Tipico", [totalsOutcome("Over", 2.25, 3.5), totalsOutcome("Under", 1.6, 3.5)]),
  ]);

  const result = findTotalsOutcome(event, "OVER", "3.5");

  assert.equal(result.kind, "MATCHED");
  if (result.kind !== "MATCHED") return;
  assert.equal(result.bookmaker, "Tipico");
  assert.equal(result.price, 2.25);
  assert.equal(result.isFallbackBookmaker, true);
});

test("H5-A4.1 (F): same fixture, UNDER 3.5 also falls back to Tipico", () => {
  const event = totalsEvent("Arsenal", "Coventry City", [
    totalsBookmaker("pinnacle", "Pinnacle", [totalsOutcome("Over", 1.95, 3), totalsOutcome("Under", 1.88, 3)]),
    totalsBookmaker("tipico_de", "Tipico", [totalsOutcome("Over", 2.25, 3.5), totalsOutcome("Under", 1.6, 3.5)]),
  ]);

  const result = findTotalsOutcome(event, "UNDER", "3.5");

  assert.equal(result.kind, "MATCHED");
  if (result.kind !== "MATCHED") return;
  assert.equal(result.bookmaker, "Tipico");
  assert.equal(result.price, 1.6);
  assert.equal(result.isFallbackBookmaker, true);
});

/* --- G/H/I. No bookmaker has the exact line ------------------------------ */

test("H5-A4.1 (G): no bookmaker (preferred or fallback) has the exact requested line -> LINE_NOT_AVAILABLE, no substitute chosen", () => {
  const event = totalsEvent("Arsenal", "Coventry City", [
    totalsBookmaker("pinnacle", "Pinnacle", [totalsOutcome("Over", 1.95, 3), totalsOutcome("Under", 1.88, 3)]),
    totalsBookmaker("onexbet", "1xBet", [totalsOutcome("Over", 1.64, 2.5), totalsOutcome("Under", 2.47, 2.5)]),
    totalsBookmaker("tipico_de", "Tipico", [totalsOutcome("Over", 2.25, 3.5), totalsOutcome("Under", 1.6, 3.5)]),
  ]);

  const result = findTotalsOutcome(event, "OVER", "4");

  assert.equal(result.kind, "LINE_NOT_AVAILABLE");
});

test("H5-A4.1 (H): requested 2.5, provider only has 2.25/3.0/3.5 across every bookmaker -> NO MATCH, never nearest-line", () => {
  const event = totalsEvent("Arsenal", "Coventry City", [
    totalsBookmaker("pinnacle", "Pinnacle", [totalsOutcome("Over", 1.95, 3), totalsOutcome("Under", 1.88, 3)]),
    totalsBookmaker("quarter-book", "Quarter Book", [totalsOutcome("Over", 1.7, 2.25), totalsOutcome("Under", 2.1, 2.25)]),
    totalsBookmaker("tipico_de", "Tipico", [totalsOutcome("Over", 2.25, 3.5), totalsOutcome("Under", 1.6, 3.5)]),
  ]);

  const result = findTotalsOutcome(event, "OVER", "2.5");

  assert.equal(result.kind, "LINE_NOT_AVAILABLE");
});

test("H5-A4.1 (I): requested 3.5, provider has only 3.0 across every bookmaker -> NO MATCH", () => {
  const event = totalsEvent("Arsenal", "Coventry City", [
    totalsBookmaker("pinnacle", "Pinnacle", [totalsOutcome("Over", 1.95, 3), totalsOutcome("Under", 1.88, 3)]),
    totalsBookmaker("coolbet", "Coolbet", [totalsOutcome("Over", 1.93, 3), totalsOutcome("Under", 1.93, 3)]),
  ]);

  const result = findTotalsOutcome(event, "OVER", "3.5");

  assert.equal(result.kind, "LINE_NOT_AVAILABLE");
});

/* --- J. Deterministic ordering -------------------------------------------- */

test("H5-A4.1 (J): several fallback bookmakers have the exact line -> the FIRST one in deterministic provider order wins, never the best price", () => {
  const event = totalsEvent("Arsenal", "Coventry City", [
    totalsBookmaker("pinnacle", "Pinnacle", [totalsOutcome("Over", 1.95, 3), totalsOutcome("Under", 1.88, 3)]),
    totalsBookmaker("bookmaker-a", "Bookmaker A", [totalsOutcome("Over", 1.5, 2.5), totalsOutcome("Under", 2.6, 2.5)]),
    totalsBookmaker("bookmaker-b", "Bookmaker B", [totalsOutcome("Over", 1.95, 2.5), totalsOutcome("Under", 1.85, 2.5)]),
  ]);

  const result = findTotalsOutcome(event, "OVER", "2.5");

  assert.equal(result.kind, "MATCHED");
  if (result.kind !== "MATCHED") return;
  assert.equal(result.bookmaker, "Bookmaker A", "must select the first eligible bookmaker in provider response order, never the higher-priced Bookmaker B");
  assert.equal(result.price, 1.5);
});

test("H5-A4.1: explicit no-best-price proof — a later, higher-priced fallback bookmaker never overrides an earlier, lower-priced eligible one", () => {
  const event = totalsEvent("Arsenal", "Coventry City", [
    totalsBookmaker("pinnacle", "Pinnacle", [totalsOutcome("Over", 1.95, 3), totalsOutcome("Under", 1.88, 3)]),
    totalsBookmaker("cheap-first", "Cheap First", [totalsOutcome("Over", 1.5, 2.5), totalsOutcome("Under", 2.6, 2.5)]),
    totalsBookmaker("expensive-second", "Expensive Second", [totalsOutcome("Over", 2.5, 2.5), totalsOutcome("Under", 1.5, 2.5)]),
  ]);

  const result = findTotalsOutcome(event, "OVER", "2.5");
  assert.equal(result.kind, "MATCHED");
  if (result.kind === "MATCHED") {
    assert.equal(result.bookmaker, "Cheap First");
    assert.equal(result.price, 1.5, "the FIRST eligible fallback bookmaker wins regardless of a later one offering better odds");
  }
});

/* --- Market safety: another bookmaker with no totals market at all ------- */

test("H5-A4.1: another bookmaker has an h2h market but no totals market at all -> never used as a market substitute", () => {
  const event = totalsEvent("Arsenal", "Coventry City", [
    { key: "pinnacle", title: "Pinnacle", markets: [{ key: "h2h", outcomes: [] }] },
    { key: "other", title: "Other Bookmaker", markets: [{ key: "h2h", outcomes: [{ name: "Arsenal", price: 1.5 }] }] },
  ]);

  const result = findTotalsOutcome(event, "OVER", "2.5");

  assert.equal(result.kind, "MARKET_ABSENT");
});

/* --- Quarter TOTALS lines also benefit from the fallback fix ------------- */

test("H5-A4.1: quarter TOTALS (2.25) also falls back correctly — Pinnacle has 2.5, a fallback bookmaker has the exact 2.25", () => {
  const event = totalsEvent("Arsenal", "Coventry City", [
    totalsBookmaker("pinnacle", "Pinnacle", [totalsOutcome("Over", 1.9, 2.5), totalsOutcome("Under", 1.9, 2.5)]),
    totalsBookmaker("quarter-book", "Quarter Book", [totalsOutcome("Over", 1.91, 2.25), totalsOutcome("Under", 1.85, 2.25)]),
  ]);

  const result = findTotalsOutcome(event, "OVER", "2.25");

  assert.equal(result.kind, "MATCHED");
  if (result.kind !== "MATCHED") return;
  assert.equal(result.bookmaker, "Quarter Book");
  assert.equal(result.price, 1.91);
  assert.equal(result.isFallbackBookmaker, true);
});

/* --- Only one provider fetch, never one per bookmaker --------------------- */

test("H5-A4.1: fallback across bookmakers happens entirely within the ALREADY-fetched event — verifyTotalsOdds still makes exactly one HTTP request", async () => {
  let fetchCount = 0;
  currentHandler = async () => {
    fetchCount += 1;
    return jsonResponse([
      totalsFetchEvent("evt-totals-onefetch", "Arsenal", "Coventry City", [
        totalsBookmaker("pinnacle", "Pinnacle", [totalsOutcome("Over", 1.95, 3), totalsOutcome("Under", 1.88, 3)]),
        totalsBookmaker("a", "A", [totalsOutcome("Over", 1.93, 3), totalsOutcome("Under", 1.93, 3)]),
        totalsBookmaker("onexbet", "1xBet", [totalsOutcome("Over", 1.64, 2.5), totalsOutcome("Under", 2.47, 2.5)]),
      ]),
    ]);
  };

  const result = await verifyTotalsOdds({ sport: "premier league", event: "Arsenal vs Coventry City", direction: "OVER", line: "2.5", odds: null });

  assert.equal(result.matched, true, result.note ?? "expected a match");
  assert.equal(fetchCount, 1, "inspecting multiple bookmakers must never trigger additional HTTP requests — the provider response already contains all bookmakers");
});

/* --- Full live-bug-shape fixture: all six requested selections ----------- */

test("H5-A4.1 live-bug-shape fixture: Pinnacle Over/Under 3, 1xBet Over/Under 2.5, Tipico Over/Under 3.5 -> every genuinely-offered selection now resolves to its real bookmaker/price", async () => {
  const fixture = () => [
    totalsFetchEvent("evt-live-bug-shape", "Arsenal", "Coventry City", [
      totalsBookmaker("pinnacle", "Pinnacle", [totalsOutcome("Over", 1.95, 3), totalsOutcome("Under", 1.88, 3)]),
      totalsBookmaker("onexbet", "1xBet", [totalsOutcome("Over", 1.64, 2.5), totalsOutcome("Under", 2.47, 2.5)]),
      totalsBookmaker("tipico_de", "Tipico", [totalsOutcome("Over", 2.25, 3.5), totalsOutcome("Under", 1.6, 3.5)]),
    ]),
  ];

  mockEvents(fixture());
  const over25 = await verifyTotalsOdds({ sport: "premier league", event: "Arsenal vs Coventry City", direction: "OVER", line: "2.5", odds: null });
  assert.equal(over25.matched, true);
  assert.equal(over25.bookmaker, "1xBet");
  assert.equal(over25.sourceOdds, 1.64);

  mockEvents(fixture());
  const under25 = await verifyTotalsOdds({ sport: "premier league", event: "Arsenal vs Coventry City", direction: "UNDER", line: "2.5", odds: null });
  assert.equal(under25.matched, true);
  assert.equal(under25.bookmaker, "1xBet");
  assert.equal(under25.sourceOdds, 2.47);

  mockEvents(fixture());
  const over3 = await verifyTotalsOdds({ sport: "premier league", event: "Arsenal vs Coventry City", direction: "OVER", line: "3", odds: null });
  assert.equal(over3.matched, true);
  assert.equal(over3.bookmaker, "Pinnacle");
  assert.equal(over3.sourceOdds, 1.95);

  mockEvents(fixture());
  const under3 = await verifyTotalsOdds({ sport: "premier league", event: "Arsenal vs Coventry City", direction: "UNDER", line: "3", odds: null });
  assert.equal(under3.matched, true);
  assert.equal(under3.bookmaker, "Pinnacle");
  assert.equal(under3.sourceOdds, 1.88);

  mockEvents(fixture());
  const over35 = await verifyTotalsOdds({ sport: "premier league", event: "Arsenal vs Coventry City", direction: "OVER", line: "3.5", odds: null });
  assert.equal(over35.matched, true);
  assert.equal(over35.bookmaker, "Tipico");
  assert.equal(over35.sourceOdds, 2.25);

  mockEvents(fixture());
  const under35 = await verifyTotalsOdds({ sport: "premier league", event: "Arsenal vs Coventry City", direction: "UNDER", line: "3.5", odds: null });
  assert.equal(under35.matched, true);
  assert.equal(under35.bookmaker, "Tipico");
  assert.equal(under35.sourceOdds, 1.6);
});

/* ============================================================================
 * Betting Markets V1, Phase 3.3 — verifyTotalsOdds(): the full fetch ->
 * event-match -> findTotalsOutcome pipeline, mirroring verifyOdds()'s own
 * end-to-end shape. "premier league" (single sport_key) is used throughout,
 * same reasoning as the Phase 3.1 cache test above (generic "football" fans
 * out across 7 competitions, which would obscure what each test is actually
 * proving).
 * ============================================================================ */

function totalsFetchEvent(id: string, homeTeam: string, awayTeam: string, bookmakers: OddsApiBookmaker[]): unknown {
  return { id, home_team: homeTeam, away_team: awayTeam, bookmakers };
}

test("verifyTotalsOdds: SINGLE Over 2.5 VERIFIED — submitted odds matches the provider's price within tolerance", async () => {
  mockEvents([
    totalsFetchEvent("evt-totals-over", "Arsenal", "Chelsea", [pinnacleTotalsBookmaker([totalsOutcome("Over", 1.9, 2.5), totalsOutcome("Under", 1.9, 2.5)])]),
  ]);

  const result = await verifyTotalsOdds({ sport: "premier league", event: "Arsenal vs Chelsea", direction: "OVER", line: "2.5", odds: 1.9 });

  assert.equal(result.matched, true, result.note ?? "expected a match");
  assert.equal(result.withinTolerance, true);
  assert.equal(result.sourceOdds, 1.9);
  assert.equal(result.discrepancyPercent, 0);
});

test("verifyTotalsOdds: SINGLE Under 2.5 VERIFIED — submitted odds matches the provider's price within tolerance", async () => {
  mockEvents([
    totalsFetchEvent("evt-totals-under", "Arsenal", "Chelsea", [pinnacleTotalsBookmaker([totalsOutcome("Over", 1.9, 2.5), totalsOutcome("Under", 1.95, 2.5)])]),
  ]);

  const result = await verifyTotalsOdds({ sport: "premier league", event: "Arsenal vs Chelsea", direction: "UNDER", line: "2.5", odds: 1.95 });

  assert.equal(result.matched, true, result.note ?? "expected a match");
  assert.equal(result.withinTolerance, true);
  assert.equal(result.sourceOdds, 1.95);
});

test("verifyTotalsOdds: ODDS_CHANGED when submitted odds differ from the provider's price beyond the existing tolerance", async () => {
  mockEvents([
    totalsFetchEvent("evt-totals-changed", "Arsenal", "Chelsea", [pinnacleTotalsBookmaker([totalsOutcome("Over", 2.5, 2.5), totalsOutcome("Under", 1.6, 2.5)])]),
  ]);

  // Player submitted 1.9, provider now shows 2.5 for Over 2.5 — well beyond
  // the 3% tolerance.
  const result = await verifyTotalsOdds({ sport: "premier league", event: "Arsenal vs Chelsea", direction: "OVER", line: "2.5", odds: 1.9 });

  assert.equal(result.matched, true, result.note ?? "expected a match (matched, just not within tolerance)");
  assert.equal(result.withinTolerance, false);
  assert.equal(result.sourceOdds, 2.5);
  assert.equal(result.submittedOdds, 1.9);
});

test("verifyTotalsOdds: requested 2.5 never matches a bookmaker that only offers 3.5 — FAILED, never a closest-line fallback", async () => {
  mockEvents([
    totalsFetchEvent("evt-totals-wrongline", "Arsenal", "Chelsea", [pinnacleTotalsBookmaker([totalsOutcome("Over", 1.7, 3.5), totalsOutcome("Under", 2.1, 3.5)])]),
  ]);

  const result = await verifyTotalsOdds({ sport: "premier league", event: "Arsenal vs Chelsea", direction: "OVER", line: "2.5", odds: 1.9 });

  assert.equal(result.matched, false);
  assert.ok(result.note?.includes("LINE_NOT_AVAILABLE"), `expected a LINE_NOT_AVAILABLE note, got: ${result.note}`);
});

test("verifyTotalsOdds: missing totals market on the bookmaker — FAILED", async () => {
  mockEvents([
    totalsFetchEvent("evt-totals-nomarket", "Arsenal", "Chelsea", [{ key: "pinnacle", title: "Pinnacle", markets: [{ key: "h2h", outcomes: [] }] }]),
  ]);

  const result = await verifyTotalsOdds({ sport: "premier league", event: "Arsenal vs Chelsea", direction: "OVER", line: "2.5", odds: 1.9 });

  assert.equal(result.matched, false);
  assert.ok(result.note?.includes("MARKET_ABSENT"), `expected a MARKET_ABSENT note, got: ${result.note}`);
});

test("verifyTotalsOdds: a malformed provider point — FAILED, never coerced or crashed on", async () => {
  mockEvents([
    // A string, not a number — NaN would round-trip through JSON as `null`
    // (JSON.stringify(NaN) === "null"), which is indistinguishable from a
    // genuinely absent point; a malformed-but-present value is what a real
    // non-numeric provider payload would actually look like on the wire.
    totalsFetchEvent("evt-totals-badpoint", "Arsenal", "Chelsea", [
      {
        key: "pinnacle",
        title: "Pinnacle",
        markets: [{ key: "totals", outcomes: [{ name: "Over", price: 1.9, point: "not-a-number" as unknown as number }, totalsOutcome("Under", 1.9, 2.5)] }],
      },
    ]),
  ]);

  const result = await verifyTotalsOdds({ sport: "premier league", event: "Arsenal vs Chelsea", direction: "OVER", line: "2.5", odds: 1.9 });

  assert.equal(result.matched, false);
  assert.ok(result.note?.includes("MALFORMED_POINT"), `expected a MALFORMED_POINT note, got: ${result.note}`);
});

test("verifyTotalsOdds: a missing provider point on the matched-direction outcome — FAILED", async () => {
  mockEvents([
    totalsFetchEvent("evt-totals-nopoint", "Arsenal", "Chelsea", [
      pinnacleTotalsBookmaker([totalsOutcome("Over", 1.9, undefined), totalsOutcome("Under", 1.9, 2.5)]),
    ]),
  ]);

  const result = await verifyTotalsOdds({ sport: "premier league", event: "Arsenal vs Chelsea", direction: "OVER", line: "2.5", odds: 1.9 });

  assert.equal(result.matched, false);
  assert.ok(result.note?.includes("MISSING_POINT"), `expected a MISSING_POINT note, got: ${result.note}`);
});

test("verifyTotalsOdds: event not found — FAILED, same note template as h2h", async () => {
  mockEvents([]);

  const result = await verifyTotalsOdds({ sport: "premier league", event: "Arsenal vs Chelsea", direction: "OVER", line: "2.5", odds: 1.9 });

  assert.equal(result.matched, false);
  assert.ok(result.note?.includes("No matching event found"), `expected an event-not-found note, got: ${result.note}`);
});

test("verifyTotalsOdds: provider fetch failure (unavailable) — FAILED, same fetch-error handling as h2h", async () => {
  currentHandler = async () => new Response("", { status: 500 });

  const result = await verifyTotalsOdds({ sport: "premier league", event: "Arsenal vs Chelsea", direction: "OVER", line: "2.5", odds: 1.9 });

  assert.equal(result.matched, false);
  assert.ok(result.note?.includes("status 500"), `expected an HTTP-failure note, got: ${result.note}`);
});

test("verifyTotalsOdds: provider event metadata (providerEventId/providerSportKey/eventStartTime) round-trips exactly like h2h", async () => {
  mockEvents([
    { ...(totalsFetchEvent("evt-totals-meta", "Arsenal", "Chelsea", [pinnacleTotalsBookmaker([totalsOutcome("Over", 1.9, 2.5), totalsOutcome("Under", 1.9, 2.5)])]) as object), commence_time: "2026-08-15T18:00:00.000Z" },
  ]);

  const result = await verifyTotalsOdds({ sport: "premier league", event: "Arsenal vs Chelsea", direction: "OVER", line: "2.5", odds: 1.9 });

  assert.equal(result.matched, true, result.note ?? "expected a match");
  assert.equal(result.providerEventId, "evt-totals-meta");
  assert.equal(result.providerSportKey, "soccer_epl");
  assert.equal(result.eventStartTime, "2026-08-15T18:00:00.000Z");
});

/* ============================================================================
 * Handicap Stage H1 — Spread fetch + pure outcome lookup + full verification
 * entry point. Mirrors the Totals section immediately above one-for-one:
 * same fetch-stub discipline, same fixture-building style, same test
 * ordering (fetch -> pure lookup -> full verifySpreadOdds pipeline).
 * ============================================================================ */

function spreadOutcome(name: string, price: number, point: number | undefined): OddsApiOutcome {
  return point === undefined ? { name, price } : { name, price, point };
}

function spreadEvent(homeTeam: string, awayTeam: string, bookmakers: OddsApiBookmaker[]): OddsApiEvent {
  return { id: "evt-spread-1", home_team: homeTeam, away_team: awayTeam, bookmakers };
}

function pinnacleSpreadBookmaker(outcomes: OddsApiOutcome[]): OddsApiBookmaker {
  return { key: "pinnacle", title: "Pinnacle", markets: [{ key: "spreads", outcomes }] };
}

test("Spread fetch: fetchSpreadOddsForSport requests markets=spreads, not h2h or totals", async () => {
  let requestedUrl = "";
  currentHandler = async (url: string) => {
    requestedUrl = url;
    return jsonResponse([]);
  };

  await fetchSpreadOddsForSport("soccer_epl");

  assert.equal(marketsParamFromUrl(requestedUrl), "spreads");
});

test("Spread cache: an h2h/totals response never satisfies a spreads request for the same sport_key, or vice versa", async () => {
  let callCount = 0;
  currentHandler = async (url: string) => {
    callCount += 1;
    const market = marketsParamFromUrl(url);
    return jsonResponse([{ id: `evt-${market}`, home_team: "Arsenal", away_team: "Chelsea", bookmakers: [] }]);
  };

  await verifyOdds(bet({ sport: "premier league", event: "Arsenal vs Chelsea", selection: "1", odds: 1.9 }));
  assert.equal(callCount, 1);

  const spreadEvents = await fetchSpreadOddsForSport("soccer_epl");
  assert.equal(callCount, 2, "a spreads request for the same sport_key must NOT be served from the h2h cache entry — it must be a real second fetch");
  assert.equal(spreadEvents[0].id, "evt-spreads", "must return the spreads-specific payload, not the h2h one");
});

/* -------------------------------------------------------------------------- */
/* findSpreadOutcome — pure lookup, several different teams/events per       */
/* section 13's mandate: no hardcoded team-specific behavior anywhere in the */
/* implementation.                                                           */
/* -------------------------------------------------------------------------- */

test("findSpreadOutcome: favorite negative line exact match (Arsenal -1.5)", () => {
  const event = spreadEvent("Arsenal", "Coventry City", [
    pinnacleSpreadBookmaker([spreadOutcome("Arsenal", 1.85, -1.5), spreadOutcome("Coventry City", 1.95, 1.5)]),
  ]);

  const result = findSpreadOutcome(event, "Arsenal", "-1.5");

  assert.equal(result.kind, "MATCHED");
  if (result.kind !== "MATCHED") return;
  assert.equal(result.price, 1.85);
  assert.equal(result.point, "-1.5");
  assert.equal(result.marketKey, "spreads");
  assert.equal(result.bookmaker, "Pinnacle");
  assert.equal(result.isFallbackBookmaker, false);
  assert.equal(result.outcomeName, "Arsenal");
});

test("findSpreadOutcome: underdog positive line exact match (Coventry City +1.5) — symmetric opposite side of the same test 8's example", () => {
  const event = spreadEvent("Arsenal", "Coventry City", [
    pinnacleSpreadBookmaker([spreadOutcome("Arsenal", 1.9, -1.5), spreadOutcome("Coventry City", 1.95, 1.5)]),
  ]);

  const result = findSpreadOutcome(event, "Coventry City", "+1.5");

  assert.equal(result.kind, "MATCHED");
  if (result.kind !== "MATCHED") return;
  assert.equal(result.price, 1.95, "must never use Arsenal's price merely because the absolute line value (1.5) matches");
  assert.equal(result.point, "1.5", "canonical form is unsigned-positive, matching domain.ts's normalizeLineString convention");
});

test("findSpreadOutcome: home side (Real Madrid -1)", () => {
  const event = spreadEvent("Real Madrid", "Barcelona", [
    pinnacleSpreadBookmaker([spreadOutcome("Real Madrid", 1.9, -1), spreadOutcome("Barcelona", 1.9, 1)]),
  ]);

  const result = findSpreadOutcome(event, "Real Madrid", "-1");

  assert.equal(result.kind, "MATCHED");
  if (result.kind !== "MATCHED") return;
  assert.equal(result.price, 1.9);
  assert.equal(result.point, "-1");
});

test("findSpreadOutcome: away side (Barcelona +1) — same event as the home-side test above", () => {
  const event = spreadEvent("Real Madrid", "Barcelona", [
    pinnacleSpreadBookmaker([spreadOutcome("Real Madrid", 1.85, -1), spreadOutcome("Barcelona", 1.98, 1)]),
  ]);

  const result = findSpreadOutcome(event, "Barcelona", "+1");

  assert.equal(result.kind, "MATCHED");
  if (result.kind !== "MATCHED") return;
  assert.equal(result.price, 1.98);
  assert.equal(result.point, "1");
});

test("findSpreadOutcome: multi-word team names (Manchester United -0.5 / Chelsea +0.5)", () => {
  const event = spreadEvent("Manchester United", "Chelsea", [
    pinnacleSpreadBookmaker([spreadOutcome("Manchester United", 1.8, -0.5), spreadOutcome("Chelsea", 2.0, 0.5)]),
  ]);

  const home = findSpreadOutcome(event, "Manchester United", "-0.5");
  assert.equal(home.kind, "MATCHED");
  if (home.kind === "MATCHED") assert.equal(home.price, 1.8);

  const away = findSpreadOutcome(event, "Chelsea", "0.5");
  assert.equal(away.kind, "MATCHED");
  if (away.kind === "MATCHED") assert.equal(away.price, 2.0);
});

test("findSpreadOutcome: multiple available lines for the same team — the exact requested line is selected, never the nearest one (mandatory test)", () => {
  const event = spreadEvent("Arsenal", "Coventry City", [
    pinnacleSpreadBookmaker([
      spreadOutcome("Arsenal", 1.4, -1),
      spreadOutcome("Arsenal", 1.85, -1.5),
      spreadOutcome("Arsenal", 2.3, -2),
      spreadOutcome("Coventry City", 2.9, 1),
      spreadOutcome("Coventry City", 1.95, 1.5),
      spreadOutcome("Coventry City", 1.6, 2),
    ]),
  ]);

  const minusOneHalf = findSpreadOutcome(event, "Arsenal", "-1.5");
  assert.equal(minusOneHalf.kind, "MATCHED");
  if (minusOneHalf.kind === "MATCHED") assert.equal(minusOneHalf.price, 1.85);

  const minusTwo = findSpreadOutcome(event, "Arsenal", "-2");
  assert.equal(minusTwo.kind, "MATCHED");
  if (minusTwo.kind === "MATCHED") assert.equal(minusTwo.price, 2.3);

  // -1.75 is not one of the three lines this bookmaker actually offers
  // (-1/-1.5/-2) — never substituted for the nearest neighbor.
  const quarterLine = findSpreadOutcome(event, "Arsenal", "-1.75");
  assert.equal(quarterLine.kind, "LINE_NOT_AVAILABLE");
});

test("findSpreadOutcome: requested line absent — LINE_NOT_AVAILABLE, never a nearest-line substitution", () => {
  const event = spreadEvent("Arsenal", "Coventry City", [
    pinnacleSpreadBookmaker([spreadOutcome("Arsenal", 1.85, -1), spreadOutcome("Coventry City", 1.95, 1)]),
  ]);

  const result = findSpreadOutcome(event, "Arsenal", "-1.5");

  assert.equal(result.kind, "LINE_NOT_AVAILABLE");
});

test("findSpreadOutcome: wrong/unrelated participant — PARTICIPANT_NOT_FOUND, never falls back to the other team's price", () => {
  const event = spreadEvent("Arsenal", "Coventry City", [
    pinnacleSpreadBookmaker([spreadOutcome("Arsenal", 1.85, -1.5), spreadOutcome("Coventry City", 1.95, 1.5)]),
  ]);

  const result = findSpreadOutcome(event, "Real Madrid", "-1.5");

  assert.equal(result.kind, "PARTICIPANT_NOT_FOUND");
});

test("findSpreadOutcome: right team, wrong line is not a match; right line, wrong team is not a match (section 8's exact requirement)", () => {
  const event = spreadEvent("Arsenal", "Coventry City", [
    pinnacleSpreadBookmaker([spreadOutcome("Arsenal", 1.9, -1.5), spreadOutcome("Coventry City", 1.95, 1.5)]),
  ]);

  assert.equal(findSpreadOutcome(event, "Arsenal", "1.5").kind, "LINE_NOT_AVAILABLE", "Arsenal has no +1.5 outcome");
  assert.equal(findSpreadOutcome(event, "Coventry City", "-1.5").kind, "LINE_NOT_AVAILABLE", "Coventry City has no -1.5 outcome");
});

test("findSpreadOutcome: no 'spreads' market on the picked bookmaker reports MARKET_ABSENT", () => {
  const event = spreadEvent("Arsenal", "Coventry City", [
    { key: "pinnacle", title: "Pinnacle", markets: [{ key: "h2h", outcomes: [] }] },
  ]);

  const result = findSpreadOutcome(event, "Arsenal", "-1.5");

  assert.equal(result.kind, "MARKET_ABSENT");
});

test("findSpreadOutcome: no bookmaker at all on the event reports NO_BOOKMAKER", () => {
  const event = spreadEvent("Arsenal", "Coventry City", []);

  const result = findSpreadOutcome(event, "Arsenal", "-1.5");

  assert.equal(result.kind, "NO_BOOKMAKER");
});

test("findSpreadOutcome: a malformed requestedLine is rejected up front as INVALID_REQUESTED_LINE, before any bookmaker/market work", () => {
  const event = spreadEvent("Arsenal", "Coventry City", [
    pinnacleSpreadBookmaker([spreadOutcome("Arsenal", 1.85, -1.5)]),
  ]);

  const result = findSpreadOutcome(event, "Arsenal", "not-a-number");

  assert.equal(result.kind, "INVALID_REQUESTED_LINE");
});

test("findSpreadOutcome: signed line is preserved exactly — the sign is never dropped, flipped, or coerced", () => {
  const event = spreadEvent("Arsenal", "Coventry City", [
    pinnacleSpreadBookmaker([spreadOutcome("Arsenal", 1.85, -1.5), spreadOutcome("Coventry City", 1.95, 1.5)]),
  ]);

  const negative = findSpreadOutcome(event, "Arsenal", "-1.5");
  assert.equal(negative.kind, "MATCHED");
  if (negative.kind === "MATCHED") assert.equal(negative.point, "-1.5");

  // A "+1.5" REQUEST is accepted and canonicalized (domain-wide convention),
  // but the underlying outcome's own point is genuinely positive — this
  // proves the sign itself (not merely the request string) round-trips
  // correctly, never silently becoming "-1.5" or an unsigned "1.5" meaning
  // something else.
  const positive = findSpreadOutcome(event, "Coventry City", "+1.5");
  assert.equal(positive.kind, "MATCHED");
  if (positive.kind === "MATCHED") assert.equal(positive.point, "1.5");
});

test("findSpreadOutcome: an outcome missing `point` entirely reports MISSING_POINT, never crashes or silently matches", () => {
  const event = spreadEvent("Arsenal", "Coventry City", [
    pinnacleSpreadBookmaker([spreadOutcome("Arsenal", 1.85, undefined), spreadOutcome("Coventry City", 1.95, 1.5)]),
  ]);

  const result = findSpreadOutcome(event, "Arsenal", "-1.5");

  assert.equal(result.kind, "MISSING_POINT");
});

test("findSpreadOutcome: a malformed `point` (non-finite) reports MALFORMED_POINT, never coerced or crashed on", () => {
  const event = spreadEvent("Arsenal", "Coventry City", [
    pinnacleSpreadBookmaker([{ name: "Arsenal", price: 1.85, point: NaN }, spreadOutcome("Coventry City", 1.95, 1.5)]),
  ]);

  const result = findSpreadOutcome(event, "Arsenal", "-1.5");

  assert.equal(result.kind, "MALFORMED_POINT");
});

test("findSpreadOutcome: fallback bookmaker behavior — no Pinnacle present, falls back to the first bookmaker, exactly like h2h/totals", () => {
  const event = spreadEvent("Arsenal", "Coventry City", [
    { key: "bet365", title: "Bet365", markets: [{ key: "spreads", outcomes: [spreadOutcome("Arsenal", 1.8, -1.5), spreadOutcome("Coventry City", 2.0, 1.5)] }] },
    { key: "williamhill", title: "William Hill", markets: [{ key: "spreads", outcomes: [spreadOutcome("Arsenal", 1.75, -1.5), spreadOutcome("Coventry City", 2.05, 1.5)] }] },
  ]);

  const result = findSpreadOutcome(event, "Arsenal", "-1.5");

  assert.equal(result.kind, "MATCHED");
  if (result.kind !== "MATCHED") return;
  assert.equal(result.bookmaker, "Bet365");
  assert.equal(result.price, 1.8);
  assert.equal(result.isFallbackBookmaker, true);
});

/* -------------------------------------------------------------------------- */
/* H4-B5.6 — live production bug fix: a requested line of "-2.0" and a       */
/* provider point of -2 (a JS number, which canonicalizes via String(-2) ->  */
/* "-2", never "-2.0") must MATCH — they are the identical handicap line.    */
/* Uses deterministic fixtures only (never live odds), per this stage's own  */
/* instruction.                                                              */
/* -------------------------------------------------------------------------- */

test("H4-B5.6: requested '-2.0' matches a provider point of -2 (the exact live production bug) — bookmaker Pinnacle, price 1.93", () => {
  const event = spreadEvent("Arsenal", "Coventry City", [
    pinnacleSpreadBookmaker([spreadOutcome("Arsenal", 1.93, -2), spreadOutcome("Coventry City", 1.92, 2)]),
  ]);

  const result = findSpreadOutcome(event, "Arsenal", "-2.0");

  assert.equal(result.kind, "MATCHED");
  if (result.kind !== "MATCHED") return;
  assert.equal(result.price, 1.93);
  assert.equal(result.bookmaker, "Pinnacle");
  assert.equal(result.point, "-2", "the canonical point is the trailing-zero-stripped form, matching what the provider itself canonicalizes to");
});

test("H4-B5.6: requested '-2.00' (two trailing zeros) also matches a provider point of -2", () => {
  const event = spreadEvent("Arsenal", "Coventry City", [
    pinnacleSpreadBookmaker([spreadOutcome("Arsenal", 1.93, -2), spreadOutcome("Coventry City", 1.92, 2)]),
  ]);

  const result = findSpreadOutcome(event, "Arsenal", "-2.00");
  assert.equal(result.kind, "MATCHED");
});

test("H4-B5.6: requested '+2.0' (redundant leading plus AND trailing zero) matches a provider point of 2", () => {
  const event = spreadEvent("Arsenal", "Coventry City", [
    pinnacleSpreadBookmaker([spreadOutcome("Arsenal", 2.1, 2), spreadOutcome("Coventry City", 1.7, -2)]),
  ]);

  const result = findSpreadOutcome(event, "Arsenal", "+2.0");
  assert.equal(result.kind, "MATCHED");
});

test("H4-B5.6: requested '-1.50' matches a provider point of -1.5 (half-line trailing zero)", () => {
  const event = spreadEvent("Arsenal", "Coventry City", [
    pinnacleSpreadBookmaker([spreadOutcome("Arsenal", 1.63, -1.5), spreadOutcome("Coventry City", 2.49, 1.5)]),
  ]);

  const result = findSpreadOutcome(event, "Arsenal", "-1.50");
  assert.equal(result.kind, "MATCHED");
  if (result.kind !== "MATCHED") return;
  assert.equal(result.price, 1.63);
});

test("H4-B5.6: quarter lines are completely unaffected by trailing-zero canonicalization — '-1.25' has no trailing zero to strip, still matches exactly, and a genuinely-added trailing zero ('-1.250') still canonicalizes correctly", () => {
  const event = spreadEvent("Arsenal", "Coventry City", [
    pinnacleSpreadBookmaker([spreadOutcome("Arsenal", 1.91, -1.25), spreadOutcome("Coventry City", 1.85, 1.25)]),
  ]);

  assert.equal(findSpreadOutcome(event, "Arsenal", "-1.25").kind, "MATCHED");
  assert.equal(findSpreadOutcome(event, "Arsenal", "-1.250").kind, "MATCHED", "a genuinely present trailing zero on a quarter line still canonicalizes and matches");
  assert.equal(findSpreadOutcome(event, "Coventry City", "1.25").kind, "MATCHED");
});

test("H4-B5.6: exact-line safety is fully preserved — trailing-zero canonicalization never causes a nearest-line/cross-line match", () => {
  const event = spreadEvent("Arsenal", "Coventry City", [
    pinnacleSpreadBookmaker([spreadOutcome("Arsenal", 1.63, -1.5), spreadOutcome("Coventry City", 2.49, 1.5)]),
  ]);

  // requested -2.0, provider only offers -1.5 -> NO MATCH
  assert.equal(findSpreadOutcome(event, "Arsenal", "-2.0").kind, "LINE_NOT_AVAILABLE");

  const quarterEvent = spreadEvent("Arsenal", "Coventry City", [
    pinnacleSpreadBookmaker([spreadOutcome("Arsenal", 1.91, -1.25), spreadOutcome("Coventry City", 1.85, 1.25)]),
  ]);
  // requested -1.25, provider only offers -1.5 -> NO MATCH
  assert.equal(findSpreadOutcome(quarterEvent, "Arsenal", "-1.5").kind, "LINE_NOT_AVAILABLE");

  const wholeEvent = spreadEvent("Arsenal", "Coventry City", [
    pinnacleSpreadBookmaker([spreadOutcome("Arsenal", 1.9, -1), spreadOutcome("Coventry City", 1.9, 1)]),
  ]);
  // requested -1.25, provider only offers -1 -> NO MATCH
  assert.equal(findSpreadOutcome(wholeEvent, "Arsenal", "-1.25").kind, "LINE_NOT_AVAILABLE");

  const halfEvent = spreadEvent("Arsenal", "Coventry City", [
    pinnacleSpreadBookmaker([spreadOutcome("Arsenal", 1.9, -0.5), spreadOutcome("Coventry City", 1.9, 0.5)]),
  ]);
  // requested -0.75, provider only offers -0.5 -> NO MATCH
  assert.equal(findSpreadOutcome(halfEvent, "Arsenal", "-0.75").kind, "LINE_NOT_AVAILABLE");
});

/* -------------------------------------------------------------------------- */
/* verifySpreadOdds — the full fetch -> event-match -> findSpreadOutcome     */
/* pipeline, mirroring verifyTotalsOdds' own end-to-end shape.               */
/* -------------------------------------------------------------------------- */

function spreadFetchEvent(id: string, homeTeam: string, awayTeam: string, bookmakers: OddsApiBookmaker[]): unknown {
  return { id, home_team: homeTeam, away_team: awayTeam, bookmakers };
}

test("verifySpreadOdds: Arsenal -1.5 VERIFIED — submitted odds matches the provider's price within tolerance", async () => {
  mockEvents([
    spreadFetchEvent("evt-spread-arsenal", "Arsenal", "Coventry City", [
      pinnacleSpreadBookmaker([spreadOutcome("Arsenal", 1.85, -1.5), spreadOutcome("Coventry City", 1.95, 1.5)]),
    ]),
  ]);

  const result = await verifySpreadOdds({ sport: "premier league", event: "Arsenal vs Coventry City", participant: "Arsenal", line: "-1.5", odds: 1.85 });

  assert.equal(result.matched, true, result.note ?? "expected a match");
  assert.equal(result.withinTolerance, true);
  assert.equal(result.sourceOdds, 1.85);
  assert.equal(result.discrepancyPercent, 0);
});

test("verifySpreadOdds: Real Madrid -1 VERIFIED (a second, different event/team pair)", async () => {
  mockEvents([
    spreadFetchEvent("evt-spread-real", "Real Madrid", "Barcelona", [
      pinnacleSpreadBookmaker([spreadOutcome("Real Madrid", 1.9, -1), spreadOutcome("Barcelona", 1.9, 1)]),
    ]),
  ]);

  const result = await verifySpreadOdds({ sport: "premier league", event: "Real Madrid vs Barcelona", participant: "Real Madrid", line: "-1", odds: 1.9 });

  assert.equal(result.matched, true, result.note ?? "expected a match");
  assert.equal(result.sourceOdds, 1.9);
});

test("verifySpreadOdds: Manchester United -0.5 VERIFIED (a third event/team pair, multi-word name)", async () => {
  mockEvents([
    spreadFetchEvent("evt-spread-mufc", "Manchester United", "Chelsea", [
      pinnacleSpreadBookmaker([spreadOutcome("Manchester United", 1.8, -0.5), spreadOutcome("Chelsea", 2.0, 0.5)]),
    ]),
  ]);

  const result = await verifySpreadOdds({ sport: "premier league", event: "Manchester United vs Chelsea", participant: "Manchester United", line: "-0.5", odds: 1.8 });

  assert.equal(result.matched, true, result.note ?? "expected a match");
  assert.equal(result.sourceOdds, 1.8);
});

test("verifySpreadOdds: ODDS_CHANGED when submitted odds differ from the provider's price beyond the existing tolerance", async () => {
  mockEvents([
    spreadFetchEvent("evt-spread-changed", "Arsenal", "Coventry City", [
      pinnacleSpreadBookmaker([spreadOutcome("Arsenal", 2.5, -1.5), spreadOutcome("Coventry City", 1.6, 1.5)]),
    ]),
  ]);

  const result = await verifySpreadOdds({ sport: "premier league", event: "Arsenal vs Coventry City", participant: "Arsenal", line: "-1.5", odds: 1.9 });

  assert.equal(result.matched, true, result.note ?? "expected a match (matched, just not within tolerance)");
  assert.equal(result.withinTolerance, false);
  assert.equal(result.sourceOdds, 2.5);
  assert.equal(result.submittedOdds, 1.9);
});

test("verifySpreadOdds: requested -1.5 never matches a bookmaker that only offers -1/-2 — FAILED, never a nearest-line fallback", async () => {
  mockEvents([
    spreadFetchEvent("evt-spread-wrongline", "Arsenal", "Coventry City", [
      pinnacleSpreadBookmaker([spreadOutcome("Arsenal", 1.4, -1), spreadOutcome("Arsenal", 2.3, -2), spreadOutcome("Coventry City", 2.9, 1), spreadOutcome("Coventry City", 1.6, 2)]),
    ]),
  ]);

  const result = await verifySpreadOdds({ sport: "premier league", event: "Arsenal vs Coventry City", participant: "Arsenal", line: "-1.5", odds: 1.9 });

  assert.equal(result.matched, false);
  assert.ok(result.note?.includes("LINE_NOT_AVAILABLE"), `expected a LINE_NOT_AVAILABLE note, got: ${result.note}`);
});

test("verifySpreadOdds: wrong participant — FAILED, PARTICIPANT_NOT_FOUND note", async () => {
  mockEvents([
    spreadFetchEvent("evt-spread-wrongteam", "Arsenal", "Coventry City", [
      pinnacleSpreadBookmaker([spreadOutcome("Arsenal", 1.85, -1.5), spreadOutcome("Coventry City", 1.95, 1.5)]),
    ]),
  ]);

  const result = await verifySpreadOdds({ sport: "premier league", event: "Arsenal vs Coventry City", participant: "Real Madrid", line: "-1.5", odds: 1.9 });

  assert.equal(result.matched, false);
  assert.ok(result.note?.includes("PARTICIPANT_NOT_FOUND"), `expected a PARTICIPANT_NOT_FOUND note, got: ${result.note}`);
});

test("verifySpreadOdds: missing spreads market on the bookmaker — FAILED, MARKET_ABSENT note", async () => {
  mockEvents([
    spreadFetchEvent("evt-spread-nomarket", "Arsenal", "Coventry City", [{ key: "pinnacle", title: "Pinnacle", markets: [{ key: "h2h", outcomes: [] }] }]),
  ]);

  const result = await verifySpreadOdds({ sport: "premier league", event: "Arsenal vs Coventry City", participant: "Arsenal", line: "-1.5", odds: 1.9 });

  assert.equal(result.matched, false);
  assert.ok(result.note?.includes("MARKET_ABSENT"), `expected a MARKET_ABSENT note, got: ${result.note}`);
});

test("verifySpreadOdds: event not found — FAILED, same note template as h2h/totals", async () => {
  mockEvents([]);

  const result = await verifySpreadOdds({ sport: "premier league", event: "Arsenal vs Coventry City", participant: "Arsenal", line: "-1.5", odds: 1.9 });

  assert.equal(result.matched, false);
  assert.ok(result.note?.includes("No matching event found"), `expected an event-not-found note, got: ${result.note}`);
});

test("verifySpreadOdds: provider fetch failure (unavailable) — FAILED, same fetch-error handling as h2h/totals", async () => {
  currentHandler = async () => new Response("", { status: 500 });

  const result = await verifySpreadOdds({ sport: "premier league", event: "Arsenal vs Coventry City", participant: "Arsenal", line: "-1.5", odds: 1.9 });

  assert.equal(result.matched, false);
  assert.ok(result.note?.includes("status 500"), `expected an HTTP-failure note, got: ${result.note}`);
});

test("verifySpreadOdds: provider event metadata (providerEventId/providerSportKey/eventStartTime) round-trips exactly like h2h/totals", async () => {
  mockEvents([
    {
      ...(spreadFetchEvent("evt-spread-meta", "Arsenal", "Coventry City", [pinnacleSpreadBookmaker([spreadOutcome("Arsenal", 1.85, -1.5), spreadOutcome("Coventry City", 1.95, 1.5)])]) as object),
      commence_time: "2026-08-15T18:00:00.000Z",
    },
  ]);

  const result = await verifySpreadOdds({ sport: "premier league", event: "Arsenal vs Coventry City", participant: "Arsenal", line: "-1.5", odds: 1.9 });

  assert.equal(result.matched, true, result.note ?? "expected a match");
  assert.equal(result.providerEventId, "evt-spread-meta");
  assert.equal(result.providerSportKey, "soccer_epl");
  assert.equal(result.eventStartTime, "2026-08-15T18:00:00.000Z");
});

/* ============================================================================
 * Handicap Stage H1.1 — exact-market bookmaker fallback.
 *
 * H1's findSpreadOutcome() committed to a single bookmaker (pickBookmaker())
 * BEFORE checking whether it actually had the requested line — a real,
 * already-fetched exact match on a non-preferred bookmaker was invisible.
 * H1.1 tries every bookmaker in deterministic preference order (Pinnacle
 * first, then provider-response order), stopping at the FIRST one with the
 * exact market+participant+line — never price-shopping, never weakening the
 * exact-match discipline.
 * ============================================================================ */

function spreadBookmaker(key: string, title: string, outcomes: OddsApiOutcome[]): OddsApiBookmaker {
  return { key, title, markets: [{ key: "spreads", outcomes }] };
}

/* -------------------------------------------------------------------------- */
/* 16. Mandatory production regression fixture — Arsenal — Coventry City     */
/* -------------------------------------------------------------------------- */

test("Handicap H1.1 PRODUCTION REGRESSION: Arsenal — Coventry City — Pinnacle only has -2, MyBookie.ag has the exact -1.5 the player requested -> MyBookie.ag is selected, never Pinnacle, never a failure", () => {
  const event = spreadEvent("Arsenal", "Coventry City", [
    spreadBookmaker("pinnacle", "Pinnacle", [spreadOutcome("Arsenal", 1.93, -2), spreadOutcome("Coventry City", 1.93, 2)]),
    spreadBookmaker("mybookieag", "MyBookie.ag", [spreadOutcome("Arsenal", 1.53, -1.5), spreadOutcome("Coventry City", 2.34, 1.5)]),
  ]);

  const result = findSpreadOutcome(event, "Arsenal", "-1.5");

  assert.equal(result.kind, "MATCHED");
  if (result.kind !== "MATCHED") return;
  assert.equal(result.bookmaker, "MyBookie.ag");
  assert.equal(result.price, 1.53);
  assert.equal(result.point, "-1.5");
  assert.equal(result.isFallbackBookmaker, true);
});

test("Handicap H1.1 PRODUCTION REGRESSION, full pipeline: verifySpreadOdds end-to-end reproduces the same exact result via the fetch layer", async () => {
  mockEvents([
    spreadFetchEvent("evt-arsenal-coventry", "Arsenal", "Coventry City", [
      spreadBookmaker("pinnacle", "Pinnacle", [spreadOutcome("Arsenal", 1.93, -2), spreadOutcome("Coventry City", 1.93, 2)]),
      spreadBookmaker("mybookieag", "MyBookie.ag", [spreadOutcome("Arsenal", 1.53, -1.5), spreadOutcome("Coventry City", 2.34, 1.5)]),
    ]),
  ]);

  const result = await verifySpreadOdds({ sport: "premier league", event: "Arsenal vs Coventry City", participant: "Arsenal", line: "-1.5", odds: null });

  assert.equal(result.matched, true, result.note ?? "expected a match");
  assert.equal(result.sourceOdds, 1.53);
  assert.equal(result.bookmaker, "MyBookie.ag");
});

/* -------------------------------------------------------------------------- */
/* 1-3. Preferred-first / fallback / deterministic-order-among-fallbacks     */
/* -------------------------------------------------------------------------- */

test("H1.1 (1): preferred bookmaker (Pinnacle) has the exact line -> Pinnacle wins, no fallback needed", () => {
  const event = spreadEvent("Arsenal", "Coventry City", [
    spreadBookmaker("pinnacle", "Pinnacle", [spreadOutcome("Arsenal", 1.9, -1.5), spreadOutcome("Coventry City", 1.95, 1.5)]),
    spreadBookmaker("mybookieag", "MyBookie.ag", [spreadOutcome("Arsenal", 1.95, -1.5), spreadOutcome("Coventry City", 1.9, 1.5)]),
  ]);

  const result = findSpreadOutcome(event, "Arsenal", "-1.5");

  assert.equal(result.kind, "MATCHED");
  if (result.kind !== "MATCHED") return;
  assert.equal(result.bookmaker, "Pinnacle", "H1.1 (6): preferred bookmaker must win when it has the exact line, even though MyBookie.ag's price (1.95) is HIGHER — this is availability fallback, not best-price shopping");
  assert.equal(result.price, 1.9);
  assert.equal(result.isFallbackBookmaker, false);
});

test("H1.1 (2): preferred bookmaker lacks the exact line, second bookmaker has it -> fallback succeeds", () => {
  const event = spreadEvent("Arsenal", "Coventry City", [
    spreadBookmaker("pinnacle", "Pinnacle", [spreadOutcome("Arsenal", 1.93, -2), spreadOutcome("Coventry City", 1.93, 2)]),
    spreadBookmaker("mybookieag", "MyBookie.ag", [spreadOutcome("Arsenal", 1.53, -1.5), spreadOutcome("Coventry City", 2.34, 1.5)]),
  ]);

  const result = findSpreadOutcome(event, "Arsenal", "-1.5");

  assert.equal(result.kind, "MATCHED");
  if (result.kind !== "MATCHED") return;
  assert.equal(result.bookmaker, "MyBookie.ag");
  assert.equal(result.isFallbackBookmaker, true);
});

test("H1.1 (3): several fallback bookmakers have the exact line -> the FIRST one in deterministic provider order wins, never the best price", () => {
  const event = spreadEvent("Arsenal", "Coventry City", [
    spreadBookmaker("pinnacle", "Pinnacle", [spreadOutcome("Arsenal", 1.93, -2), spreadOutcome("Coventry City", 1.93, 2)]),
    spreadBookmaker("bookmaker-a", "Bookmaker A", [spreadOutcome("Arsenal", 1.8, -1.5), spreadOutcome("Coventry City", 2.0, 1.5)]),
    spreadBookmaker("bookmaker-b", "Bookmaker B", [spreadOutcome("Arsenal", 1.95, -1.5), spreadOutcome("Coventry City", 1.85, 1.5)]),
  ]);

  const result = findSpreadOutcome(event, "Arsenal", "-1.5");

  assert.equal(result.kind, "MATCHED");
  if (result.kind !== "MATCHED") return;
  assert.equal(result.bookmaker, "Bookmaker A", "must select the first eligible bookmaker in provider response order, never the higher-priced Bookmaker B");
  assert.equal(result.price, 1.8);
});

/* -------------------------------------------------------------------------- */
/* 4. No bookmaker has the exact line                                        */
/* -------------------------------------------------------------------------- */

test("H1.1 (4): no bookmaker (preferred or fallback) has the exact requested line -> LINE_NOT_AVAILABLE, no substitute chosen", () => {
  const event = spreadEvent("Arsenal", "Coventry City", [
    spreadBookmaker("pinnacle", "Pinnacle", [spreadOutcome("Arsenal", 1.93, -2), spreadOutcome("Coventry City", 1.93, 2)]),
    spreadBookmaker("bookmaker-a", "Bookmaker A", [spreadOutcome("Arsenal", 1.4, -1), spreadOutcome("Coventry City", 2.9, 1)]),
    spreadBookmaker("bookmaker-b", "Bookmaker B", [spreadOutcome("Arsenal", 2.49, -2.5), spreadOutcome("Coventry City", 1.63, 2.5)]),
  ]);

  const result = findSpreadOutcome(event, "Arsenal", "-1.5");

  assert.equal(result.kind, "LINE_NOT_AVAILABLE");
});

/* -------------------------------------------------------------------------- */
/* 5. Participant safety across bookmakers                                   */
/* -------------------------------------------------------------------------- */

test("H1.1 (5): wrong participant, same absolute line, on a fallback bookmaker -> never satisfies the request (Coventry +1.5 must never satisfy Arsenal -1.5)", () => {
  const event = spreadEvent("Arsenal", "Coventry City", [
    spreadBookmaker("pinnacle", "Pinnacle", [spreadOutcome("Arsenal", 1.93, -2), spreadOutcome("Coventry City", 1.93, 2)]),
    spreadBookmaker("other", "Other Bookmaker", [spreadOutcome("Arsenal", 1.9, -2), spreadOutcome("Coventry City", 1.95, 1.5)]),
  ]);

  const result = findSpreadOutcome(event, "Arsenal", "-1.5");

  assert.notEqual(result.kind, "MATCHED", "Coventry City's +1.5 outcome must never be used to satisfy an Arsenal -1.5 request, on any bookmaker");
  assert.equal(result.kind, "LINE_NOT_AVAILABLE");
});

/* -------------------------------------------------------------------------- */
/* 6. Market safety — h2h on another bookmaker is never a spread fallback    */
/* -------------------------------------------------------------------------- */

test("H1.1 (6/9): another bookmaker has an h2h Arsenal price but no spreads market at all -> FAILED, never used as a market substitute", () => {
  const event = spreadEvent("Arsenal", "Coventry City", [
    { key: "pinnacle", title: "Pinnacle", markets: [{ key: "h2h", outcomes: [] }] },
    { key: "other", title: "Other Bookmaker", markets: [{ key: "h2h", outcomes: [{ name: "Arsenal", price: 1.5 }] }] },
  ]);

  const result = findSpreadOutcome(event, "Arsenal", "-1.5");

  assert.equal(result.kind, "MARKET_ABSENT");
});

/* -------------------------------------------------------------------------- */
/* 7-8. Sign preservation across fallback                                    */
/* -------------------------------------------------------------------------- */

test("H1.1 (7): negative sign preserved through fallback", () => {
  const event = spreadEvent("Arsenal", "Coventry City", [
    spreadBookmaker("pinnacle", "Pinnacle", [spreadOutcome("Arsenal", 1.93, -2), spreadOutcome("Coventry City", 1.93, 2)]),
    spreadBookmaker("other", "Other Bookmaker", [spreadOutcome("Arsenal", 1.53, -1.5), spreadOutcome("Coventry City", 2.34, 1.5)]),
  ]);

  const result = findSpreadOutcome(event, "Arsenal", "-1.5");
  assert.equal(result.kind, "MATCHED");
  if (result.kind === "MATCHED") assert.equal(result.point, "-1.5");
});

test("H1.1 (8): positive sign preserved through fallback", () => {
  const event = spreadEvent("Arsenal", "Coventry City", [
    spreadBookmaker("pinnacle", "Pinnacle", [spreadOutcome("Arsenal", 1.93, -2), spreadOutcome("Coventry City", 1.93, 2)]),
    spreadBookmaker("other", "Other Bookmaker", [spreadOutcome("Arsenal", 1.53, -1.5), spreadOutcome("Coventry City", 2.34, 1.5)]),
  ]);

  const result = findSpreadOutcome(event, "Coventry City", "+1.5");
  assert.equal(result.kind, "MATCHED");
  if (result.kind === "MATCHED") assert.equal(result.point, "1.5");
});

/* -------------------------------------------------------------------------- */
/* 9-11. Generic team support — home/away/multi-word, several event pairs   */
/* -------------------------------------------------------------------------- */

test("H1.1 (9): home participant fallback (Real Madrid)", () => {
  const event = spreadEvent("Real Madrid", "Barcelona", [
    spreadBookmaker("pinnacle", "Pinnacle", [spreadOutcome("Real Madrid", 1.93, -2), spreadOutcome("Barcelona", 1.93, 2)]),
    spreadBookmaker("other", "Other Bookmaker", [spreadOutcome("Real Madrid", 1.9, -1), spreadOutcome("Barcelona", 1.9, 1)]),
  ]);

  const result = findSpreadOutcome(event, "Real Madrid", "-1");
  assert.equal(result.kind, "MATCHED");
  if (result.kind === "MATCHED") {
    assert.equal(result.bookmaker, "Other Bookmaker");
    assert.equal(result.price, 1.9);
  }
});

test("H1.1 (10): away participant fallback (Barcelona), same event as the home-side test above", () => {
  const event = spreadEvent("Real Madrid", "Barcelona", [
    spreadBookmaker("pinnacle", "Pinnacle", [spreadOutcome("Real Madrid", 1.93, -2), spreadOutcome("Barcelona", 1.93, 2)]),
    spreadBookmaker("other", "Other Bookmaker", [spreadOutcome("Real Madrid", 1.85, -1), spreadOutcome("Barcelona", 1.98, 1)]),
  ]);

  const result = findSpreadOutcome(event, "Barcelona", "1");
  assert.equal(result.kind, "MATCHED");
  if (result.kind === "MATCHED") assert.equal(result.price, 1.98);
});

test("H1.1 (11): multi-word team fallback (Manchester United)", () => {
  const event = spreadEvent("Manchester United", "Chelsea", [
    spreadBookmaker("pinnacle", "Pinnacle", [spreadOutcome("Manchester United", 1.93, -1), spreadOutcome("Chelsea", 1.93, 1)]),
    spreadBookmaker("other", "Other Bookmaker", [spreadOutcome("Manchester United", 1.8, -0.5), spreadOutcome("Chelsea", 2.0, 0.5)]),
  ]);

  const result = findSpreadOutcome(event, "Manchester United", "-0.5");
  assert.equal(result.kind, "MATCHED");
  if (result.kind === "MATCHED") {
    assert.equal(result.bookmaker, "Other Bookmaker");
    assert.equal(result.price, 1.8);
  }
});

/* -------------------------------------------------------------------------- */
/* 12. Fallback bookmaker metadata                                           */
/* -------------------------------------------------------------------------- */

test("H1.1 (12): full metadata for a fallback match describes the ACTUAL bookmaker used, never Pinnacle", async () => {
  mockEvents([
    spreadFetchEvent("evt-h11-meta", "Arsenal", "Coventry City", [
      spreadBookmaker("pinnacle", "Pinnacle", [spreadOutcome("Arsenal", 1.93, -2), spreadOutcome("Coventry City", 1.93, 2)]),
      spreadBookmaker("mybookieag", "MyBookie.ag", [spreadOutcome("Arsenal", 1.53, -1.5), spreadOutcome("Coventry City", 2.34, 1.5)]),
    ]),
  ]);

  const result = await verifySpreadOdds({ sport: "premier league", event: "Arsenal vs Coventry City", participant: "Arsenal", line: "-1.5", odds: 1.53 });

  assert.equal(result.matched, true, result.note ?? "expected a match");
  assert.equal(result.bookmaker, "MyBookie.ag");
  assert.equal(result.sourceOdds, 1.53);
  assert.notEqual(result.bookmaker, "Pinnacle");
});

/* -------------------------------------------------------------------------- */
/* 13. No best-price selection (explicit, separate from test 3's coverage)   */
/* -------------------------------------------------------------------------- */

test("H1.1 (13): explicit no-best-price proof — a later, higher-priced fallback bookmaker never overrides an earlier, lower-priced eligible one", () => {
  const event = spreadEvent("Arsenal", "Coventry City", [
    spreadBookmaker("pinnacle", "Pinnacle", [spreadOutcome("Arsenal", 1.93, -2), spreadOutcome("Coventry City", 1.93, 2)]),
    spreadBookmaker("cheap-first", "Cheap First", [spreadOutcome("Arsenal", 1.5, -1.5), spreadOutcome("Coventry City", 2.5, 1.5)]),
    spreadBookmaker("expensive-second", "Expensive Second", [spreadOutcome("Arsenal", 2.5, -1.5), spreadOutcome("Coventry City", 1.5, 1.5)]),
  ]);

  const result = findSpreadOutcome(event, "Arsenal", "-1.5");
  assert.equal(result.kind, "MATCHED");
  if (result.kind === "MATCHED") {
    assert.equal(result.bookmaker, "Cheap First");
    assert.equal(result.price, 1.5, "the FIRST eligible fallback bookmaker wins regardless of a later one offering better odds");
  }
});

/* -------------------------------------------------------------------------- */
/* 20. Only one provider fetch, never one per bookmaker                      */
/* -------------------------------------------------------------------------- */

test("H1.1 (20): fallback across bookmakers happens entirely within the ALREADY-fetched event — verifySpreadOdds still makes exactly one HTTP request", async () => {
  let fetchCount = 0;
  currentHandler = async () => {
    fetchCount += 1;
    return jsonResponse([
      spreadFetchEvent("evt-h11-onefetch", "Arsenal", "Coventry City", [
        spreadBookmaker("pinnacle", "Pinnacle", [spreadOutcome("Arsenal", 1.93, -2), spreadOutcome("Coventry City", 1.93, 2)]),
        spreadBookmaker("a", "A", [spreadOutcome("Arsenal", 1.9, -2), spreadOutcome("Coventry City", 1.9, 2)]),
        spreadBookmaker("b", "B", [spreadOutcome("Arsenal", 1.53, -1.5), spreadOutcome("Coventry City", 2.34, 1.5)]),
      ]),
    ]);
  };

  const result = await verifySpreadOdds({ sport: "premier league", event: "Arsenal vs Coventry City", participant: "Arsenal", line: "-1.5", odds: null });

  assert.equal(result.matched, true, result.note ?? "expected a match");
  assert.equal(fetchCount, 1, "inspecting multiple bookmakers must never trigger additional HTTP requests — the provider response already contains all bookmakers");
});

/* ============================================================================
 * H4-B5 — quarter-line (Asian handicap) exact provider verification.
 * findSpreadOutcome()/verifySpreadOdds() are UNCHANGED production code —
 * they already supported arbitrary exact decimal lines before this stage
 * (only lib/odds/theOddsApiProvider.ts's own capability gate blocked
 * quarter lines from ever reaching them). These tests are additive proof
 * that the existing matching algorithm is correct for the full quarter-line
 * grid, never a test of new production logic.
 * ============================================================================ */

/* -------------------------------------------------------------------------- */
/* Full 8-line quarter matrix, 3 team pairs — exact match, never rounded.    */
/* -------------------------------------------------------------------------- */

const QUARTER_LINES = ["-1.75", "-1.25", "-0.75", "-0.25", "0.25", "0.75", "1.25", "1.75"];

test("findSpreadOutcome: full 8-line quarter matrix — Arsenal / Coventry City, exact match at every line", () => {
  const outcomes: OddsApiOutcome[] = [];
  for (const line of QUARTER_LINES) {
    const point = Number(line);
    outcomes.push(spreadOutcome("Arsenal", 1.9 + Math.abs(point) * 0.01, point));
  }
  const event = spreadEvent("Arsenal", "Coventry City", [pinnacleSpreadBookmaker(outcomes)]);

  for (const line of QUARTER_LINES) {
    const result = findSpreadOutcome(event, "Arsenal", line);
    assert.equal(result.kind, "MATCHED", `expected ${line} to match`);
    if (result.kind === "MATCHED") assert.equal(result.point, line.startsWith("-") ? line : line.replace(/^\+/, ""));
  }
});

test("findSpreadOutcome: full 8-line quarter matrix — Real Madrid / Barcelona (second team pair, no hardcoded team logic)", () => {
  const outcomes: OddsApiOutcome[] = [];
  for (const line of QUARTER_LINES) {
    outcomes.push(spreadOutcome("Real Madrid", 1.9, Number(line)));
  }
  const event = spreadEvent("Real Madrid", "Barcelona", [pinnacleSpreadBookmaker(outcomes)]);

  for (const line of QUARTER_LINES) {
    const result = findSpreadOutcome(event, "Real Madrid", line);
    assert.equal(result.kind, "MATCHED", `expected ${line} to match`);
  }
});

test("findSpreadOutcome: full 8-line quarter matrix — Manchester United / Chelsea (third team pair, multi-word participant)", () => {
  const outcomes: OddsApiOutcome[] = [];
  for (const line of QUARTER_LINES) {
    outcomes.push(spreadOutcome("Manchester United", 1.9, Number(line)));
  }
  const event = spreadEvent("Manchester United", "Chelsea", [pinnacleSpreadBookmaker(outcomes)]);

  for (const line of QUARTER_LINES) {
    const result = findSpreadOutcome(event, "Manchester United", line);
    assert.equal(result.kind, "MATCHED", `expected ${line} to match`);
  }
});

/* -------------------------------------------------------------------------- */
/* Section 3's own exact-match/no-match examples, verbatim.                  */
/* -------------------------------------------------------------------------- */

test("findSpreadOutcome: Section 3's exact requirement — Arsenal -1.25 requested, provider offers -1.25 -> MATCH", () => {
  const event = spreadEvent("Arsenal", "Coventry City", [pinnacleSpreadBookmaker([spreadOutcome("Arsenal", 1.91, -1.25), spreadOutcome("Coventry City", 1.91, 1.25)])]);
  assert.equal(findSpreadOutcome(event, "Arsenal", "-1.25").kind, "MATCHED");
});

test("findSpreadOutcome: Section 3 — Arsenal -1.25 requested, provider only offers -1.00 -> NO MATCH, never nearest-line substitution", () => {
  const event = spreadEvent("Arsenal", "Coventry City", [pinnacleSpreadBookmaker([spreadOutcome("Arsenal", 1.4, -1), spreadOutcome("Coventry City", 2.9, 1)])]);
  assert.equal(findSpreadOutcome(event, "Arsenal", "-1.25").kind, "LINE_NOT_AVAILABLE");
});

test("findSpreadOutcome: Section 3 — Arsenal -1.25 requested, provider only offers -1.50 -> NO MATCH", () => {
  const event = spreadEvent("Arsenal", "Coventry City", [pinnacleSpreadBookmaker([spreadOutcome("Arsenal", 1.85, -1.5), spreadOutcome("Coventry City", 1.95, 1.5)])]);
  assert.equal(findSpreadOutcome(event, "Arsenal", "-1.25").kind, "LINE_NOT_AVAILABLE");
});

test("findSpreadOutcome: Section 3 — Arsenal -0.75 requested, provider only offers -0.50 -> NO MATCH", () => {
  const event = spreadEvent("Arsenal", "Coventry City", [pinnacleSpreadBookmaker([spreadOutcome("Arsenal", 1.8, -0.5), spreadOutcome("Coventry City", 2.0, 0.5)])]);
  assert.equal(findSpreadOutcome(event, "Arsenal", "-0.75").kind, "LINE_NOT_AVAILABLE");
});

test("findSpreadOutcome: Section 3 — Coventry City +1.25 requested, provider offers +1.25 -> MATCH", () => {
  const event = spreadEvent("Arsenal", "Coventry City", [pinnacleSpreadBookmaker([spreadOutcome("Arsenal", 1.6, -1.25), spreadOutcome("Coventry City", 2.3, 1.25)])]);
  const result = findSpreadOutcome(event, "Coventry City", "+1.25");
  assert.equal(result.kind, "MATCHED");
  if (result.kind === "MATCHED") assert.equal(result.price, 2.3);
});

test("findSpreadOutcome: Section 3 — Coventry City +1.25 requested, provider only offers +1.50 -> NO MATCH", () => {
  const event = spreadEvent("Arsenal", "Coventry City", [pinnacleSpreadBookmaker([spreadOutcome("Arsenal", 1.85, -1.5), spreadOutcome("Coventry City", 1.95, 1.5)])]);
  assert.equal(findSpreadOutcome(event, "Coventry City", "+1.25").kind, "LINE_NOT_AVAILABLE");
});

/* -------------------------------------------------------------------------- */
/* Section 4 — participant safety at quarter lines.                         */
/* -------------------------------------------------------------------------- */

test("findSpreadOutcome: Section 4 — Arsenal -1.25 never matches Coventry City's +1.25 outcome merely because both reference the same handicap magnitude", () => {
  const event = spreadEvent("Arsenal", "Coventry City", [pinnacleSpreadBookmaker([spreadOutcome("Coventry City", 1.91, 1.25)])]);
  // No Arsenal outcome offered at all here — only Coventry's opposite side.
  const result = findSpreadOutcome(event, "Arsenal", "-1.25");
  assert.notEqual(result.kind, "MATCHED");
});

test("findSpreadOutcome: Section 4 — Coventry City +1.25 never matches Arsenal's -1.25 outcome, the mathematically opposite side of the same handicap", () => {
  const event = spreadEvent("Arsenal", "Coventry City", [pinnacleSpreadBookmaker([spreadOutcome("Arsenal", 1.6, -1.25)])]);
  const result = findSpreadOutcome(event, "Coventry City", "+1.25");
  assert.notEqual(result.kind, "MATCHED");
});

test("findSpreadOutcome: Section 4 — Arsenal -1.25 requested; event has Coventry +1.00 and Arsenal -1.00/-1.50 (never -1.25) -> NO MATCH, participant and line both wrong-shaped never rescue each other", () => {
  const event = spreadEvent("Arsenal", "Coventry City", [
    pinnacleSpreadBookmaker([
      spreadOutcome("Arsenal", 1.4, -1),
      spreadOutcome("Arsenal", 1.85, -1.5),
      spreadOutcome("Coventry City", 2.9, 1),
    ]),
  ]);
  assert.equal(findSpreadOutcome(event, "Arsenal", "-1.25").kind, "LINE_NOT_AVAILABLE");
});

/* -------------------------------------------------------------------------- */
/* Section 5 — deterministic bookmaker fallback for a quarter line.         */
/* -------------------------------------------------------------------------- */

test("H4-B5 Section 5: preferred bookmaker has only -1.0/-1.5, fallback bookmaker has the exact -1.25 -> the eligible fallback bookmaker's exact -1.25 is used, never the globally highest price", () => {
  const event = spreadEvent("Arsenal", "Coventry City", [
    spreadBookmaker("pinnacle", "Pinnacle", [spreadOutcome("Arsenal", 1.4, -1), spreadOutcome("Arsenal", 1.85, -1.5), spreadOutcome("Coventry City", 2.9, 1), spreadOutcome("Coventry City", 1.95, 1.5)]),
    spreadBookmaker("fallbackbook", "Fallback Bookmaker", [spreadOutcome("Arsenal", 1.91, -1.25), spreadOutcome("Coventry City", 1.91, 1.25)]),
  ]);

  const result = findSpreadOutcome(event, "Arsenal", "-1.25");

  assert.equal(result.kind, "MATCHED");
  if (result.kind !== "MATCHED") return;
  assert.equal(result.bookmaker, "Fallback Bookmaker");
  assert.equal(result.price, 1.91);
  assert.equal(result.point, "-1.25");
  assert.equal(result.isFallbackBookmaker, true);
});

test("H4-B5 Section 5, full pipeline: verifySpreadOdds end-to-end reproduces the same fallback result for a quarter line via the fetch layer", async () => {
  mockEvents([
    spreadFetchEvent("evt-quarter-fallback", "Arsenal", "Coventry City", [
      spreadBookmaker("pinnacle", "Pinnacle", [spreadOutcome("Arsenal", 1.4, -1), spreadOutcome("Arsenal", 1.85, -1.5)]),
      spreadBookmaker("fallbackbook", "Fallback Bookmaker", [spreadOutcome("Arsenal", 1.91, -1.25), spreadOutcome("Coventry City", 1.91, 1.25)]),
    ]),
  ]);

  const result = await verifySpreadOdds({ sport: "premier league", event: "Arsenal vs Coventry City", participant: "Arsenal", line: "-1.25", odds: null });

  assert.equal(result.matched, true, result.note ?? "expected a match");
  assert.equal(result.sourceOdds, 1.91);
  assert.equal(result.bookmaker, "Fallback Bookmaker");
});

/* -------------------------------------------------------------------------- */
/* Section 12 — real preview/confirmability path, at the verifySpreadOdds   */
/* layer: CASE A (exact line offered) / CASE B (exact line unavailable).    */
/* -------------------------------------------------------------------------- */

test("verifySpreadOdds CASE A: Arsenal -1.25 VERIFIED — real spread price used, per existing VERIFIED/ODDS_CHANGED tolerance rules", async () => {
  mockEvents([
    spreadFetchEvent("evt-quarter-verified", "Arsenal", "Coventry City", [
      pinnacleSpreadBookmaker([spreadOutcome("Arsenal", 1.91, -1.25), spreadOutcome("Coventry City", 1.91, 1.25)]),
    ]),
  ]);

  const result = await verifySpreadOdds({ sport: "premier league", event: "Arsenal vs Coventry City", participant: "Arsenal", line: "-1.25", odds: 1.91 });

  assert.equal(result.matched, true, result.note ?? "expected a match");
  assert.equal(result.withinTolerance, true);
  assert.equal(result.sourceOdds, 1.91);
});

test("verifySpreadOdds CASE B: Arsenal -1.25 requested, provider only has -1.0/-1.5 -> FAILED/LINE_NOT_AVAILABLE, no substitution, no fabricated odds", async () => {
  mockEvents([
    spreadFetchEvent("evt-quarter-unavailable", "Arsenal", "Coventry City", [
      pinnacleSpreadBookmaker([spreadOutcome("Arsenal", 1.4, -1), spreadOutcome("Arsenal", 1.85, -1.5), spreadOutcome("Coventry City", 2.9, 1), spreadOutcome("Coventry City", 1.95, 1.5)]),
    ]),
  ]);

  const result = await verifySpreadOdds({ sport: "premier league", event: "Arsenal vs Coventry City", participant: "Arsenal", line: "-1.25", odds: 1.9 });

  assert.equal(result.matched, false);
  assert.ok(result.note?.includes("LINE_NOT_AVAILABLE"), `expected LINE_NOT_AVAILABLE, got: ${result.note}`);
  assert.equal(result.sourceOdds, null, "no fabricated odds when the exact line is unavailable");
});

test("H4-B5.6: the exact live production bug, reproduced through the FULL fetch -> event-match -> findSpreadOutcome pipeline — requested 'Arsenal -2.0' matches a deterministic fixture whose provider point is the JS number -2, price 1.93, bookmaker Pinnacle", async () => {
  mockEvents([
    spreadFetchEventTimed("evt-arsenal-coventry-h4b56", "Arsenal", "Coventry City", [
      pinnacleSpreadBookmaker([spreadOutcome("Arsenal", 1.93, -2), spreadOutcome("Coventry City", 1.92, 2)]),
    ], "2026-08-21T19:00:00Z"),
  ]);

  const result = await verifySpreadOdds({ sport: "premier league", event: "Arsenal", participant: "Arsenal", line: "-2.0", odds: null });

  assert.equal(result.matched, true, result.note ?? "expected a match");
  assert.equal(result.sourceOdds, 1.93);
  assert.equal(result.bookmaker, "Pinnacle");
  assert.equal(result.homeTeamName, "Arsenal");
  assert.equal(result.awayTeamName, "Coventry City");
});

/* -------------------------------------------------------------------------- */
/* Section 6 — event resolution is line-independent, via the real fetch     */
/* layer (not the removed adapter-level mechanism).                         */
/* -------------------------------------------------------------------------- */

test("H4-B5 Section 6: verifySpreadOdds resolves the IDENTICAL event for Arsenal -1.5, -1.25, and -0.75 against the same fixture — line value never affects event matching", async () => {
  const fixture = () => [
    spreadFetchEvent("evt-line-independent", "Arsenal", "Coventry City", [
      pinnacleSpreadBookmaker([
        spreadOutcome("Arsenal", 1.85, -1.5),
        spreadOutcome("Arsenal", 1.91, -1.25),
        spreadOutcome("Arsenal", 1.8, -0.75),
        spreadOutcome("Coventry City", 1.95, 1.5),
        spreadOutcome("Coventry City", 1.91, 1.25),
        spreadOutcome("Coventry City", 2.0, 0.75),
      ]),
    ]),
  ];

  mockEvents(fixture());
  const half = await verifySpreadOdds({ sport: "premier league", event: "Arsenal vs Coventry City", participant: "Arsenal", line: "-1.5", odds: null });

  mockEvents(fixture());
  const quarter1 = await verifySpreadOdds({ sport: "premier league", event: "Arsenal vs Coventry City", participant: "Arsenal", line: "-1.25", odds: null });

  mockEvents(fixture());
  const quarter2 = await verifySpreadOdds({ sport: "premier league", event: "Arsenal vs Coventry City", participant: "Arsenal", line: "-0.75", odds: null });

  assert.equal(half.matched, true);
  assert.equal(quarter1.matched, true);
  assert.equal(quarter2.matched, true);
  assert.equal(half.providerEventId, quarter1.providerEventId);
  assert.equal(half.providerEventId, quarter2.providerEventId);
});

/* ============================================================================
 * Handicap Stage H3.1 — resolveSpreadEventMetadata: event resolution ONLY,
 * completely independent of any requested line (the function signature
 * itself has no line parameter at all). Reuses resolveMatchedEvent()
 * unmodified — no second event matcher, same unique/ambiguous/not-found
 * policy findMatchingEvent() already implements for every other market.
 * ============================================================================ */

// extractProviderEventMetadata (oddsVerifier.ts) is all-or-nothing: it only
// populates provider metadata when the event ALSO carries a valid
// commence_time — so every fixture in this section states one explicitly,
// same convention as the pre-existing "provider event metadata round-trips"
// test above.
function spreadFetchEventTimed(id: string, homeTeam: string, awayTeam: string, bookmakers: OddsApiBookmaker[], commenceTime: string): unknown {
  return { id, home_team: homeTeam, away_team: awayTeam, bookmakers, commence_time: commenceTime };
}

test("H3.1 (1): a unique participant-only query ('Arsenal') resolves the one matching event", async () => {
  mockEvents([
    spreadFetchEventTimed("evt-h31-unique", "Arsenal", "Coventry City", [
      pinnacleSpreadBookmaker([spreadOutcome("Arsenal", 1.85, -1.5), spreadOutcome("Coventry City", 1.95, 1.5)]),
    ], "2026-08-15T18:00:00.000Z"),
  ]);

  const result = await resolveSpreadEventMetadata("premier league", "Arsenal");

  assert.equal(result.homeTeamName, "Arsenal");
  assert.equal(result.awayTeamName, "Coventry City");
});

test("H3.1 (2): 'Arsenal -1.25 stake 10' shape resolves the SAME event as 'Arsenal -1.5' — event resolution never reads a line at all", async () => {
  mockEvents([
    spreadFetchEventTimed("evt-h31-lineindep", "Arsenal", "Coventry City", [
      pinnacleSpreadBookmaker([spreadOutcome("Arsenal", 1.85, -1.5), spreadOutcome("Coventry City", 1.95, 1.5)]),
    ], "2026-08-15T18:00:00.000Z"),
  ]);

  // resolveSpreadEventMetadata has no `line` parameter in its own type
  // signature — this call proves it byte-for-byte, not just by inspection.
  const resultForQuarterLineContext = await resolveSpreadEventMetadata("premier league", "Arsenal");

  assert.equal(resultForQuarterLineContext.homeTeamName, "Arsenal");
  assert.equal(resultForQuarterLineContext.awayTeamName, "Coventry City");
});

test("H3.1 (3): standard-line vs quarter-line parity — resolveSpreadEventMetadata and verifySpreadOdds (called for a standard line against the identical fixture) resolve the IDENTICAL event", async () => {
  mockEvents([
    spreadFetchEventTimed("evt-h31-parity", "Arsenal", "Coventry City", [
      pinnacleSpreadBookmaker([spreadOutcome("Arsenal", 1.85, -1.5), spreadOutcome("Coventry City", 1.95, 1.5)]),
    ], "2026-08-15T18:00:00.000Z"),
  ]);

  const quarterLineEventOnly = await resolveSpreadEventMetadata("premier league", "Arsenal");

  mockEvents([
    spreadFetchEventTimed("evt-h31-parity", "Arsenal", "Coventry City", [
      pinnacleSpreadBookmaker([spreadOutcome("Arsenal", 1.85, -1.5), spreadOutcome("Coventry City", 1.95, 1.5)]),
    ], "2026-08-15T18:00:00.000Z"),
  ]);
  const standardLineFull = await verifySpreadOdds({ sport: "premier league", event: "Arsenal", participant: "Arsenal", line: "-1.5", odds: null });

  assert.equal(quarterLineEventOnly.homeTeamName, standardLineFull.homeTeamName);
  assert.equal(quarterLineEventOnly.awayTeamName, standardLineFull.awayTeamName);
  assert.equal(quarterLineEventOnly.providerEventId, standardLineFull.providerEventId);
});

test("H3.1 (4): an ambiguous participant-only query (two plausible Arsenal events) never picks one arbitrarily — degrades to all-null, never a fabricated event", async () => {
  mockEvents([
    spreadFetchEventTimed("evt-h31-amb-1", "Arsenal", "Coventry City", [pinnacleSpreadBookmaker([spreadOutcome("Arsenal", 1.85, -1.5), spreadOutcome("Coventry City", 1.95, 1.5)])], "2026-08-15T18:00:00.000Z"),
    spreadFetchEventTimed("evt-h31-amb-2", "Arsenal", "Fulham", [pinnacleSpreadBookmaker([spreadOutcome("Arsenal", 1.7, -1.5), spreadOutcome("Fulham", 2.1, 1.5)])], "2026-08-22T18:00:00.000Z"),
  ]);

  const result = await resolveSpreadEventMetadata("premier league", "Arsenal");

  assert.equal(result.homeTeamName, null);
  assert.equal(result.awayTeamName, null);
  assert.equal(result.providerEventId, null);
});

test("H3.1 (5): no matching event at all — NOT_FOUND, degrades to all-null, never a fabricated event", async () => {
  mockEvents([]);

  const result = await resolveSpreadEventMetadata("premier league", "Arsenal");

  assert.equal(result.homeTeamName, null);
  assert.equal(result.awayTeamName, null);
  assert.equal(result.eventStartTime, null);
  assert.equal(result.providerEventId, null);
  assert.equal(result.providerSportKey, null);
  assert.equal(result.competitionName, null);
});

test("H3.1 (6): an AWAY-side-only participant query ('Coventry City') still resolves the same event, home/away independent", async () => {
  mockEvents([
    spreadFetchEventTimed("evt-h31-away", "Arsenal", "Coventry City", [
      pinnacleSpreadBookmaker([spreadOutcome("Arsenal", 1.85, -1.5), spreadOutcome("Coventry City", 1.95, 1.5)]),
    ], "2026-08-15T18:00:00.000Z"),
  ]);

  const result = await resolveSpreadEventMetadata("premier league", "Coventry City");

  assert.equal(result.homeTeamName, "Arsenal");
  assert.equal(result.awayTeamName, "Coventry City");
});

test("H3.1 (7): explicit two-team query ('Real Madrid vs Barcelona') still resolves authoritatively — participant-only fallback never weakens full-event matching", async () => {
  mockEvents([
    spreadFetchEventTimed("evt-h31-realbarca", "Real Madrid", "Barcelona", [
      pinnacleSpreadBookmaker([spreadOutcome("Real Madrid", 1.9, -1), spreadOutcome("Barcelona", 1.9, 1)]),
    ], "2026-08-16T20:00:00.000Z"),
  ]);

  const result = await resolveSpreadEventMetadata("premier league", "Real Madrid vs Barcelona");

  assert.equal(result.homeTeamName, "Real Madrid");
  assert.equal(result.awayTeamName, "Barcelona");
});

test("H3.1 (8): generic multi-team coverage — Manchester United/Chelsea (multi-word participant) resolves correctly, no team-specific code", async () => {
  mockEvents([
    spreadFetchEventTimed("evt-h31-mufc", "Manchester United", "Chelsea", [
      pinnacleSpreadBookmaker([spreadOutcome("Manchester United", 1.8, -0.5), spreadOutcome("Chelsea", 2.0, 0.5)]),
    ], "2026-08-17T15:00:00.000Z"),
  ]);

  const result = await resolveSpreadEventMetadata("premier league", "Manchester United");

  assert.equal(result.homeTeamName, "Manchester United");
  assert.equal(result.awayTeamName, "Chelsea");
});

test("H3.1 (9): provider fetch failure degrades to all-null, never throws", async () => {
  currentHandler = async () => new Response("", { status: 500 });

  const result = await resolveSpreadEventMetadata("premier league", "Arsenal");

  assert.equal(result.homeTeamName, null);
  assert.equal(result.providerEventId, null);
});

test("H3.1 (10): resolveSpreadEventMetadata never calls findSpreadOutcome — no quarter-line price can ever be found through this path (verified indirectly: a bookmaker offering a matching spread outcome is present in the fixture, but no price/bookmaker field exists anywhere on this function's return type at all)", async () => {
  mockEvents([
    spreadFetchEventTimed("evt-h31-noprice", "Arsenal", "Coventry City", [
      pinnacleSpreadBookmaker([spreadOutcome("Arsenal", 1.85, -1.25), spreadOutcome("Coventry City", 1.95, 1.25)]),
    ], "2026-08-15T18:00:00.000Z"),
  ]);

  const result = await resolveSpreadEventMetadata("premier league", "Arsenal");

  // Event resolves correctly...
  assert.equal(result.homeTeamName, "Arsenal");
  // ...but the return type structurally has no price/bookmaker/matched
  // field at all — there is nothing here that could ever leak a
  // quarter-line price to a caller, by construction, not by convention.
  assert.deepEqual(Object.keys(result).sort(), [
    "awayTeamName",
    "competitionName",
    "eventStartTime",
    "homeTeamName",
    "providerEventId",
    "providerSportKey",
  ]);
});
