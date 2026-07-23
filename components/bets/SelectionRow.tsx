import { SportIcon } from "@/components/miniapp/sportIcons";
import { getOddsStatusBadge } from "@/lib/bets/oddsStatusBadge";
import { formatAmount } from "@/lib/bets/formatAmount";
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

export default function SelectionRow({ selection, legLabel, showStatus = true }: SelectionRowProps) {
  const odds = toNumber(selection.odds);
  const currentOdds = showStatus ? toNumber(selection.currentOdds) : null;
  const statusBadge = showStatus ? getOddsStatusBadge(selection.oddsStatus) : null;

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

          <p className="break-words text-xs text-slate-400">
            {selection.outcome}
            {selection.market ? ` · ${selection.market}` : ""}
          </p>

          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
            <span>Odds: {odds !== null ? formatAmount(odds) : "—"}</span>
            {showStatus && currentOdds !== null && <span>Current: {formatAmount(currentOdds)}</span>}
          </div>
        </div>
      </div>
    </div>
  );
}
