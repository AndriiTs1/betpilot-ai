"use client";

import { useEffect, useState } from "react";
import ManualReviewItem from "./ManualReviewItem";
import EmptyState from "@/components/dashboard/EmptyState";
import { dispatchDashboardRefresh } from "@/lib/dashboard/refreshEvent";
import {
  determineManualReviewViewState,
  manualRetryResolvesTheReview,
  mapNeedsReviewBetForDisplay,
  type NeedsReviewBetApi,
} from "./manualReviewDisplay";

// Stage 4.3.5/4.3.6 — same fetch/loading/empty/error shape as
// components/bets/BetQueue.tsx (poll every 10s, cancel-on-unmount guard,
// Russian copy only for the transient fetch-failure message — matching
// that file's own exact established convention; every structural/label
// string stays English, matching StatusBadge/EmptyState/StatCard
// throughout this Dashboard).
//
// Stage 4.3.6 adds exactly one write path: Retry Automatically, entirely
// inside ManualReviewItem.tsx. This file's own job is only deciding what
// happens to the LIST after a retry response — remove the item (settled)
// or trigger a fresh fetch (every other outcome), via the same `refreshTick`
// dependency BetQueue.tsx's own poll interval already uses the effect
// pattern for — never a second, parallel data-fetching mechanism.

const POLL_INTERVAL_MS = 10000;

export default function ManualReviewQueue() {
  const [bets, setBets] = useState<NeedsReviewBetApi[] | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isInitialLoad, setIsInitialLoad] = useState(true);
  const [refreshTick, setRefreshTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const isInitial = refreshTick === 0;

    async function loadNeedsReview() {
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

    loadNeedsReview();
    const intervalId = setInterval(loadNeedsReview, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
  }, [refreshTick]);

  function handleItemRetried(betId: string, status: string) {
    if (manualRetryResolvesTheReview(status)) {
      // Settled — remove locally instead of waiting for the next poll, and
      // let the rest of the Dashboard (Exposure/Available/Player cards)
      // refresh immediately, same convention BetQueueItem.tsx's own
      // confirm/reject action already established.
      setBets((current) => (current ? current.filter((bet) => bet.id !== betId) : current));
      setTotal((current) => (current !== null ? Math.max(0, current - 1) : current));
      dispatchDashboardRefresh();
      return;
    }

    // WAITING / TRANSIENT_FAILURE / PERMANENT_REVIEW / CONFLICT /
    // PROVIDER_UNAVAILABLE — the bet is still in Manual Review; re-run the
    // effect above so this row shows the server's fresh
    // retryCount/reviewReason/last error rather than guessing at them
    // client-side.
    setRefreshTick((tick) => tick + 1);
  }

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
            <ManualReviewItem key={bet.id} bet={bet} onRetried={handleItemRetried} />
          ))}
        </div>
      )}
    </section>
  );
}
