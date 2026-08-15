import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  resolveTicketSelectionOdds,
  resolveTicketStatusBadge,
  formatDate,
  formatTime,
  shortTicketId,
  STATUS_CONFIG,
  type BetTicketSelection,
} from "./BetTicket";

// Stage M4.9 — CLEAN EXPRESS CURRENT-ODDS UX. This project deliberately has
// no DOM-rendering test infra (see e.g. ActiveBetsScreen.test.ts's own
// comment, and components/bets/SelectionRow.test.ts's identical pattern),
// so the two rendering decisions this stage fixed — which odds value the
// main line shows, and whether a status badge appears — are extracted as
// pure functions and tested directly here.
//
// Root cause this proves fixed: BetTicket.tsx (the submitted/confirmed
// ticket screen) has its own inline per-selection rendering, never routed
// through components/bets/SelectionRow.tsx, so it never picked up Stage
// M4.1's "current price only" fix — it kept showing the submitted/
// screenshot odds on the main line, a separate "Current: X" line, and a
// "Verified"/"Odds changed" badge for every EXPRESS leg. These functions
// now reuse SelectionRow.tsx's own getOddsPresentation directly.

function selection(overrides: Partial<BetTicketSelection> = {}): BetTicketSelection {
  return {
    sport: "Football",
    league: null,
    event: "Alavés vs Getafe",
    selection: "Getafe",
    market: "Match Winner",
    odds: 3.7,
    currentOdds: null,
    oddsStatus: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------
// resolveTicketSelectionOdds
// ---------------------------------------------------------------------

// The exact production reproduction this stage fixes: submitted 3.70,
// current 3.87 (ODDS_CHANGED). The player must see 3.87 exactly once —
// never 3.70, never both.
test("resolveTicketSelectionOdds: ODDS_CHANGED leg (submitted 3.70, current 3.87) resolves to 3.87, never the submitted 3.70", () => {
  const result = resolveTicketSelectionOdds(selection({ odds: 3.7, currentOdds: 3.87, oddsStatus: "ODDS_CHANGED" }));
  assert.equal(result, 3.87);
  assert.notEqual(result, 3.7);
});

// The second reported leg: submitted 2.38, current 2.45, VERIFIED.
test("resolveTicketSelectionOdds: VERIFIED leg (submitted 2.38, current 2.45) resolves to 2.45, never the submitted 2.38", () => {
  const result = resolveTicketSelectionOdds(selection({ odds: 2.38, currentOdds: 2.45, oddsStatus: "VERIFIED" }));
  assert.equal(result, 2.45);
  assert.notEqual(result, 2.38);
});

test("resolveTicketSelectionOdds: NOT_FOUND/UNAVAILABLE/PENDING never resolve to a fabricated value — null, not the stale submitted odds", () => {
  for (const oddsStatus of ["NOT_FOUND", "UNAVAILABLE", "PENDING"] as const) {
    const result = resolveTicketSelectionOdds(selection({ odds: 3.7, currentOdds: null, oddsStatus }));
    assert.equal(result, null, `${oddsStatus} must resolve to null, never a fabricated price`);
  }
});

// SINGLE selections never set oddsStatus (toBetTicketData's own contract,
// locked in by BetScreen.test.ts) — selection.odds is already Stage M4.8's
// accepted price, so it must pass through completely unchanged.
test("resolveTicketSelectionOdds: SINGLE (oddsStatus null) passes selection.odds through unchanged — already the accepted price", () => {
  assert.equal(resolveTicketSelectionOdds(selection({ odds: 2.04, currentOdds: null, oddsStatus: null })), 2.04);
});

test("resolveTicketSelectionOdds: a null odds field on a SINGLE-shaped selection stays null, never fabricated", () => {
  assert.equal(resolveTicketSelectionOdds(selection({ odds: null, oddsStatus: null })), null);
});

// ---------------------------------------------------------------------
// resolveTicketStatusBadge
// ---------------------------------------------------------------------

test("resolveTicketStatusBadge: VERIFIED never renders a badge", () => {
  assert.equal(resolveTicketStatusBadge(selection({ currentOdds: 2.45, oddsStatus: "VERIFIED" })), null);
});

test("resolveTicketStatusBadge: ODDS_CHANGED never renders a badge — identical treatment to VERIFIED, no 'odds changed' label surfaced to the player", () => {
  assert.equal(resolveTicketStatusBadge(selection({ currentOdds: 3.87, oddsStatus: "ODDS_CHANGED" })), null);
});

test("resolveTicketStatusBadge: a genuinely non-confirmable status (NOT_FOUND/UNAVAILABLE/PENDING) still shows its badge — explains the absence of a price, never a real one", () => {
  for (const oddsStatus of ["NOT_FOUND", "UNAVAILABLE", "PENDING"] as const) {
    assert.equal(resolveTicketStatusBadge(selection({ currentOdds: null, oddsStatus })), oddsStatus);
  }
});

test("resolveTicketStatusBadge: SINGLE (oddsStatus null) never renders a badge", () => {
  assert.equal(resolveTicketStatusBadge(selection({ oddsStatus: null })), null);
});

/* -------------------------------------------------------------------------- */
/* Stage M5.1 — BET TICKET HEADER & META COMPACTION                          */
/*                                                                             */
/* This project deliberately has no DOM-rendering test infra (see this       */
/* file's own header comment above, and BetScreen.test.ts's own              */
/* readFileSync-based structural proof for the exact same "no render         */
/* harness" situation). The new compact header's content (status text,       */
/* ticket ID/player/date/time formatting) is proven via the same exported-   */
/* pure-function pattern already used above for the odds/badge logic;        */
/* the removal of the old verbose markup is proven structurally, against     */
/* the component's own source text, matching BetScreen.test.ts's             */
/* established technique.                                                    */
/* -------------------------------------------------------------------------- */

const source = readFileSync(fileURLToPath(new URL("./BetTicket.tsx", import.meta.url)), "utf8");

// Requirement 1/2 — status + its short detail remain visible, per status,
// not special-cased to "submitted" (STATUS_CONFIG drives one shared render
// path for every BetTicketStatus).
test("STATUS_CONFIG: submitted status remains visible with its exact label", () => {
  assert.equal(STATUS_CONFIG.submitted.badgeLabel, "Submitted");
});

test("STATUS_CONFIG: awaiting-confirmation meaning remains visible, as a short compact detail (not the old full sentence)", () => {
  assert.equal(STATUS_CONFIG.submitted.detail, "Awaiting confirmation");
});

test("STATUS_CONFIG: every other status still has a real badgeLabel and a short (non-sentence) detail — the compaction applies uniformly, not just to 'submitted'", () => {
  for (const key of ["confirmed", "rejected", "settled_won", "settled_lost", "void"] as const) {
    const config = STATUS_CONFIG[key];
    assert.ok(config.badgeLabel.length > 0, `${key} must have a badgeLabel`);
    assert.ok(config.detail.length > 0, `${key} must have a detail`);
    assert.ok(config.detail.length < 20, `${key}'s detail must be a short phrase, not a full sentence`);
  }
});

// Requirement 3 — Ticket ID remains visible, in its existing readable format.
test("shortTicketId: still formats as a readable #-prefixed uppercase short id", () => {
  assert.equal(shortTicketId("clx1a2b3c4d5e6f7g8h9"), "#E6F7G8H9");
});

// Requirements 5/6 — Date/Time remain visible via the exact same formatters.
test("formatDate: unchanged formatting, still produces a readable date", () => {
  assert.equal(formatDate("2026-08-15T15:14:00.000Z"), "Aug 15, 2026");
});

test("formatTime: unchanged formatting, still produces a readable time", () => {
  const result = formatTime("2026-08-15T15:14:00.000Z");
  assert.match(result, /^\d{2}:\d{2}\s?(AM|PM)?$/i);
});

test("formatDate/formatTime: an invalid date degrades to '—', never a crash or 'Invalid Date' string", () => {
  assert.equal(formatDate("not-a-date"), "—");
  assert.equal(formatTime("not-a-date"), "—");
});

// Requirement 4 — Player remains visible: ticket.player is interpolated
// directly (no formatter to unit-test), so this is proven structurally
// below (source still reads `{ticket.player}` inside the compact meta
// line) alongside requirements 7/8.

// Requirement 7 — the old long explanatory sentence is gone, for every
// status (not just "submitted").
test("source: the old full explanatory sentences are gone", () => {
  const oldSentences = [
    "Your bet has been submitted and is awaiting confirmation.",
    "Your bet has been confirmed and is now active.",
    "This bet was not accepted.",
    "Congratulations — this bet won.",
    "This bet did not win.",
    "This bet was voided.",
  ];
  for (const sentence of oldSentences) {
    assert.equal(source.includes(sentence), false, `old explanatory sentence must be gone: "${sentence}"`);
  }
});

// Requirement 8 — the old large header/status presentation is gone: the
// separate "Digital Bet Ticket" caption, the large 64px status icon
// circle, the status pill, and the 2×2 metadata grid are all removed.
test("source: the old large header/status/meta presentation is gone", () => {
  assert.equal(source.includes("Digital Bet Ticket"), false, "the separate caption line must be gone");
  assert.equal(source.includes("h-16 w-16"), false, "the large 64px status icon circle must be gone");
  assert.equal(source.includes("grid-cols-2"), false, "the old 2×2 metadata grid must be gone");
  assert.equal(source.includes("TicketMeta"), false, "the old per-field TicketMeta cell component must be gone");
});

// Requirements 3/4/5/6 combined, structurally — the new compact meta line
// still reads all four fields, on one line, using the exact same
// formatters proven above.
test("source: the new compact meta line still renders Ticket ID, Player, Date, and Time together", () => {
  assert.match(source, /shortTicketId\(ticket\.id\)/);
  assert.match(source, /\{ticket\.player\}/);
  assert.match(source, /formatDate\(ticket\.createdAt\)/);
  assert.match(source, /formatTime\(ticket\.createdAt\)/);
});

// Requirement 9/10 — EXPRESS leg data and odds rendering are completely
// untouched by this stage: the exact M4.9 resolver calls and per-leg field
// reads must still be present, byte-for-byte.
test("source: EXPRESS leg rendering (event/selection/market/odds/badge) is unchanged by this stage", () => {
  assert.match(source, /resolveTicketSelectionOdds\(selection\)/);
  assert.match(source, /resolveTicketStatusBadge\(selection\)/);
  assert.match(source, /\{selection\.event\}/);
  assert.match(source, /\{selection\.selection\}/);
  assert.match(source, /selection\.market \? ` · \$\{selection\.market\}` : ""/);
  assert.match(source, /displayOdds !== null \? ` · \$\{formatAmount\(displayOdds\)\}` : ""/);
});

// Requirement 11 — Stake / Combined odds / Potential win rows and their
// data sources (ticket.stake, ticket.totalOdds, the same
// stake*totalOdds potentialWin computation) are unchanged.
test("source: Stake / Combined odds / Potential win rows and their computation are unchanged", () => {
  assert.match(source, /label="Stake"/);
  assert.match(source, /isParlay \? "Combined odds" : "Odds"/);
  assert.match(source, /label="Potential win"/);
  assert.match(source, /ticket\.stake \* ticket\.totalOdds/);
});

// Requirement 12 — Done / View History remain present and wired to the
// same handlers.
test("source: Done / View History buttons are unchanged", () => {
  assert.match(source, /aria-label="Done"/);
  assert.match(source, /onClick=\{onDone\}/);
  assert.match(source, /aria-label="View history"/);
  assert.match(source, /onClick=\{onViewHistory\}/);
});

// Accessibility — the ticket's own group role/label (which already
// communicates status to assistive tech) is unchanged.
test("source: the ticket's own accessible group role/label is unchanged", () => {
  assert.match(source, /role="group"/);
  assert.match(source, /aria-label=\{`Digital bet ticket, status: \$\{status\.badgeLabel\}`\}/);
});
