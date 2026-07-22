import StatusBadge from "@/components/bets/StatusBadge";
import BetSelectionsList from "./BetSelectionsList";
import { SportIcon, ExpressIcon } from "./sportIcons";
import { formatBetDate } from "./formatBetDate";
import type { RecentBet } from "./types";
import { mapBetForDisplay } from "@/lib/bets/mapBetForDisplay";

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
        <div className="mt-4 space-y-3.5">
          {finishedBets.map((bet) => {
            const isExpress = Boolean(bet.selections && bet.selections.length > 1);
            const oddsValue = (isExpress ? bet.totalOdds : bet.odds) ?? "—";
            // Stage 12.2 — see ActiveBetsScreen.tsx's identical comment.
            const display = mapBetForDisplay(bet);

            return (
              // Same fixed two-column grid as ActiveBetsScreen.tsx (sport
              // image | content), same min-height, same left-column width,
              // same SportIcon size — one shared layout system so a card
              // looks identical between the two screens regardless of
              // event/outcome length or status label.
              <div
                key={bet.id}
                className="grid min-h-[124px] grid-cols-[76px_minmax(0,1fr)] overflow-hidden rounded-xl border border-slate-800"
              >
                <div
                  className="flex items-center justify-center border-r border-white/5"
                  style={{ background: "rgba(59,130,246,0.14)" }}
                >
                  {/* EXPRESS can span multiple sports — a single sport icon
                      would misrepresent it, so it gets its own dedicated
                      icon instead of e.g. always showing football. */}
                  {isExpress ? (
                    <ExpressIcon size={56} className="text-slate-200" />
                  ) : (
                    <SportIcon sport={bet.sport} size={56} className="text-slate-200" />
                  )}
                </div>

                {/* content-between pins row 1 to the top and row 3 to the
                    bottom, row 2 centered between them — same as
                    ActiveBetsScreen.tsx's right column. */}
                <div className="grid content-between gap-y-1.5 px-3 py-3">
                  {/* Row 1: event title — one line, ellipsis. */}
                  <p className="truncate text-[15px] font-semibold text-white">{display.displayTitle}</p>

                  {/* Row 2: outcome / odds / stake, same fixed columns as
                      Active Bets so both screens' figures line up. */}
                  <div className="grid grid-cols-[minmax(0,1fr)_56px_48px] items-center gap-2 text-sm">
                    <span className="min-w-0 truncate text-slate-500">{display.displaySubtitle}</span>
                    <span className="text-center font-medium tabular-nums text-blue-300">{oddsValue}</span>
                    <span className="text-right tabular-nums text-slate-200">{bet.stake}</span>
                  </div>

                  <BetSelectionsList selections={bet.selections} />

                  {/* Row 3: status centered across the whole content width,
                      date pinned to the right — StatusBadge unchanged, still
                      shows Won/Lost/Void/Rejected exactly as before, only
                      its position changed. */}
                  <div className="grid grid-cols-[1fr_auto_1fr] items-center text-sm">
                    <span />
                    <StatusBadge status={bet.status} />
                    <span className="justify-self-end text-slate-400">{formatBetDate(bet.createdAt)}</span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
