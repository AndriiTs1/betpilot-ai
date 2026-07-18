import StatusBadge from "@/components/bets/StatusBadge";
import type { RecentBet } from "./types";

interface ActiveBetsScreenProps {
  recentBets: RecentBet[];
}

// Classified purely from the existing Bet.status values already returned by
// /api/miniapp/me — PENDING/CONFIRMED means "not yet settled". No API,
// Prisma, or status-model changes involved.
const ACTIVE_STATUSES = new Set(["PENDING", "CONFIRMED"]);

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("ru-RU", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

export default function ActiveBetsScreen({ recentBets }: ActiveBetsScreenProps) {
  const activeBets = recentBets.filter((bet) => ACTIVE_STATUSES.has(bet.status));

  return (
    <div>
      <h2 className="text-center text-xl font-semibold">Активные</h2>

      {activeBets.length === 0 ? (
        <p className="mt-3 text-center text-sm text-slate-400">
          Здесь будут отображаться ставки, которые ещё не рассчитаны.
        </p>
      ) : (
        <div className="mt-4 space-y-3">
          {activeBets.map((bet) => (
            <div key={bet.id} className="rounded-xl border border-slate-800 p-3">
              <p className="font-semibold">{bet.event}</p>
              <p className="text-sm text-slate-400">{bet.outcome}</p>
              <div className="mt-2 flex items-center justify-between text-sm">
                <span>
                  {bet.stake} @ {bet.odds ?? "—"}
                </span>
                <StatusBadge status={bet.status} />
                <span className="text-slate-400">{formatDate(bet.createdAt)}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
