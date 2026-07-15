"use client";

import { useEffect, useState } from "react";
import StatusBadge from "./StatusBadge";

interface HistoryBet {
  id: string;
  player: { id: string; name: string };
  sport: string;
  event: string;
  outcome: string;
  odds: string | null;
  stake: string;
  status: string;
  updatedAt: string;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "Europe/Zurich",
  });
}

export default function BetHistory() {
  const [bets, setBets] = useState<HistoryBet[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function loadHistory() {
      try {
        const response = await fetch("/api/dashboard/bets/history");

        if (!response.ok) {
          throw new Error(`Request failed with status ${response.status}`);
        }

        const data = await response.json();

        if (!cancelled) {
          setBets(data.bets ?? []);
        }
      } catch {
        if (!cancelled) {
          setError("Не удалось загрузить историю ставок. Попробуйте обновить страницу.");
        }
      }
    }

    loadHistory();

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section className="mt-10">
      <h2 className="mb-6 text-2xl font-semibold">Bet History</h2>

      {bets === null && !error && <p className="text-slate-400">Loading...</p>}

      {error && (
        <p className="rounded-lg bg-red-950 px-4 py-3 text-sm text-red-400">{error}</p>
      )}

      {bets !== null && bets.length === 0 && !error && (
        <p className="text-slate-400">No resolved bets yet.</p>
      )}

      {bets !== null && bets.length > 0 && (
        <div className="space-y-3">
          {bets.map((bet) => (
            <div
              key={bet.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-800 bg-slate-900 p-5"
            >
              <div>
                <p className="font-semibold text-white">
                  {bet.player.name} — {bet.event}
                </p>
                <p className="mt-1 text-sm text-slate-400">{bet.outcome}</p>
              </div>

              <div className="flex items-center gap-6 text-sm">
                <span className="text-slate-200">
                  {bet.stake} @ {bet.odds ?? "—"}
                </span>
                <StatusBadge status={bet.status} />
                <span className="text-slate-400">{formatDate(bet.updatedAt)}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
