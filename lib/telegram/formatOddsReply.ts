// Step 9B — pure Telegram HTML formatter for a /odds result. Reads only
// the existing, already-computed BetSlipPreview (lib/bets/buildBetSlipPreview.ts,
// protected/unmodified) — never talks to a provider, never computes odds or
// combined prices itself, never invents a field BetSlipPreview doesn't have
// (no league/period/line/provider timestamp/checked-at — none of those
// exist on this type).

import type { BetSelectionOddsStatus } from "@/lib/generated/prisma/client";
import type { BetSlipPreview, BetSlipPreviewSelection } from "@/lib/bets/buildBetSlipPreview";
import { escapeHtml } from "./escapeHtml";

// Deterministic 1:1 mapping from the existing, provider-neutral
// BetSelectionOddsStatus enum (prisma/schema.prisma) — no Telegram-only
// status is introduced, and this switch is exhaustive over every value the
// enum can hold today, including PENDING (never actually produced by
// mapOddsCheckToSelectionStatus post-verification, but a safe fallback line
// exists for it regardless, since the type permits it).
const STATUS_LINES: Record<BetSelectionOddsStatus, string> = {
  VERIFIED: "✅ Odds confirmed",
  ODDS_CHANGED: "⚠️ Odds changed",
  NOT_FOUND: "❔ Event or selection not found",
  UNAVAILABLE: "⚠️ Odds check unavailable",
  PENDING: "⚠️ Verification pending",
};

// The one presentation-level distinction the task explicitly asks for on
// top of the raw enum: UNAVAILABLE caused by "no submitted odds to compare
// against" reads very differently from UNAVAILABLE caused by a provider
// failure — both are the exact same domain status (buildBetSlipPreview.ts
// never distinguishes them either), so this is a wording choice only, never
// a new status.
//
// H4-B5.1 — a second, equally real distinction: NOT_FOUND covers both "the
// event itself was never resolved" AND "the event WAS resolved, only this
// exact selection/line isn't offered" (e.g. a quarter-line SPREAD request
// no bookmaker prices) — buildBetSlipPreview.ts's own selection.event field
// already shows the correct, fully-resolved event name ("Arsenal —
// Coventry City") in the latter case (proven live against production odds
// data), but the single generic "Event or selection not found" wording
// right below it directly contradicted that, reading as if the event were
// unknown. homeTeamName/awayTeamName are only ever populated once the
// provider actually resolved an event (see buildBetSlipPreview.ts), so
// their presence is the one honest signal for which case this is — never
// re-derived from event/selection text.
function statusLineFor(selection: BetSlipPreviewSelection): string {
  if (selection.oddsStatus === "UNAVAILABLE" && selection.submittedOdds === null) {
    return "⚠️ No submitted odds were provided, so comparison is unavailable.";
  }
  if (selection.oddsStatus === "NOT_FOUND" && selection.homeTeamName !== null && selection.awayTeamName !== null) {
    return "❔ Event found, but this exact selection/line is not offered by any bookmaker";
  }
  return STATUS_LINES[selection.oddsStatus];
}

// Numbers are never escaped (escapeHtml only matters for provider/user text
// that could contain &, <, or >) and never reformatted/rounded — displayed
// exactly as buildBetSlipPreview.ts computed them.
function formatOddsValue(value: number | null): string {
  return value === null ? "—" : String(value);
}

function formatSelectionBlock(selection: BetSlipPreviewSelection, index: number, isExpress: boolean): string {
  const lines: string[] = [];

  lines.push(isExpress ? `<b>Selection ${index + 1}</b>` : "<b>Current odds check</b>");
  lines.push(`<b>Sport:</b> ${escapeHtml(selection.sport)}`);
  lines.push(`<b>Event:</b> ${escapeHtml(selection.event)}`);
  if (selection.market !== null) {
    lines.push(`<b>Market:</b> ${escapeHtml(selection.market)}`);
  }
  lines.push(`<b>Selection:</b> ${escapeHtml(selection.selection)}`);
  lines.push(`<b>Submitted odds:</b> ${formatOddsValue(selection.submittedOdds)}`);
  lines.push(`<b>Current odds:</b> ${formatOddsValue(selection.currentOdds)}`);
  if (selection.bookmaker !== null) {
    lines.push(`<b>Bookmaker:</b> ${escapeHtml(selection.bookmaker)}`);
  }
  lines.push(`<b>Status:</b> ${statusLineFor(selection)}`);

  return lines.join("\n");
}

export function formatOddsReply(preview: BetSlipPreview): string {
  const isExpress = preview.selections.length > 1;

  const parts: string[] = [];
  if (isExpress) {
    parts.push("<b>Current odds check (EXPRESS)</b>");
  }

  preview.selections.forEach((selection, index) => {
    parts.push(formatSelectionBlock(selection, index, isExpress));
  });

  // Only ever rendered when buildBetSlipPreview.ts itself computed them
  // (every selection had known submittedOdds) — never derived, multiplied,
  // or partially estimated here.
  if (preview.totalOdds !== null) {
    parts.push(`<b>Total odds:</b> ${formatOddsValue(preview.totalOdds)}`);
  }
  if (preview.potentialWin !== null) {
    parts.push(`<b>Potential win:</b> ${formatOddsValue(preview.potentialWin)}`);
  }

  return parts.join("\n\n");
}
