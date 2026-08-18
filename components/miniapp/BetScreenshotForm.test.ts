import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Stage M4.7 — SILENT CURRENT-ODDS PLAYER UX. Same structural-source-text
// technique as BetTextForm.test.ts / BetScreen.test.ts (no DOM-rendering
// infra exists in this project). Proves the amber "Your offer has been
// refreshed. Please review and confirm again." banner (and the
// oddsChangedInfo state that used to drive it) is gone from the screenshot
// flow too, while the refreshed-preview/token staging, the return to the
// "ready" phase, and the explicit-second-Confirm requirement all survive
// unchanged — SILENT UX != SILENT ACCEPTANCE.

const source = readFileSync(fileURLToPath(new URL("./BetScreenshotForm.tsx", import.meta.url)), "utf8");

test("BetScreenshotForm: the odds-changed banner state (oddsChangedInfo) no longer exists anywhere in this file", () => {
  assert.equal(source.includes("oddsChangedInfo"), false);
  assert.equal(source.includes("OddsChangedReconfirmUpdate"), false);
});

// Deliberately checks only the exact removed user-facing phrases, not
// generic words like "odds changed" — this file's own comments legitimately
// describe the odds_changed mechanism in prose, and a broader check would
// flag that internal documentation, not actual rendered copy.
test("BetScreenshotForm: the exact removed banner copy is absent — no 'offer has been refreshed' / 'review and confirm again' text anywhere in this file", () => {
  const lower = source.toLowerCase();
  for (const forbidden of ["offer has been refreshed", "review and confirm again"]) {
    assert.equal(lower.includes(forbidden), false, `must not contain: "${forbidden}"`);
  }
});

test("BetScreenshotForm: an odds_changed confirm failure still stages the refreshed preview/token (setPreview) and returns to the ready phase — safety unchanged by the banner removal", () => {
  const branchMatch = source.match(/if \(result\.failure\.kind === "odds_changed"\) \{([\s\S]*?)return;/);
  assert.ok(branchMatch, "expected an odds_changed branch inside handleConfirm");
  const branchBody = branchMatch![1];

  assert.match(branchBody, /const update = buildOddsChangedReconfirm\(result\.failure\)/);
  assert.match(branchBody, /setPreview\(update\.preview\)/);
  assert.match(branchBody, /setPhase\("ready"\)/);
  assert.equal(/fetchBetConfirm/.test(branchBody), false);
});

test("BetScreenshotForm: Confirm bet is gated ONLY on the Stage M4.5 unavailable-odds check, never on any odds-changed flag", () => {
  assert.match(source, /\{!oddsUnavailable && \(\s*<button[\s\S]{0,300}aria-label="Confirm bet"/);
});

test("BetScreenshotForm: Choose different image remains rendered unconditionally alongside Confirm bet — never gated on odds-changed state", () => {
  assert.match(source, /aria-label="Choose different image"/);
});

// Stage M5.4 — SINGLE-SCREEN CORE BET FLOW. Root cause of the two
// production screenshots showing "Upload your bet slip" at very different
// vertical positions: the whole hero+content group was wrapped in a
// vertically-centered (`justify-center`) flex-1 container, so its top
// position was a function of total content height — short (idle, two
// buttons) vs. tall (ready, a full EXPRESS preview) states centered
// differently. The fix anchors the group to the top instead, so every
// phase starts from the same place.
test("source: the hero/content group is top-anchored, not vertically centered — the root cause of the inconsistent top spacing is gone", () => {
  assert.match(source, /<div className="flex flex-1 flex-col items-center text-center">/);
  assert.equal(source.includes('flex flex-1 flex-col items-center justify-center text-center'), false, "old vertically-centering wrapper must be gone");
});

test("source: the large hero icon is shown only for the pre-recognition phases (idle/selected/recognizing), not once a preview is ready", () => {
  assert.match(source, /\{showSelectionBlock && \(\s*<div\s*className="flex h-16 w-16 items-center justify-center rounded-full"/);
});

test("source: the 'choose a photo' subtitle is shown only for the pre-recognition phases — it no longer describes what's on screen once a preview is showing", () => {
  assert.match(source, /\{showSelectionBlock && \(\s*<p className="mt-2 text-sm text-slate-400">Choose a photo from your gallery or take a new one\.<\/p>\s*\)\}/);
});

test("source: 'Upload your bet slip' is still the heading in every phase, just compact once a preview is ready", () => {
  assert.match(source, /showSelectionBlock \? "mt-5 text-xl font-bold text-white" : "mt-3 text-lg font-bold text-white"/);
  assert.match(source, />\s*Upload your bet slip\s*<\/p>/);
});

test("source: the action-area gap above Confirm bet/Choose different image was tightened (mt-4 -> mt-3 wrapper, mt-3 -> mt-2.5 buttons)", () => {
  assert.match(source, /\{showPreviewBlock && preview && \(\s*<div className="mt-3 w-full">/);
  assert.match(source, /aria-label="Confirm bet"\s*className="mt-2\.5 min-h-11 w-full/);
  assert.match(source, /aria-label="Choose different image"\s*className="mt-2\.5 min-h-11 w-full/);
});
