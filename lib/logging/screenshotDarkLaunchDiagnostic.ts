// MASTER STAGE M4.0 — a NEW, permanent-by-design diagnostic, deliberately
// kept separate from lib/logging/screenshotQa1Diagnostic.ts (that module's
// own header labels itself TEMPORARY, scoped to one specific incident,
// meant to be removed once answered). This one exists for the lifetime of
// the M4.0/M4.1 dark-launch comparison: "what would the localized-evidence
// path have decided, compared to what the current whole-screen path
// actually decided" — a genuinely different, ongoing question, not a
// one-incident investigation.
//
// Not wired into any route or pipeline stage yet. Nothing in this file is
// called by app/api/miniapp/bets/screenshot/preview/route.ts,
// lib/ocr/recognizeBetSlipScreenshot.ts, or lib/ai/betParser.ts as of this
// stage — it exists so M4.1's dark-launch wiring has a real, reviewed shape
// to log into, without inventing one under time pressure alongside the
// actual localization call.
//
// Same privacy discipline as screenshotQa1Diagnostic.ts, restated here
// explicitly since this is a new, independent module: every field is a
// boolean/enum/number/id — never raw image bytes, never a full OCR
// transcript (only bounded LENGTH counts), never Telegram initData, a
// player id, an auth header, a preview token, or an Anthropic response
// body. `fixtureId` is the one string field, and only ever an internal
// fixture identifier (lib/testing/screenshotFixtures.ts) a developer
// assigned — never OCR-derived or player-supplied text.
//
// Side-effect-only, exactly like logScreenshotQa1Diagnostic: returns void,
// only ever calls console.log, cannot change a response's status/body.

import type { CurrentFinalDecision, LocalizationStatus, ShadowVerdict } from "@/lib/ocr/selectedRegionLocalization";

export const SCREENSHOT_DARK_LAUNCH_DIAGNOSTIC_MARKER = "[SCREENSHOT_DARK_LAUNCH_DIAGNOSTIC]";

export type SelectedRegionConfidenceBand = "HIGH" | "MEDIUM" | "LOW" | "NOT_AVAILABLE";

// Buckets a raw 0-1 confidence into a closed enum for logging — matches this
// codebase's existing "closed enums / bounded diagnostics preferred over raw
// floats" convention (see screenshotQa1Diagnostic.ts's own header). Bucket
// edges are round, defensible operational starting points (not a measured
// calibration), same caveat lib/ai/betParser.ts's own CLAUDE_OCR_PARSER_TIMEOUT_MS
// comment already gives for a similarly provisional constant — expected to
// be revisited once real M4.1 confidence values exist to calibrate against.
export function selectedRegionConfidenceBand(confidence: number | null): SelectedRegionConfidenceBand {
  if (confidence === null) return "NOT_AVAILABLE";
  if (confidence >= 0.8) return "HIGH";
  if (confidence >= 0.5) return "MEDIUM";
  return "LOW";
}

export interface ScreenshotDarkLaunchDiagnostic {
  readonly stage: "dark_launch_comparison";
  // Internal fixture identifier only when this fires from the fixture-driven
  // shadow harness; null for a real (non-fixture) request, once M4.1 ever
  // wires this into live traffic.
  readonly fixtureId: string | null;
  readonly localizationAttempted: boolean;
  readonly localizationStatus: LocalizationStatus;
  readonly betSlipRegionPresent: boolean;
  readonly selectedRegionPresent: boolean;
  readonly selectedRegionConfidenceBand: SelectedRegionConfidenceBand;
  // Character counts only — never the text itself. null whenever the
  // corresponding OCR pass was never attempted (e.g. localizedOcrLength/
  // selectedOcrLength both null when localizationStatus !== "FOUND_BOTH" /
  // "FOUND_SLIP_ONLY").
  readonly fullImageOcrLength: number | null;
  readonly localizedOcrLength: number | null;
  readonly selectedOcrLength: number | null;
  readonly currentNumericVerdict: ShadowVerdict;
  readonly localizedNumericVerdict: ShadowVerdict;
  readonly currentMarketVerdict: ShadowVerdict;
  readonly localizedMarketVerdict: ShadowVerdict;
  readonly currentFinalDecision: CurrentFinalDecision;
  readonly wouldLocalizedPathDiffer: boolean;
}

export function logScreenshotDarkLaunchDiagnostic(diagnostic: ScreenshotDarkLaunchDiagnostic): void {
  console.log(SCREENSHOT_DARK_LAUNCH_DIAGNOSTIC_MARKER, JSON.stringify(diagnostic));
}
