"use client";

import { useEffect, useState } from "react";
import StatCard from "./StatCard";

export default function DashboardOverview() {
  const [activePlayers, setActivePlayers] = useState<number | null>(null);
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

  return (
    <section className="grid gap-6 md:grid-cols-2 xl:grid-cols-4">
      <StatCard
        title="Active Players"
        value={activePlayersValue}
        description={activePlayersDescription}
        icon="users"
      />

      <StatCard
        title="Balance"
        value="850 USDC"
        description="Current bankroll"
      />

      <StatCard
        title="Pending Bets"
        value="12"
        description="Waiting confirmation"
      />

      <StatCard
        title="Profit / Loss"
        value="+350 USDC"
        description="This month"
      />
    </section>
  );
}
