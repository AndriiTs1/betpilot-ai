"use client";

import { useState } from "react";
import { dispatchDashboardRefresh } from "@/lib/dashboard/refreshEvent";
import SelectionList from "./SelectionList";
import { mapBetForDisplay } from "@/lib/bets/mapBetForDisplay";

export interface PendingBetSelection {
  id: string;
  sport: string;
  event: string;
  outcome: string;
  market: string | null;
  odds: string | null;
  currentOdds: string | null;
  oddsStatus: string;
}

export interface PendingBet {
  id: string;
  playerId: string;
  player: { id: string; name: string };
  sport: string;
  // Nullable to match the real Prisma contract — both are genuinely null
  // for an EXPRESS bet (event/outcome live per-leg on selections instead).
  // Already true on the wire; this type was simply never honest about it.
  event: string | null;
  outcome: string | null;
  odds: string | null;
  totalOdds: string | null;
  stake: string;
  status: string;
  rawMessage: string | null;
  createdAt: string;
  updatedAt: string;
  // Already present on every real API response (GET /api/bets/pending
  // includes selections; the dashboard route proxies it unmodified) — just
  // not previously declared here, which is the root cause of an EXPRESS
  // Pending row rendering with a blank Event/Selection before this fix.
  selections: PendingBetSelection[];
  oddsSnapshot: {
    id: string;
    sourceOdds: string | null;
    submittedOdds: string;
    matched: boolean;
    checkedAt: string;
  } | null;
}

interface BetQueueItemProps {
  bet: PendingBet;
  onResolved: (betId: string) => void;
}

type Action = "confirm" | "reject";

export default function BetQueueItem({ bet, onResolved }: BetQueueItemProps) {
  const [pendingAction, setPendingAction] = useState<Action | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleAction(action: Action) {
    setPendingAction(action);
    setError(null);

    try {
      const response = await fetch(`/api/dashboard/bets/${bet.id}/${action}`, {
        method: "POST",
      });

      if (response.ok) {
        onResolved(bet.id);
        // Confirm/reject also changes Exposure, Available, and the
        // player's Active Bets/History — let those refresh immediately
        // rather than only on the next manual reload.
        dispatchDashboardRefresh();
        return;
      }

      if (response.status === 409) {
        const body = await response.json().catch(() => null);
        setError(body?.error ?? "Ставка уже не в статусе PENDING — обновите список.");
        return;
      }

      if (response.status === 404) {
        setError("Ставка не найдена — возможно, уже обработана.");
        return;
      }

      setError("Не удалось выполнить действие. Попробуйте ещё раз.");
    } catch {
      setError("Не удалось связаться с сервером. Проверьте соединение.");
    } finally {
      setPendingAction(null);
    }
  }

  // EXPRESS is never given its own type of Bet on the client — inferred
  // from selection count, same established convention as
  // ActiveBetsScreen.tsx/HistoryScreen.tsx (a real EXPRESS bet always has
  // >1 BetSelection row; a real SINGLE bet always has zero).
  const display = mapBetForDisplay({
    ...bet,
    type: bet.selections.length > 1 ? "EXPRESS" : "SINGLE",
  });
  const isExpress = display.selectionCount > 1;
  const effectiveOdds = bet.totalOdds ?? bet.odds;

  return (
    <div className="rounded-2xl border border-slate-800/70 bg-[#0b1220] p-6 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.04)]">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-xl font-semibold">{bet.player.name}</h3>
          <p className="mt-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
            {isExpress ? `Express ×${display.selectionCount}` : "Single"}
          </p>
        </div>

        <div className="text-right">
          <p className="text-2xl font-bold">{bet.stake}</p>
          <p className="text-slate-400">
            {isExpress ? "Total odds" : "Odds"} {effectiveOdds ?? "—"}
          </p>
        </div>
      </div>

      {/* Every selection is always fully rendered here, never collapsed —
          the operator must see the complete bet before Confirm/Reject is
          even reachable, at any leg count. */}
      <div className="mt-4">
        <SelectionList selections={display.selections} mode="full" showStatus showLegLabels={isExpress} />
      </div>

      {error && (
        <p className="mt-4 rounded-lg bg-red-950 px-3 py-2 text-sm text-red-400">{error}</p>
      )}

      <div className="mt-5 flex gap-3">
        <button
          type="button"
          onClick={() => handleAction("confirm")}
          disabled={pendingAction !== null}
          aria-label={`Confirm bet for ${bet.player.name}`}
          className="min-h-11 rounded-xl bg-green-500 px-5 py-2 font-semibold text-black transition-colors hover:bg-green-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-green-400 disabled:opacity-50 disabled:hover:bg-green-500"
        >
          {pendingAction === "confirm" ? "Confirming..." : "Confirm"}
        </button>

        <button
          type="button"
          onClick={() => handleAction("reject")}
          disabled={pendingAction !== null}
          aria-label={`Reject bet for ${bet.player.name}`}
          className="min-h-11 rounded-xl bg-red-500 px-5 py-2 font-semibold text-white transition-colors hover:bg-red-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-400 disabled:opacity-50 disabled:hover:bg-red-500"
        >
          {pendingAction === "reject" ? "Rejecting..." : "Reject"}
        </button>
      </div>
    </div>
  );
}
