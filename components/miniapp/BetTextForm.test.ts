import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

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
  assert.match(source, /aria-selected=\{betTypeTab === "single"\}[\s\S]{0,120}onClick=\{\(\) => setBetTypeTab\("single"\)\}/);
  assert.match(source, /aria-selected=\{betTypeTab === "express"\}[\s\S]{0,120}onClick=\{\(\) => setBetTypeTab\("express"\)\}/);
});

test("BetTextForm: the bet-type tab is purely visual — never read by the preview submit flow or sent to the API", () => {
  const submitFnMatch = source.match(/async function handlePreviewSubmit\(\) \{([\s\S]*?)\n  \}/);
  assert.ok(submitFnMatch, "expected handlePreviewSubmit to be found");
  assert.equal(/betTypeTab/.test(submitFnMatch![1]), false);
  assert.match(submitFnMatch![1], /fetchBetPreview\(tg\.initData, message\.trim\(\)\)/);
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
test("BetTextForm: the preview request payload is exactly (initData, trimmed message) — never mixed with the UI locale", () => {
  const submitFnMatch = source.match(/async function handlePreviewSubmit\(\) \{([\s\S]*?)\n  \}/);
  assert.ok(submitFnMatch, "expected handlePreviewSubmit to be found");
  const fetchCallMatch = submitFnMatch![1].match(/const result = await fetchBetPreview\(tg\.initData, message\.trim\(\)\);/);
  assert.ok(fetchCallMatch, "expected the fetchBetPreview call to be found");
  assert.equal(/\bt\(|locale/.test(fetchCallMatch![0]), false);
  assert.match(fetchCallMatch![0], /fetchBetPreview\(tg\.initData, message\.trim\(\)\)/);
});
