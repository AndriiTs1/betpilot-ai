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

// M4.1 — CLEAN PLAYER ODDS UX. "plain" is now reached ONLY by the
// showStatus=false review-context path below (Active Bets/History/
// PlayerCard), which builds it directly, never via getOddsPresentation —
// kept only so that path's pre-existing rendering stays byte-for-byte
// unchanged. A decision-context row (showStatus=true) never has anything to
// compare: the screenshot/typed odds a player submitted are not a real
// offer (see BetPreviewCard.tsx's own header) and must never be shown or
// compared against the current price — so getOddsPresentation below only
// ever returns "prominent" (one clean current-odds value) or "unavailable".
export type OddsPresentation =
  | { mode: "prominent"; value: number }
  | { mode: "unavailable" }
  | { mode: "plain"; odds: number | null; currentOdds: number | null };

// UI Polish — the odds-presentation decision, extracted as a pure function
// so it's unit-testable without this project's deliberately absent
// DOM-rendering test infra (same pattern as BetPreviewCard.tsx's
// isProviderUnavailable). Never returns "prominent" for anything other than
// VERIFIED/ODDS_CHANGED — an unmatched selection (NOT_FOUND/UNAVAILABLE/
// PENDING) must never render a value that looks like a confirmed price (see
// this file's own test suite). VERIFIED and ODDS_CHANGED render IDENTICALLY
// — both are real, provider-confirmed, current prices; ODDS_CHANGED only
// additionally gates CONFIRM-time reconfirmation (a separate, untouched
// mechanism — see betConfirmApi.ts), which this preview-time presentation
// has no part in. Takes only currentOdds, never the submitted value — a
// player must only ever see BetPilot's current offer, never what they
// typed or what a screenshot said.
export function getOddsPresentation(
  oddsStatus: string | null | undefined,
  currentOdds: number | null,
): OddsPresentation {
  const isConfirmable = oddsStatus === "VERIFIED" || oddsStatus === "ODDS_CHANGED";
  if (isConfirmable && currentOdds !== null) {
    return { mode: "prominent", value: currentOdds };
  }
  return { mode: "unavailable" };
}

export default function SelectionRow({ selection, legLabel, showStatus = true }: SelectionRowProps) {
  const odds = toNumber(selection.odds);
  const currentOdds = showStatus ? toNumber(selection.currentOdds) : null;
  // M4.1 — VERIFIED/ODDS_CHANGED are both the normal "ready to confirm"
  // state now that they render identically (see getOddsPresentation above);
  // a badge would only ever announce the exact screenshot-vs-provider
  // distinction the product rule hides. Only a genuinely blocking status
  // (NOT_FOUND/UNAVAILABLE/PENDING) still shows a badge, explaining why
  // Confirm is disabled.
  const isConfirmableStatus = selection.oddsStatus === "VERIFIED" || selection.oddsStatus === "ODDS_CHANGED";
  const statusBadge = showStatus && !isConfirmableStatus ? getOddsStatusBadge(selection.oddsStatus) : null;
  const eventDateTime = formatEventDateTime(selection.eventStartTime);

  // Reuses statusBadge.color computed above (one source of truth for status
  // color, same as the badge pill) rather than inventing a new palette.
  const statusColor = statusBadge?.color ?? "#ffffff";
  // Scoped to decision contexts only (showStatus=true — Preview/
  // Confirmation Ticket/Pending Queue): a review-context row (Active Bets/
  // History/PlayerCard, showStatus=false) must render byte-for-byte as it
  // did before this task, even for a VERIFIED historical selection — never
  // call getOddsPresentation there, since oddsStatus alone (without the
  // showStatus gate) can't distinguish the two contexts.
  const presentation: OddsPresentation = showStatus
    ? getOddsPresentation(selection.oddsStatus, currentOdds)
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
            // The one and only value a player sees: BetPilot's current
            // offer for this leg. No comparison, no second number.
            <div className="mt-1.5 flex items-baseline gap-1.5">
              <span className="text-xs text-slate-500">Odds</span>
              <span className="text-base font-bold" style={{ color: statusColor }}>
                {formatAmount(presentation.value)}
              </span>
            </div>
          ) : presentation.mode === "unavailable" ? (
            <div className="mt-1.5 text-xs text-slate-500">Odds: —</div>
          ) : (
            // Review-context only (showStatus=false) — the bet's own final,
            // already-accepted odds; unrelated to the preview/confirm-time
            // concerns above.
            <div className="mt-1.5 text-xs text-slate-500">
              Odds: {presentation.odds !== null ? formatAmount(presentation.odds) : "—"}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
