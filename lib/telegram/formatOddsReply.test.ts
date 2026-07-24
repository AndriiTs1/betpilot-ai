import { test } from "node:test";
import assert from "node:assert/strict";
import { formatOddsReply } from "./formatOddsReply";
import type { BetSlipPreview, BetSlipPreviewSelection } from "@/lib/bets/buildBetSlipPreview";

function selection(overrides: Partial<BetSlipPreviewSelection> = {}): BetSlipPreviewSelection {
  return {
    sport: "Football",
    event: "Real Madrid vs Barcelona",
    market: null,
    selection: "Real Madrid",
    submittedOdds: 2.05,
    currentOdds: 2.05,
    oddsStatus: "VERIFIED",
    bookmaker: null,
    discrepancyPercent: 0,
    ...overrides,
  };
}

function preview(overrides: Partial<BetSlipPreview> = {}): BetSlipPreview {
  return {
    type: "SINGLE",
    stake: 50,
    totalOdds: null,
    potentialWin: null,
    selections: [selection()],
    ...overrides,
  };
}

test("formatOddsReply: VERIFIED renders the confirmation line and both odds values", () => {
  const text = formatOddsReply(preview({ selections: [selection({ oddsStatus: "VERIFIED", submittedOdds: 2.05, currentOdds: 2.05 })] }));

  assert.match(text, /✅ Odds confirmed/);
  assert.match(text, /Submitted odds:<\/b> 2\.05/);
  assert.match(text, /Current odds:<\/b> 2\.05/);
});

test("formatOddsReply: ODDS_CHANGED shows both submitted and current odds", () => {
  const text = formatOddsReply(
    preview({ selections: [selection({ oddsStatus: "ODDS_CHANGED", submittedOdds: 2.05, currentOdds: 1.93 })] }),
  );

  assert.match(text, /⚠️ Odds changed/);
  assert.match(text, /Submitted odds:<\/b> 2\.05/);
  assert.match(text, /Current odds:<\/b> 1\.93/);
});

test("formatOddsReply: NOT_FOUND renders the not-found line", () => {
  const text = formatOddsReply(preview({ selections: [selection({ oddsStatus: "NOT_FOUND", currentOdds: null })] }));
  assert.match(text, /❔ Event or selection not found/);
});

test("formatOddsReply: UNAVAILABLE with a real submittedOdds reads as a provider/check failure", () => {
  const text = formatOddsReply(
    preview({ selections: [selection({ oddsStatus: "UNAVAILABLE", submittedOdds: 2.05, currentOdds: null })] }),
  );
  assert.match(text, /⚠️ Odds check unavailable/);
  assert.doesNotMatch(text, /No submitted odds were provided/);
});

test("formatOddsReply: UNAVAILABLE with submittedOdds:null uses accurate wording, never claims provider downtime", () => {
  const text = formatOddsReply(
    preview({ selections: [selection({ oddsStatus: "UNAVAILABLE", submittedOdds: null, currentOdds: null })] }),
  );
  assert.match(text, /No submitted odds were provided, so comparison is unavailable\./);
  assert.doesNotMatch(text, /Odds check unavailable/);
});

test("formatOddsReply: PENDING has a safe fallback line", () => {
  const text = formatOddsReply(preview({ selections: [selection({ oddsStatus: "PENDING" })] }));
  assert.match(text, /⚠️ Verification pending/);
});

test("formatOddsReply: bookmaker is rendered only when present", () => {
  const withBookmaker = formatOddsReply(preview({ selections: [selection({ bookmaker: "Pinnacle" })] }));
  assert.match(withBookmaker, /Bookmaker:<\/b> Pinnacle/);

  const withoutBookmaker = formatOddsReply(preview({ selections: [selection({ bookmaker: null })] }));
  assert.doesNotMatch(withoutBookmaker, /Bookmaker:/);
});

test("formatOddsReply: market is rendered only when present", () => {
  const withMarket = formatOddsReply(preview({ selections: [selection({ market: "Match Winner" })] }));
  assert.match(withMarket, /Market:<\/b> Match Winner/);

  const withoutMarket = formatOddsReply(preview({ selections: [selection({ market: null })] }));
  assert.doesNotMatch(withoutMarket, /Market:/);
});

test("formatOddsReply: HTML-significant characters in dynamic fields are escaped", () => {
  const text = formatOddsReply(
    preview({
      selections: [
        selection({
          event: "Team <A> & Co vs Team B",
          selection: "A & B > C",
          market: "<script>",
          bookmaker: "Book & Sons",
        }),
      ],
    }),
  );

  assert.doesNotMatch(text, /<script>/);
  assert.match(text, /Team &lt;A&gt; &amp; Co vs Team B/);
  assert.match(text, /A &amp; B &gt; C/);
  assert.match(text, /&lt;script&gt;/);
  assert.match(text, /Book &amp; Sons/);
});

test("formatOddsReply: never leaks provider keys or raw payload markers", () => {
  const text = formatOddsReply(preview());
  assert.doesNotMatch(text, /ODDS_API_KEY/i);
  assert.doesNotMatch(text, /sport_key/i);
  assert.doesNotMatch(text, /ANTHROPIC/i);
});

/* -------------------------------------------------------------------------- */
/* EXPRESS                                                                     */
/* -------------------------------------------------------------------------- */

test("formatOddsReply: EXPRESS renders every selection as its own numbered block", () => {
  const text = formatOddsReply(
    preview({
      type: "EXPRESS",
      selections: [
        selection({ event: "Real Madrid vs Barcelona", selection: "Real Madrid" }),
        selection({ event: "Inter vs Juventus", selection: "Juventus", oddsStatus: "ODDS_CHANGED", currentOdds: 2.3 }),
      ],
    }),
  );

  assert.match(text, /Selection 1/);
  assert.match(text, /Selection 2/);
  assert.match(text, /Real Madrid vs Barcelona/);
  assert.match(text, /Inter vs Juventus/);
});

test("formatOddsReply: EXPRESS renders totalOdds and potentialWin only when both are present", () => {
  const withTotals = formatOddsReply(
    preview({
      type: "EXPRESS",
      totalOdds: 4.5,
      potentialWin: 225,
      selections: [selection({ event: "A vs B" }), selection({ event: "C vs D" })],
    }),
  );
  assert.match(withTotals, /Total odds:<\/b> 4\.5/);
  assert.match(withTotals, /Potential win:<\/b> 225/);

  const withoutTotals = formatOddsReply(
    preview({
      type: "EXPRESS",
      totalOdds: null,
      potentialWin: null,
      selections: [selection({ event: "A vs B" }), selection({ event: "C vs D", submittedOdds: null })],
    }),
  );
  assert.doesNotMatch(withoutTotals, /Total odds:/);
  assert.doesNotMatch(withoutTotals, /Potential win:/);
});

test("formatOddsReply: an unresolved EXPRESS leg does not hide the other, resolved legs", () => {
  const text = formatOddsReply(
    preview({
      type: "EXPRESS",
      selections: [
        selection({ event: "Real Madrid vs Barcelona", oddsStatus: "VERIFIED" }),
        selection({ event: "Obscure Cup Match", oddsStatus: "NOT_FOUND", currentOdds: null }),
      ],
    }),
  );

  assert.match(text, /Real Madrid vs Barcelona/);
  assert.match(text, /Obscure Cup Match/);
  assert.match(text, /✅ Odds confirmed/);
  assert.match(text, /❔ Event or selection not found/);
});

test("formatOddsReply: EXPRESS formatting never multiplies odds itself — totalOdds/potentialWin come only from the preview input", () => {
  const text = formatOddsReply(
    preview({
      type: "EXPRESS",
      totalOdds: 999,
      potentialWin: 111,
      selections: [selection({ submittedOdds: 2, currentOdds: 2 }), selection({ submittedOdds: 3, currentOdds: 3 })],
    }),
  );

  // The formatter must render exactly what it was given (999/111), never a
  // value it derived itself (e.g. 2*3=6) — proving no multiplication logic
  // exists in this file.
  assert.match(text, /Total odds:<\/b> 999/);
  assert.match(text, /Potential win:<\/b> 111/);
});
