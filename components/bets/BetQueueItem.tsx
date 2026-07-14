"use client";

import { useState } from "react";

export interface PendingBet {
  id: string;
  playerId: string;
  player: { id: string; name: string };
  sport: string;
  event: string;
  outcome: string;
  odds: string | null;
  stake: string;
  status: string;
  rawMessage: string | null;
  createdAt: string;
  updatedAt: string;
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

  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900 p-6">
      <div className="flex justify-between">
        <div>
          <h3 className="text-xl font-semibold">{bet.player.name}</h3>

          <p className="mt-2 text-slate-400">{bet.event}</p>

          <p className="mt-1 text-slate-400">{bet.outcome}</p>
        </div>

        <div className="text-right">
          <p className="text-2xl font-bold">{bet.stake}</p>

          <p className="text-slate-400">Odds {bet.odds ?? "—"}</p>
        </div>
      </div>

      {error && (
        <p className="mt-4 rounded-lg bg-red-950 px-3 py-2 text-sm text-red-400">{error}</p>
      )}

      <div className="mt-5 flex gap-3">
        <button
          type="button"
          onClick={() => handleAction("confirm")}
          disabled={pendingAction !== null}
          className="rounded-xl bg-green-500 px-5 py-2 font-semibold text-black disabled:opacity-50"
        >
          {pendingAction === "confirm" ? "Confirming..." : "Confirm"}
        </button>

        <button
          type="button"
          onClick={() => handleAction("reject")}
          disabled={pendingAction !== null}
          className="rounded-xl bg-red-500 px-5 py-2 font-semibold text-white disabled:opacity-50"
        >
          {pendingAction === "reject" ? "Rejecting..." : "Reject"}
        </button>
      </div>
    </div>
  );
}
