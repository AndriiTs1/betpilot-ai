import StatusBadge from "@/components/bets/StatusBadge";
import BetSelectionsList from "./BetSelectionsList";
import { formatBetDate } from "./formatBetDate";
import { SportIcon, ExpressIcon } from "./sportIcons";
import type { RecentBet } from "./types";
import { mapBetForDisplay } from "@/lib/bets/mapBetForDisplay";
import { useLocale } from "./LocaleProvider";

interface ActiveBetsScreenProps {
  recentBets: RecentBet[];
}

// Classified purely from the existing Bet.status values already returned by
// /api/miniapp/me — PENDING/CONFIRMED means "not yet settled". No API,
// Prisma, or status-model changes involved. Exported so
// ActiveBetsScreen.test.ts can filter fixtures through the exact same set
// this component uses, instead of duplicating the literal.
export const ACTIVE_STATUSES = new Set(["PENDING", "CONFIRMED"]);

// UI-polish, this screen only — a calmer, capsule-shaped treatment for
// CONFIRMED specifically. Every other status still renders through the
// shared StatusBadge (components/bets/StatusBadge.tsx) completely
// unchanged: that component is also used by the operator dashboard's
// PlayerCard.tsx, HistoryScreen.tsx, and BetScreen.tsx's recent-activity
// list, so it isn't touched here — this is a local override, not a global
// restyle. Sized to land at the same ~20px row height StatusBadge's plain
// text already had (text-xs line-height 1rem + py-0.5's 0.25rem of
// padding), so the row doesn't grow.
function ActiveStatus({ status, confirmedLabel }: { status: string; confirmedLabel: string }) {
  if (status !== "CONFIRMED") {
    return <StatusBadge status={status} />;
  }

  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 text-xs font-medium text-blue-300">
      <span
        className="h-1.5 w-1.5 rounded-full bg-blue-400"
        aria-hidden="true"
      />
      {confirmedLabel}
    </span>
  );
}

export default function ActiveBetsScreen({ recentBets }: ActiveBetsScreenProps) {
  const { t } = useLocale();
  const activeBets = recentBets.filter((bet) => ACTIVE_STATUSES.has(bet.status));

  return (
    <div>
      <h2 className="text-center text-xl font-semibold">{t("active.title")}</h2>

      {activeBets.length === 0 ? (
        <p className="mt-3 text-center text-sm text-slate-400">
          {t("active.emptyState")}
        </p>
      ) : (
        // space-y-3 -> space-y-3.5: +2px between cards, the low end of the
        // requested 2-4px range, deliberately conservative so the list
        // doesn't read as sparse.
        <div className="mt-4 space-y-3.5">
          {activeBets.map((bet) => {
            const isExpress = Boolean(bet.selections && bet.selections.length > 1);
            const oddsValue = (isExpress ? bet.totalOdds : bet.odds) ?? "—";
            // Stage 12.2 — displayTitle/displaySubtitle replace direct
            // bet.event/bet.outcome reads, which are null for a real
            // EXPRESS bet (or a legacy zero-selection row) — see
            // lib/bets/mapBetForDisplay.ts.
            const display = mapBetForDisplay(bet);

            return (
              // Fixed two-column grid (sport image | content), not flex —
              // the left column's width never varies by card, and (with
              // grid's default align-items: stretch) it always spans the
              // card's full height regardless of how tall the right side's
              // content makes it. min-h locks every card to the same
              // baseline height so odds/stake/Confirmed/date land on
              // identical y-positions across the whole list.
              <div
                key={bet.id}
                className="rounded-2xl border border-white/[0.07] bg-white/[0.025] px-3.5 py-3.5"
              >
                <div className="flex items-start gap-3">
                  <div
                    className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-white/[0.06]"
                    style={{ background: "rgba(59,130,246,0.08)" }}
                  >
                    {isExpress ? (
                      <ExpressIcon size={28} className="text-slate-300" />
                    ) : (
                      <SportIcon sport={bet.sport} size={28} className="text-slate-300" />
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

                    <div className="mt-2 grid grid-cols-[minmax(0,1fr)_52px_44px] items-center gap-2 text-sm">
                      <span className="min-w-0 truncate text-slate-400">
                        {isExpress
                          ? t("active.selectionsCount").replace(
                              "{count}",
                              String(bet.selections?.length ?? 0),
                            )
                          : display.displaySubtitle}
                      </span>
                      <span className="text-center font-semibold tabular-nums text-blue-300">
                        {oddsValue}
                      </span>
                      <span className="text-right font-medium tabular-nums text-slate-200">
                        {bet.stake}
                      </span>
                    </div>
                  </div>
                </div>

                {isExpress && (
                  <div className="mt-3 border-t border-white/[0.05] pt-2.5">
                    <BetSelectionsList selections={bet.selections} />
                  </div>
                )}

                <div className="mt-3 flex items-center justify-between border-t border-white/[0.05] pt-2.5">
                  <ActiveStatus status={bet.status} confirmedLabel={t("active.confirmedBadge")} />
                  <span className="text-xs tabular-nums text-slate-500">
                    {formatBetDate(bet.createdAt)}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
