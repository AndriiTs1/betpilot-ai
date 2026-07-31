import { SportIcon } from "@/components/miniapp/sportIcons";
import { getOddsStatusBadge } from "@/lib/bets/oddsStatusBadge";
import { formatAmount } from "@/lib/bets/formatAmount";
import { formatEventDateTime } from "@/lib/bets/formatEventDateTime";
import type { DisplaySelection } from "@/lib/bets/mapBetForDisplay";

// English-only selection labels (temporary product rule) are normalized by
// each caller before a DisplaySelection reaches this component — never
// here. Every current caller already does this at its own entry point
// (lib/bets/mapBetForDisplay.ts for BetQueueItem/PlayerCard,
// BetPreviewCard.tsx for the pre-persistence preview, BetSelectionsList.tsx
// for the raw Mini App selections list) — see normalizeSelectionToEnglish's
// own header comment for the full list. Normalizing again here would be a
// second, redundant pass over already-normalized text on every render.

// The canonical per-selection row for the shared Bet Card family — one
// SINGLE bet's only selection and one EXPRESS bet's each leg both render
// through this exact component, on every surface (Mini App Preview,
// Confirmation Ticket, Active Bets, History; Dashboard Pending Queue,
// Active Bets, History). Promoted from BetPreviewCard.tsx's original
// (Mini App Preview-only) SelectionRow, the closest existing match to this
// shape — extended with a small sport icon and a flex-1 text column so the
// row balances across the card's full width instead of hugging the left
// edge.
//
// `showStatus` toggles the decision-context-only fields (current odds,
// odds-verification badge) — review/list contexts (Dashboard/Mini App
// Active Bets & History) omit them to stay compact; Preview/Confirmation
// Ticket/Pending Queue show them since verification detail is
// decision-relevant there.

interface SelectionRowProps {
  selection: DisplaySelection;
  legLabel?: string;
  showStatus?: boolean;
}

function toNumber(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const num = typeof value === "number" ? value : Number(value);
  return Number.isFinite(num) ? num : null;
}

export type OddsPresentation =
  | { mode: "prominent"; value: number }
  | { mode: "dual"; submitted: number; current: number }
  | { mode: "plain"; odds: number | null; currentOdds: number | null };

// UI Polish — the odds-presentation decision, extracted as a pure function
// so it's unit-testable without this project's deliberately absent
// DOM-rendering test infra (same pattern as BetPreviewCard.tsx's
// isProviderUnavailable). Never returns "prominent" for anything other than
// VERIFIED — an unavailable/unverified selection must never render a value
// that looks like a confirmed price (see this file's own test suite).
export function getOddsPresentation(
  oddsStatus: string | null | undefined,
  odds: number | null,
  currentOdds: number | null,
): OddsPresentation {
  const isVerified = oddsStatus === "VERIFIED";
  const isChanged = oddsStatus === "ODDS_CHANGED";
  const prominentOdds = currentOdds ?? odds;

  if (isVerified && prominentOdds !== null) {
    return { mode: "prominent", value: prominentOdds };
  }
  if (isChanged && odds !== null && currentOdds !== null) {
    return { mode: "dual", submitted: odds, current: currentOdds };
  }
  return { mode: "plain", odds, currentOdds };
}

export default function SelectionRow({ selection, legLabel, showStatus = true }: SelectionRowProps) {
  const odds = toNumber(selection.odds);
  const currentOdds = showStatus ? toNumber(selection.currentOdds) : null;
  const statusBadge = showStatus ? getOddsStatusBadge(selection.oddsStatus) : null;
  const eventDateTime = formatEventDateTime(selection.eventStartTime);

  // Reuses statusBadge.color computed above (one source of truth for status
  // color, same as the badge pill) rather than inventing a new palette.
  // Text labels ("Submitted"/"Current"/"Odds") are the accessible signal in
  // every branch — color is only ever a secondary cue, never the sole
  // indicator.
  const statusColor = statusBadge?.color ?? "#ffffff";
  // Scoped to decision contexts only (showStatus=true — Preview/
  // Confirmation Ticket/Pending Queue): a review-context row (Active Bets/
  // History/PlayerCard, showStatus=false) must render byte-for-byte as it
  // did before this task, even for a VERIFIED historical selection — never
  // call getOddsPresentation there, since oddsStatus alone (without the
  // showStatus gate) can't distinguish the two contexts.
  const presentation: OddsPresentation = showStatus
    ? getOddsPresentation(selection.oddsStatus, odds, currentOdds)
    : { mode: "plain", odds, currentOdds: null };

  return (
    <div
      className="rounded-xl p-3"
      style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)" }}
    >
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 shrink-0 text-slate-400" aria-hidden="true">
          <SportIcon sport={selection.sport} size={18} />
        </span>

        <div className="min-w-0 flex-1">
          {legLabel && (
            <p className="mb-0.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">{legLabel}</p>
          )}

          <div className="flex items-start justify-between gap-3">
            <p className="min-w-0 flex-1 break-words text-sm font-semibold text-white">{selection.event}</p>
            {statusBadge && statusBadge.label && (
              <span
                className="shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium"
                style={{ background: `${statusBadge.color}1A`, color: statusBadge.color }}
              >
                {statusBadge.label}
              </span>
            )}
          </div>

          {(selection.competitionName || eventDateTime) && (
            <p className="break-words text-xs text-slate-500">
              {selection.competitionName}
              {selection.competitionName && eventDateTime ? " · " : ""}
              {eventDateTime}
            </p>
          )}

          <p className="break-words text-xs text-slate-400">
            {selection.outcome}
            {selection.market ? ` · ${selection.market}` : ""}
          </p>

          {presentation.mode === "prominent" ? (
            // Submitted odds equal (or were promoted from) the verified
            // current price — showing both fields would just repeat the
            // same number twice, so this collapses to one prominent value.
            <div className="mt-1.5 flex items-baseline gap-1.5">
              <span className="text-xs text-slate-500">Odds</span>
              <span className="text-base font-bold" style={{ color: statusColor }}>
                {formatAmount(presentation.value)}
              </span>
            </div>
          ) : presentation.mode === "dual" ? (
            // Genuinely different values — both stay visible, clearly
            // labeled; the current price is the prominent one since that's
            // what re-confirming would accept.
            <div className="mt-1.5 flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className="text-xs text-slate-500">Submitted {formatAmount(presentation.submitted)}</span>
              <span className="text-base font-bold" style={{ color: statusColor }}>
                Current {formatAmount(presentation.current)}
              </span>
            </div>
          ) : (
            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
              <span>Odds: {presentation.odds !== null ? formatAmount(presentation.odds) : "—"}</span>
              {showStatus && presentation.currentOdds !== null && (
                <span>Current: {formatAmount(presentation.currentOdds)}</span>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
