"use client";

import { useEffect, useState } from "react";
import ManualReviewItem from "./ManualReviewItem";
import EmptyState from "@/components/dashboard/EmptyState";
import { determineManualReviewViewState, mapNeedsReviewBetForDisplay, type NeedsReviewBetApi } from "./manualReviewDisplay";

// Stage 4.3.5 — read-only. Same fetch/loading/empty/error shape as
// components/bets/BetQueue.tsx (poll every 10s, cancel-on-unmount guard,
// Russian copy only for the transient fetch-failure message — matching
// that file's own exact established convention; every structural/label
// string stays English, matching StatusBadge/EmptyState/StatCard
// throughout this Dashboard). No write action anywhere in this file — see
// ManualReviewItem.tsx's own header for why no button (not even a disabled
// one) exists yet.

const POLL_INTERVAL_MS = 10000;

export default function ManualReviewQueue() {
  const [bets, setBets] = useState<NeedsReviewBetApi[] | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isInitialLoad, setIsInitialLoad] = useState(true);

  useEffect(() => {
    let cancelled = false;

    async function loadNeedsReview(isInitial: boolean) {
      try {
        const response = await fetch("/api/dashboard/bets/needs-review");

        if (!response.ok) {
          throw new Error(`Request failed with status ${response.status}`);
        }

        const data = await response.json();

        if (!cancelled) {
          setBets(data.bets ?? []);
          setTotal(data.pagination?.total ?? null);
          if (isInitial) setError(null);
        }
      } catch (err) {
        if (cancelled) return;

        if (isInitial) {
          setError("Не удалось загрузить список ставок на проверку. Попробуйте обновить страницу.");
        } else {
          console.error("ManualReviewQueue: background refresh failed", err);
        }
      } finally {
        if (!cancelled && isInitial) {
          setIsInitialLoad(false);
        }
      }
    }

    loadNeedsReview(true);
    const intervalId = setInterval(() => loadNeedsReview(false), POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
  }, []);

  const viewState = determineManualReviewViewState({ bets, error, isInitialLoad });
  const display = bets !== null ? bets.map(mapNeedsReviewBetForDisplay) : [];

  return (
    <section className="mt-10">
      <h2 className="mb-6 text-center text-2xl font-semibold sm:text-left">
        Manual Review{total !== null && total > 0 ? ` (${total})` : ""}
      </h2>

      {viewState === "loading" && <p className="text-slate-400">Loading...</p>}

      {viewState === "error" && (
        <p className="rounded-lg bg-red-950 px-4 py-3 text-sm text-red-400">{error}</p>
      )}

      {viewState === "empty" && (
        <EmptyState
          icon="checkbox"
          title="No bets need manual review."
          description="Bets that fail automatic settlement will appear here."
        />
      )}

      {viewState === "list" && (
        <div className="space-y-4">
          {display.map((bet) => (
            <ManualReviewItem key={bet.id} bet={bet} />
          ))}
        </div>
      )}
    </section>
  );
}
