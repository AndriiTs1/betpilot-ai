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
}

export function logScreenshotPipelineEvent(
  event: ScreenshotPipelineEvent,
  metadata: ScreenshotPipelineLogMetadata = {},
): void {
  console.log(JSON.stringify({ event, ...metadata }));
}
