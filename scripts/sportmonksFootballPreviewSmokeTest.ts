import "dotenv/config";
import { buildSportmonksFootballPreview } from "../lib/bets/buildSportmonksFootballPreview";
import type { ParsedBetSlip } from "../lib/bets/betSlip";

// Stage 10 — local live smoke test against the REAL Sportmonks API (real
// token, real network). Not a *.test.ts file (npm test never runs it).
// Never logs SPORTMONKS_API_TOKEN or a full raw API response. Creates no
// Bet, mutates no balance — buildSportmonksFootballPreview has no db/write
// path at all (proven statically in its own test file).
//
// The AI Parser leg itself is NOT live here (neither ANTHROPIC_API_KEY nor
// a local Ollama server is configured in this environment) — this script
// uses a manually-constructed ParsedBetSlip matching exactly what
// parseBetSlipMessage("Juventus победа 100") is expected to produce
// (sport: Football, event: the named team, selection: the stated outcome,
// no submitted odds), so it exercises the REAL Sportmonks resolver/fixture/
// odds adapters end to end — the part Stage 10 is actually about.

// Live data now shows Juventus playing in 4 different pre-season friendlies
// in the current window (correctly surfaced as AMBIGUOUS by the resolver,
// not a bug — see the Stage 10 report). Using the disambiguating "Juventus
// vs Nice" phrasing, which Candidate Resolver's existing " vs " match-query
// grammar (Stage 8) already supports, to reach the same target fixture
// (19743018) unambiguously.
const slip: ParsedBetSlip = {
  type: "SINGLE",
  stake: 100,
  selections: [{ sport: "Football", event: "Juventus vs Nice", market: null, selection: "Juventus победа", submittedOdds: null }],
};

async function main() {
  console.log('Input phrase: "Juventus vs Nice победа 100"');
  console.log("ParsedBetSlip (manually constructed, AI Parser not live in this environment):");
  console.log(JSON.stringify(slip));

  const result = await buildSportmonksFootballPreview(slip);

  console.log("\nResult kind:", result.kind);

  if (result.kind !== "SUCCESS") {
    console.log("Not a SUCCESS result — no preview built.");
    return;
  }

  const sel = result.preview.selections[0];
  console.log("\n=== Preview built ===");
  console.log("event:", sel.event);
  console.log("market:", sel.market);
  console.log("selection:", sel.selection);
  console.log("bookmaker:", sel.bookmaker);
  console.log("currentOdds:", sel.currentOdds);
  console.log("submittedOdds:", sel.submittedOdds);
  console.log("oddsStatus:", sel.oddsStatus);
  console.log("stake:", result.preview.stake);
  console.log("totalOdds:", result.preview.totalOdds);
  console.log("potentialWin:", result.preview.potentialWin);
  console.log("previewToken present:", "previewToken" in result);
}

main().catch((err) => {
  console.error("Script error (message only):", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
