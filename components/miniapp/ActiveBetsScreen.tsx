import { Check } from "lucide-react";
import StatusBadge from "@/components/bets/StatusBadge";
import BetSelectionsList from "./BetSelectionsList";
import { formatBetDate } from "./formatBetDate";
import { SportIcon } from "./sportIcons";
import type { RecentBet } from "./types";

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
function ActiveStatus({ status }: { status: string }) {
  if (status !== "CONFIRMED") {
    return <StatusBadge status={status} />;
  }

  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-xs font-medium"
      style={{ background: "rgba(96,165,250,0.14)", color: "#93c5fd" }}
    >
      <Check size={11} strokeWidth={2.5} aria-hidden="true" />
      Confirmed
    </span>
  );
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
        // space-y-3 -> space-y-3.5: +2px between cards, the low end of the
        // requested 2-4px range, deliberately conservative so the list
        // doesn't read as sparse.
        <div className="mt-4 space-y-3.5">
          {activeBets.map((bet) => {
            const isExpress = Boolean(bet.selections && bet.selections.length > 1);
            const oddsValue = (isExpress ? bet.totalOdds : bet.odds) ?? "—";

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
                className="grid min-h-[124px] grid-cols-[76px_minmax(0,1fr)] overflow-hidden rounded-xl border border-slate-800"
              >
                <div
                  className="flex items-center justify-center border-r border-white/5"
                  style={{ background: "rgba(59,130,246,0.14)" }}
                >
                  <SportIcon sport={bet.sport} size={56} className="text-slate-200" />
                </div>

                {/* content-between (align-content: space-between) pins row 1
                    to the top and row 3 to the bottom, with row 2 centered
                    between them — a CSS Grid stand-in for the old flex
                    justify-between, which let element position drift with
                    content length instead of guaranteeing it. */}
                <div className="grid content-between gap-y-1.5 px-3 py-3">
                  {/* Row 1: event title — one line, ellipsis, never pushes
                      the rows below. */}
                  <p className="truncate text-[15px] font-semibold text-white">{bet.event}</p>

                  {/* Row 2: outcome / odds / stake, each its own fixed
                      column so every card's odds and stake land at the same
                      x-position no matter how long the outcome text is. */}
                  <div className="grid grid-cols-[minmax(0,1fr)_56px_48px] items-center gap-2 text-sm">
                    <span className="min-w-0 truncate text-slate-500">{bet.outcome}</span>
                    <span className="text-center font-medium tabular-nums text-blue-300">{oddsValue}</span>
                    <span className="text-right tabular-nums text-slate-200">{bet.stake}</span>
                  </div>

                  <BetSelectionsList selections={bet.selections} />

                  {/* Row 3: Confirmed centered across the whole content
                      width (1fr/auto/1fr — not just "between its
                      neighbors"), date pinned to the right edge. */}
                  <div className="grid grid-cols-[1fr_auto_1fr] items-center text-sm">
                    <span />
                    <ActiveStatus status={bet.status} />
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
