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
