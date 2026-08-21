import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isValidStakeInput, isSingleBetReady, buildSingleSubmissionText } from "./BetTextForm";
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

// Structured SINGLE input pass — betTypeTab's literal value is still never
// sent to the API (the AI parser remains the sole SINGLE/EXPRESS
// authority), but it IS now read by handlePreviewSubmit to decide which
// text to compose/send: SINGLE's three structured fields via
// buildSingleSubmissionText, or EXPRESS's free-text message unchanged.
test("BetTextForm: betTypeTab's literal value is never sent to the API — only the derived free-text is, composed per mode", () => {
  const submitFnMatch = source.match(/async function handlePreviewSubmit\(\) \{([\s\S]*?)\n  \}/);
  assert.ok(submitFnMatch, "expected handlePreviewSubmit to be found");
  const body = submitFnMatch![1];

  assert.match(body, /betTypeTab === "single" \? buildSingleSubmissionText\(eventValue, selectionValue, stakeValue\) : message\.trim\(\)/);
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
test("BetTextForm: Place a bet / bet-type labels / placeholder / Preview bet all come from centralized translation keys, never hardcoded literals", () => {
  assert.match(source, /import \{ useLocale \} from "\.\/LocaleProvider";/);
  assert.match(source, /const \{ t, locale \} = useLocale\(\);/);
  assert.match(source, /\{t\("bet\.placeBet"\)\}/);
  assert.match(source, /aria-label=\{t\("bet\.typeAriaLabel"\)\}/);
  assert.match(source, /\{t\("bet\.single"\)\}/);
  assert.match(source, /\{t\("bet\.express"\)\}/);
  assert.match(source, /placeholder=\{t\("bet\.placeholder"\)\}/);
  assert.match(source, /: t\("bet\.preview"\)/);

  // "Place a bet" legitimately still appears in this file's own prose
  // comments (naming the screen) — only the actual rendered JSX text node
  // is checked, not the whole file.
  assert.equal(source.includes('>Place a bet<'), false);
  assert.equal(source.includes(">Ординар<"), false);
  assert.equal(source.includes(">Экспресс<"), false);
  assert.equal(source.includes('placeholder="Команда'), false);
});

// Requirement 12 — the player's own typed text must remain byte-for-byte
// unchanged when the UI locale switches: `message`/`setMessage` (the only
// state backing the textarea's value) is never read or written by t()/
// useLocale, and the textarea's `value` prop stays bound to `message`
// alone — only its `placeholder` (shown when message is empty) is
// locale-driven.
test("BetTextForm: switching UI locale can never rewrite/translate the player's typed message — message state is fully independent of t()/locale", () => {
  assert.match(source, /<textarea\s*\n\s*value=\{message\}/);
  assert.match(source, /onChange=\{\(event\) => handleMessageChange\(event\.target\.value\)\}/);

  const handleMessageChangeMatch = source.match(/function handleMessageChange\(value: string\) \{([\s\S]*?)\n {2}\}/);
  assert.ok(handleMessageChangeMatch, "expected handleMessageChange to be found");
  assert.equal(/\bt\(|useLocale|locale/.test(handleMessageChangeMatch![1]), false);
});

// Requirement 13 — the parser/fetch payload carries the player's original
// text verbatim; UI locale is never part of it. Already partly proven by
// the "purely visual" test above (fetchBetPreview(tg.initData,
// message.trim())) — this asserts the complementary fact that the
// fetchBetPreview call ITSELF is never called with any t()/locale-derived
// argument (handlePreviewSubmit's body legitimately references `locale`
// elsewhere now, to localize the resulting error message on failure — that
// is correct localization behavior, not a violation of this invariant).
test("BetTextForm: the preview request payload is (initData, composed text) — the composed text itself is never mixed with the UI locale", () => {
  const submitFnMatch = source.match(/async function handlePreviewSubmit\(\) \{([\s\S]*?)\n  \}/);
  assert.ok(submitFnMatch, "expected handlePreviewSubmit to be found");
  const body = submitFnMatch![1];

  const textToSubmitMatch = body.match(
    /const textToSubmit =\s*betTypeTab === "single" \? buildSingleSubmissionText\(eventValue, selectionValue, stakeValue\) : message\.trim\(\);/,
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

// Requirement — no old combined SINGLE textarea remains. The free-text
// <textarea> must now only render for EXPRESS (the `) : (` / `<>` branch),
// never unconditionally.
test("source: the old single combined textarea no longer renders unconditionally — it's EXPRESS-only, gated behind the same betTypeTab branch", () => {
  // The textarea is the FIRST element inside the "express" branch of the
  // `betTypeTab === "single" ? (...) : (<>...` conditional, never rendered
  // outside it — i.e. exactly one <textarea> in the whole file, and it's
  // reached only via that "express" branch.
  assert.equal((source.match(/<textarea/g) ?? []).length, 1);
  assert.match(source, /\) : \(\s*<>\s*<textarea/);
});

test("source: the primary button reads Review bet (bet.reviewBet) for SINGLE and Preview bet (bet.preview) for EXPRESS, never a hardcoded literal", () => {
  assert.match(
    source,
    /isTimeoutError\s*\?\s*t\("bet\.tryAgain"\)\s*:\s*betTypeTab === "single"\s*\?\s*t\("bet\.reviewBet"\)\s*:\s*t\("bet\.preview"\)/,
  );
  assert.equal(source.includes(">Review bet<"), false);
  assert.equal(source.includes(">Проверить ставку<"), false);
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

test("source: EXPRESS's free-text textarea/message state/placeholder/aria-label are all byte-for-byte the same as before this pass", () => {
  assert.match(source, /<textarea\s*\n\s*value=\{message\}\s*\n\s*onChange=\{\(event\) => handleMessageChange\(event\.target\.value\)\}\s*\n\s*maxLength=\{MESSAGE_MAX_LENGTH\}\s*\n\s*placeholder=\{t\("bet\.placeholder"\)\}\s*\n\s*aria-label=\{t\("bet\.messageAriaLabel"\)\}/);
  assert.match(source, /\{message\.length\} \/ \{MESSAGE_MAX_LENGTH\}/);
});

test("source: EXPRESS's own submit gating (message length) is untouched — canSubmitPreview still falls back to trimmedLength >= MESSAGE_MIN_LENGTH for the express branch", () => {
  assert.match(
    source,
    /betTypeTab === "single"\s*\?\s*isSingleBetReady\(eventValue, selectionValue, stakeValue\)\s*:\s*trimmedLength >= MESSAGE_MIN_LENGTH/,
  );
});

test("source: handleExcludeLeg/handleConfirm (Sector 1 EXPRESS recovery, confirm flow) are untouched by the SINGLE input change", () => {
  assert.match(source, /async function handleExcludeLeg\(legIndex: number\) \{/);
  assert.match(source, /fetchExpressLegExclusionPreview\(initDataValue, preview\.previewToken, \[legIndex\]\)/);
  assert.match(source, /async function handleConfirm\(\) \{/);
});
