"use client";

import { useId, useState } from "react";
import StatusBadge from "@/components/bets/StatusBadge";
import EmptyState from "@/components/dashboard/EmptyState";
import SelectionList from "@/components/bets/SelectionList";
import {
  ExpressIcon,
  getDashboardSportIcon,
} from "@/components/miniapp/sportIcons";
import { formatDisplayNumber, formatSignedDisplayNumber } from "@/lib/format/number";
import { mapBetForDisplay } from "@/lib/bets/mapBetForDisplay";
import { getSettlementCountdown } from "@/lib/dashboard/settlementCountdown";
import { computePlayerStatus, type PlayerStatusTone } from "@/lib/dashboard/playerStatus";

const ICON_RENDER_PX = 28;

const FOCUS_RING =
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-400";
const FOCUS_RING_INSET =
  "focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-blue-400";

function BetRowIcon({
  isExpress,
  sport,
}: {
  isExpress: boolean;
  sport: string;
}) {
  const Icon = isExpress ? ExpressIcon : getDashboardSportIcon(sport);
  if (!Icon) return null;

  return (
    <span
      className="inline-flex h-5 w-5 shrink-0 items-center justify-center overflow-hidden"
      aria-hidden="true"
    >
      {/* eslint-disable-next-line react-hooks/static-components */}
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
  event: string | null;
  outcome: string | null;
  stake: string;
  odds: string | null;
  totalOdds: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
  selections: PlayerBetSelection[];
}

interface PlayerCardProps {
  name: string;
  telegramId: string | null;
  phoneNumber: string | null;
  creditLimit: string;
  available: string;
  exposure: string;
  activeBetsCount: number;
  pendingBetsCount: number;
  periodPnl: string;
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

function computePotentialPayout(bet: PlayerBet): string | null {
  const odds = bet.totalOdds ?? bet.odds;
  if (odds === null) return null;

  const payout = Number(bet.stake) * Number(odds);
  if (!Number.isFinite(payout)) return null;

  return payout.toFixed(2);
}

function TabButton({
  id,
  controls,
  label,
  isSelected,
  isFocusable,
  onClick,
}: {
  id: string;
  controls: string;
  label: string;
  isSelected: boolean;
  isFocusable: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      id={id}
      aria-selected={isSelected}
      aria-controls={controls}
      tabIndex={isFocusable ? 0 : -1}
      onClick={onClick}
      className={`-mb-px min-h-9 border-b-2 px-1 pb-2.5 text-sm font-medium transition-colors ${FOCUS_RING} ${
        isSelected
          ? "border-blue-400 text-white"
          : "border-transparent text-slate-500 hover:text-slate-300"
      }`}
    >
      {label}
    </button>
  );
}

function MiniStat({
  label,
  value,
  valueClassName = "text-white",
  format = false,
  secondary,
}: {
  label: string;
  value: string;
  valueClassName?: string;
  format?: boolean;
  /** Optional second line under the value — e.g. a settlement countdown. */
  secondary?: string;
}) {
  return (
    <div className="flex h-full flex-col justify-between rounded-xl border border-slate-800/70 bg-slate-950/50 p-3.5 text-center">
      <p className="text-xs text-slate-500">{label}</p>
      <div className="mt-2">
        <p className={`text-xl font-bold ${valueClassName}`}>
          {format ? formatDisplayNumber(value) : value}
        </p>
        {secondary && <p className="mt-0.5 text-[11px] text-slate-500">{secondary}</p>}
      </div>
    </div>
  );
}

const PLAYER_STATUS_STYLES: Record<PlayerStatusTone, { border: string; bg: string; text: string; dot: string }> = {
  red: { border: "border-red-500/25", bg: "bg-red-500/10", text: "text-red-400", dot: "bg-red-400" },
  amber: { border: "border-amber-500/25", bg: "bg-amber-500/10", text: "text-amber-400", dot: "bg-amber-400" },
  yellow: { border: "border-yellow-500/25", bg: "bg-yellow-500/10", text: "text-yellow-300", dot: "bg-yellow-400" },
  blue: { border: "border-blue-500/25", bg: "bg-blue-500/10", text: "text-blue-300", dot: "bg-blue-400" },
  slate: { border: "border-slate-700/60", bg: "bg-slate-800/40", text: "text-slate-500", dot: "bg-slate-600" },
  green: { border: "border-green-500/25", bg: "bg-green-500/10", text: "text-green-400", dot: "bg-green-400" },
};

function PlayerStatusPill({
  tone,
  label,
  description,
}: {
  tone: PlayerStatusTone;
  label: string;
  description: string;
}) {
  const style = PLAYER_STATUS_STYLES[tone];

  return (
    <span
      className={`mt-2 inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium ${style.border} ${style.bg} ${style.text}`}
      title={description}
      aria-label={`Player status: ${label}. ${description}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${style.dot}`} aria-hidden="true" />
      {label}
    </span>
  );
}

function displayForBet(bet: PlayerBet) {
  return mapBetForDisplay({
    ...bet,
    type: bet.selections.length > 1 ? "EXPRESS" : "SINGLE",
  });
}

function DesktopBetRow({ bet, tab }: { bet: PlayerBet; tab: Tab }) {
  const [isOpen, setIsOpen] = useState(false);
  const display = displayForBet(bet);
  const isExpress = display.selectionCount > 1;
  const payout = computePotentialPayout(bet);
  const columnCount = tab === "active" ? 7 : 6;

  const eventLabel = isExpress
    ? `Express ×${display.selectionCount}`
    : display.displayTitle;
  const selectionSummary = isExpress
    ? display.selections.map((selection) => selection.event).join(" · ")
    : display.displaySubtitle;

  const oddsDisplay = bet.totalOdds ?? bet.odds;

  return (
    <>
      <tr className="border-t border-slate-800">
        <td className="max-w-52 truncate py-2 pr-4 text-left text-white" title={eventLabel}>
          {isExpress ? (
            <button
              type="button"
              onClick={() => setIsOpen((current) => !current)}
              aria-expanded={isOpen}
              aria-label={`${isOpen ? "Hide" : "Show"} all ${display.selectionCount} selections`}
              className={`inline-flex max-w-full items-center gap-1.5 hover:text-blue-300 ${FOCUS_RING}`}
            >
              <i
                className={`ti ti-chevron-${isOpen ? "down" : "right"} shrink-0 text-sm`}
                aria-hidden="true"
              />
              <BetRowIcon isExpress sport={bet.sport} />
              <span className="truncate">{eventLabel}</span>
            </button>
          ) : (
            <span className="inline-flex max-w-full items-center gap-1.5">
              <BetRowIcon isExpress={false} sport={bet.sport} />
              <span className="truncate">{eventLabel}</span>
            </span>
          )}
        </td>
        <td className="max-w-60 truncate py-2 pr-4 text-left text-slate-200" title={selectionSummary ?? undefined}>
          {selectionSummary}
        </td>
        <td className="py-2 pr-4 text-right tabular-nums text-white">{formatDisplayNumber(bet.stake)}</td>
        <td className="py-2 pr-4 text-right tabular-nums text-slate-200">
          {oddsDisplay ? formatDisplayNumber(oddsDisplay) : "—"}
        </td>
        {tab === "active" && (
          <td className="py-2 pr-4 text-right tabular-nums text-green-400">
            {payout ? formatDisplayNumber(payout) : "—"}
          </td>
        )}
        <td className="py-2 pr-4 text-center">
          <StatusBadge status={bet.status} />
        </td>
        <td className="py-2 text-right text-slate-200">
          {formatDateTime(tab === "active" ? bet.createdAt : bet.updatedAt)}
        </td>
      </tr>

      {isExpress && isOpen && (
        <tr className="border-t border-slate-800/50">
          <td
            colSpan={columnCount}
            className="bg-slate-950/40 px-4 py-3 text-left"
          >
            <SelectionList
              selections={display.selections}
              mode="full"
              showStatus
              showLegLabels
            />
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
        description={
          tab === "active"
            ? "Confirmed bets will appear here until they're settled."
            : "Rejected, settled, and void bets will appear here."
        }
      />
    );
  }

  return (
    <>
      <div className="hidden overflow-x-auto lg:block">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="text-slate-500">
              <th className="pb-2 pr-4 text-left font-normal">Event</th>
              <th className="pb-2 pr-4 text-left font-normal">Selection</th>
              <th className="pb-2 pr-4 text-right font-normal">Stake</th>
              <th className="pb-2 pr-4 text-right font-normal">Odds</th>
              {tab === "active" && (
                <th className="pb-2 pr-4 text-right font-normal">Potential payout</th>
              )}
              <th className="pb-2 pr-4 text-center font-normal">Status</th>
              <th className="pb-2 text-right font-normal">
                {tab === "active" ? "Placed" : "Resolved"}
              </th>
            </tr>
          </thead>
          <tbody>
            {bets.map((bet) => (
              <DesktopBetRow key={bet.id} bet={bet} tab={tab} />
            ))}
          </tbody>
        </table>
      </div>

      <div className="space-y-3 lg:hidden">
        {bets.map((bet) => {
          const display = displayForBet(bet);
          const isExpress = display.selectionCount > 1;
          const payout = computePotentialPayout(bet);

          return (
            <div
              key={bet.id}
              className="rounded-xl border border-slate-800 bg-slate-950/40 p-4"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="flex items-start gap-1.5 font-semibold text-white">
                    <BetRowIcon isExpress={isExpress} sport={bet.sport} />
                    <span>
                      {isExpress
                        ? `Express ×${display.selectionCount}`
                        : display.displayTitle}
                    </span>
                  </p>
                  {!isExpress && (
                    <p className="text-sm text-slate-400">
                      {display.displaySubtitle}
                    </p>
                  )}
                </div>
                <StatusBadge status={bet.status} />
              </div>

              {isExpress && (
                <div className="mt-3">
                  <SelectionList
                    selections={display.selections}
                    mode="list"
                    showStatus={false}
                    showLegLabels
                  />
                </div>
              )}

              <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
                <span className="text-slate-200">
                  {formatDisplayNumber(bet.stake)} @ {bet.totalOdds ?? bet.odds ?? "—"}
                </span>
                {tab === "active" && payout && (
                  <span className="text-green-400">Payout {formatDisplayNumber(payout)}</span>
                )}
                <span className="text-slate-500">
                  {formatDateTime(
                    tab === "active" ? bet.createdAt : bet.updatedAt,
                  )}
                </span>
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
  activeBetsCount,
  pendingBetsCount,
  periodPnl,
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

  const periodPnlDisplay = formatSignedDisplayNumber(periodPnl);
  const periodPnlNum = Number(periodPnl);
  const periodPnlColor =
    Number.isFinite(periodPnlNum) && periodPnlNum > 0
      ? "text-green-400"
      : Number.isFinite(periodPnlNum) && periodPnlNum < 0
        ? "text-red-400"
        : "text-white";

  // Computed once here and shared by both the Settlement ministat's
  // secondary line and the header status pill's "Settlement Due" check —
  // Stage 9: a single calculation feeding both display spots, not two.
  const settlementCountdown = getSettlementCountdown(nextSettlementDate);

  const status = computePlayerStatus({
    available,
    isSettlementDueOrOverdue: settlementCountdown.tone !== "upcoming",
    pendingBetsCount,
    activeBetsCount,
    hasTelegramLinked: telegramId !== null,
  });

  const bets = activeTab === "active" ? activeBets : history;

  return (
    <div className="overflow-hidden rounded-2xl border border-slate-800/70 bg-[#0b1220] shadow-[inset_0_1px_0_0_rgba(255,255,255,0.04)] transition-colors hover:border-slate-700">
      <button
        type="button"
        onClick={() => setIsExpanded((current) => !current)}
        aria-expanded={isExpanded}
        aria-controls={panelId}
        className={`group w-full p-6 text-left ${FOCUS_RING_INSET}`}
      >
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h3 className="text-2xl font-bold tracking-tight text-white">
              {name}
            </h3>
            <p className="mt-1.5 text-sm text-slate-500">
              Contact: {phoneNumber ?? "—"}
            </p>

            <PlayerStatusPill tone={status.tone} label={status.label} description={status.description} />
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
          <MiniStat label="Credit Limit" value={creditLimit} format />
          <MiniStat label="Available" value={available} format />
          <MiniStat label="Exposure" value={exposure} format />
          <MiniStat
            label="Period P/L"
            value={periodPnlDisplay}
            valueClassName={periodPnlColor}
          />
          <MiniStat label="Active Bets" value={String(activeBetsCount)} />
          <MiniStat
            label="Next Settlement"
            value={formatDate(nextSettlementDate)}
            valueClassName="text-blue-300"
            secondary={settlementCountdown.label}
          />
        </div>
      </button>

      <div
        id={panelId}
        className={`grid transition-[grid-template-rows] duration-300 ease-out motion-reduce:transition-none ${
          isExpanded ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
        }`}
      >
        <div className="overflow-hidden">
          <div className="border-t border-slate-800/70 px-6 pb-6 pt-4">
            <div
              role="tablist"
              aria-label={`${name}'s bets`}
              className="flex gap-5 border-b border-slate-800/70"
            >
              <TabButton
                id={activeTabId}
                controls={`${panelId}-active`}
                label="Active Bets"
                isSelected={activeTab === "active"}
                isFocusable={isExpanded}
                onClick={() => setActiveTab("active")}
              />
              <TabButton
                id={historyTabId}
                controls={`${panelId}-history`}
                label="History"
                isSelected={activeTab === "history"}
                isFocusable={isExpanded}
                onClick={() => setActiveTab("history")}
              />
            </div>

            <div
              role="tabpanel"
              id={
                activeTab === "active"
                  ? `${panelId}-active`
                  : `${panelId}-history`
              }
              aria-labelledby={
                activeTab === "active" ? activeTabId : historyTabId
              }
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
