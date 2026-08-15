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
  computeTicketPotentialWin,
  type BetTicketSelection,
} from "./BetTicket";
import { formatPotentialWin } from "./BetPreviewCard";

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
// Stage M5.2 — the computation itself moved from inline in the component
// body into the exported computeTicketPotentialWin (see the dedicated
// behavioral tests below), so this now checks the call site + the
// function's own untouched formula, instead of the old inline expression.
test("source: Stake / Combined odds / Potential win rows and their computation are unchanged", () => {
  assert.match(source, /label="Stake"/);
  assert.match(source, /isParlay \? "Combined odds" : "Odds"/);
  assert.match(source, /label="Potential win"/);
  assert.match(source, /computeTicketPotentialWin\(ticket\.stake, ticket\.totalOdds\)/);
  assert.match(source, /stake \* totalOdds/);
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

/* -------------------------------------------------------------------------- */
/* Stage M5.2 — BET TICKET FINANCIAL SUMMARY POLISH                          */
/*                                                                             */
/* Root cause this proves fixed: BetTicket.tsx's "Potential win" row rendered */
/* a bare number ("34.10") with no currency, unlike the pre-confirmation      */
/* preview (BetPreviewCard.tsx's formatPotentialWin, "34.10 USDC"). This      */
/* stage makes the ticket reuse that exact same existing function/currency   */
/* source rather than inventing a second, independently-maintained one.      */
/* Behavioral tests are used where practical (computeTicketPotentialWin,     */
/* formatPotentialWin are both now directly importable pure functions);      */
/* source-text checks (this project's established no-DOM-render technique)   */
/* cover what can't be expressed as a pure-function call (which literal      */
/* value ticket.availableCredit/ticket.stake feed, styling tiers, etc).      */
/* -------------------------------------------------------------------------- */

// Requirement A/B — EXPRESS and SINGLE Potential win both format with the
// project's existing currency source (formatPotentialWin, reused from
// BetPreviewCard.tsx — not a second, independently hardcoded "USDC").
// computeTicketPotentialWin itself is bet-type-agnostic (same formula for
// both), matching the unchanged pre-M5.2 behavior.
test("EXPRESS: Potential win (stake 5, combined odds 6.82) formats with the existing USDC currency source", () => {
  const potentialWin = computeTicketPotentialWin(5, 6.82);
  assert.equal(formatPotentialWin(potentialWin), "34.10 USDC");
});

test("SINGLE: Potential win (stake 75, odds 1.95) formats with the same existing USDC currency source", () => {
  const potentialWin = computeTicketPotentialWin(75, 1.95);
  assert.equal(formatPotentialWin(potentialWin), "146.25 USDC");
});

test("computeTicketPotentialWin: unchanged formula and null-handling — no totalOdds, non-finite stake/odds all degrade to null, never a fabricated number", () => {
  assert.equal(computeTicketPotentialWin(5, null), null);
  assert.equal(computeTicketPotentialWin(NaN, 6.82), null);
  assert.equal(computeTicketPotentialWin(5, Infinity), null);
});

test("formatPotentialWin: a null potential win still falls back to 'Not available', exactly as it did before reuse (never a bare number, never a fabricated currency)", () => {
  assert.equal(formatPotentialWin(null), "Not available");
});

// Requirement C — Stake value/calculation (ticket.stake, formatAmount, no
// currency suffix) is unchanged. Bare formatting matches the pre-confirm
// preview's own established convention (BetPreviewCard.tsx's Stake row
// also has no currency suffix) — inspected before deciding, not invented.
test("source: Stake keeps its exact pre-M5.2 bare (no-currency) formatting — matches the pre-confirm preview's own established convention", () => {
  assert.match(source, /label="Stake" value=\{formatAmount\(ticket\.stake\)\}/);
});

// Requirement D — Combined odds (EXPRESS) unchanged: no badge, no
// explanatory text, no provider info, no submitted/current comparison,
// same totalOdds source.
test("source: Combined odds (EXPRESS) is unchanged — bare totalOdds value only, no badge or comparison text", () => {
  assert.match(source, /ticket\.totalOdds !== null \? formatAmount\(ticket\.totalOdds\) : "Not provided"/);
});

// Requirement E — SINGLE's "Odds" label (the same row, non-parlay branch)
// is unchanged.
test("source: SINGLE's 'Odds' label is unchanged — same row/branch as Combined odds, just isParlay ? ... : \"Odds\"", () => {
  assert.match(source, /isParlay \? "Combined odds" : "Odds"/);
});

// Requirement F — Available credit's value/source (ticket.availableCredit,
// passed through verbatim) is unchanged; only its visual weight changed.
// Confirmed by inspection: every other surface that reads availableCredit
// (BetScreen.tsx's own dashboard "Доступно" row, BalanceScreen.tsx's
// "Доступно") also renders it as a bare value with no currency suffix —
// GET /api/miniapp/me computes it as a plain Decimal.toString(), never
// USDC-suffixed anywhere in the pipeline. Reusing that established
// convention here, not inventing a new one.
test("source: Available credit's value/source is unchanged (ticket.availableCredit, no currency appended) — matches the established convention every other surface already uses", () => {
  assert.match(source, /value=\{ticket\.availableCredit\}/);
  assert.equal(source.includes("ticket.availableCredit} USDC"), false, "must never append a currency suffix nowhere else in the product does");
});

// Requirement F (continued) — Available credit is now visually muted
// relative to Stake/Combined odds, on top of already being secondary to
// Potential win.
test("source: Available credit now renders with the new muted tier", () => {
  assert.match(source, /label="Available credit"[\s\S]{0,120}muted/);
});

test("FinancialRow: the new muted tier is additive — emphasize (Potential win) and the default tier (Stake/Combined odds) are untouched by its addition", () => {
  // Structural proof (no rendering harness): the function signature still
  // defaults muted to false, so every existing call site that never passes
  // it keeps its exact prior rendering.
  assert.match(source, /muted\?: boolean;/);
  assert.match(source, /muted = false,/);
});

// Requirement G — the M5.1 compact header remains fully intact; this
// stage touched only the financial block below it.
test("source: the M5.1 compact header/status/meta block remains fully intact", () => {
  assert.match(source, /· \{status\.detail\}/);
  assert.match(source, /shortTicketId\(ticket\.id\)/);
  assert.match(source, /\{ticket\.player\}/);
  assert.equal(source.includes("Digital Bet Ticket"), false);
  assert.equal(source.includes("h-16 w-16"), false);
  assert.equal(source.includes("grid-cols-2"), false);
});

// Requirement H — M4.9's EXPRESS current-odds rendering (resolveTicketSelectionOdds/
// resolveTicketStatusBadge) is completely untouched by this stage.
test("source: M4.9 EXPRESS current-odds rendering (resolveTicketSelectionOdds/resolveTicketStatusBadge) remains intact", () => {
  assert.match(source, /resolveTicketSelectionOdds\(selection\)/);
  assert.match(source, /resolveTicketStatusBadge\(selection\)/);
});

// Requirement I — no old submitted/current comparison or Verified/Odds
// changed badges are reintroduced anywhere in the file, including the
// financial block this stage touched.
// Checks the exact removed JSX pattern, not the bare substring "Current: "
// — this file's own M4.9 header comment legitimately quotes that string as
// historical documentation of the bug it fixed, which a plain substring
// check would collide with.
test("source: no old submitted/current odds comparison or unconditional Verified/Odds changed badges are reintroduced", () => {
  assert.equal(/<span>Current: \{formatAmount\(selection\.currentOdds\)\}<\/span>/.test(source), false);
  assert.equal(/\{selection\.oddsStatus != null && <OddsStatusPill/.test(source), false);
});

/* -------------------------------------------------------------------------- */
/* Stage M5.3 — BET TICKET FOOTER COMPACTION                                 */
/*                                                                             */
/* Goal: shrink the barcode/"Verified by BetPilot AI" footer's visual weight  */
/* and vertical footprint without touching the barcode's own seed-derived    */
/* data (barcodeWidths), removing it, or changing anything above the footer. */
/* Same no-DOM-render, source-text-inspection technique as every prior       */
/* BetTicket stage (this project deliberately has no rendering harness).     */
/* -------------------------------------------------------------------------- */

// Requirement A — the barcode is still rendered (same component, same
// seed), never removed.
test("source: the barcode is still rendered, wired to the same ticket.id seed", () => {
  assert.match(source, /<TicketBarcode seed=\{ticket\.id\}\s*\/>/);
});

// Requirement B — "Verified by BetPilot AI" keeps its exact existing text
// and icon, no new copy/badges/borders/cards added.
test("source: 'Verified by BetPilot AI' is still rendered, unchanged text, no new icon/badge/border added", () => {
  assert.match(source, /Verified by BetPilot AI/);
  assert.match(source, /<Barcode size=\{12\} strokeWidth=\{2\} aria-hidden="true" \/>/);
});

// Requirement C — the footer uses the new compact sizing/spacing: the
// barcode container shrank from h-10 (40px) to h-6 (24px, a 40%
// reduction), the outer footer padding tightened (pt-5 pb-6 -> pt-4 pb-5),
// and the gap before "Verified by BetPilot AI" tightened (mt-3 -> mt-1.5)
// so the two elements read as one compact unit.
test("source: the footer uses the new compact barcode height and tighter spacing", () => {
  assert.match(source, /className="flex h-6 items-center gap-\[3px\]"/);
  assert.equal(source.includes('className="flex h-10 items-center gap-[3px]"'), false, "old 40px barcode height must be gone");
  assert.match(source, /className="flex flex-col items-center px-5 pt-4 pb-5"/);
  assert.equal(source.includes('px-5 pb-6 pt-5"'), false, "old, looser footer padding must be gone");
  assert.match(source, /<p className="mt-1\.5 flex items-center gap-1\.5 text-\[11px\] text-slate-500">/);
  assert.equal(/<p className="mt-3 flex items-center gap-1\.5 text-\[11px\]/.test(source), false, "old, looser gap before the verification line must be gone");
});

// Requirement C (continued) — the barcode's own seed-derived pattern
// generation is completely untouched by the height reduction.
test("barcodeWidths generation logic is unaffected — behavioral proof via the still-unchanged TicketBarcode/seed wiring and bar-count/gap markers", () => {
  assert.match(source, /function barcodeWidths\(seed: string\): number\[\]/);
  assert.match(source, /for \(let i = 0; i < 36; i \+= 1\)/);
  assert.match(source, /bars\.push\(1 \+ \(hash % 3\)\)/);
});

// Requirement D — the M5.1 compact header remains fully intact.
test("M5.3 regression guard: the M5.1 compact header/status/meta block is untouched", () => {
  assert.equal(STATUS_CONFIG.submitted.badgeLabel, "Submitted");
  assert.equal(STATUS_CONFIG.submitted.detail, "Awaiting confirmation");
  assert.match(source, /shortTicketId\(ticket\.id\)/);
  assert.equal(source.includes("Digital Bet Ticket"), false);
});

// Requirement E — the M5.2 financial summary (including currency-suffixed
// Potential win) remains fully intact.
test("M5.3 regression guard: the M5.2 financial summary, including Potential win's USDC formatting, is untouched", () => {
  assert.equal(formatPotentialWin(computeTicketPotentialWin(5, 6.82)), "34.10 USDC");
  assert.match(source, /label="Stake" value=\{formatAmount\(ticket\.stake\)\}/);
  assert.match(source, /label="Available credit"[\s\S]{0,120}muted/);
});

// Requirement F — M4.9's EXPRESS current-odds rendering remains intact
// (behavioral, not just source-text).
test("M5.3 regression guard: M4.9 EXPRESS current-odds behavior is untouched", () => {
  const result = resolveTicketSelectionOdds(selection({ odds: 3.7, currentOdds: 3.87, oddsStatus: "ODDS_CHANGED" }));
  assert.equal(result, 3.87);
  assert.equal(resolveTicketStatusBadge(selection({ currentOdds: 3.87, oddsStatus: "ODDS_CHANGED" })), null);
});

// Requirement G — SINGLE ticket rendering (oddsStatus undefined — odds
// passes straight through, "Odds" label) remains correct.
test("M5.3 regression guard: SINGLE ticket rendering is untouched", () => {
  assert.equal(resolveTicketSelectionOdds(selection({ odds: 2.04, currentOdds: null, oddsStatus: null })), 2.04);
  assert.match(source, /isParlay \? "Combined odds" : "Odds"/);
});

// Requirement H — EXPRESS ticket rendering (leg list + "Combined odds"
// label + financial summary) remains correct.
test("M5.3 regression guard: EXPRESS ticket rendering is untouched", () => {
  assert.match(source, /\{isParlay && \(/);
  assert.match(source, /Leg \{index \+ 1\}/);
  assert.match(source, /isParlay \? "Combined odds" : "Odds"/);
});

// Requirement I — Done / View History remain unchanged, same handlers,
// same labels, unaffected by the footer change directly above them.
test("M5.3 regression guard: Done / View History remain unchanged", () => {
  assert.match(source, /aria-label="Done"/);
  assert.match(source, /onClick=\{onDone\}/);
  assert.match(source, /aria-label="View history"/);
  assert.match(source, /onClick=\{onViewHistory\}/);
});
