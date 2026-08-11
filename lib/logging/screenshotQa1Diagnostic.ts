// SCREENSHOT QA-1.1 — TEMPORARY diagnostic for one specific incident (the
// Bayern Munich vs. VfB Stuttgart screenshot returning IMAGE_NOT_RECOGNIZED
// in production, credentials unavailable locally to reproduce directly).
// Deliberately kept separate from lib/logging/structuredLog.ts's permanent,
// content-free ScreenshotPipelineEvent log (whose own header comment
// explicitly says metadata can never carry OCR text or parsed bet content)
// — this module exists ONLY to answer "which stage first diverges from the
// expected bet slip" for this investigation, is meant to be removed once
// that's answered, and is intentionally the only place in the codebase that
// logs parsed bet content (event/selection/market/line/odds/stake) at all.
//
// Every field below is either a boolean/enum/number, or — for the parser
// stage only — the bet's own already-extracted structured fields (which the
// player who reported this issue already disclosed in plaintext). This
// module MUST NEVER be given: Telegram initData, a Telegram/player id, an
// auth header, a cookie, a bot token, an Anthropic key, a DB URL, a preview
// token, raw image bytes/base64, or a full raw OCR transcript — none of
// those types are constructible from this file's exported types at all.
//
// Side-effect-only: every function here returns void and only calls
// console.log. Nothing it does can change a response's status/body — see
// app/api/miniapp/bets/screenshot/preview/route.test.ts's QA-1.1 tests for
// the proof (identical HTTP result with console.log mocked to a no-op).

export const SCREENSHOT_QA1_DIAGNOSTIC_MARKER = "[SCREENSHOT_QA1_DIAGNOSTIC]";

export interface Qa1PreprocessingDiagnostic {
  stage: "preprocessing";
  mimeType: string;
  imageWidth: number | null;
  imageHeight: number | null;
  looksLikeFullScreenScreenshot: boolean;
}

export interface Qa1RegionDetectionDiagnostic {
  stage: "region_detection";
  attempted: boolean;
  outcome: "skipped_small_image" | "region_found" | "region_not_found" | "region_invalid" | "region_timeout" | "region_error";
  // Normalized (0-1) coordinates exactly as the model returned them —
  // never pixel values, and null whenever outcome !== "region_found".
  region: { x: number; y: number; width: number; height: number } | null;
  cropWidthPx: number | null;
  cropHeightPx: number | null;
  // true whenever OCR ends up running on the original, uncropped buffer —
  // i.e. every outcome except "region_found" (skipped, not-found, invalid,
  // timeout, or error all fall back to full-image OCR, matching
  // recognizeBetSlipScreenshot.ts's own existing fallback behavior,
  // unchanged by this diagnostic).
  fallbackToFullImage: boolean;
}

// Booleans only, per this stage's explicit "prefer boolean markers"
// instruction — deliberately no raw/redacted OCR text field at all, to keep
// this module's own attack surface as small as possible; text LENGTH is a
// safe count, never content.
export interface Qa1OcrDiagnostic {
  stage: "ocr";
  normalizedTextLength: number;
  containsBayern: boolean;
  containsStuttgart: boolean;
  containsOdds142: boolean;
  containsStake100: boolean;
  containsP1: boolean;
}

export interface Qa1ParserSelectionDiagnostic {
  sport: string;
  event: string;
  market: string | null;
  selection: string;
  line: string | null;
  odds: number | null;
}

export interface Qa1ParserDiagnostic {
  stage: "parser";
  valid: boolean;
  // ParseBetSlipResult's own optional discriminator
  // (lib/ai/betParser.ts) — "unspecified" only when the parser rejected
  // without one of the three named codes (e.g. reject_bet, malformed
  // extraction), never a fabricated value.
  errorCode: "timeout" | "numeric_mismatch" | "market_mismatch" | "unspecified" | null;
  type: "SINGLE" | "EXPRESS" | null;
  stake: number | null;
  selections: Qa1ParserSelectionDiagnostic[] | null;
}

export type Qa1Diagnostic = Qa1PreprocessingDiagnostic | Qa1RegionDetectionDiagnostic | Qa1OcrDiagnostic | Qa1ParserDiagnostic;

export function logScreenshotQa1Diagnostic(diagnostic: Qa1Diagnostic): void {
  console.log(SCREENSHOT_QA1_DIAGNOSTIC_MARKER, JSON.stringify(diagnostic));
}

// Pure, exported separately so route.ts and tests can both compute/verify
// these booleans without duplicating the substring logic. Case-insensitive
// (Node's string .toLowerCase() correctly case-folds Cyrillic under the
// full-ICU builds this project already runs on) — a real bookmaker UI's
// exact capitalization is never something OCR/the player controls.
export function computeQa1OcrIndicators(normalizedText: string): Omit<Qa1OcrDiagnostic, "stage" | "normalizedTextLength"> {
  const lower = normalizedText.toLowerCase();
  return {
    containsBayern: lower.includes("bayern"),
    containsStuttgart: lower.includes("stuttgart"),
    containsOdds142: lower.includes("1.42"),
    containsStake100: lower.includes("100"),
    containsP1: lower.includes("п1"),
  };
}
