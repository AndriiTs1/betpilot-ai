import { SportIcon } from "@/components/miniapp/sportIcons";
import { formatAmount } from "@/lib/bets/formatAmount";
import type { ManualReviewDisplayBet } from "./manualReviewDisplay";

// Stage 4.3.5 — read-only. No action button of any kind lives in this
// component (not even a disabled one — Stage 4.3 v3's own instruction: a
// disabled button that isn't an established pattern elsewhere in this
// Dashboard would mislead an operator into expecting it to eventually
// work). Retry Automatically / Resolve / Force WIN-LOSS-VOID are Stage
// 4.3.6+'s job, not this file's.

interface ManualReviewItemProps {
  bet: ManualReviewDisplayBet;
}

function toNumber(value: string | null): number | null {
  if (value === null) return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

export default function ManualReviewItem({ bet }: ManualReviewItemProps) {
  const stake = toNumber(bet.stake);
  const effectiveOdds = toNumber(bet.effectiveOdds);
  const potentialPayout = toNumber(bet.potentialPayout);

  return (
    <div className="rounded-2xl border border-amber-500/30 bg-[#0b1220] p-6 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.04)]">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-xl font-semibold">{bet.playerName}</h3>
          <p className="mt-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
            {bet.isExpress ? `Express ×${bet.selections.length}` : "Single"}
          </p>
        </div>

        <div className="text-right">
          <p className="text-2xl font-bold">{stake !== null ? formatAmount(stake) : "—"}</p>
          <p className="text-slate-400">
            {bet.isExpress ? "Total odds" : "Odds"} {effectiveOdds !== null ? formatAmount(effectiveOdds) : "—"}
          </p>
        </div>
      </div>

      <div className="mt-3 flex items-center gap-2 rounded-xl border border-amber-500/20 bg-amber-500/10 px-3 py-2">
        <i className="ti ti-alert-triangle text-sm text-amber-400" aria-hidden="true" />
        <span className="text-sm font-medium text-amber-300">{bet.reviewReasonLabel}</span>
      </div>

      {bet.selections.length > 0 && (
        <div className="mt-4 space-y-2">
          {bet.selections.map((selection, index) => (
            <div
              key={selection.id}
              className="rounded-xl p-3"
              style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)" }}
            >
              <div className="flex items-start gap-2.5">
                <span className="mt-0.5 shrink-0 text-slate-400" aria-hidden="true">
                  <SportIcon sport={selection.sport} size={18} />
                </span>
                <div className="min-w-0 flex-1">
                  {bet.isExpress && (
                    <p className="mb-0.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">Leg {index + 1}</p>
                  )}
                  <p className="min-w-0 flex-1 break-words text-sm font-semibold text-white">
                    {selection.participant ?? "—"}
                  </p>
                  <p className="break-words text-xs text-slate-400">
                    {selection.selection}
                    {selection.market ? ` · ${selection.market}` : ""}
                  </p>
                  <p className="mt-1 text-xs text-slate-500">
                    Event: {selection.providerEventId ?? "—"}
                  </p>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 text-xs sm:grid-cols-4">
        <div>
          <dt className="text-slate-500">Potential payout</dt>
          <dd className="mt-0.5 font-medium text-white">{potentialPayout !== null ? formatAmount(potentialPayout) : "—"}</dd>
        </div>
        <div>
          <dt className="text-slate-500">Retry count</dt>
          <dd className="mt-0.5 font-medium text-white">{bet.retryCount}</dd>
        </div>
        <div>
          <dt className="text-slate-500">Event start</dt>
          <dd className="mt-0.5 font-medium text-white">{bet.eventStartDisplay}</dd>
        </div>
        <div>
          <dt className="text-slate-500">Created</dt>
          <dd className="mt-0.5 font-medium text-white">{bet.createdAtDisplay}</dd>
        </div>
      </dl>

      {(bet.lastErrorCode || bet.lastErrorMessage) && (
        <p className="mt-3 break-words text-xs text-slate-500">
          Last attempt {bet.lastAttemptDisplay}
          {bet.lastErrorCode ? ` · ${bet.lastErrorCode}` : ""}
          {bet.lastErrorMessage ? ` — ${bet.lastErrorMessage}` : ""}
        </p>
      )}
    </div>
  );
}
