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
  // lib/bets/buildBetSlipPreview.ts's own per-selection odds-check outcome
  // — deliberately distinct names from the odds_verification_* aggregate
  // events above (those fire once per request, from the route; these fire
  // once per selection, from a lower-level function shared by both the
  // text and screenshot bet flows) so a log line can never be misread as
  // the wrong granularity. The "ScreenshotPipeline" name predates this
  // shared use — it's still the same small, generic
  // JSON.stringify+console.log mechanism regardless of caller.
  | "odds_check_not_matched"
  | "odds_check_rejected";

export interface ScreenshotPipelineLogMetadata {
  durationMs?: number;
  totalDurationMs?: number;
  failureCode?: string;
  parserMode?: "CHAT" | "OCR";
  selectionCount?: number;
  oddsVerificationStatus?: string;
  // Purely positional (0, 1, 2, ...) — never the selection's own content
  // (event/selection/market/odds/stake).
  selectionIndex?: number;
  // Pixel dimensions only — never image bytes, never a data URL, never any
  // decoded content. Used to distinguish the cropped-slip path from the
  // full-screen-screenshot path in logs/metrics.
  imageWidth?: number;
  imageHeight?: number;
  // The region-detection model's own confidence figure — a plain number,
  // never its free-text `reason` (that field is deliberately never passed
  // to this logger at all, see lib/ocr/regionDetection.ts).
  regionConfidence?: number;
}

export function logScreenshotPipelineEvent(
  event: ScreenshotPipelineEvent,
  metadata: ScreenshotPipelineLogMetadata = {},
): void {
  console.log(JSON.stringify({ event, ...metadata }));
}
