import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getOddsPresentation } from "./SelectionRow";

const source = readFileSync(fileURLToPath(new URL("./SelectionRow.tsx", import.meta.url)), "utf8");

// UI Polish task — Bet Preview Cards. This project deliberately has no
// DOM-rendering test infra (see e.g. ActiveBetsScreen.test.ts's own
// comment), so the odds-presentation decision is extracted as a pure
// function (getOddsPresentation) and tested directly here, exactly as
// BetPreviewCard.test.ts already does for isProviderUnavailable.
//
// M4.1 — CLEAN PLAYER ODDS UX rewrote this function: it now takes only
// currentOdds (never the submitted/screenshot value), and VERIFIED /
// ODDS_CHANGED render IDENTICALLY — there is no more "dual" comparison
// mode. A player must only ever see BetPilot's current offer.

test("VERIFIED with a current odds value: one prominent value", () => {
  const result = getOddsPresentation("VERIFIED", 1.16);
  assert.deepEqual(result, { mode: "prominent", value: 1.16 });
});

test("VERIFIED with odds auto-promoted from the provider (the only value that ever existed): still one prominent value", () => {
  const result = getOddsPresentation("VERIFIED", 1.46);
  assert.deepEqual(result, { mode: "prominent", value: 1.46 });
});

// The exact production reproduction this stage fixes: screenshot odds 2.01,
// provider current odds 1.39. ODDS_CHANGED must render exactly like
// VERIFIED — one clean current-odds value, never the screenshot number,
// never a "Submitted 2.01 / Current 1.39" comparison.
test("ODDS_CHANGED renders identically to VERIFIED: one prominent value, the current odds only — never the submitted/screenshot odds, never a dual comparison", () => {
  const result = getOddsPresentation("ODDS_CHANGED", 1.39);
  assert.deepEqual(result, { mode: "prominent", value: 1.39 });
  assert.notEqual((result as { value?: number }).value, 2.01);
});

test("NOT_FOUND never returns prominent — no misleading verified-looking value", () => {
  const result = getOddsPresentation("NOT_FOUND", null);
  assert.deepEqual(result, { mode: "unavailable" });
});

test("UNAVAILABLE never returns prominent — no misleading verified-looking value", () => {
  const result = getOddsPresentation("UNAVAILABLE", null);
  assert.deepEqual(result, { mode: "unavailable" });
});

test("a null/undefined oddsStatus (review-context rows that never set it) falls back to unavailable, never prominent", () => {
  assert.deepEqual(getOddsPresentation(null, 1.5), { mode: "unavailable" });
  assert.deepEqual(getOddsPresentation(undefined, 1.5), { mode: "unavailable" });
});

// A confirmable status with no current odds at all (shouldn't happen in
// practice — buildBetSlipPreview.ts only sets VERIFIED/ODDS_CHANGED when a
// real sourceOdds was found) must still degrade safely rather than crash or
// fabricate a value.
test("VERIFIED/ODDS_CHANGED with a missing current odds degrades to unavailable, never a fabricated prominent value", () => {
  assert.deepEqual(getOddsPresentation("VERIFIED", null), { mode: "unavailable" });
  assert.deepEqual(getOddsPresentation("ODDS_CHANGED", null), { mode: "unavailable" });
});

// Stage M5.4 — SINGLE-SCREEN CORE BET FLOW. Section B: card padding and the
// odds-row gap tightened (this row is the shared leg card used by every
// EXPRESS preview/queue/list surface) so a 2-leg EXPRESS preview has a
// realistic shot at fitting a normal iPhone viewport without scrolling. No
// field (sport icon, event, competition/date, selection, market, odds,
// status badge) was removed — only the gaps around them shrank.
test("source: the card's own padding was tightened (p-3 -> p-2.5)", () => {
  assert.match(source, /className="rounded-xl p-2\.5"/);
  assert.equal(source.includes('className="rounded-xl p-3"'), false, "old, looser card padding must be gone");
});

test("source: the odds-row gap was tightened (mt-1.5 -> mt-1) for all three odds-row branches (prominent/unavailable/plain)", () => {
  assert.equal((source.match(/mt-1 (flex items-baseline gap-1\.5|text-xs text-slate-500)/g) ?? []).length, 3);
  assert.equal(source.includes("mt-1.5"), false, "old, looser odds-row gap must be gone");
});

// ---------------------------------------------------------------------
// Localization closure pass — SelectionRow stays a generic/shared
// component (Mini App Preview AND the operator dashboard's Pending
// Queue/Active Bets/History all render through it) and imports no
// localization mechanism itself. oddsLabel/statusBadgeLabel are optional,
// plain-string presentation overrides only the Mini App's own
// BetPreviewCard.tsx supplies (via lib/i18n); every other caller —
// including every operator/dashboard surface — omits them and keeps this
// row's exact original English presentation, unchanged, with no code
// changes required on their part.
// ---------------------------------------------------------------------

test("source: SelectionRow imports no localization mechanism — no LocaleProvider/useLocale/translate", () => {
  assert.equal(source.includes("LocaleProvider"), false);
  assert.equal(source.includes("useLocale"), false);
  assert.equal(/from ".*i18n/.test(source), false);
});

test("source: oddsLabel/statusBadgeLabel are optional props defaulting to the original English presentation — no default-behavior change for any existing (dashboard-included) caller", () => {
  assert.match(source, /oddsLabel\?: string/);
  assert.match(source, /statusBadgeLabel\?: string/);
  assert.match(source, /oddsLabel = "Odds"/);
});

test("source: the odds row's three branches (prominent/unavailable/plain) all render the oddsLabel prop, never a hardcoded 'Odds' literal", () => {
  assert.match(source, /<span className="text-xs text-slate-500">\{oddsLabel\}<\/span>/);
  assert.match(source, /<div className="mt-1 text-xs text-slate-500">\{oddsLabel\}: —<\/div>/);
  assert.match(source, /\{oddsLabel\}: \{presentation\.odds !== null \? formatAmount\(presentation\.odds\) : "—"\}/);
  assert.equal(source.includes(">Odds<"), false);
  assert.equal(source.includes(">Odds: —<"), false);
});

test("source: statusBadgeLabel only ever overrides the badge's .label — color still comes from getOddsStatusBadge, and whether a badge shows at all is still gated by showStatus/isConfirmableStatus, both completely unchanged", () => {
  assert.match(
    source,
    /const statusBadge =\s*showStatus && !isConfirmableStatus\s*\? \{ \.\.\.getOddsStatusBadge\(selection\.oddsStatus\), \.\.\.\(statusBadgeLabel \? \{ label: statusBadgeLabel \} : \{\}\) \}\s*: null;/,
  );
  // getOddsStatusBadge is still called with no locale argument — defaults
  // to "en" exactly as before this pass, for every caller.
  assert.match(source, /getOddsStatusBadge\(selection\.oddsStatus\)/);
});
