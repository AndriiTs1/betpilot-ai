// Stage 14.4A — the first (and, deliberately, only) logging abstraction in
// this codebase (confirmed before adding this: no logger/logging file, no
// logging package, existed anywhere — every other file just calls
// console.error with a plain string prefix). Kept intentionally minimal —
// one function, one JSON.stringify'd console.log line — not a logging
// framework. Metadata is strictly typed to exactly the fields the
// screenshot preview pipeline is allowed to log, so a future edit can't
// accidentally widen this to accept OCR text, event/selection/stake/odds
// values, image bytes, Telegram initData, tokens, or headers — none of
// those are expressible in ScreenshotPipelineLogMetadata's shape at all.

export type ScreenshotPipelineEvent =
  | "screenshot_preview_started"
  // Stage 4.2B2 — fired once per image, immediately after the raw bytes are
  // obtained (before any OCR/region-detection/crop touches them), by every
  // screenshot source (Mini App upload, Telegram file download, the
  // operator debug route). The one common, source-independent checkpoint
  // that carries imageHash — see lib/ocr/imageHash.ts.
  | "image_received"
  | "image_metadata_read"
  | "image_too_large"
  | "image_decode_failed"
  | "region_detection_skipped"
  | "region_detection_found"
  | "region_detection_not_found"
  | "region_detection_invalid"
  | "region_detection_timeout"
  | "region_detection_error"
  | "crop_applied"
  | "ocr_succeeded"
  | "ocr_failed"
  | "parser_succeeded"
  | "parser_rejected"
  | "parser_timed_out"
  | "parser_failed"
  | "odds_verification_succeeded"
  | "odds_verification_not_found"
  | "odds_verification_failed"
  | "screenshot_preview_completed"
  // Stage 4.2B3 — recognition (OCR + AI parser output) and verification
  // (odds check) cache outcomes. "_reused" means the existing, unmodified
  // OCR/parser/odds-verification call was skipped entirely in favor of an
  // already-persisted row (lib/bets/screenshotRecognitionService.ts);
  // "_created" means it ran and a new row was persisted. Exactly one of
  // each pair fires per request.
  | "recognition_reused"
  | "recognition_created"
  | "verification_reused"
  | "verification_created"
  // lib/bets/buildBetSlipPreview.ts's own per-selection odds-check outcome
  // — deliberately distinct names from the odds_verification_* aggregate
  // events above (those fire once per request, from the route; these fire
  // once per selection, from a lower-level function shared by both the
  // text and screenshot bet flows) so a log line can never be misread as
  // the wrong granularity. The "ScreenshotPipeline" name predates this
  // shared use — it's still the same small, generic
  // JSON.stringify+console.log mechanism regardless of caller.
  | "odds_check_not_matched"
  | "odds_check_rejected"
  // lib/odds/oddsVerifier.ts — fires once per failed provider fetch attempt
  // (a real HTTP error, timeout, or unexpected exception from The Odds
  // API). Permanent operational logging, not gated behind a debug flag —
  // safe by construction: failureCode is always a short, enum-like token
  // (the provider's own error_code, a synthesized HTTP_<status>,
  // "TIMEOUT", or "UNKNOWN"), never the raw response body, headers, or API
  // key.
  | "odds_provider_fetch_failed";

export interface ScreenshotPipelineLogMetadata {
  durationMs?: number;
  totalDurationMs?: number;
  failureCode?: string;
  // Stage M4.4 — the granular sub-reason behind failureCode, when one
  // exists (currently only for spread SELECTION_NOT_FOUND: one of
  // findSpreadOutcome's own kinds, e.g.
  // "LEGACY_SPREAD_LINE_NOT_AVAILABLE"/"LEGACY_SPREAD_PARTICIPANT_NOT_FOUND"
  // — see lib/odds/theOddsApiProvider.ts's classifyLegacyFailureNote).
  // Always a short, fixed, enum-like token produced by that classifier,
  // never raw provider payload/response text.
  diagnosticCode?: string;
  parserMode?: "CHAT" | "OCR";
  selectionCount?: number;
  oddsVerificationStatus?: string;
  // Purely positional (0, 1, 2, ...) — never the selection's own content
  // (event/selection/market/odds/stake).
  selectionIndex?: number;
  // The Odds API sport_key that failed (e.g. "soccer_epl") — a fixed,
  // internal identifier, never player-submitted text. See
  // odds_provider_fetch_failed above.
  sportKey?: string;
  // The raw HTTP status code from a failed provider request (e.g. 401,
  // 429, 503) — a plain number, paired with failureCode above.
  httpStatus?: number;
  // Pixel dimensions only — never image bytes, never a data URL, never any
  // decoded content. Used to distinguish the cropped-slip path from the
  // full-screen-screenshot path in logs/metrics.
  imageWidth?: number;
  imageHeight?: number;
  // The region-detection model's own confidence figure — a plain number,
  // never its free-text `reason` (that field is deliberately never passed
  // to this logger at all, see lib/ocr/regionDetection.ts).
  regionConfidence?: number;
  // Stage 4.2B2 — SHA-256 hex digest of the raw, unmodified image bytes
  // (lib/ocr/imageHash.ts). A hash, not the image itself or any of its
  // content — safe, non-reversible, no PII. Lets identical uploads be
  // correlated across separate requests/log lines without ever storing the
  // image anywhere.
  imageHash?: string;
}

export function logScreenshotPipelineEvent(
  event: ScreenshotPipelineEvent,
  metadata: ScreenshotPipelineLogMetadata = {},
): void {
  console.log(JSON.stringify({ event, ...metadata }));
}
