import { Check } from "lucide-react";
import StatusBadge from "@/components/bets/StatusBadge";
import BetSelectionsList from "./BetSelectionsList";
import { formatCompactDate } from "./formatCompactDate";
import type { RecentBet } from "./types";

interface ActiveBetsScreenProps {
  recentBets: RecentBet[];
}

// Classified purely from the existing Bet.status values already returned by
// /api/miniapp/me — PENDING/CONFIRMED means "not yet settled". No API,
// Prisma, or status-model changes involved.
const ACTIVE_STATUSES = new Set(["PENDING", "CONFIRMED"]);

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
      className="inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium"
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
          {activeBets.map((bet) => (
            <div key={bet.id} className="rounded-xl border border-slate-800 p-3">
              <p className="break-words font-semibold">{bet.event}</p>
              {/* text-slate-400 -> text-slate-500: one step further into
                  this app's existing muted-gray scale (already used this
                  way for de-emphasized labels elsewhere, e.g.
                  BetTicket.tsx's TicketMeta), so the outcome reads as
                  secondary to the event title above it without losing
                  legibility. */}
              <p className="text-sm text-slate-500">{bet.outcome}</p>

              <BetSelectionsList selections={bet.selections} />

              <div className="mt-2 flex items-center justify-between gap-2 text-sm">
                <span className="min-w-0 truncate">
                  {bet.stake} @{" "}
                  {(bet.selections && bet.selections.length > 1 ? bet.totalOdds : bet.odds) ?? "—"}
                </span>
                <ActiveStatus status={bet.status} />
                <span className="shrink-0 text-slate-400">{formatCompactDate(bet.createdAt)}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
