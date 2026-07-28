"use client";

import { useEffect, useState } from "react";
import StatCard from "./StatCard";
import { DASHBOARD_REFRESH_EVENT } from "@/lib/dashboard/refreshEvent";
import { formatDisplayNumber, formatSignedDisplayNumber } from "@/lib/format/number";

export default function DashboardOverview() {
  const [activePlayers, setActivePlayers] = useState<number | null>(null);
  const [totalAvailable, setTotalAvailable] = useState<string | null>(null);
  const [pendingBetsCount, setPendingBetsCount] = useState<number | null>(null);
  const [pendingBetsSum, setPendingBetsSum] = useState<string | null>(null);
  const [confirmedCount, setConfirmedCount] = useState<number | null>(null);
  const [confirmedSum, setConfirmedSum] = useState<string | null>(null);
  const [periodPnl, setPeriodPnl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function loadOverview() {
      setError(null);

      try {
        const response = await fetch("/api/dashboard/overview");

        if (!response.ok) {
          throw new Error(`Request failed with status ${response.status}`);
        }

        const data = await response.json();

        if (!cancelled) {
          setActivePlayers(data.activePlayers);
          setTotalAvailable(data.totalAvailable);
          setPendingBetsCount(data.pendingBetsCount);
          setPendingBetsSum(data.pendingBetsSum);
          setConfirmedCount(data.confirmedCount);
          setConfirmedSum(data.confirmedSum);
          setPeriodPnl(data.periodPnl);
        }
      } catch {
        if (!cancelled) {
          setError("Failed to load");
        }
      }
    }

    loadOverview();

    // Stage 6.1: Confirm/Reject on a pending bet changes Pending Bets,
    // Exposure, and Available all at once — BetQueueItem dispatches this
    // event on a successful action so this KPI row refreshes immediately
    // instead of only on next page load. See lib/dashboard/refreshEvent.ts.
    window.addEventListener(DASHBOARD_REFRESH_EVENT, loadOverview);

    // Stage 8 — the event above only fires for an action taken in this same
    // browser tab (e.g. this operator's own Confirm/Reject click). A new bet
    // placed via Telegram, or a Confirm/Reject done from another tab/device,
    // never dispatches it, so these KPIs went stale until a manual refresh.
    // Same 10s interval as BetQueue's own polling (components/bets/BetQueue.tsx).
    const intervalId = setInterval(loadOverview, 10000);

    return () => {
      cancelled = true;
      clearInterval(intervalId);
      window.removeEventListener(DASHBOARD_REFRESH_EVENT, loadOverview);
    };
  }, []);

  const playersValue = error ? "—" : activePlayers === null ? "…" : String(activePlayers);
  const playersDescription = error ? "Failed to load" : "Registered players";

  const availableValue = error ? "—" : totalAvailable === null ? "…" : totalAvailable;
  const availableDescription = error ? "Failed to load" : "Remaining credit across players";

  const exposureValue = error ? "—" : confirmedSum === null ? "…" : confirmedSum;
  const exposureDescription = error
    ? "Failed to load"
    : confirmedCount === null
      ? "…"
      : `${confirmedCount} confirmed bet${confirmedCount === 1 ? "" : "s"}`;

  const pendingBetsValue = error ? "—" : pendingBetsCount === null ? "…" : String(pendingBetsCount);
  const pendingBetsDescription = error
    ? "Failed to load"
    : pendingBetsSum === null
      ? "…"
      : `Total stake ${formatDisplayNumber(pendingBetsSum)}`;

  // Pre-signed and pre-grouped ("+1 250" / "-75" / "0") before StatCard's
  // own formatDisplayNumber() runs on it — safe: formatDisplayNumber treats
  // an already-space-grouped integer part as non-numeric and returns it
  // unchanged, so this never double-formats. Kept as one shared formatter
  // (formatSignedDisplayNumber, in lib/format/number.ts) rather than a
  // second grouping implementation.
  const periodPnlValue = error ? "—" : periodPnl === null ? "…" : formatSignedDisplayNumber(periodPnl);
  const periodPnlDescription = error ? "Failed to load" : "Settled bets this settlement period";
  const periodPnlToneClass =
    error || periodPnl === null
      ? "text-white"
      : Number(periodPnl) > 0
        ? "text-green-400"
        : Number(periodPnl) < 0
          ? "text-red-400"
          : "text-white";

  return (
    <section className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
      <StatCard title="Players" value={playersValue} description={playersDescription} icon="users" accent="blue" />

      <StatCard
        title="Available Credit"
        value={availableValue}
        description={availableDescription}
        icon="credit-card"
        accent="blue"
      />

      <StatCard
        title="Exposure"
        value={exposureValue}
        description={exposureDescription}
        icon="chart-bar"
        accent="blue"
      />

      <StatCard
        title="Pending Bets"
        value={pendingBetsValue}
        description={pendingBetsDescription}
        icon="hourglass"
        accent="green"
        emphasize={pendingBetsCount !== null && pendingBetsCount > 0}
      />

      <StatCard
        title="Current Period P/L"
        value={periodPnlValue}
        description={periodPnlDescription}
        icon="trending-up"
        accent="blue"
        valueClassName={periodPnlToneClass}
      />
    </section>
  );
}
