import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyOdds, type OddsVerificationInput } from "./oddsVerifier";

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

function h2hEventWithId(id: string, homeTeam: string, awayTeam: string, outcomes: OutcomeFixture[]): unknown {
  return {
    id,
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
  });

  const result = await verifyOdds(bet({ sport: "football", event: "Arsenal vs Chelsea", selection: "Arsenal", odds: 1.9 }));

  assert.equal(result.matched, true);
  assert.doesNotMatch(result.note ?? "", /Ambiguous/);
});

test("Step 16A: two genuinely different events tied at the same best score across leagues return an ambiguity result, never an arbitrary pick", async () => {
  // Two DIFFERENT ids, identical team names, in two different competitions
  // (a plausible real scenario: a club and its reserve/B-team both
  // registered similarly, or duplicate test-data-shaped listings) — neither
  // may be silently preferred by league order.
  mockEventsBySportKey({
    soccer_epl: [h2hEventWithId("evt-a", "Sporting FC", "Athletic FC", standardOutcomes("Sporting FC", "Athletic FC", 2.0, 3.0))],
    soccer_spain_la_liga: [],
    soccer_italy_serie_a: [],
    soccer_germany_bundesliga: [],
    soccer_france_ligue_one: [],
    soccer_uefa_champs_league: [h2hEventWithId("evt-b", "Sporting FC", "Athletic FC", standardOutcomes("Sporting FC", "Athletic FC", 2.2, 2.8))],
  });

  const result = await verifyOdds(bet({ sport: "football", event: "Sporting FC vs Athletic FC", selection: "Sporting FC", odds: 2.0 }));

  assert.equal(result.matched, false);
  assert.equal(result.sourceOdds, null, "an ambiguous match must never fabricate a source price from either candidate");
  assert.match(result.note ?? "", /Ambiguous event match/);
});
