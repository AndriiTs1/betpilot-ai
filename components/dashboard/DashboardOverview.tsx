"use client";

import { useEffect, useState } from "react";
import StatCard from "./StatCard";
import PlayStatusCard from "./PlayStatusCard";

export default function DashboardOverview() {
  const [activePlayers, setActivePlayers] = useState<number | null>(null);
  const [totalRemainingCredit, setTotalRemainingCredit] = useState<string | null>(null);
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
          setTotalRemainingCredit(data.totalRemainingCredit);
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

    return () => {
      cancelled = true;
    };
  }, []);

  const activePlayersValue = error ? "—" : activePlayers === null ? "…" : String(activePlayers);
  const activePlayersDescription = error ? "Failed to load" : "Placed at least one bet";

  const creditValue =
    error ? "—" : totalRemainingCredit === null ? "…" : totalRemainingCredit;
  const creditDescription = error ? "Failed to load" : "Total remaining";

  const pendingBetsValue =
    error ? "—" : pendingBetsCount === null ? "…" : String(pendingBetsCount);
  const pendingBetsDescription = error
    ? "Failed to load"
    : pendingBetsSum === null
      ? "…"
      : `Totaling ${pendingBetsSum}`;

  const playedCountValue = error ? "—" : confirmedCount === null ? "…" : String(confirmedCount);
  const playedSumValue = error ? "—" : confirmedSum === null ? "…" : confirmedSum;
  const notPlayedCountValue = error ? "—" : pendingBetsCount === null ? "…" : String(pendingBetsCount);
  const notPlayedSumValue = error ? "—" : pendingBetsSum === null ? "…" : pendingBetsSum;

  return (
    <section className="grid gap-6 md:grid-cols-2 xl:grid-cols-4">
      <StatCard
        title="Active Players"
        value={activePlayersValue}
        description={activePlayersDescription}
        icon="users"
      />

      <StatCard
        title="Available Credit"
        value={creditValue}
        description={creditDescription}
        icon="credit-card"
      />

      <StatCard
        title="Pending Bets"
        value={pendingBetsValue}
        description={pendingBetsDescription}
      />

      <PlayStatusCard
        playedCount={playedCountValue}
        playedSum={playedSumValue}
        notPlayedCount={notPlayedCountValue}
        notPlayedSum={notPlayedSumValue}
      />
    </section>
  );
}
