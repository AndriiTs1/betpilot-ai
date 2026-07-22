"use client";

import { useId, useState } from "react";
import StatusBadge from "@/components/bets/StatusBadge";
import EmptyState from "@/components/dashboard/EmptyState";
import SelectionList from "@/components/bets/SelectionList";
import { ExpressIcon, getDashboardSportIcon } from "@/components/miniapp/sportIcons";
import { formatDisplayNumber } from "@/lib/format/number";
import { mapBetForDisplay } from "@/lib/bets/mapBetForDisplay";

// The icon box stays a fixed 20x20 (matches text-sm's default line-height
// of 1.25rem exactly, so adding it never changes row height) — but the
// source PNG artwork (football/tennis/basketball/hockey/express) each bake
// in a padded rounded-square backdrop, with the actual ball/puck/ticket
// only occupying roughly 65-72% of the frame (measured directly from the
// source files, consistently across all five). Rendered at ICON_RENDER_PX
// and clipped by this fixed-size, overflow-hidden wrapper instead of at
// ICON_BOX_PX directly, so the visible artwork fills the box rather than
// floating in the middle of it — the box itself, and therefore row height/
// alignment, is unaffected.
const ICON_BOX_PX = 20;
const ICON_RENDER_PX = 28;

function BetRowIcon({ isExpress, sport }: { isExpress: boolean; sport: string }) {
  const Icon = isExpress ? ExpressIcon : getDashboardSportIcon(sport);
  if (!Icon) return null;

  return (
    <span
      className="inline-flex shrink-0 items-center justify-center overflow-hidden"
      style={{ width: ICON_BOX_PX, height: ICON_BOX_PX }}
      aria-hidden="true"
    >
      {/* max-w-none cancels Tailwind's preflight `img { max-width: 100% }` —
          without it, the browser clamps the image's rendered width to its
          20px-wide parent while the explicit inline height stays at
          ICON_RENDER_PX, squashing a 28x28 icon into a distorted 20x28. */}
      {/* eslint-disable-next-line react-hooks/static-components -- Icon is picked from a fixed, module-level map of never-redefined component references, not created during render. */}
      <Icon size={ICON_RENDER_PX} className="max-w-none text-slate-300" />
    </span>
  );
}

export interface PlayerBetSelection {
  id: string;
  sport: string;
  event: string;
  outcome: string;
  market: string | null;
  odds: string | null;
  currentOdds: string | null;
  oddsStatus: string;
}

export interface PlayerBet {
  id: string;
  sport: string;
  // Nullable to match the real Prisma contract — both are genuinely null
  // for an EXPRESS bet (event/outcome live per-leg on selections instead).
  // Already true on the wire; this type was simply never honest about it,
  // which is the root cause of an EXPRESS row rendering with a blank
  // Event/Selection before this fix.
  event: string | null;
  outcome: string | null;
  stake: string;
  odds: string | null;
  totalOdds: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
  // Already present on every real API response (GET /api/dashboard/players
  // already selects selections) — just not previously declared here.
  selections: PlayerBetSelection[];
}

interface PlayerCardProps {
  name: string;
  telegramId: string | null;
  phoneNumber: string | null;
  creditLimit: string;
  available: string;
  exposure: string;
  currentCredit: string;
  activeBetsCount: number;
  nextSettlementDate: string;
  activeBets: PlayerBet[];
  history: PlayerBet[];
}

type Tab = "active" | "history";

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "Europe/Zurich",
  });
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Zurich",
  });
}

// Display-only estimate, same approach already used elsewhere in this app
// (e.g. the Mini App's own potentialWin) — never trusted for a write, only
// shown to the operator. totalOdds (parlay) takes priority over odds
// (single) when both could theoretically be present.
function computePotentialPayout(bet: PlayerBet): string | null {
  const odds = bet.totalOdds ?? bet.odds;
  if (odds === null) return null;

  const payout = Number(bet.stake) * Number(odds);
  if (!Number.isFinite(payout)) return null;

  return payout.toFixed(2);
}

// Bet UI Design System — Active Bets and History are both read-only. Won/
// Lost/Void are lifecycle statuses rendered by the shared StatusBadge, not
// operator actions: the operator's only manual decision is Confirm/Reject
// on a new request (BetQueueItem.tsx). Settlement itself (WON/LOST/VOID
// determination, exposure/wallet/ledger updates, player notification) will
// be automated by a separate future backend task; manual settlement will
// then exist only as an exception workflow for bets that automation can't
// resolve, once that pipeline and its real failure states exist — not
// built here. The Won/Lost/Void POST endpoint this screen used to call
// (app/api/dashboard/bets/[id]/settle/route.ts, lib/bets/settleBet.ts) is
// left in place unchanged; it's simply no longer wired to any button.

function MiniStat({
  label,
  value,
  valueClassName = "text-white",
  format = false,
}: {
  label: string;
  value: string;
  valueClassName?: string;
  format?: boolean;
}) {
  return (
    <div className="flex h-full flex-col justify-between rounded-xl border border-slate-800/70 bg-slate-950/50 p-3.5 text-center">
      <p className="text-xs text-slate-500">{label}</p>
      <p className={`mt-2 text-xl font-bold ${valueClassName}`}>
        {format ? formatDisplayNumber(value) : value}
      </p>
    </div>
  );
}

// EXPRESS is inferred from selection count, not a `type` field — GET
// /api/dashboard/players doesn't select Bet.type (not needed: a real
// EXPRESS bet always has >1 BetSelection row, a real SINGLE bet always has
// zero), matching the same established convention as
// ActiveBetsScreen.tsx/HistoryScreen.tsx/BetQueueItem.tsx.
function displayForBet(bet: PlayerBet) {
  return mapBetForDisplay({ ...bet, type: bet.selections.length > 1 ? "EXPRESS" : "SINGLE" });
}

// Desktop table row for one bet — collapsed by default. A SINGLE row is
// static (nothing to expand); an EXPRESS row shows a compact "Express ×N"
// / joined-event-names summary and can be expanded to reveal the complete
// shared SelectionList in a full-width row directly beneath it, so the
// operator never has to leave the table to see every leg.
function DesktopBetRow({ bet, tab }: { bet: PlayerBet; tab: Tab }) {
  const [isOpen, setIsOpen] = useState(false);
  const display = displayForBet(bet);
  const isExpress = display.selectionCount > 1;
  const payout = computePotentialPayout(bet);
  const columnCount = tab === "active" ? 7 : 6;

  const eventLabel = isExpress ? `Express ×${display.selectionCount}` : display.displayTitle;
  const selectionSummary = isExpress
    ? display.selections.map((selection) => selection.event).join(" · ")
    : display.displaySubtitle;

  return (
    <>
      <tr className="border-t border-slate-800 text-center">
        <td className="py-2 pr-4 text-white">
          {isExpress ? (
            <button
              type="button"
              onClick={() => setIsOpen((current) => !current)}
              aria-expanded={isOpen}
              aria-label={`${isOpen ? "Hide" : "Show"} all ${display.selectionCount} selections`}
              className="inline-flex items-center gap-1.5 hover:text-blue-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-400"
            >
              <i className={`ti ti-chevron-${isOpen ? "down" : "right"} text-sm`} aria-hidden="true" />
              <BetRowIcon isExpress sport={bet.sport} />
              {eventLabel}
            </button>
          ) : (
            <span className="inline-flex items-center gap-1.5">
              <BetRowIcon isExpress={false} sport={bet.sport} />
              {eventLabel}
            </span>
          )}
        </td>
        <td className="max-w-[240px] truncate py-2 pr-4 text-slate-200">{selectionSummary}</td>
        <td className="py-2 pr-4 text-white">{bet.stake}</td>
        <td className="py-2 pr-4 text-slate-200">{bet.totalOdds ?? bet.odds ?? "—"}</td>
        {tab === "active" && <td className="py-2 pr-4 text-green-400">{payout ?? "—"}</td>}
        <td className="py-2 pr-4">
          <StatusBadge status={bet.status} />
        </td>
        <td className="py-2 text-slate-200">{formatDateTime(tab === "active" ? bet.createdAt : bet.updatedAt)}</td>
      </tr>
      {isExpress && isOpen && (
        <tr className="border-t border-slate-800/50">
          <td colSpan={columnCount} className="bg-slate-950/40 px-4 py-3 text-left">
            <SelectionList selections={display.selections} mode="full" showStatus showLegLabels />
          </td>
        </tr>
      )}
    </>
  );
}

function BetsTable({ bets, tab }: { bets: PlayerBet[]; tab: Tab }) {
  if (bets.length === 0) {
    return (
      <EmptyState
        icon={tab === "active" ? "list-check" : "history"}
        title={tab === "active" ? "No active bets." : "No bet history yet."}
      />
    );
  }

  return (
    <>
      {/* Desktop (lg+): table — read-only, no Actions column. */}
      <div className="hidden overflow-x-auto lg:block">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="text-center text-slate-500">
              <th className="pb-2 pr-4 font-normal">Event</th>
              <th className="pb-2 pr-4 font-normal">Selection</th>
              <th className="pb-2 pr-4 font-normal">Stake</th>
              <th className="pb-2 pr-4 font-normal">Odds</th>
              {tab === "active" && <th className="pb-2 pr-4 font-normal">Potential payout</th>}
              <th className="pb-2 pr-4 font-normal">Status</th>
              <th className="pb-2 font-normal">{tab === "active" ? "Placed" : "Resolved"}</th>
            </tr>
          </thead>
          <tbody>
            {bets.map((bet) => (
              <DesktopBetRow key={bet.id} bet={bet} tab={tab} />
            ))}
          </tbody>
        </table>
      </div>

      {/* Mobile + tablet (below lg): card list — read-only. */}
      <div className="space-y-3 lg:hidden">
        {bets.map((bet) => {
          const display = displayForBet(bet);
          const isExpress = display.selectionCount > 1;
          const payout = computePotentialPayout(bet);

          return (
            <div key={bet.id} className="rounded-xl border border-slate-800 bg-slate-950/40 p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="flex items-start gap-1.5 font-semibold text-white">
                    <BetRowIcon isExpress={isExpress} sport={bet.sport} />
                    <span>{isExpress ? `Express ×${display.selectionCount}` : display.displayTitle}</span>
                  </p>
                  {!isExpress && <p className="text-sm text-slate-400">{display.displaySubtitle}</p>}
                </div>
                <StatusBadge status={bet.status} />
              </div>

              {isExpress && (
                <div className="mt-3">
                  <SelectionList selections={display.selections} mode="list" showStatus={false} showLegLabels />
                </div>
              )}

              <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
                <span className="text-slate-200">
                  {bet.stake} @ {bet.totalOdds ?? bet.odds ?? "—"}
                </span>
                {tab === "active" && payout && <span className="text-green-400">Payout {payout}</span>}
                <span className="text-slate-500">{formatDateTime(tab === "active" ? bet.createdAt : bet.updatedAt)}</span>
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}

export default function PlayerCard({
  name,
  telegramId,
  phoneNumber,
  creditLimit,
  available,
  exposure,
  currentCredit,
  activeBetsCount,
  nextSettlementDate,
  activeBets,
  history,
}: PlayerCardProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [activeTab, setActiveTab] = useState<Tab>("active");
  const baseId = useId();
  const panelId = `${baseId}-panel`;
  const activeTabId = `${baseId}-tab-active`;
  const historyTabId = `${baseId}-tab-history`;

  const isNegative = currentCredit.startsWith("-");
  const isZero = Number(currentCredit) === 0;
  const balanceDisplay = isNegative || isZero ? currentCredit : `+${currentCredit}`;
  const balanceColor = isNegative ? "text-red-400" : isZero ? "text-white" : "text-green-400";

  const bets = activeTab === "active" ? activeBets : history;

  return (
    <div className="overflow-hidden rounded-2xl border border-slate-800/70 bg-[#0b1220] shadow-[inset_0_1px_0_0_rgba(255,255,255,0.04)] transition-colors hover:border-slate-700">
      <button
        type="button"
        onClick={() => setIsExpanded((current) => !current)}
        aria-expanded={isExpanded}
        aria-controls={panelId}
        className="group w-full p-6 text-left focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-blue-400"
      >
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h3 className="text-2xl font-bold tracking-tight text-white">{name}</h3>
            <p className="mt-1.5 text-sm text-slate-500">Contact: {phoneNumber ?? "—"}</p>

            {telegramId ? (
              <span className="mt-2 inline-flex items-center gap-1.5 rounded-full border border-green-500/25 bg-green-500/10 px-2 py-0.5 text-xs font-medium text-green-400">
                <span className="h-1.5 w-1.5 rounded-full bg-green-400" aria-hidden="true" />
                Telegram: connected
              </span>
            ) : (
              <span className="mt-2 inline-flex items-center gap-1.5 rounded-full border border-slate-700/60 bg-slate-800/40 px-2 py-0.5 text-xs font-medium text-slate-500">
                <span className="h-1.5 w-1.5 rounded-full bg-slate-600" aria-hidden="true" />
                Telegram: not linked yet
              </span>
            )}
          </div>

          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-slate-500 transition-colors duration-200 group-hover:bg-white/5 group-hover:text-slate-300 group-focus-visible:bg-white/5 group-focus-visible:text-slate-300">
            <i
              className={`ti ti-chevron-down text-lg transition-transform duration-200 ${
                isExpanded ? "rotate-180" : ""
              }`}
              aria-hidden="true"
            />
          </span>
        </div>

        <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <MiniStat label="Limit" value={creditLimit} format />
          <MiniStat label="Available" value={available} format />
          <MiniStat label="Exposure" value={exposure} format />
          <MiniStat label="Balance" value={balanceDisplay} valueClassName={balanceColor} format />
          <MiniStat label="Active Bets" value={String(activeBetsCount)} />
          <MiniStat label="Settlement" value={formatDate(nextSettlementDate)} valueClassName="text-blue-300" />
        </div>
      </button>

      {/* CSS-only expand/collapse via grid-template-rows 0fr/1fr — animates
          to the content's real height with no JS measurement and no
          arbitrary max-height overshoot. */}
      <div
        id={panelId}
        className={`grid transition-[grid-template-rows] duration-300 ease-out motion-reduce:transition-none ${
          isExpanded ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
        }`}
      >
        <div className="overflow-hidden">
          <div className="border-t border-slate-800/70 px-6 pb-6 pt-4">
            <div role="tablist" aria-label={`${name}'s bets`} className="flex gap-5 border-b border-slate-800/70">
              <button
                type="button"
                role="tab"
                id={activeTabId}
                aria-selected={activeTab === "active"}
                aria-controls={`${panelId}-active`}
                tabIndex={isExpanded ? 0 : -1}
                onClick={() => setActiveTab("active")}
                className={`-mb-px min-h-9 border-b-2 px-1 pb-2.5 text-sm font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-400 ${
                  activeTab === "active"
                    ? "border-blue-400 text-white"
                    : "border-transparent text-slate-500 hover:text-slate-300"
                }`}
              >
                Active Bets
              </button>
              <button
                type="button"
                role="tab"
                id={historyTabId}
                aria-selected={activeTab === "history"}
                aria-controls={`${panelId}-history`}
                tabIndex={isExpanded ? 0 : -1}
                onClick={() => setActiveTab("history")}
                className={`-mb-px min-h-9 border-b-2 px-1 pb-2.5 text-sm font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-400 ${
                  activeTab === "history"
                    ? "border-blue-400 text-white"
                    : "border-transparent text-slate-500 hover:text-slate-300"
                }`}
              >
                History
              </button>
            </div>

            <div
              role="tabpanel"
              id={activeTab === "active" ? `${panelId}-active` : `${panelId}-history`}
              aria-labelledby={activeTab === "active" ? activeTabId : historyTabId}
              className="mt-4"
            >
              <BetsTable bets={bets} tab={activeTab} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
