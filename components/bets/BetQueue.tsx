"use client";

import { useEffect, useState } from "react";
import BetQueueItem, { type PendingBet } from "./BetQueueItem";

export default function BetQueue() {
  const [bets, setBets] = useState<PendingBet[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function loadPendingBets() {
      setError(null);

      try {
        const response = await fetch("/api/dashboard/bets/pending");

        if (!response.ok) {
          throw new Error(`Request failed with status ${response.status}`);
        }

        const data = await response.json();

        if (!cancelled) {
          setBets(data.bets ?? []);
        }
      } catch {
        if (!cancelled) {
          setError("Не удалось загрузить заявки. Попробуйте обновить страницу.");
        }
      }
    }

    loadPendingBets();

    return () => {
      cancelled = true;
    };
  }, []);

  function handleResolved(betId: string) {
    setBets((current) => (current ? current.filter((bet) => bet.id !== betId) : current));
  }

  return (
    <section className="mt-10">
      <h2 className="mb-6 text-2xl font-semibold">Pending Bets</h2>

      {bets === null && !error && <p className="text-slate-400">Loading...</p>}

      {error && (
        <p className="rounded-lg bg-red-950 px-4 py-3 text-sm text-red-400">{error}</p>
      )}

      {bets !== null && bets.length === 0 && !error && (
        <p className="text-slate-400">No pending bets.</p>
      )}

      {bets !== null && bets.length > 0 && (
        <div className="space-y-4">
          {bets.map((bet) => (
            <BetQueueItem key={bet.id} bet={bet} onResolved={handleResolved} />
          ))}
        </div>
      )}
    </section>
  );
}
