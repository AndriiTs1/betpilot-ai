import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  isValidStakeInput,
  isSingleBetReady,
  buildSingleSubmissionText,
  isExpressLegComplete,
  isExpressBetReady,
  buildExpressSubmissionText,
  MIN_EXPRESS_LEGS,
  MAX_EXPRESS_LEGS,
  type ExpressLegInput,
} from "./BetTextForm";
import { translate } from "@/lib/i18n/translations";

// Stage M4.7 — SILENT CURRENT-ODDS PLAYER UX. This project deliberately has
// no DOM-rendering test infra (see BetPreviewCard.test.ts's own header
// comment) — BetScreen.test.ts already established the precedent for
// proving a structural UI fact via the component's own raw source text
// instead. Used here to prove two things at once: the amber "Your offer
// has been refreshed. Please review and confirm again." banner (and the
// oddsChangedInfo state that used to drive it) is gone, AND — the actual
// safety-critical part — that the refreshed-preview/refreshed-token
// staging, the return to the "ready" phase, and the requirement for an
// explicit second Confirm tap all survive completely untouched. SILENT UX
// != SILENT ACCEPTANCE: this file never asserts anything about whether a
// bet gets created (that's app/api/miniapp/bets/text/confirm/route.test.ts's
// job, unaffected by this stage since no server code changed) — only that
// the client still stages the fresh data and still requires the player to
// press Confirm bet again.

const source = readFileSync(fileURLToPath(new URL("./BetTextForm.tsx", import.meta.url)), "utf8");

test("BetTextForm: the odds-changed banner state (oddsChangedInfo) no longer exists anywhere in this file", () => {
  assert.equal(source.includes("oddsChangedInfo"), false);
  assert.equal(source.includes("OddsChangedReconfirmUpdate"), false);
});

// Deliberately checks only the exact removed user-facing phrases, not
// generic words like "odds changed" — this file's own comments legitimately
// describe the odds_changed mechanism in prose (e.g. "Step 15B — odds
// changed since the preview was generated"), and a broader check would
// flag that internal documentation, not actual rendered copy.
test("BetTextForm: the exact removed banner copy is absent — no 'offer has been refreshed' / 'review and confirm again' text anywhere in this file", () => {
  const lower = source.toLowerCase();
  for (const forbidden of ["offer has been refreshed", "review and confirm again"]) {
    assert.equal(lower.includes(forbidden), false, `must not contain: "${forbidden}"`);
  }
});

test("BetTextForm: an odds_changed confirm failure still stages the refreshed preview/token (setPreview) and returns to the ready phase — safety unchanged by the banner removal", () => {
  const branchMatch = source.match(/if \(result\.failure\.kind === "odds_changed"\) \{([\s\S]*?)return;/);
  assert.ok(branchMatch, "expected an odds_changed branch inside handleConfirm");
  const branchBody = branchMatch![1];

  // Still builds the refreshed preview from the server's own
  // refreshedPreview/refreshedPreviewToken and stages it as the new preview
  // (overwriting the stale, pre-movement one) — the exact mechanism a
  // second Confirm tap will submit against.
  assert.match(branchBody, /const update = buildOddsChangedReconfirm\(result\.failure\)/);
  assert.match(branchBody, /setPreview\(update\.preview\)/);
  // Returns to "ready" (never "confirming" or any auto-submit state) so
  // the existing Confirm bet button is what the player must explicitly
  // tap again.
  assert.match(branchBody, /setPhase\("ready"\)/);
  // Never calls fetchBetConfirm a second time from inside this branch —
  // resubmission must only ever happen from a fresh, explicit player tap.
  assert.equal(/fetchBetConfirm/.test(branchBody), false);
});

test("BetTextForm: Confirm bet is gated ONLY on the Stage M4.5 unavailable-odds check, never on any odds-changed flag", () => {
  assert.match(source, /\{!oddsUnavailable && \(\s*<button[\s\S]{0,300}aria-label=\{t\("confirm\.confirmBet"\)\}/);
});

// Stage M5.4 — SINGLE-SCREEN CORE BET FLOW. Same action-area tightening as
// BetScreenshotForm.tsx, applied here for consistency between the two
// submission flows (both share this exact preview/Confirm/Edit structure).
test("source: the action-area gap above Confirm bet/Edit message was tightened (mt-4 -> mt-3 wrapper, mt-3 -> mt-2.5 buttons)", () => {
  assert.match(source, /\{showPreviewBlock && preview && \(\s*<div className="mt-3">/);
  assert.match(source, /aria-label=\{t\("confirm\.confirmBet"\)\}\s*className="mt-2\.5 min-h-11 w-full/);
  assert.match(source, /aria-label=\{t\("bet\.editMessage"\)\}\s*className="mt-2\.5 min-h-11 w-full/);
});

// Clean top-of-screen pass: removes the secondary helper line under "Place a
// bet" and replaces it with a purely visual Ординар/Экспресс segmented
// control. Deliberately source-based, same as every other test in this file
// (no DOM-rendering infra — see this file's header comment).
test("BetTextForm: the removed 'Describe your bet...' helper line is gone and not replaced by other explanatory copy", () => {
  assert.equal(source.includes("Describe your bet in one message"), false);
  assert.equal(source.includes("odds aren&apos;t required"), false);
});

test("BetTextForm: both bet-type segments render as a tablist right under the Place a bet title (now localized, see the translation-keys test below for exact copy)", () => {
  assert.match(
    source,
    /<p className="mt-3 text-xl font-bold text-white">\{t\("bet\.placeBet"\)\}<\/p>\s*<div\s+role="tablist"[\s\S]{0,800}\{t\("bet\.single"\)\}[\s\S]{0,800}\{t\("bet\.express"\)\}/,
  );
});

test("BetTextForm: bet-type tab state exists, defaults to 'single', and both buttons toggle it via aria-selected", () => {
  assert.match(source, /const \[betTypeTab, setBetTypeTab\] = useState<BetTypeTab>\("single"\)/);
  assert.match(source, /aria-selected=\{betTypeTab === "single"\}[\s\S]{0,120}onClick=\{\(\) => handleBetTypeChange\("single"\)\}/);
  assert.match(source, /aria-selected=\{betTypeTab === "express"\}[\s\S]{0,120}onClick=\{\(\) => handleBetTypeChange\("express"\)\}/);
});

// Structured input pass (SINGLE and EXPRESS both) — betTypeTab's literal
// value is still never sent to the API (the AI parser remains the sole
// SINGLE/EXPRESS authority), but it IS read by handlePreviewSubmit to
// decide which structured fields to compose/send.
test("BetTextForm: betTypeTab's literal value is never sent to the API — only the derived free-text is, composed per mode", () => {
  const submitFnMatch = source.match(/async function handlePreviewSubmit\(\) \{([\s\S]*?)\n  \}/);
  assert.ok(submitFnMatch, "expected handlePreviewSubmit to be found");
  const body = submitFnMatch![1];

  assert.match(
    body,
    /betTypeTab === "single"\s*\?\s*buildSingleSubmissionText\(eventValue, selectionValue, stakeValue\)\s*:\s*buildExpressSubmissionText\(expressLegs, expressStakeValue\)/,
  );
  assert.match(body, /fetchBetPreview\(tg\.initData, textToSubmit\)/);
  // betTypeTab is read to branch, but its own string value ("single"/
  // "express") never appears as an argument to fetchBetPreview.
  assert.equal(/fetchBetPreview\([^)]*betTypeTab/.test(body), false);
});

// ---------------------------------------------------------------------
// Localization foundation
// ---------------------------------------------------------------------

// Requirement 6 — bet-form labels update immediately on a locale switch:
// proven by showing every one of the five named product strings is read
// through t(), not a hardcoded literal, so re-render with a new `locale`
// always reflects the current language (no per-string cache to invalidate).
test("BetTextForm: Place a bet / bet-type labels / Review express all come from centralized translation keys, never hardcoded literals", () => {
  assert.match(source, /import \{ useLocale \} from "\.\/LocaleProvider";/);
  assert.match(source, /const \{ t, locale \} = useLocale\(\);/);
  assert.match(source, /\{t\("bet\.placeBet"\)\}/);
  assert.match(source, /aria-label=\{t\("bet\.typeAriaLabel"\)\}/);
  assert.match(source, /\{t\("bet\.single"\)\}/);
  assert.match(source, /\{t\("bet\.express"\)\}/);
  assert.match(source, /: t\("bet\.reviewExpress"\)/);

  // "Place a bet" legitimately still appears in this file's own prose
  // comments (naming the screen) — only the actual rendered JSX text node
  // is checked, not the whole file.
  assert.equal(source.includes('>Place a bet<'), false);
  assert.equal(source.includes(">Ординар<"), false);
  assert.equal(source.includes(">Экспресс<"), false);
});

// Requirement 12 — the player's own typed text must remain byte-for-byte
// unchanged when the UI locale switches: every EXPRESS field-change handler
// only ever reads/writes the raw leg or stake state, never t()/useLocale —
// only each input's `placeholder` (shown when the field is empty) is
// locale-driven.
test("BetTextForm: switching UI locale can never rewrite/translate the player's typed EXPRESS fields — leg/stake state is fully independent of t()/locale", () => {
  assert.match(source, /value=\{leg\.event\}/);
  assert.match(source, /value=\{leg\.selection\}/);
  assert.match(source, /value=\{expressStakeValue\}/);

  for (const handler of ["handleExpressLegEventChange", "handleExpressLegSelectionChange", "handleExpressStakeChange"]) {
    const match = source.match(new RegExp(`function ${handler}\\([^)]*\\) \\{([\\s\\S]*?)\\n {2}\\}`));
    assert.ok(match, `expected ${handler} to be found`);
    assert.equal(/\bt\(|useLocale|locale/.test(match![1]), false);
  }
});

// Requirement 13 — the parser/fetch payload carries the player's original
// text verbatim; UI locale is never part of it. This asserts the
// fetchBetPreview call ITSELF is never called with any t()/locale-derived
// argument (handlePreviewSubmit's body legitimately references `locale`
// elsewhere now, to localize the resulting error message on failure — that
// is correct localization behavior, not a violation of this invariant).
test("BetTextForm: the preview request payload is (initData, composed text) — the composed text itself is never mixed with the UI locale", () => {
  const submitFnMatch = source.match(/async function handlePreviewSubmit\(\) \{([\s\S]*?)\n  \}/);
  assert.ok(submitFnMatch, "expected handlePreviewSubmit to be found");
  const body = submitFnMatch![1];

  const textToSubmitMatch = body.match(
    /const textToSubmit =\s*betTypeTab === "single"\s*\?\s*buildSingleSubmissionText\(eventValue, selectionValue, stakeValue\)\s*:\s*buildExpressSubmissionText\(expressLegs, expressStakeValue\);/,
  );
  assert.ok(textToSubmitMatch, "expected the textToSubmit composition to be found");
  assert.equal(/\bt\(|locale/.test(textToSubmitMatch![0]), false);

  const fetchCallMatch = body.match(/const result = await fetchBetPreview\(tg\.initData, textToSubmit\);/);
  assert.ok(fetchCallMatch, "expected the fetchBetPreview call to be found");
  assert.equal(/\bt\(|locale/.test(fetchCallMatch![0]), false);
});

// buildSingleSubmissionText/isSingleBetReady/isValidStakeInput are pure and
// exported specifically so this file's own behavioral coverage below never
// needs a DOM-rendering harness this project deliberately doesn't have.

// ---------------------------------------------------------------------
// Structured SINGLE input — Event / Selection / Stake
// ---------------------------------------------------------------------

test("isValidStakeInput: rejects empty/whitespace, non-numeric, zero, and negative values; accepts a real positive amount", () => {
  assert.equal(isValidStakeInput(""), false);
  assert.equal(isValidStakeInput("   "), false);
  assert.equal(isValidStakeInput("abc"), false);
  assert.equal(isValidStakeInput("0"), false);
  assert.equal(isValidStakeInput("-5"), false);
  assert.equal(isValidStakeInput("NaN"), false);
  assert.equal(isValidStakeInput("100"), true);
  assert.equal(isValidStakeInput("  25.50  "), true);
});

// Requirement — button disabled with incomplete required fields.
test("isSingleBetReady: false when event, selection, or stake is missing/invalid — true only when all three are valid", () => {
  assert.equal(isSingleBetReady("", "", ""), false);
  assert.equal(isSingleBetReady("Inter vs Juventus", "", "100"), false, "missing selection");
  assert.equal(isSingleBetReady("", "Inter to win", "100"), false, "missing event");
  assert.equal(isSingleBetReady("Inter vs Juventus", "Inter to win", ""), false, "missing stake");
  assert.equal(isSingleBetReady("Inter vs Juventus", "Inter to win", "0"), false, "invalid (zero) stake");
  assert.equal(isSingleBetReady("   ", "Inter to win", "100"), false, "whitespace-only event doesn't count as present");
});

// Requirement — button enabled with valid Event + Selection + Stake.
test("isSingleBetReady: true when event, selection, and stake are all present and the stake is a valid positive number", () => {
  assert.equal(isSingleBetReady("Inter vs Juventus", "Inter to win", "100"), true);
  assert.equal(isSingleBetReady("  Inter vs Juventus  ", "  Inter to win  ", "  25.5  "), true);
});

test("buildSingleSubmissionText: composes a comma-joined, trimmed sentence from the three raw fields — no locale-specific phrasing", () => {
  assert.equal(
    buildSingleSubmissionText("Inter vs Juventus", "Inter to win", "100"),
    "Inter vs Juventus, Inter to win, 100",
  );
  assert.equal(
    buildSingleSubmissionText("  Интер — Ювентус  ", "  Интер победит  ", "  50  "),
    "Интер — Ювентус, Интер победит, 50",
  );
});

test("source: SINGLE renders Event/Selection/Stake as three structured inputs, each using centralized translation keys for its label/placeholder", () => {
  assert.match(source, /\{betTypeTab === "single" \? \(/);
  assert.match(source, /<label className="mb-1 block text-xs text-slate-500">\{t\("bet\.eventLabel"\)\}<\/label>/);
  assert.match(source, /placeholder=\{t\("bet\.eventPlaceholder"\)\}/);
  assert.match(source, /<label className="mb-1 block text-xs text-slate-500">\{t\("bet\.selectionLabel"\)\}<\/label>/);
  assert.match(source, /placeholder=\{t\("bet\.selectionPlaceholder"\)\}/);
  assert.match(source, /<label className="mb-1 block text-xs text-slate-500">\{t\("bet\.stakeLabel"\)\}<\/label>/);
  assert.match(source, /value=\{eventValue\}/);
  assert.match(source, /value=\{selectionValue\}/);
  assert.match(source, /value=\{stakeValue\}/);
  // No hardcoded literal labels — everything routes through t().
  assert.equal(source.includes(">Событие<"), false);
  assert.equal(source.includes(">Event<"), false);
  assert.equal(source.includes(">Исход<"), false);
  assert.equal(source.includes(">Selection<"), false);
});

// Requirement — no free-text <textarea> remains anywhere in this file: both
// SINGLE and EXPRESS are fully structured input now.
test("source: no <textarea> element remains — both SINGLE and EXPRESS render only structured <input> fields", () => {
  assert.equal((source.match(/<textarea/g) ?? []).length, 0);
});

test("source: the primary button reads Review bet (bet.reviewBet) for SINGLE and Review express (bet.reviewExpress) for EXPRESS, never a hardcoded literal", () => {
  assert.match(
    source,
    /isTimeoutError\s*\?\s*t\("bet\.tryAgain"\)\s*:\s*betTypeTab === "single"\s*\?\s*t\("bet\.reviewBet"\)\s*:\s*t\("bet\.reviewExpress"\)/,
  );
  assert.equal(source.includes(">Review bet<"), false);
  assert.equal(source.includes(">Проверить ставку<"), false);
  assert.equal(source.includes(">Review express<"), false);
  assert.equal(source.includes(">Проверить экспресс<"), false);
});

test("source: USDC is a fixed literal (this product's one stake currency, matching Preview/Ticket elsewhere), not a new translation key or a currency selector", () => {
  assert.match(source, /<span className="shrink-0 pl-2 text-sm font-medium text-slate-400">USDC<\/span>/);
  assert.equal(source.includes(">CHF<"), false);
  assert.equal(/<select/.test(source), false, "no currency selector must be introduced");
});

test("source: editing any structured SINGLE field, or switching bet-type tabs, invalidates a stale preview — same safety principle as editing the EXPRESS message", () => {
  for (const handler of ["handleEventChange", "handleSelectionChange", "handleStakeChange", "handleBetTypeChange"]) {
    const match = source.match(new RegExp(`function ${handler}\\([^)]*\\) \\{([\\s\\S]*?)\\n  \\}`));
    assert.ok(match, `expected ${handler} to be found`);
    assert.match(match![1], /resetPreviewIfShown\(\)/);
  }
});

// Requirement — RU/EN localization remains centralized: spot-check the six
// new keys resolve to the exact required copy in both locales, through the
// same translate() function every other key already uses.
test("translations: the six new SINGLE-input keys resolve to the exact required RU/EN copy", () => {
  assert.equal(translate("ru", "bet.eventLabel"), "Событие");
  assert.equal(translate("en", "bet.eventLabel"), "Event");
  assert.equal(translate("ru", "bet.eventPlaceholder"), "Например: Интер — Ювентус");
  assert.equal(translate("en", "bet.eventPlaceholder"), "Example: Inter — Juventus");
  assert.equal(translate("ru", "bet.selectionLabel"), "Исход");
  assert.equal(translate("en", "bet.selectionLabel"), "Selection");
  assert.equal(translate("ru", "bet.selectionPlaceholder"), "Например: Интер победит");
  assert.equal(translate("en", "bet.selectionPlaceholder"), "Example: Inter to win");
  assert.equal(translate("ru", "bet.stakeLabel"), "Ставка");
  assert.equal(translate("en", "bet.stakeLabel"), "Stake");
  assert.equal(translate("ru", "bet.reviewBet"), "Проверить ставку");
  assert.equal(translate("en", "bet.reviewBet"), "Review bet");
});

// ---------------------------------------------------------------------
// EXPRESS behavior is not accidentally changed
// ---------------------------------------------------------------------

test("source: EXPRESS's own submit gating comes from isExpressBetReady(expressLegs, expressStakeValue), not a leftover message-length check", () => {
  assert.match(
    source,
    /betTypeTab === "single"\s*\?\s*isSingleBetReady\(eventValue, selectionValue, stakeValue\)\s*:\s*isExpressBetReady\(expressLegs, expressStakeValue\)/,
  );
});

test("source: handleExcludeLeg/handleConfirm (Sector 1 EXPRESS recovery, confirm flow) are untouched by the EXPRESS builder change", () => {
  assert.match(source, /async function handleExcludeLeg\(legIndex: number\) \{/);
  assert.match(source, /fetchExpressLegExclusionPreview\(initDataValue, preview\.previewToken, \[legIndex\]\)/);
  assert.match(source, /async function handleConfirm\(\) \{/);
});

// ---------------------------------------------------------------------
// Structured EXPRESS input — a variable-length list of legs + one shared
// Stake. Lettered requirements A–P below mirror the task spec.
// ---------------------------------------------------------------------

function legs(...pairs: Array<[string, string]>): ExpressLegInput[] {
  return pairs.map(([event, selection]) => ({ event, selection }));
}

// A — initial state: exactly two empty legs.
test("A: expressLegs initial state is exactly two empty legs (id: 0, id: 1)", () => {
  assert.match(
    source,
    /const \[expressLegs, setExpressLegs\] = useState<ExpressLeg\[\]>\(\(\) => \[\s*\{ id: 0, event: "", selection: "" \},\s*\{ id: 1, event: "", selection: "" \},\s*\]\);/,
  );
});

// B — each leg renders an Event input and a Selection input, using
// centralized translation keys for its title/placeholders/aria-labels.
test("B: each EXPRESS leg renders a title, an Event input, and a Selection input, all via centralized translation keys", () => {
  assert.match(source, /\{t\("bet\.expressLegTitle", \{ number: String\(index \+ 1\) \}\)\}/);
  assert.match(source, /placeholder=\{t\("bet\.expressEventPlaceholder"\)\}/);
  assert.match(source, /aria-label=\{t\("bet\.eventLabel"\)\}\s*\n\s*disabled=\{phase === "previewing"\}\s*\n\s*className="w-full rounded-xl/);
  assert.match(source, /placeholder=\{t\("bet\.expressSelectionPlaceholder"\)\}/);
  assert.match(source, /aria-label=\{t\("bet\.selectionLabel"\)\}/);
  assert.equal(source.includes(">Событие 1<"), false, "leg title must come from t(), not a hardcoded literal");
});

// C — exactly one shared Stake field for the whole EXPRESS slip, not one
// per leg.
test("C: EXPRESS has exactly one shared Stake field (USDC), never a per-leg stake input", () => {
  const mapStart = source.indexOf("expressLegs.map((leg, index) => (");
  const addButtonStart = source.indexOf("onClick={handleAddExpressLeg}");
  assert.ok(mapStart > -1 && addButtonStart > mapStart, "expected the leg-mapping JSX, followed later by the Add event button");
  const legMapSection = source.slice(mapStart, addButtonStart);
  assert.equal(/stakeLabel|USDC/.test(legMapSection), false, "no stake field inside the per-leg map");

  assert.equal((source.match(/value=\{expressStakeValue\}/g) ?? []).length, 1);
  assert.match(source, /value=\{expressStakeValue\}[\s\S]{0,600}USDC/);
});

// D — "+ Add event" appends a new, empty leg and is a real <button>.
test("D: handleAddExpressLeg appends one new empty leg, guarded by MAX_EXPRESS_LEGS", () => {
  const match = source.match(/function handleAddExpressLeg\(\) \{([\s\S]*?)\n {2}\}/);
  assert.ok(match, "expected handleAddExpressLeg to be found");
  assert.match(match![1], /if \(expressLegs\.length >= MAX_EXPRESS_LEGS\) return;/);
  assert.match(match![1], /setExpressLegs\(\(legs\) => \[\.\.\.legs, \{ id: nextId, event: "", selection: "" \}\]\);/);
  assert.match(match![1], /resetPreviewIfShown\(\);/);
  assert.match(source, /<button\s*\n\s*type="button"\s*\n\s*onClick=\{handleAddExpressLeg\}/);
  assert.match(source, /\{t\("bet\.addEvent"\)\}/);
});

// E — remove-leg control never drops below MIN_EXPRESS_LEGS, and is only
// rendered once there are more than the minimum (so the first two legs are
// never individually removable).
test("E: handleRemoveExpressLeg is guarded by MIN_EXPRESS_LEGS, and the remove control only renders beyond the minimum", () => {
  const match = source.match(/function handleRemoveExpressLeg\(id: number\) \{([\s\S]*?)\n {2}\}/);
  assert.ok(match, "expected handleRemoveExpressLeg to be found");
  assert.match(match![1], /if \(expressLegs\.length <= MIN_EXPRESS_LEGS\) return;/);
  assert.match(match![1], /setExpressLegs\(\(legs\) => legs\.filter\(\(leg\) => leg\.id !== id\)\);/);
  assert.match(match![1], /resetPreviewIfShown\(\);/);
  assert.match(source, /\{expressLegs\.length > MIN_EXPRESS_LEGS && \(/);
  assert.match(source, /aria-label=\{t\("bet\.removeEvent", \{ number: String\(index \+ 1\) \}\)\}/);
});

// F — max-leg enforcement: "+ Add event" itself disappears once the leg
// count reaches MAX_EXPRESS_LEGS, on top of the handler's own guard (D).
test("F: '+ Add event' is only rendered while expressLegs.length < MAX_EXPRESS_LEGS, and MAX_EXPRESS_LEGS matches the backend's own EXPRESS ceiling", () => {
  assert.match(source, /\{expressLegs\.length < MAX_EXPRESS_LEGS && \(/);
  assert.equal(MAX_EXPRESS_LEGS, 10, "must match MAX_EXPRESS_SELECTIONS in lib/bets/betSlipRules.ts / lib/betPreview/previewToken.ts");
  assert.equal(MIN_EXPRESS_LEGS, 2, "must match MIN_EXPRESS_SELECTIONS in lib/bets/betSlipRules.ts / lib/betPreview/previewToken.ts");
});

// G — isExpressLegComplete / isExpressBetReady pure-function coverage
// (button disabled/enabled logic).
test("G: isExpressLegComplete requires both a non-empty event and a non-empty selection", () => {
  assert.equal(isExpressLegComplete({ event: "", selection: "" }), false);
  assert.equal(isExpressLegComplete({ event: "Arsenal — Chelsea", selection: "" }), false);
  assert.equal(isExpressLegComplete({ event: "", selection: "Arsenal to win" }), false);
  assert.equal(isExpressLegComplete({ event: "   ", selection: "Arsenal to win" }), false, "whitespace-only doesn't count");
  assert.equal(isExpressLegComplete({ event: "Arsenal — Chelsea", selection: "Arsenal to win" }), true);
});

test("G: isExpressBetReady is false below MIN_EXPRESS_LEGS, above MAX_EXPRESS_LEGS, with any incomplete leg, or an invalid stake — true only when every condition holds", () => {
  const complete = legs(["Arsenal — Chelsea", "Arsenal to win"], ["Real Madrid — Barcelona", "Real Madrid to win"]);

  assert.equal(isExpressBetReady(legs(["Arsenal — Chelsea", "Arsenal to win"]), "100"), false, "only 1 leg, below MIN_EXPRESS_LEGS");
  assert.equal(isExpressBetReady(complete, ""), false, "missing stake");
  assert.equal(isExpressBetReady(complete, "0"), false, "invalid (zero) stake");
  assert.equal(
    isExpressBetReady(legs(["Arsenal — Chelsea", ""], ["Real Madrid — Barcelona", "Real Madrid to win"]), "100"),
    false,
    "one incomplete leg",
  );
  assert.equal(isExpressBetReady(complete, "100"), true);

  const elevenLegs: ExpressLegInput[] = Array.from({ length: MAX_EXPRESS_LEGS + 1 }, (_, i) => ({
    event: `Event ${i}`,
    selection: `Selection ${i}`,
  }));
  assert.equal(isExpressBetReady(elevenLegs, "100"), false, "above MAX_EXPRESS_LEGS");
});

// H — composition into the preview request: buildExpressSubmissionText.
test("H: buildExpressSubmissionText composes every leg plus the one shared stake into a single trimmed free-text string", () => {
  assert.equal(
    buildExpressSubmissionText(legs(["Arsenal — Chelsea", "Arsenal to win"], ["Real Madrid — Barcelona", "Real Madrid to win"]), "100"),
    "Arsenal — Chelsea, Arsenal to win; Real Madrid — Barcelona, Real Madrid to win; stake 100",
  );
  assert.equal(
    buildExpressSubmissionText(legs(["  Интер — Ювентус  ", "  Интер победит  "]), "  50  "),
    "Интер — Ювентус, Интер победит; stake 50",
  );
});

// I — editing any EXPRESS field, adding a leg, or removing a leg all
// invalidate a stale preview, same safety principle as SINGLE.
test("I: editing an EXPRESS leg field, changing the stake, adding a leg, or removing a leg all invalidate a stale preview", () => {
  for (const handler of [
    "handleExpressLegEventChange",
    "handleExpressLegSelectionChange",
    "handleExpressStakeChange",
    "handleAddExpressLeg",
    "handleRemoveExpressLeg",
  ]) {
    const match = source.match(new RegExp(`function ${handler}\\([^)]*\\) \\{([\\s\\S]*?)\\n  \\}`));
    assert.ok(match, `expected ${handler} to be found`);
    assert.match(match![1], /resetPreviewIfShown\(\);/);
  }
});

// J — Single/Express state never leaks into each other: fully independent
// state slices, already proven structurally (separate useState calls); this
// spot-checks there is no shared/derived state between the two.
test("J: SINGLE fields (eventValue/selectionValue/stakeValue) and EXPRESS state (expressLegs/expressStakeValue) are fully independent useState slices", () => {
  assert.match(source, /const \[eventValue, setEventValue\] = useState\(""\);/);
  assert.match(source, /const \[selectionValue, setSelectionValue\] = useState\(""\);/);
  assert.match(source, /const \[stakeValue, setStakeValue\] = useState\(""\);/);
  assert.match(source, /const \[expressLegs, setExpressLegs\] = useState<ExpressLeg\[\]>/);
  assert.match(source, /const \[expressStakeValue, setExpressStakeValue\] = useState\(""\);/);
});

// K — SINGLE is byte-for-byte unaffected: re-assert its own composition and
// gating are untouched by the EXPRESS builder work (belt-and-suspenders on
// top of the dedicated SINGLE tests above).
test("K: SINGLE's own submission composition and readiness gating are untouched by the EXPRESS builder change", () => {
  assert.match(
    source,
    /betTypeTab === "single"\s*\?\s*buildSingleSubmissionText\(eventValue, selectionValue, stakeValue\)/,
  );
  assert.match(
    source,
    /betTypeTab === "single"\s*\?\s*isSingleBetReady\(eventValue, selectionValue, stakeValue\)/,
  );
});

// L — RU/EN localization symmetry for every new EXPRESS-builder key.
test("L: every new EXPRESS-builder translation key resolves to the exact required RU/EN copy", () => {
  assert.equal(translate("en", "bet.expressLegTitle", { number: "1" }), "Event 1");
  assert.equal(translate("ru", "bet.expressLegTitle", { number: "1" }), "Событие 1");
  assert.equal(translate("en", "bet.expressEventPlaceholder"), "Example: Arsenal — Chelsea");
  assert.equal(translate("ru", "bet.expressEventPlaceholder"), "Например: Арсенал — Челси");
  assert.equal(translate("en", "bet.expressSelectionPlaceholder"), "Example: Arsenal to win");
  assert.equal(translate("ru", "bet.expressSelectionPlaceholder"), "Например: Арсенал победит");
  assert.equal(translate("en", "bet.addEvent"), "+ Add event");
  assert.equal(translate("ru", "bet.addEvent"), "+ Добавить событие");
  assert.equal(translate("en", "bet.removeEvent", { number: "2" }), "Remove event 2");
  assert.equal(translate("ru", "bet.removeEvent", { number: "2" }), "Удалить событие 2");
  assert.equal(translate("en", "bet.reviewExpress"), "Review express");
  assert.equal(translate("ru", "bet.reviewExpress"), "Проверить экспресс");
});

// M — no second parser/API flow: the EXPRESS builder still funnels through
// the exact same single fetchBetPreview call as SINGLE (already proven by
// tests A/H above and the "betTypeTab's literal value is never sent"
// test); this spot-checks no second fetch/endpoint reference was
// introduced anywhere in the file.
test("M: no second preview/parser endpoint was introduced — fetchBetPreview is still the only preview call in this file", () => {
  assert.equal((source.match(/fetchBetPreview\(/g) ?? []).length, 1);
});

// N — existing Preview/Confirm/Sector 1 exclusion behavior is intact,
// independent of which bet-type tab produced the preview being confirmed.
test("N: canConfirm/handleConfirm/PreviewCard rendering are untouched — Confirm works identically regardless of which tab produced the preview", () => {
  assert.match(source, /const canConfirm = canConfirmBetSlip\(phase === "ready", preview\) && excludingLegIndex === null;/);
  assert.match(source, /<PreviewCard preview=\{preview\.preview\} onExcludeLeg=\{handleExcludeLeg\} excludingLegIndex=\{excludingLegIndex\} \/>/);
});

// O — no hardcoded EXPRESS strings / no `locale === "ru"` ternaries were
// introduced by the builder.
test("O: no hardcoded EXPRESS-builder strings and no locale === \"ru\" ternary anywhere in this file", () => {
  assert.equal(/locale === ["']ru["']/.test(source), false);
  assert.equal(source.includes(">Arsenal — Chelsea<"), false);
  assert.equal(source.includes(">Арсенал — Челси<"), false);
});

// P — accessibility: mobile-friendly numeric stake input, real <button>
// elements for Add/Remove, and per-input aria-labels (already partly
// covered by B, D, E above) — this rounds out the stake input itself.
test("P: the shared EXPRESS stake input is a mobile-friendly numeric field with its own aria-label", () => {
  assert.match(
    source,
    /value=\{expressStakeValue\}\s*\n\s*onChange=\{\(event\) => handleExpressStakeChange\(event\.target\.value\)\}\s*\n\s*placeholder="0"\s*\n\s*aria-label=\{t\("bet\.stakeLabel"\)\}/,
  );
  const stakeInputMatch = source.match(/<input\s*\n\s*type="number"\s*\n\s*inputMode="decimal"[\s\S]{0,400}value=\{expressStakeValue\}/);
  assert.ok(stakeInputMatch, "expected the shared EXPRESS stake input to be type=number/inputMode=decimal");
});
