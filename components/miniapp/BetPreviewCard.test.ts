import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  isProviderUnavailable,
  PROVIDER_UNAVAILABLE_TITLE,
  PROVIDER_UNAVAILABLE_MESSAGE,
  formatPotentialWin,
  formatSingleOdds,
  ODDS_UNAVAILABLE_NOTICE,
} from "./BetPreviewCard";
import type { BetSelectionOddsStatus } from "./betPreviewApi";

const source = readFileSync(fileURLToPath(new URL("./BetPreviewCard.tsx", import.meta.url)), "utf8");

// This project deliberately has no DOM-rendering test infra (see
// ActiveBetsScreen.test.ts's own comment on why jsdom/@testing-library were
// never added) — BetPreviewCard.tsx's own JSX is exercised manually, not by
// an automated render. What IS covered here, without any rendering, is the
// decision this task is actually about: for a provider-technical failure
// (oddsStatus "UNAVAILABLE" — timeout/rate limit/quota exhausted/auth
// failure/generic outage, all collapsed by lib/odds/mapOddsStatus.ts), the
// Mini App must show the neutral "temporarily unavailable" copy, and that
// copy must never imply the team/event wasn't found or that the player
// entered the bet incorrectly. isProviderUnavailable is the exact predicate
// BetPreviewCard.tsx's OddsStatus (SINGLE) and ExpressOddsSummary (EXPRESS)
// both branch on before falling through to any other message.

test("isProviderUnavailable: true only for oddsStatus UNAVAILABLE", () => {
  assert.equal(isProviderUnavailable("UNAVAILABLE"), true);
});

test("isProviderUnavailable: false for every other BetSelectionOddsStatus value — a genuine NOT_FOUND must never show the provider-unavailable copy", () => {
  const nonProviderStatuses: BetSelectionOddsStatus[] = ["PENDING", "VERIFIED", "ODDS_CHANGED", "NOT_FOUND"];
  for (const status of nonProviderStatuses) {
    assert.equal(isProviderUnavailable(status), false, `${status} must not be treated as a provider failure`);
  }
});

test("PROVIDER_UNAVAILABLE_TITLE/MESSAGE match the required neutral copy exactly", () => {
  assert.equal(PROVIDER_UNAVAILABLE_TITLE, "Live odds are temporarily unavailable");
  assert.equal(PROVIDER_UNAVAILABLE_MESSAGE, "We couldn't verify this bet right now. Please try again later.");
});

// The three things this copy must never say, regardless of future edits —
// checked directly against the exported constants so a future change that
// reintroduces one of these implications fails loudly here rather than
// only being caught by manual review.
test("PROVIDER_UNAVAILABLE_TITLE/MESSAGE never imply the team wasn't found, the event doesn't exist, or the player entered the bet incorrectly", () => {
  const combined = `${PROVIDER_UNAVAILABLE_TITLE} ${PROVIDER_UNAVAILABLE_MESSAGE}`.toLowerCase();
  for (const forbidden of ["not found", "doesn't exist", "does not exist", "incorrect", "edit your bet", "check the spelling"]) {
    assert.equal(combined.includes(forbidden), false, `copy must not contain: "${forbidden}"`);
  }
});

/* -------------------------------------------------------------------------- */
/* UI Polish task — Bet Preview Cards                                         */
/* -------------------------------------------------------------------------- */

// Requirement: "Potential win must include the currency, for example
// '16.90 USDC'." Formatting only — formatPotentialWin never recomputes the
// value, only appends the unit to what buildBetSlipPreview.ts already
// computed.
test("formatPotentialWin: appends USDC to a real value, matching the exact reproduction figure from this task", () => {
  assert.equal(formatPotentialWin(16.9), "16.90 USDC");
});

test("formatPotentialWin: null (nothing available yet) stays the existing 'Not available' text, no fabricated currency", () => {
  assert.equal(formatPotentialWin(null), "Not available");
});

test("formatPotentialWin: zero is a real value, not treated as absent", () => {
  assert.equal(formatPotentialWin(0), "0.00 USDC");
});

/* -------------------------------------------------------------------------- */
/* Stage M4.5 — CLEAN UNAVAILABLE-ODDS UX                                    */
/*                                                                             */
/* No DOM-rendering infra exists in this project (see this file's own header */
/* comment above), so PreviewCard's/OddsStatus's JSX itself is exercised     */
/* manually — what IS covered here, without rendering, is the exact single  */
/* condition (isConfirmableSingleOdds, tested in canConfirmBetSlip.test.ts)  */
/* those components now branch their "Odds"/"Potential win"/notice output   */
/* on, plus the exact copy that replaces every previous SINGLE warning box. */
/* -------------------------------------------------------------------------- */

// Requirement 2: SINGLE + odds unavailable shows "Odds" / "Not available".
// formatSingleOdds is the exact function PreviewCard's "Odds" row calls —
// currentOdds is null in every unavailable case (see this function's own
// doc comment in BetPreviewCard.tsx).
test("formatSingleOdds: null currentOdds (the unavailable-odds case) renders 'Not available'", () => {
  assert.equal(formatSingleOdds(null), "Not available");
});

test("formatSingleOdds: a real current price is formatted, never 'Not available'", () => {
  assert.equal(formatSingleOdds(1.91), "1.91");
});

// Requirement 3: exactly one concise message, the new required copy.
// Stage M4.6 — shortened again, same meaning, still one compact line.
test("ODDS_UNAVAILABLE_NOTICE: matches the required concise copy exactly", () => {
  assert.equal(ODDS_UNAVAILABLE_NOTICE, "Odds for this selection are currently unavailable.");
});

// Requirement 5/7: none of the old verbose warning copy this notice
// replaces (the "could not be verified" / "check the bet details" / "try
// again later" / "odds unavailable... edit your bet" boxes), AND the prior
// Stage M4.5 sentence it just replaced, may reappear inside the new
// message.
test("ODDS_UNAVAILABLE_NOTICE: never contains any of the old verbose warning copy it replaces, including the prior M4.5 sentence", () => {
  const lower = ODDS_UNAVAILABLE_NOTICE.toLowerCase();
  for (const forbidden of [
    "could not be verified",
    "couldn't verify",
    "check the bet details",
    "try again later",
    "edit your bet",
    "operator",
    "provider",
    "exact odds",
    "aren't available right now",
  ]) {
    assert.equal(lower.includes(forbidden), false, `ODDS_UNAVAILABLE_NOTICE must not contain: "${forbidden}"`);
  }
});

// Stage M5.4 — SINGLE-SCREEN CORE BET FLOW. Section C: the EXPRESS card's
// internal spacing (heading-to-list gap, list-to-financial gap, financial
// block's own padding) tightened so a 2-leg EXPRESS preview + financial
// summary has a realistic shot at fitting a normal iPhone viewport without
// scrolling. No selection, label, or figure was removed — only the gaps
// between them shrank.
test("source: the EXPRESS heading-to-selection-list gap was tightened (h3 mb-3 -> mb-2, wrapper mt-4 removed)", () => {
  assert.match(source, /<h3 className="mb-2 text-base font-bold text-white">\s*\{t\("preview\.expressCount", \{ count: String\(preview\.selections\.length\) \}\)\}\s*<\/h3>/);
});

test("source: the EXPRESS financial block's gap and internal padding were tightened (mt-4 -> mt-3, p-3 -> p-2.5)", () => {
  assert.match(source, /className="mt-3 rounded-xl p-2\.5"/);
  assert.equal(source.includes('className="mt-4 rounded-xl p-3"'), false, "old, looser EXPRESS financial block spacing must be gone");
});

test("source: PreviewRow's inter-row gap was tightened (mb-2 -> mb-1.5) — applies to both SINGLE and EXPRESS, since both share PreviewRow", () => {
  assert.match(source, /\$\{last \? "" : "mb-1\.5"\}`/);
});

// ---------------------------------------------------------------------
// Localization closure pass — the EXPRESS branch's SelectionRow now
// receives translated oddsLabel/statusBadgeLabel, resolved here via the
// Mini App's own i18n layer (useLocale()'s t()/getOddsStatusBadge), so a
// player's EXPRESS leg row is never left showing hardcoded English
// ("Odds"/status badge) inside an otherwise-translated RU preview.
// SelectionRow itself stays untouched/generic — see SelectionRow.test.ts's
// own "imports no localization mechanism" proof.
// ---------------------------------------------------------------------

test("BetPreviewCard: EXPRESS SelectionRow rows receive oddsLabel from t(\"preview.odds\") and statusBadgeLabel from getOddsStatusBadge(..., locale)", () => {
  assert.match(source, /import \{ getOddsStatusBadge \} from "@\/lib\/bets\/oddsStatusBadge";/);
  assert.match(
    source,
    /<SelectionRow\s*\n\s*selection=\{selections\[index\]\}\s*\n\s*showStatus\s*\n\s*oddsLabel=\{t\("preview\.odds"\)\}\s*\n\s*statusBadgeLabel=\{getOddsStatusBadge\(selection\.oddsStatus, locale\)\.label\}\s*\n\s*\/>/,
  );
});

// Behavioral proof (not just source-regex) of the actual required result:
// RU renders "Коэффициент" + a translated status label; EN renders "Odds"
// + the original English status label — exercising the exact same two
// calls (translate("preview.odds", locale) via t(), getOddsStatusBadge(...,
// locale)) BetPreviewCard.tsx's EXPRESS branch makes for each leg.
test("BetPreviewCard EXPRESS leg localization: RU resolves 'Коэффициент' + translated status; EN resolves 'Odds' + the original English status", async () => {
  const { translate } = await import("../../lib/i18n/translations");
  const { getOddsStatusBadge } = await import("../../lib/bets/oddsStatusBadge");

  assert.equal(translate("en", "preview.odds"), "Odds");
  assert.equal(translate("ru", "preview.odds"), "Коэффициент");

  const enBadge = getOddsStatusBadge("NOT_FOUND", "en");
  const ruBadge = getOddsStatusBadge("NOT_FOUND", "ru");
  assert.equal(enBadge.label, "Not found");
  assert.equal(ruBadge.label, "Не найдено");
  // Color must never depend on locale — same proof as
  // localization.test.ts's own getOddsStatusBadge coverage, repeated here
  // in the exact context this component actually calls it from.
  assert.equal(enBadge.color, ruBadge.color);
});
