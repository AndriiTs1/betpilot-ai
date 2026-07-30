"use client";

import { useState } from "react";
import { SportIcon } from "@/components/miniapp/sportIcons";
import { formatAmount } from "@/lib/bets/formatAmount";
import { describeManualRetryOutcome, type ManualReviewDisplayBet } from "./manualReviewDisplay";

// Stage 4.3.6 — adds exactly one action: Retry Automatically. It re-runs
// the same automatic settlement pipeline the cron already uses, for this
// one bet (POST /api/dashboard/bets/:id/settlement-retry) — never a manual
// Force WIN/LOSS/VOID/Resolve path, and none of those are added here
// either (Stage 4.3.6's own explicit "do not add" list).

interface ManualReviewItemProps {
  bet: ManualReviewDisplayBet;
  // Called once per retry response, after the request settles (success or
  // handled error) — the parent (ManualReviewQueue) decides what to do:
  // remove the item (status === SETTLED) or refetch the list so this row
  // reflects the server's fresh state, never guessed at client-side.
  onRetried: (betId: string, status: string) => void;
}

function toNumber(value: string | null): number | null {
  if (value === null) return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

const FEEDBACK_TONE_CLASS: Record<string, string> = {
  success: "bg-green-950 text-green-400",
  info: "bg-slate-800 text-slate-300",
  warning: "bg-amber-950 text-amber-400",
  error: "bg-red-950 text-red-400",
};

export default function ManualReviewItem({ bet, onRetried }: ManualReviewItemProps) {
  const [isRetrying, setIsRetrying] = useState(false);
  const [feedback, setFeedback] = useState<{ tone: string; text: string } | null>(null);

  const stake = toNumber(bet.stake);
  const effectiveOdds = toNumber(bet.effectiveOdds);
  const potentialPayout = toNumber(bet.potentialPayout);

  async function handleRetry() {
    // Double-click / double-tap guard — a second click while a request is
    // already in flight is simply ignored, not queued.
    if (isRetrying) return;

    setIsRetrying(true);
    setFeedback(null);

    try {
      const response = await fetch(`/api/dashboard/bets/${bet.id}/settlement-retry`, { method: "POST" });
      const body = await response.json().catch(() => null);

      if (response.ok && body?.success) {
        const status = body.result?.status as string;
        setFeedback(describeManualRetryOutcome(status));
        onRetried(bet.id, status);
        return;
      }

      if (response.status === 409) {
        setFeedback({ tone: "info", text: body?.error?.message ?? "Состояние ставки изменилось — список будет обновлён." });
        onRetried(bet.id, "CONFLICT");
        return;
      }

      setFeedback({ tone: "error", text: "Не удалось выполнить повтор. Попробуйте ещё раз." });
    } catch {
      setFeedback({ tone: "error", text: "Не удалось связаться с сервером. Проверьте соединение." });
    } finally {
      setIsRetrying(false);
    }
  }

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

      {feedback && (
        <p className={`mt-4 rounded-lg px-3 py-2 text-sm ${FEEDBACK_TONE_CLASS[feedback.tone] ?? FEEDBACK_TONE_CLASS.error}`}>
          {feedback.text}
        </p>
      )}

      <div className="mt-5">
        <button
          type="button"
          onClick={handleRetry}
          disabled={isRetrying}
          aria-label={`Retry automatic settlement for ${bet.playerName}`}
          className="min-h-11 rounded-xl bg-blue-500 px-5 py-2 font-semibold text-white transition-colors hover:bg-blue-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-400 disabled:opacity-50 disabled:hover:bg-blue-500"
        >
          {isRetrying ? "Retrying..." : "Retry Automatically"}
        </button>
      </div>
    </div>
  );
}
