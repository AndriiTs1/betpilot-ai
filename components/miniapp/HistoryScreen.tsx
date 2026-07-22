import StatusBadge from "@/components/bets/StatusBadge";
import BetSelectionsList from "./BetSelectionsList";
import { SportIcon } from "./sportIcons";
import { formatCompactDate } from "./formatCompactDate";
import type { RecentBet } from "./types";

interface HistoryScreenProps {
  recentBets: RecentBet[];
}

// Complement of ActiveBetsScreen's ACTIVE_STATUSES — every Bet.status value
// is either "not yet settled" (active) or one of these final states, so a
// bet can never appear in both screens at once. No API/Prisma changes.
const FINAL_STATUSES = new Set(["REJECTED", "SETTLED_WIN", "SETTLED_LOSS", "VOID"]);

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
              {/* items-start: icon anchors to the first line of the
                  title, not centered against the whole card. */}
              <div className="flex items-start gap-2">
                <span
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg"
                  style={{ background: "rgba(59,130,246,0.10)" }}
                >
                  <SportIcon sport={bet.sport} size={18} stroke={2} className="text-slate-400" />
                </span>

                <div className="min-w-0 flex-1">
                  <p className="break-words font-semibold">{bet.event}</p>
                  <p className="text-sm text-slate-400">{bet.outcome}</p>

                  <BetSelectionsList selections={bet.selections} />

                  <div className="mt-2 flex items-center justify-between gap-1.5 text-sm">
                    <span className="min-w-0 truncate">
                      {bet.stake} @{" "}
                      {(bet.selections && bet.selections.length > 1 ? bet.totalOdds : bet.odds) ?? "—"}
                    </span>
                    <StatusBadge status={bet.status} />
                    {/* Compact date (Today/Yesterday/"D Mon"/"D Mon YYYY")
                        instead of the previous full Russian long form
                        ("21 июля 2026 г.") — same helper ActiveBetsScreen.tsx
                        already uses, for a consistent date language across
                        both card lists. Never wraps to a second line: it's
                        short enough at 320px that shrink-0 + the stake
                        span's own truncate is enough on its own now. */}
                    <span className="shrink-0 text-slate-400">{formatCompactDate(bet.createdAt)}</span>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
