"use client";

import { useEffect, useState } from "react";
import PlayerCard from "./PlayerCard";

interface RecentBet {
  id: string;
  sport: string;
  event: string;
  outcome: string;
  stake: string;
  odds: string | null;
  status: string;
  createdAt: string;
}

interface Player {
  id: string;
  name: string;
  whatsappId: string;
  creditLimit: string;
  currentCredit: string;
  exposure: string;
  totalBets: number;
  nextSettlementDate: string;
  recentBets: RecentBet[];
}

export default function PlayerList() {
  const [players, setPlayers] = useState<Player[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function loadPlayers() {
      setError(null);

      try {
        const response = await fetch("/api/dashboard/players");

        if (!response.ok) {
          throw new Error(`Request failed with status ${response.status}`);
        }

        const data = await response.json();

        if (!cancelled) {
          setPlayers(data.players ?? []);
        }
      } catch {
        if (!cancelled) {
          setError("Не удалось загрузить игроков. Попробуйте обновить страницу.");
        }
      }
    }

    loadPlayers();

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section className="mt-10">
      <h2 className="mb-6 text-2xl font-semibold">Players</h2>

      {players === null && !error && <p className="text-slate-400">Loading...</p>}

      {error && (
        <p className="rounded-lg bg-red-950 px-4 py-3 text-sm text-red-400">{error}</p>
      )}

      {players !== null && players.length === 0 && !error && (
        <p className="text-slate-400">No players yet.</p>
      )}

      {players !== null && players.length > 0 && (
        <div className="space-y-6">
          {players.map((player) => (
            <PlayerCard
              key={player.id}
              name={player.name}
              whatsappId={player.whatsappId}
              creditLimit={player.creditLimit}
              currentCredit={player.currentCredit}
              exposure={player.exposure}
              totalBets={player.totalBets}
              nextSettlementDate={player.nextSettlementDate}
              recentBets={player.recentBets}
            />
          ))}
        </div>
      )}
    </section>
  );
}
