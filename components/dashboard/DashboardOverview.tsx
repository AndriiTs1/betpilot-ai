"use client";

import { useEffect, useState } from "react";
import StatCard from "./StatCard";
import { DASHBOARD_REFRESH_EVENT } from "@/lib/dashboard/refreshEvent";

export default function DashboardOverview() {
  const [activePlayers, setActivePlayers] = useState<number | null>(null);
  const [totalAvailable, setTotalAvailable] = useState<string | null>(null);
  const [pendingBetsCount, setPendingBetsCount] = useState<number | null>(null);
  const [pendingBetsSum, setPendingBetsSum] = useState<string | null>(null);
  const [confirmedCount, setConfirmedCount] = useState<number | null>(null);
  const [confirmedSum, setConfirmedSum] = useState<string | null>(null);
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
  const availableDescription = error ? "Failed to load" : "Remaining, minus exposure";

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
      : `Totaling ${pendingBetsSum}`;

  return (
    <section className="grid gap-6 md:grid-cols-2 xl:grid-cols-4">
      <StatCard title="Players" value={playersValue} description={playersDescription} icon="users" accent="blue" />

      <StatCard
        title="Available"
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
    </section>
  );
}
