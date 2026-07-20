"use client";

import { useEffect, useState } from "react";
import PlayerCard, { type PlayerBet } from "./PlayerCard";
import { DASHBOARD_REFRESH_EVENT } from "@/lib/dashboard/refreshEvent";

interface Player {
  id: string;
  name: string;
  telegramId: string | null;
  phoneNumber: string | null;
  creditLimit: string;
  currentCredit: string;
  available: string;
  exposure: string;
  activeBetsCount: number;
  nextSettlementDate: string;
  activeBets: PlayerBet[];
  history: PlayerBet[];
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

    // Stage 6.1: Confirm/Reject on a pending bet moves it into this
    // player's Active Bets or History and changes their Exposure/Available
    // — refresh immediately instead of only on next page load.
    window.addEventListener(DASHBOARD_REFRESH_EVENT, loadPlayers);

    return () => {
      cancelled = true;
      window.removeEventListener(DASHBOARD_REFRESH_EVENT, loadPlayers);
    };
  }, []);

  return (
    <section className="mt-10">
      <h2 className="mb-6 text-center text-2xl font-semibold sm:text-left">Players</h2>

      {players === null && !error && <p className="text-slate-400">Loading...</p>}

      {error && (
        <p className="rounded-lg bg-red-950 px-4 py-3 text-sm text-red-400">{error}</p>
      )}

      {players !== null && players.length === 0 && !error && (
        <p className="text-slate-400">No players yet.</p>
      )}

      {players !== null && players.length > 0 && (
        <div className="space-y-4">
          {players.map((player) => (
            <PlayerCard
              key={player.id}
              name={player.name}
              telegramId={player.telegramId}
              phoneNumber={player.phoneNumber}
              creditLimit={player.creditLimit}
              available={player.available}
              exposure={player.exposure}
              currentCredit={player.currentCredit}
              activeBetsCount={player.activeBetsCount}
              nextSettlementDate={player.nextSettlementDate}
              activeBets={player.activeBets}
              history={player.history}
            />
          ))}
        </div>
      )}
    </section>
  );
}
