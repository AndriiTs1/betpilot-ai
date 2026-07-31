// TEMPORARY — investigating an EXPRESS-bet-specific verification report
// (single-team selections resolve correctly for SINGLE bets but stay
// unresolved/"Unavailable" for EXPRESS legs). One shared, env-var-gated
// structured logger used by both lib/odds/oddsVerifier.ts and
// lib/bets/buildBetSlipPreview.ts, so there is exactly one debug-logging
// mechanism, not two independently-maintained ones.
//
// Defaults OFF (opt-in via ODDS_DEBUG_LOGGING=true): never fires during
// `npm test` (several existing tests assert an exact log-event sequence or
// that no free-text bet content is ever logged — this must never affect
// either), and is a zero-risk, single-env-var rollback in production
// without a redeploy.
//
// Remove this file and every call site importing it once the investigation
// concludes and any real fix (if needed) ships.
export function isOddsDebugLoggingEnabled(): boolean {
  return process.env.ODDS_DEBUG_LOGGING === "true";
}

// Single JSON.stringify'd argument, flat event/string/number/boolean/null
// fields only — matches lib/bets/buildBetSlipPreview.ts's existing
// structured-log convention (enforced there by a test), followed here too
// for consistency.
export function oddsDebugLog(event: string, data: Record<string, string | number | boolean | null>): void {
  if (!isOddsDebugLoggingEnabled()) return;
  console.log(JSON.stringify({ event: `odds_debug_${event}`, ...data }));
}
