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
