import { test } from "node:test";
import assert from "node:assert/strict";
import {
  logScreenshotDarkLaunchDiagnostic,
  selectedRegionConfidenceBand,
  SCREENSHOT_DARK_LAUNCH_DIAGNOSTIC_MARKER,
  type ScreenshotDarkLaunchDiagnostic,
} from "./screenshotDarkLaunchDiagnostic";

test("selectedRegionConfidenceBand: null -> NOT_AVAILABLE", () => {
  assert.equal(selectedRegionConfidenceBand(null), "NOT_AVAILABLE");
});

test("selectedRegionConfidenceBand: bucket boundaries", () => {
  assert.equal(selectedRegionConfidenceBand(0.95), "HIGH");
  assert.equal(selectedRegionConfidenceBand(0.8), "HIGH");
  assert.equal(selectedRegionConfidenceBand(0.79), "MEDIUM");
  assert.equal(selectedRegionConfidenceBand(0.5), "MEDIUM");
  assert.equal(selectedRegionConfidenceBand(0.49), "LOW");
  assert.equal(selectedRegionConfidenceBand(0), "LOW");
});

function diagnostic(overrides: Partial<ScreenshotDarkLaunchDiagnostic> = {}): ScreenshotDarkLaunchDiagnostic {
  return {
    stage: "dark_launch_comparison",
    fixtureId: "single-moneyline-home-01",
    localizationAttempted: true,
    localizationStatus: "FOUND_BOTH",
    betSlipRegionPresent: true,
    selectedRegionPresent: true,
    selectedRegionConfidenceBand: "HIGH",
    fullImageOcrLength: 512,
    localizedOcrLength: 96,
    selectedOcrLength: 40,
    currentNumericVerdict: "CORROBORATED",
    localizedNumericVerdict: "CORROBORATED",
    currentMarketVerdict: "CORROBORATED",
    localizedMarketVerdict: "CORROBORATED",
    currentFinalDecision: "ACCEPTED",
    wouldLocalizedPathDiffer: false,
    ...overrides,
  };
}

test("logScreenshotDarkLaunchDiagnostic: side-effect-only, never throws, logs exactly one marker-prefixed JSON line", () => {
  const originalLog = console.log;
  const calls: unknown[][] = [];
  console.log = (...args: unknown[]) => {
    calls.push(args);
  };
  try {
    const result = logScreenshotDarkLaunchDiagnostic(diagnostic());
    assert.equal(result, undefined);
  } finally {
    console.log = originalLog;
  }

  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], SCREENSHOT_DARK_LAUNCH_DIAGNOSTIC_MARKER);
  const logged = JSON.parse(calls[0][1] as string);
  assert.equal(logged.stage, "dark_launch_comparison");
  assert.equal(logged.fixtureId, "single-moneyline-home-01");
});

test("logScreenshotDarkLaunchDiagnostic: never logs a raw OCR transcript field, only bounded length counts", () => {
  const originalLog = console.log;
  let loggedPayload = "";
  console.log = (...args: unknown[]) => {
    loggedPayload = String(args[1]);
  };
  try {
    logScreenshotDarkLaunchDiagnostic(diagnostic());
  } finally {
    console.log = originalLog;
  }

  const parsed = JSON.parse(loggedPayload);
  const allowedKeys = new Set([
    "stage",
    "fixtureId",
    "localizationAttempted",
    "localizationStatus",
    "betSlipRegionPresent",
    "selectedRegionPresent",
    "selectedRegionConfidenceBand",
    "fullImageOcrLength",
    "localizedOcrLength",
    "selectedOcrLength",
    "currentNumericVerdict",
    "localizedNumericVerdict",
    "currentMarketVerdict",
    "localizedMarketVerdict",
    "currentFinalDecision",
    "wouldLocalizedPathDiffer",
  ]);
  for (const key of Object.keys(parsed)) {
    assert.ok(allowedKeys.has(key), `unexpected field "${key}" in dark-launch diagnostic payload`);
  }
});
