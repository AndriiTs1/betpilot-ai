import { STATUS_BADGES } from "@/components/bets/StatusBadge";
import BetSelectionsList from "./BetSelectionsList";
import { SportIcon, ExpressIcon } from "./sportIcons";
import { formatBetDate } from "./formatBetDate";
import type { RecentBet } from "./types";
import { mapBetForDisplay } from "@/lib/bets/mapBetForDisplay";
import { useLocale } from "./LocaleProvider";

interface HistoryScreenProps {
  recentBets: RecentBet[];
}

// Complement of ActiveBetsScreen's ACTIVE_STATUSES — every Bet.status value
// is either "not yet settled" (active) or one of these final states, so a
// bet can never appear in both screens at once. No API/Prisma changes.
//
// H4-B4 — SETTLED_HALF_WIN/SETTLED_HALF_LOSS (H4-B1) are also terminal
// settlement outcomes and must land in History, never Active, never
// disappear from both. Before this fix, a HALF_* bet would have matched
// neither ACTIVE_STATUSES nor this set — invisible in the player's bet
// list entirely, not merely miscategorized.
//
// Exported so HistoryScreen.test.ts can filter fixtures through the exact
// same set this component uses — same convention as ActiveBetsScreen.tsx's
// own exported ACTIVE_STATUSES.
export const FINAL_STATUSES = new Set([
  "REJECTED",
  "SETTLED_WIN",
  "SETTLED_LOSS",
  "VOID",
  "SETTLED_HALF_WIN",
  "SETTLED_HALF_LOSS",
]);

const HISTORY_STATUS_KEYS = {
  REJECTED: "home.activityRejected",
  SETTLED_WIN: "home.activityWon",
  SETTLED_LOSS: "home.activityLost",
  VOID: "home.activityVoid",
  SETTLED_HALF_WIN: "home.activityHalfWon",
  SETTLED_HALF_LOSS: "home.activityHalfLost",
} as const;

export default function HistoryScreen({ recentBets }: HistoryScreenProps) {
  const { t } = useLocale();
  const finishedBets = recentBets.filter((bet) => FINAL_STATUSES.has(bet.status));

  return (
    <div>
      <h2 className="text-center text-xl font-semibold">{t("history.title")}</h2>

      {finishedBets.length === 0 ? (
        <p className="mt-3 text-center text-sm text-slate-400">
          {t("history.emptyState")}
        </p>
      ) : (
        <div className="mt-4 space-y-3.5">
          {finishedBets.map((bet) => {
            const display = mapBetForDisplay(bet);
            const isExpress = display.selectionCount > 1;
            const oddsValue = (isExpress ? bet.totalOdds : bet.odds) ?? "—";

            return (
              <div
                key={bet.id}
                className="overflow-hidden rounded-2xl border border-slate-800/90 bg-slate-950/45"
              >
                <div className="px-4 pb-3 pt-3.5">
                  {/* Primary bet row — compact icon instead of the old
                      full-height 76px media rail. The text column owns the
                      available width; figures remain fixed and aligned. */}
                  <div className="flex min-w-0 items-start gap-3">
                    <div
                      className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-white/5"
                      style={{ background: "rgba(59,130,246,0.10)" }}
                    >
                      {isExpress ? (
                        <ExpressIcon size={30} className="text-slate-200" />
                      ) : (
                        <SportIcon sport={bet.sport} size={30} className="text-slate-200" />
                      )}
                    </div>

                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[15px] font-semibold leading-5 text-white">
                        {display.displayTitle}
                      </p>

                      {(display.displayCompetition || display.displayEventTime) && (
                        <p className="mt-0.5 truncate text-xs text-slate-500">
                          {display.displayCompetition}
                          {display.displayCompetition && display.displayEventTime ? " · " : ""}
                          {display.displayEventTime}
                        </p>
                      )}

                      <div className="mt-2 grid grid-cols-[minmax(0,1fr)_56px_48px] items-center gap-2 text-sm">
                        <span className="min-w-0 truncate text-slate-400">
                          {isExpress
                            ? t("history.selectionsCount").replace(
                                "{count}",
                                String(display.selectionCount),
                              )
                            : display.displaySubtitle}
                        </span>
                        <span className="text-center font-semibold tabular-nums text-blue-300">
                          {oddsValue}
                        </span>
                        <span className="text-right tabular-nums text-slate-200">
                          {bet.stake}
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* EXPRESS legs are supporting detail. SINGLE has no
                      redundant nested selection card. */}
                  {isExpress && (
                    <div className="mt-3">
                      <BetSelectionsList selections={bet.selections} />
                    </div>
                  )}

                  {/* History-specific footer: the terminal result is the
                      important state signal; settlement date stays quiet
                      and aligned at the opposite edge. */}
                  <div className="mt-3 flex items-center justify-between border-t border-white/5 pt-2.5 text-sm">
                    {(() => {
                      const badge =
                        STATUS_BADGES[bet.status] ?? {
                          dot: "bg-slate-500",
                          text: "text-slate-400",
                        };

                      const statusKey =
                        HISTORY_STATUS_KEYS[
                          bet.status as keyof typeof HISTORY_STATUS_KEYS
                        ];

                      return (
                        <span className="inline-flex items-center gap-1.5 text-xs font-medium">
                          <span
                            className={`h-1.5 w-1.5 rounded-full ${badge.dot}`}
                            aria-hidden="true"
                          />
                          <span className={badge.text}>
                            {statusKey ? t(statusKey) : bet.status}
                          </span>
                        </span>
                      );
                    })()}
                    <span className="shrink-0 text-xs tabular-nums text-slate-500">
                      {formatBetDate(bet.createdAt)}
                    </span>
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
