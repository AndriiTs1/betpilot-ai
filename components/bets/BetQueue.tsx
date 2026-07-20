"use client";

import { useEffect, useState } from "react";
import BetQueueItem, { type PendingBet } from "./BetQueueItem";
import EmptyState from "@/components/dashboard/EmptyState";

export default function BetQueue() {
  const [bets, setBets] = useState<PendingBet[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isInitialLoad, setIsInitialLoad] = useState(true);

  useEffect(() => {
    let cancelled = false;

    async function loadPendingBets(isInitial: boolean) {
      try {
        const response = await fetch("/api/dashboard/bets/pending");

        if (!response.ok) {
          throw new Error(`Request failed with status ${response.status}`);
        }

        const data = await response.json();

        if (!cancelled) {
          setBets(data.bets ?? []);
          if (isInitial) setError(null);
        }
      } catch (err) {
        if (cancelled) return;

        if (isInitial) {
          setError("Не удалось загрузить заявки. Попробуйте обновить страницу.");
        } else {
          console.error("BetQueue: background refresh failed", err);
        }
      } finally {
        if (!cancelled && isInitial) {
          setIsInitialLoad(false);
        }
      }
    }

    loadPendingBets(true);
    const intervalId = setInterval(() => loadPendingBets(false), 10000);

    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
  }, []);

  function handleResolved(betId: string) {
    setBets((current) => (current ? current.filter((bet) => bet.id !== betId) : current));
  }

  return (
    <section className="mt-10">
      <h2 className="mb-6 text-center text-2xl font-semibold sm:text-left">Pending Bets</h2>

      {isInitialLoad && !error && <p className="text-slate-400">Loading...</p>}

      {error && (
        <p className="rounded-lg bg-red-950 px-4 py-3 text-sm text-red-400">{error}</p>
      )}

      {bets !== null && bets.length === 0 && !error && (
        <EmptyState
          icon="inbox"
          title="No pending bets."
          description="New bets will appear here for confirmation."
        />
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
