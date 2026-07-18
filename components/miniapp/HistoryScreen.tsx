import StatusBadge from "@/components/bets/StatusBadge";
import BetSelectionsList from "./BetSelectionsList";
import type { RecentBet } from "./types";

interface HistoryScreenProps {
  recentBets: RecentBet[];
}

// Complement of ActiveBetsScreen's ACTIVE_STATUSES — every Bet.status value
// is either "not yet settled" (active) or one of these final states, so a
// bet can never appear in both screens at once. No API/Prisma changes.
const FINAL_STATUSES = new Set(["REJECTED", "SETTLED_WIN", "SETTLED_LOSS", "VOID"]);

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("ru-RU", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

export default function HistoryScreen({ recentBets }: HistoryScreenProps) {
  const finishedBets = recentBets.filter((bet) => FINAL_STATUSES.has(bet.status));

  return (
    <div>
      <h2 className="text-center text-xl font-semibold">История</h2>

      {finishedBets.length === 0 ? (
        <p className="mt-3 text-center text-sm text-slate-400">
          Здесь будут отображаться завершённые ставки.
        </p>
      ) : (
        <div className="mt-4 space-y-3">
          {finishedBets.map((bet) => (
            <div key={bet.id} className="rounded-xl border border-slate-800 p-3">
              <p className="font-semibold">{bet.event}</p>
              <p className="text-sm text-slate-400">{bet.outcome}</p>

              <BetSelectionsList selections={bet.selections} />

              <div className="mt-2 flex items-center justify-between text-sm">
                <span>
                  {bet.stake} @{" "}
                  {(bet.selections && bet.selections.length > 1 ? bet.totalOdds : bet.odds) ?? "—"}
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
