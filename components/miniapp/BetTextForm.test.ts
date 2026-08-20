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
  assert.match(source, /\{!oddsUnavailable && \(\s*<button[\s\S]{0,300}aria-label="Confirm bet"/);
});

// Stage M5.4 — SINGLE-SCREEN CORE BET FLOW. Same action-area tightening as
// BetScreenshotForm.tsx, applied here for consistency between the two
// submission flows (both share this exact preview/Confirm/Edit structure).
test("source: the action-area gap above Confirm bet/Edit message was tightened (mt-4 -> mt-3 wrapper, mt-3 -> mt-2.5 buttons)", () => {
  assert.match(source, /\{showPreviewBlock && preview && \(\s*<div className="mt-3">/);
  assert.match(source, /aria-label="Confirm bet"\s*className="mt-2\.5 min-h-11 w-full/);
  assert.match(source, /aria-label="Edit message"\s*className="mt-2\.5 min-h-11 w-full/);
});

// Clean top-of-screen pass: removes the secondary helper line under "Place a
// bet" and replaces it with a purely visual Ординар/Экспресс segmented
// control. Deliberately source-based, same as every other test in this file
// (no DOM-rendering infra — see this file's header comment).
test("BetTextForm: the removed 'Describe your bet...' helper line is gone and not replaced by other explanatory copy", () => {
  assert.equal(source.includes("Describe your bet in one message"), false);
  assert.equal(source.includes("odds aren&apos;t required"), false);
});

test("BetTextForm: both bet-type segments (Ординар, Экспресс) render as a tablist right under the Place a bet title", () => {
  assert.match(
    source,
    /<p className="mt-3 text-xl font-bold text-white">Place a bet<\/p>\s*<div\s+role="tablist"[\s\S]{0,800}Ординар[\s\S]{0,800}Экспресс/,
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
