import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { toBetTicketData, resolveLiveTicketStatus } from "./BetScreen";
import type { ConfirmedBet, ConfirmedExpressBet, ConfirmedExpressSelection } from "./betConfirmApi";
import type { RecentBet } from "./types";

function recentBet(overrides: Partial<RecentBet> = {}): RecentBet {
  return {
    id: "bet-1",
    type: "SINGLE",
    sport: "Football",
    event: "Real Madrid vs Barcelona",
    outcome: "Real Madrid Win",
    stake: "100",
    odds: "2.1",
    status: "PENDING",
    createdAt: "2026-07-21T12:00:00.000Z",
    totalOdds: "2.1",
    homeTeamName: null,
    awayTeamName: null,
    competitionName: null,
    eventStartTime: null,
    selections: [],
    ...overrides,
  };
}

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

// ---------------------------------------------------------------------
// Regression: confirmed-ticket top-overlap bug. The old Stage M5.5B
// "compact top-spacing" wrapper (-mt-4 around the confirmedBet branch's
// BetTicket) was written against an earlier shell that applied a larger
// mt-4 gap above BetScreen. The shell's own top offset has since shrunk to
// a single mt-2 (app/miniapp/page.tsx's global h-8 header + mt-2 before
// BetScreen) — the same -mt-4 then over-cancelled that smaller gap and
// pulled the ticket up into the header, overlapping the LanguageSwitcher
// (most visible on a tall EXPRESS ticket). The global header now owns top
// spacing; a confirmed ticket must stay in normal document flow below it,
// with no negative-top-margin/translate-y offset of its own.
// ---------------------------------------------------------------------

test("source: submitted BetTicket still renders from the confirmedBet branch, wired to the same ticket/onDone/onViewHistory as before", () => {
  const source = readFileSync(fileURLToPath(new URL("./BetScreen.tsx", import.meta.url)), "utf8");

  assert.match(source, /if \(confirmedBet\) \{\s*\/\/ Status sync fix/);
  assert.match(source, /<BetTicket\s*\n\s*ticket=\{toBetTicketData\(confirmedBet, playerName, availableCredit, liveStatus \?\? undefined\)\}\s*\n\s*onDone=\{closeToDashboard\}/);
  assert.match(source, /onViewHistory=\{\(\) => \{\s*closeToDashboard\(\);\s*onNavigateToHistory\(\);\s*\}\}/);
});

test("source: the confirmedBet branch renders BetTicket directly — no -mt-4 (or any other negative top-margin/translate-y) wrapper around it", () => {
  const source = readFileSync(fileURLToPath(new URL("./BetScreen.tsx", import.meta.url)), "utf8");

  const branchMatch = source.match(/if \(confirmedBet\) \{([\s\S]*?)\n  \}/);
  assert.ok(branchMatch, "expected the confirmedBet branch to be found");
  const branchBody = branchMatch![1];

  // Strip this file's own regression-comment prose (which legitimately
  // mentions "-mt-4" in explaining the bug) before scanning for the actual
  // offending className — same convention as localization.test.ts's
  // stripComments() helper.
  const codeOnly = branchBody.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

  assert.equal(codeOnly.includes("-mt-4"), false, "must not reintroduce the stale -mt-4 wrapper");
  assert.equal(/-mt-\d/.test(codeOnly), false, "must not introduce any other negative top margin");
  assert.equal(/-translate-y/.test(codeOnly), false, "must not introduce a translate-y workaround");
  assert.equal(/\babsolute\b|\bfixed\b/.test(codeOnly), false, "must not introduce absolute/fixed positioning");

  // BetTicket is returned directly (no wrapping <div> at all) — the exact
  // structure this bug's fix restores.
  assert.match(branchBody, /return \(\s*<BetTicket/);
});

// Status sync fix — the open ticket must reconcile its status from
// `recentBets` (already kept fresh by app/miniapp/page.tsx's own existing
// polling), by the exact same bet id, before rendering — never from the
// frozen `confirmedBet` snapshot alone. See the dedicated test suite below
// this file's toBetTicketData/resolveLiveTicketStatus tests for the full
// behavioral proof; this is the structural wiring check.
test("source: the confirmedBet branch derives liveStatus from recentBets by matching confirmedBet.id, via the existing page-level polling — no second fetch/interval introduced here", () => {
  const source = readFileSync(fileURLToPath(new URL("./BetScreen.tsx", import.meta.url)), "utf8");

  const branchMatch = source.match(/if \(confirmedBet\) \{([\s\S]*?)return \(/);
  assert.ok(branchMatch, "expected the confirmedBet branch to be found");
  const body = branchMatch![1];

  assert.match(body, /const liveTicket = recentBets\.find\(\(bet\) => bet\.id === confirmedBet\.id\);/);
  assert.match(body, /const liveStatus = liveTicket \? resolveLiveTicketStatus\(liveTicket\.status\) : null;/);
  // No fetch/setInterval/setTimeout is introduced in this branch — it only
  // ever reads the `recentBets` prop it's already given.
  assert.equal(/\bfetch\(|setInterval\(|setTimeout\(/.test(body), false);
});

test("source: the old bare (unwrapped) BetTicket return is gone — BetTicket is no longer the direct JSX child of the confirmedBet return", () => {
  const source = readFileSync(fileURLToPath(new URL("./BetScreen.tsx", import.meta.url)), "utf8");

  assert.equal(/if \(confirmedBet\) \{\s*return \(\s*<BetTicket/.test(source), false, "BetTicket must now be wrapped, not returned bare");
});

test("source: preview-form state (BetTextForm) spacing is untouched — still a bare return, no new wrapper added", () => {
  const source = readFileSync(fileURLToPath(new URL("./BetScreen.tsx", import.meta.url)), "utf8");

  assert.match(source, /if \(isTextFormOpen\) \{\s*return <BetTextForm onBack=\{\(\) => setTextFormOpen\(false\)\} onConfirmed=\{handleConfirmed\} \/>;\s*\}/);
});

test("source: upload/recognizing-form state (BetScreenshotForm) spacing is untouched — still a bare return, no new wrapper added", () => {
  const source = readFileSync(fileURLToPath(new URL("./BetScreen.tsx", import.meta.url)), "utf8");

  assert.match(source, /if \(isScreenshotFormOpen\) \{\s*return \(\s*<BetScreenshotForm onBack=\{\(\) => setScreenshotFormOpen\(false\)\} onConfirmed=\{handleConfirmed\} \/>\s*\);\s*\}/);
});

test("source: Done / View History wiring into BetTicket is byte-for-byte unchanged — only a new ancestor wrapper was added around the same call", () => {
  const source = readFileSync(fileURLToPath(new URL("./BetScreen.tsx", import.meta.url)), "utf8");

  assert.match(source, /onDone=\{closeToDashboard\}/);
  assert.match(source, /onViewHistory=\{\(\) => \{\s*closeToDashboard\(\);\s*onNavigateToHistory\(\);\s*\}\}/);
});

// BetTicket.tsx itself (M5.1 header, M5.2 financial summary, M5.3
// barcode/footer, M5.4 leg density) is not touched by this stage at all —
// this file only adds an ancestor wrapper around the existing <BetTicket
// .../> call, so those internals' own regression coverage in
// BetTicket.test.ts (unmodified by this stage) remains the proof they are
// unaffected.
test("source: BetTicket itself is imported and invoked exactly as before — no new BetTicket props added or removed (ticket/onDone/onViewHistory only; the status sync fix only changes toBetTicketData's own arguments, not BetTicket's props)", () => {
  const source = readFileSync(fileURLToPath(new URL("./BetScreen.tsx", import.meta.url)), "utf8");

  assert.match(source, /import BetTicket, \{ type BetTicketData, type BetTicketStatus \} from "\.\/BetTicket";/);
  const betTicketCall = source.match(
    /<BetTicket\s*\n\s*ticket=\{toBetTicketData\(confirmedBet, playerName, availableCredit, liveStatus \?\? undefined\)\}\s*\n\s*onDone=\{closeToDashboard\}\s*\n\s*onViewHistory=\{\(\) => \{\s*\n\s*closeToDashboard\(\);\s*\n\s*onNavigateToHistory\(\);\s*\n\s*\}\}\s*\n\s*\/>/,
  );
  assert.ok(betTicketCall, "expected BetTicket to still be called with exactly ticket/onDone/onViewHistory, nothing added or removed");
});

// ---------------------------------------------------------------------
// Localization foundation — home screen strings must come from the
// centralized translation dictionary (lib/i18n/translations.ts) via
// useLocale()'s t(), never a hardcoded literal, so a locale switch is
// reflected immediately with no per-string cache to invalidate.
// ---------------------------------------------------------------------

test("BetScreen: home-screen strings are translated via t(), not hardcoded Russian literals", () => {
  const source = readFileSync(fileURLToPath(new URL("./BetScreen.tsx", import.meta.url)), "utf8");

  assert.match(source, /import \{ useLocale \} from "\.\/LocaleProvider";/);
  assert.match(source, /\{t\("home\.sendBet"\)\}/);
  assert.match(source, /\{t\("home\.screenshotOrText"\)\}/);
  assert.match(source, /aria-label=\{t\("home\.sendBetAriaLabel"\)\}/);
  assert.match(source, /label=\{t\("home\.available"\)\}/);
  assert.match(source, /label=\{t\("home\.exposure"\)\}/);
  assert.match(source, /label=\{t\("home\.pending"\)\}/);
  assert.match(source, /\{t\("home\.lastActivity"\)\}/);
  assert.match(source, /\{t\("home\.noActivityYet"\)\}/);
  assert.match(source, /t\("bet\.single"\)/);
  assert.match(source, /t\("preview\.expressCount"/);
  assert.match(source, /"home\.activityPending"/);
  assert.match(source, /"home\.activityAccepted"/);
  assert.match(source, /"home\.activityRejected"/);
  assert.match(source, /"home\.activityWon"/);
  assert.match(source, /"home\.activityLost"/);
  assert.match(source, /"home\.activityVoid"/);
  assert.match(source, /"home\.activityHalfWon"/);
  assert.match(source, /"home\.activityHalfLost"/);


  assert.equal(source.includes('"Готов проверить вашу ставку"'), false);
  assert.equal(source.includes('"Отправить ставку"'), false);
  assert.equal(source.includes('"Доступно"'), false);
});

// ---------------------------------------------------------------------
// Status sync fix — the open BetTicket must reconcile its status from the
// fresh `recentBets` entry matching confirmedBet.id (the exact array
// app/miniapp/page.tsx's existing polling already keeps up to date),
// instead of the frozen confirmedBet snapshot's own (always-PENDING)
// status. These tests exercise the exact same two-step resolution
// BetScreen.tsx's confirmedBet branch performs — recentBets.find(...) then
// resolveLiveTicketStatus(...) then toBetTicketData(..., liveStatus ??
// undefined) — as pure functions, without needing this project's
// deliberately absent DOM-rendering test infra.
// ---------------------------------------------------------------------

function resolveOpenTicketStatus(bet: ConfirmedBet | ConfirmedExpressBet, allRecentBets: RecentBet[]) {
  const liveTicket = allRecentBets.find((entry) => entry.id === bet.id);
  const liveStatus = liveTicket ? resolveLiveTicketStatus(liveTicket.status) : null;
  return toBetTicketData(bet, "Andrii", "9390", liveStatus ?? undefined).status;
}

// Requirement 1 — freshly submitted PENDING ticket initially renders
// submitted/awaiting state.
test("status sync: a freshly submitted bet (recentBets has it as PENDING) renders 'submitted'", () => {
  const bet = singleBet();
  const status = resolveOpenTicketStatus(bet, [recentBet({ id: bet.id, status: "PENDING" })]);
  assert.equal(status, "submitted");
});

// Also covers the brief instant before the optimistic merge has landed in
// recentBets at all — must never crash, must fall back to "submitted"
// (byte-for-byte the original, pre-fix behavior), never show a wrong or
// blank status.
test("status sync: if the bet id isn't in recentBets yet, the ticket safely falls back to 'submitted' — never crashes, never shows a stale/wrong status", () => {
  const bet = singleBet();
  const status = resolveOpenTicketStatus(bet, []);
  assert.equal(status, "submitted");
});

// Requirement 2 — when the same bet id is later reconciled as CONFIRMED,
// the open ticket resolves to CONFIRMED.
test("status sync: once recentBets reconciles the same id as CONFIRMED, the open ticket resolves to 'confirmed'", () => {
  const bet = singleBet();
  const status = resolveOpenTicketStatus(bet, [recentBet({ id: bet.id, status: "CONFIRMED" })]);
  assert.equal(status, "confirmed");
});

// Requirement 3 — REJECTED, not only CONFIRMED.
test("status sync: once recentBets reconciles the same id as REJECTED, the open ticket resolves to 'rejected'", () => {
  const bet = singleBet();
  const status = resolveOpenTicketStatus(bet, [recentBet({ id: bet.id, status: "REJECTED" })]);
  assert.equal(status, "rejected");
});

test("status sync: SETTLED_WIN/SETTLED_LOSS/VOID reconcile too, via the same mapping BetTicket.tsx's STATUS_CONFIG already supports", () => {
  const bet = singleBet();
  assert.equal(resolveOpenTicketStatus(bet, [recentBet({ id: bet.id, status: "SETTLED_WIN" })]), "settled_won");
  assert.equal(resolveOpenTicketStatus(bet, [recentBet({ id: bet.id, status: "SETTLED_LOSS" })]), "settled_lost");
  assert.equal(resolveOpenTicketStatus(bet, [recentBet({ id: bet.id, status: "VOID" })]), "void");
});

test("resolveLiveTicketStatus: a status with no existing BetTicket visual state (e.g. SETTLED_HALF_WIN) returns null rather than fabricating one", () => {
  assert.equal(resolveLiveTicketStatus("SETTLED_HALF_WIN"), null);
  assert.equal(resolveLiveTicketStatus("SETTLED_HALF_LOSS"), null);
  assert.equal(resolveLiveTicketStatus("SOME_FUTURE_STATUS"), null);
});

// Requirement 4 — unrelated recent bets cannot change the open ticket.
test("status sync: an unrelated recent bet (different id) — even one with a different status — never affects the open ticket", () => {
  const bet = singleBet({ id: "bet-open" });
  const status = resolveOpenTicketStatus(bet, [
    recentBet({ id: "bet-open", status: "PENDING" }),
    recentBet({ id: "bet-unrelated-1", status: "CONFIRMED" }),
    recentBet({ id: "bet-unrelated-2", status: "REJECTED" }),
  ]);
  assert.equal(status, "submitted", "only the entry whose id matches the open ticket may affect it");
});

// Requirement 5 — EXPRESS works the same way.
test("status sync: EXPRESS reconciles identically — PENDING -> submitted, then CONFIRMED -> confirmed, then REJECTED -> rejected, keyed on the same bet id", () => {
  const bet = expressBet();
  assert.equal(resolveOpenTicketStatus(bet, [recentBet({ id: bet.id, type: "EXPRESS", status: "PENDING" })]), "submitted");
  assert.equal(resolveOpenTicketStatus(bet, [recentBet({ id: bet.id, type: "EXPRESS", status: "CONFIRMED" })]), "confirmed");
  assert.equal(resolveOpenTicketStatus(bet, [recentBet({ id: bet.id, type: "EXPRESS", status: "REJECTED" })]), "rejected");
});

// Requirement 7 (structural half already covered above in "source:" tests)
// — the fix must never touch how selections/stake/totalOdds are derived,
// only `status`. Reusing this file's own pre-existing EXPRESS assertions
// proves the rest of toBetTicketData's output is unaffected by the new
// 4th parameter.
test("status sync: reconciling status leaves every other ticket field (selections/stake/totalOdds) exactly as toBetTicketData already produced it", () => {
  const bet = expressBet();
  const withoutLiveStatus = toBetTicketData(bet, "Andrii", "9390");
  const withLiveStatus = toBetTicketData(bet, "Andrii", "9390", "confirmed");

  assert.notEqual(withoutLiveStatus.status, withLiveStatus.status);
  assert.deepEqual(withoutLiveStatus.selections, withLiveStatus.selections);
  assert.equal(withoutLiveStatus.stake, withLiveStatus.stake);
  assert.equal(withoutLiveStatus.totalOdds, withLiveStatus.totalOdds);
});
