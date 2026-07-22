import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { toBetTicketData } from "./BetScreen";
import type { ConfirmedBet, ConfirmedExpressBet, ConfirmedExpressSelection } from "./betConfirmApi";

function singleBet(overrides: Partial<ConfirmedBet> = {}): ConfirmedBet {
  return {
    id: "bet-1",
    status: "PENDING",
    type: "SINGLE",
    sport: "Football",
    event: "Real Madrid vs Barcelona",
    outcome: "Real Madrid Win",
    stake: 100,
    odds: 2.1,
    totalOdds: 2.1,
    createdAt: "2026-07-21T12:00:00.000Z",
    ...overrides,
  };
}

function expressSelection(overrides: Partial<ConfirmedExpressSelection> = {}): ConfirmedExpressSelection {
  return {
    id: "sel-1",
    sport: "Football",
    event: "Real Madrid vs Barcelona",
    outcome: "Real Madrid Win",
    market: "Match Winner",
    odds: "1.8",
    currentOdds: "1.8",
    oddsStatus: "VERIFIED",
    ...overrides,
  };
}

function expressBet(overrides: Partial<ConfirmedExpressBet> = {}): ConfirmedExpressBet {
  return {
    id: "bet-2",
    status: "PENDING",
    type: "EXPRESS",
    sport: "Football",
    event: null,
    outcome: null,
    odds: null,
    stake: "40",
    totalOdds: "3.06",
    createdAt: "2026-07-21T12:00:00.000Z",
    selections: [
      expressSelection({ id: "sel-1", event: "Real Madrid vs Barcelona", outcome: "Real Madrid Win" }),
      expressSelection({
        id: "sel-2",
        sport: "Tennis",
        event: "Inter Milan vs Juventus",
        outcome: "Over 2.5 Goals",
        market: null,
        odds: "1.7",
        currentOdds: null,
        oddsStatus: "UNAVAILABLE",
      }),
    ],
    ...overrides,
  };
}

// ---------------------------------------------------------------------
// SINGLE regression — must be byte-for-byte what it was before Step 5.
// ---------------------------------------------------------------------

test("toBetTicketData: SINGLE produces one selection with unchanged fields", () => {
  const ticket = toBetTicketData(singleBet(), "Andrii", "9390");

  assert.equal(ticket.id, "bet-1");
  assert.equal(ticket.status, "submitted");
  assert.equal(ticket.player, "Andrii");
  assert.equal(ticket.createdAt, "2026-07-21T12:00:00.000Z");
  assert.equal(ticket.stake, 100);
  assert.equal(ticket.totalOdds, 2.1);
  assert.equal(ticket.availableCredit, "9390");
  assert.equal(ticket.selections.length, 1);
  assert.deepEqual(ticket.selections[0], {
    sport: "Football",
    league: null,
    event: "Real Madrid vs Barcelona",
    selection: "Real Madrid Win",
    odds: 2.1,
  });
  // No EXPRESS-only fields leak onto a SINGLE selection.
  assert.equal("market" in ticket.selections[0], false);
  assert.equal("currentOdds" in ticket.selections[0], false);
  assert.equal("oddsStatus" in ticket.selections[0], false);
});

// ---------------------------------------------------------------------
// EXPRESS
// ---------------------------------------------------------------------

test("toBetTicketData: EXPRESS produces one BetTicketSelection per confirmed selection, in order", () => {
  const ticket = toBetTicketData(expressBet(), "Andrii", "9390");

  assert.equal(ticket.selections.length, 2);
  assert.equal(ticket.selections[0].event, "Real Madrid vs Barcelona");
  assert.equal(ticket.selections[1].event, "Inter Milan vs Juventus");
});

test("toBetTicketData: EXPRESS stake/totalOdds are parsed from decimal strings into numbers", () => {
  const ticket = toBetTicketData(expressBet({ stake: "40.10", totalOdds: "1.10" }), "Andrii", "9390");
  assert.equal(ticket.stake, 40.1);
  assert.equal(ticket.totalOdds, 1.1);
});

test("toBetTicketData: EXPRESS null totalOdds stays null", () => {
  const ticket = toBetTicketData(expressBet({ totalOdds: null }), "Andrii", "9390");
  assert.equal(ticket.totalOdds, null);
});

test("toBetTicketData: mixed-sport EXPRESS preserves each selection's own sport", () => {
  const ticket = toBetTicketData(expressBet(), "Andrii", "9390");
  assert.equal(ticket.selections[0].sport, "Football");
  assert.equal(ticket.selections[1].sport, "Tennis");
});

test("toBetTicketData: EXPRESS market/outcome/odds are carried through per selection", () => {
  const ticket = toBetTicketData(expressBet(), "Andrii", "9390");
  assert.equal(ticket.selections[0].market, "Match Winner");
  assert.equal(ticket.selections[0].selection, "Real Madrid Win");
  assert.equal(ticket.selections[0].odds, 1.8);
});

test("toBetTicketData: EXPRESS currentOdds is parsed to a number when present, and null stays null (never fabricated)", () => {
  const ticket = toBetTicketData(expressBet(), "Andrii", "9390");
  assert.equal(ticket.selections[0].currentOdds, 1.8);
  assert.equal(ticket.selections[1].currentOdds, null);
});

test("toBetTicketData: EXPRESS oddsStatus is carried through per selection independently", () => {
  const ticket = toBetTicketData(expressBet(), "Andrii", "9390");
  assert.equal(ticket.selections[0].oddsStatus, "VERIFIED");
  assert.equal(ticket.selections[1].oddsStatus, "UNAVAILABLE");
});

test("toBetTicketData: a long event name passes through unmangled (layout wrapping is CSS's job, not this function's)", () => {
  const longEvent =
    "FC Something Very Long Football Club vs Another Extremely Long Named Opponent Athletic Association";
  const ticket = toBetTicketData(
    expressBet({ selections: [expressSelection({ event: longEvent })] }),
    "Andrii",
    "9390",
  );
  assert.equal(ticket.selections[0].event, longEvent);
});

test("toBetTicketData: repeated calls with the same confirmed bet (simulating an idempotent re-confirm) produce identical ticket data", () => {
  const bet = expressBet();
  const first = toBetTicketData(bet, "Andrii", "9390");
  const second = toBetTicketData(bet, "Andrii", "9390");
  assert.deepEqual(first, second);
});

// ---------------------------------------------------------------------
// Data-freshness fix — BetTextForm and BetScreenshotForm must both feed
// the exact same confirmation-update path (handleConfirmed), never two
// separate handlers. This project has no DOM-rendering test infra (see
// ActiveBetsScreen.test.ts's own comment), so this is a source-level
// regression guard rather than a rendered-tree assertion: it fails loudly
// if BetScreen.tsx is ever changed to wire the two forms to different
// callbacks, or if handleConfirmed stops forwarding to the page-level
// onBetConfirmed callback (components/miniapp/mergeConfirmedBet.ts /
// app/miniapp/page.tsx) that actually does the optimistic merge.
// ---------------------------------------------------------------------

test("BetScreen: BetTextForm and BetScreenshotForm are both wired to the exact same onConfirmed handler", () => {
  const source = readFileSync(fileURLToPath(new URL("./BetScreen.tsx", import.meta.url)), "utf8");

  // [\s\S]*? (not [^>]*) — these JSX elements' own props can contain
  // arrow functions (e.g. onBack={() => ...}), which include a literal
  // ">" that would otherwise truncate a "stop at the next >" pattern
  // before ever reaching onConfirmed=.
  const textFormMatch = source.match(/<BetTextForm[\s\S]*?onConfirmed=\{(\w+)\}[\s\S]*?\/>/);
  const screenshotFormMatch = source.match(/<BetScreenshotForm[\s\S]*?onConfirmed=\{(\w+)\}[\s\S]*?\/>/);

  assert.ok(textFormMatch, "expected BetTextForm to be wired to an onConfirmed handler");
  assert.ok(screenshotFormMatch, "expected BetScreenshotForm to be wired to an onConfirmed handler");
  assert.equal(textFormMatch![1], screenshotFormMatch![1], "both forms must share the exact same handler");

  // And that shared handler must actually forward to the page-level
  // optimistic-merge callback, not just set local ticket state.
  assert.match(source, /onBetConfirmed\(bet\)/);
});
