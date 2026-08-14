import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isProviderUnavailable,
  PROVIDER_UNAVAILABLE_TITLE,
  PROVIDER_UNAVAILABLE_MESSAGE,
  formatPotentialWin,
  formatSingleOdds,
  ODDS_UNAVAILABLE_NOTICE,
} from "./BetPreviewCard";
import type { BetSelectionOddsStatus } from "./betPreviewApi";

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
test("ODDS_UNAVAILABLE_NOTICE: matches the required concise copy exactly", () => {
  assert.equal(ODDS_UNAVAILABLE_NOTICE, "Exact odds for this selection aren't available right now.");
});

// Requirement 5: none of the old verbose warning copy this notice replaces
// (the "could not be verified" / "check the bet details" / "try again
// later" / "odds unavailable... edit your bet" boxes) may reappear inside
// the new single message.
test("ODDS_UNAVAILABLE_NOTICE: never contains any of the old verbose warning copy it replaces", () => {
  const lower = ODDS_UNAVAILABLE_NOTICE.toLowerCase();
  for (const forbidden of [
    "could not be verified",
    "couldn't verify",
    "check the bet details",
    "try again later",
    "edit your bet",
    "operator",
    "provider",
  ]) {
    assert.equal(lower.includes(forbidden), false, `ODDS_UNAVAILABLE_NOTICE must not contain: "${forbidden}"`);
  }
});
