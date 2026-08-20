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
  assert.match(source, /\{!oddsUnavailable && \(\s*<button[\s\S]{0,300}aria-label=\{t\("confirm\.confirmBet"\)\}/);
});

test("BetScreenshotForm: Choose different image remains rendered unconditionally alongside Confirm bet — never gated on odds-changed state", () => {
  assert.match(source, /aria-label=\{t\("screenshot\.chooseDifferentImage"\)\}/);
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
  assert.match(source, /\{showSelectionBlock && \(\s*<p className="mt-2 text-sm text-slate-400">\{t\("screenshot\.uploadSubtitle"\)\}<\/p>\s*\)\}/);
});

test("source: 'Upload your bet slip' is still the heading in every phase, just compact once a preview is ready", () => {
  assert.match(source, /showSelectionBlock \? "mt-5 text-xl font-bold text-white" : "mt-3 text-lg font-bold text-white"/);
  assert.match(source, />\s*\{t\("screenshot\.uploadTitle"\)\}\s*<\/p>/);
});

test("source: the action-area gap above Confirm bet/Choose different image was tightened (mt-4 -> mt-3 wrapper, mt-3 -> mt-2.5 buttons)", () => {
  assert.match(source, /\{showPreviewBlock && preview && \(\s*<div className="mt-3 w-full">/);
  assert.match(source, /aria-label=\{t\("confirm\.confirmBet"\)\}\s*className="mt-2\.5 min-h-11 w-full/);
  assert.match(source, /aria-label=\{t\("screenshot\.chooseDifferentImage"\)\}\s*className="mt-2\.5 min-h-11 w-full/);
});

// Stage M5.5A — HIDE TECHNICAL FILE METADATA FROM PLAYER. The selected
// image's raw upload metadata (filename, formatted byte size) is
// implementation detail, not betting information — removing it, and its
// now-dead formatFileSize helper and wrapper row, entirely.
test("source: the uploaded filename (file.name) is no longer rendered anywhere in this file", () => {
  assert.equal(source.includes("{file.name}"), false, "file.name must no longer be rendered");
});

test("source: the formatted file size (formatFileSize) is no longer rendered, and the now-unused helper itself is gone", () => {
  assert.equal(source.includes("formatFileSize"), false, "formatFileSize must no longer exist — it was only ever used to render the removed file-size text");
});

test("source: the dead filename/size wrapper row is gone — the image preview flows directly into the Recognize bet button", () => {
  assert.equal(source.includes('<div className="mt-2 flex items-center justify-between gap-3">'), false, "the wrapper row that existed only for filename/size must be removed, not just emptied");
});

test("source: the screenshot thumbnail/preview itself is still rendered, unchanged", () => {
  assert.match(source, /<img\s*\n\s*src=\{previewUrl\}\s*\n\s*alt=\{t\("screenshot\.selectedImageAlt"\)\}\s*\n\s*className="max-h-64 w-full object-contain"/);
});

test("source: the Recognizing state is unchanged", () => {
  assert.match(source, /\{phase === "recognizing" \? t\("screenshot\.recognizing"\) : t\("screenshot\.recognizeBet"\)\}/);
});

test("source: Remove is unchanged", () => {
  assert.match(source, /onClick=\{handleRemove\}/);
  assert.match(source, />\s*\{t\("screenshot\.remove"\)\}\s*<\/button>/);
});

// M5.4 ready-state layout (Section G root-cause fix + action-area spacing)
// is untouched by this stage — only the selected/pre-recognition block
// (showSelectionBlock) changed.
test("M5.5A regression guard: the M5.4 ready-state layout is untouched", () => {
  assert.match(source, /<div className="flex flex-1 flex-col items-center text-center">/);
  assert.match(source, /\{showPreviewBlock && preview && \(\s*<div className="mt-3 w-full">/);
  assert.match(source, /aria-label=\{t\("confirm\.confirmBet"\)\}\s*className="mt-2\.5 min-h-11 w-full/);
});
