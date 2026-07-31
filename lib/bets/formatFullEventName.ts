// Shared by both the server (buildBetSlipPreview.ts, mapBetForDisplay.ts)
// and the client (BetPreviewCard.tsx) — pure, dependency-free, safe in
// either bundle. Falls back to the original (possibly single-team, e.g.
// "Arsenal") parsed text whenever the provider's own team names aren't both
// known — never fabricates a "Team — undefined" string, so an older bet
// (created before this metadata existed) or a bet the provider couldn't
// unambiguously match still renders exactly as it always did.
export function formatFullEventName(
  fallbackEvent: string,
  homeTeamName: string | null | undefined,
  awayTeamName: string | null | undefined,
): string {
  if (homeTeamName && awayTeamName) return `${homeTeamName} — ${awayTeamName}`;
  return fallbackEvent;
}
