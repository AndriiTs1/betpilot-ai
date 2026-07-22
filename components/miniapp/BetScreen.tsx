"use client";

import { useState } from "react";
import { ScanLine, Zap } from "lucide-react";
import StatusBadge from "@/components/bets/StatusBadge";
import BetActionSheet from "./BetActionSheet";
import BetTextForm from "./BetTextForm";
import BetScreenshotForm from "./BetScreenshotForm";
import BetTicket, { type BetTicketData } from "./BetTicket";
import type { AnyConfirmedBet } from "./betConfirmApi";
import type { RecentBet } from "./types";
import { SportIcon, ExpressIcon } from "./sportIcons";
import { mapBetForDisplay } from "@/lib/bets/mapBetForDisplay";

interface BetScreenProps {
  playerName: string;
  availableCredit: string;
  exposure: string;
  pendingExposure: string;
  recentBets: RecentBet[];
  // Data-freshness fix — the one shared confirmation-update path both
  // BetTextForm and BetScreenshotForm feed into below (via a single local
  // handleConfirmed), rather than either form talking to the Mini App's
  // page-level data owner directly. Optimistically merges the confirmed
  // bet into recentBets and kicks off a silent background reconciliation —
  // see components/miniapp/mergeConfirmedBet.ts and app/miniapp/page.tsx.
  onBetConfirmed: (bet: AnyConfirmedBet) => void;
  onNavigateToHistory: () => void;
}

// bet.status is always the literal "PENDING" for either shape — the
// player-side confirm step (Stage 4.4B, extended to EXPRESS in Phase 4
// Step 4) only ever creates a pending Bet; only the operator dashboard's
// own confirm step (a different action, same word) can move it to
// CONFIRMED. The ticket badge says "Submitted", not "Confirmed",
// specifically to avoid implying the operator has already accepted it —
// see the Stage 4.5G changelog entry.
//
// Stage 12, Phase 4, Step 5 — SINGLE branch is byte-for-byte what this
// function has always done. EXPRESS builds a real multi-entry
// selections[] from bet.selections instead of the single hardcoded entry;
// stake/totalOdds are parsed from confirm's decimal strings into numbers
// purely for this display-only ticket (BetTicket.tsx already renders
// every other number as a plain JS number) — no precision-sensitive
// storage or calculation happens here, the exact values already came from
// the server as strings and are shown, not recomputed.
export function toBetTicketData(bet: AnyConfirmedBet, playerName: string, availableCredit: string): BetTicketData {
  if (bet.type === "SINGLE") {
    return {
      id: bet.id,
      status: "submitted",
      player: playerName,
      createdAt: bet.createdAt,
      selections: [{ sport: bet.sport, league: null, event: bet.event, selection: bet.outcome, odds: bet.odds }],
      stake: bet.stake,
      totalOdds: bet.totalOdds,
      availableCredit,
    };
  }

  return {
    id: bet.id,
    status: "submitted",
    player: playerName,
    createdAt: bet.createdAt,
    selections: bet.selections.map((selection) => ({
      sport: selection.sport,
      league: null,
      event: selection.event,
      selection: selection.outcome,
      odds: selection.odds !== null ? Number(selection.odds) : null,
      market: selection.market,
      currentOdds: selection.currentOdds !== null ? Number(selection.currentOdds) : null,
      oddsStatus: selection.oddsStatus,
    })),
    stake: Number(bet.stake),
    totalOdds: bet.totalOdds !== null ? Number(bet.totalOdds) : null,
    availableCredit,
  };
}

const RECENT_ACTIVITY_LIMIT = 2;

// "AI Assistant First" composition: one large action zone opens a bottom
// sheet with the two submission methods, instead of two competing cards.
// "Написать ставку" opens BetTextForm and "Отправить скриншот" opens
// BetScreenshotForm — both preview -> confirm -> real Bet (Stage 4.4B /
// 4.5D), sharing the same confirmed-Bet success screen below.
export default function BetScreen({
  playerName,
  availableCredit,
  exposure,
  pendingExposure,
  recentBets,
  onBetConfirmed,
  onNavigateToHistory,
}: BetScreenProps) {
  const [isSheetOpen, setSheetOpen] = useState(false);
  const [isTextFormOpen, setTextFormOpen] = useState(false);
  const [isScreenshotFormOpen, setScreenshotFormOpen] = useState(false);
  // Set only after a real POST .../confirm success (Stage 4.4B) — holds the
  // whitelisted server response only, never previewId/playerId/previewToken.
  const [confirmedBet, setConfirmedBet] = useState<AnyConfirmedBet | null>(null);
  const recentActivity = recentBets.slice(0, RECENT_ACTIVITY_LIMIT);

  // The single shared confirmation-update path — sets the local ticket
  // state (unchanged UI concern) and, in the same call, feeds the
  // page-level optimistic-merge + background-reconciliation path. Both
  // forms below are wired to this exact same function reference, never two
  // separate handlers.
  const handleConfirmed = (bet: AnyConfirmedBet) => {
    setConfirmedBet(bet);
    onBetConfirmed(bet);
  };

  const closeSheet = () => setSheetOpen(false);

  const openTextForm = () => {
    closeSheet();
    setTextFormOpen(true);
  };

  const openScreenshotForm = () => {
    closeSheet();
    setScreenshotFormOpen(true);
  };

  const closeToDashboard = () => {
    setConfirmedBet(null);
    setTextFormOpen(false);
    setScreenshotFormOpen(false);
  };

  if (confirmedBet) {
    return (
      <BetTicket
        ticket={toBetTicketData(confirmedBet, playerName, availableCredit)}
        onDone={closeToDashboard}
        onViewHistory={() => {
          closeToDashboard();
          onNavigateToHistory();
        }}
      />
    );
  }

  if (isTextFormOpen) {
    return <BetTextForm onBack={() => setTextFormOpen(false)} onConfirmed={handleConfirmed} />;
  }

  if (isScreenshotFormOpen) {
    return (
      <BetScreenshotForm onBack={() => setScreenshotFormOpen(false)} onConfirmed={handleConfirmed} />
    );
  }

  return (
    <div>
      {/* Compact top status */}
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-sm font-semibold uppercase tracking-wide text-white">
          <Zap size={14} strokeWidth={2} style={{ color: "#60E84A" }} />
          BetPilot AI
        </span>
        <span
          className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide"
          style={{ color: "#60E84A" }}
        >
          <span className="h-1.5 w-1.5 rounded-full" style={{ background: "#60E84A" }} />
          AI Online
        </span>
      </div>
      <p className="mt-1 text-sm text-slate-400">Готов проверить вашу ставку</p>

      {/* Main action zone — the single primary CTA on this screen */}
      <button
        type="button"
        onClick={() => setSheetOpen(true)}
        aria-haspopup="dialog"
        aria-label="Отправить ставку — скриншот или текст"
        className="mt-5 flex w-full flex-col items-center rounded-3xl px-6 py-7 text-center"
        style={{
          background: "linear-gradient(160deg, rgba(96,232,74,0.10), rgba(20,30,48,0.6))",
          border: "1px solid rgba(96,232,74,0.20)",
          boxShadow: "0 20px 50px rgba(0,0,0,0.35)",
        }}
      >
        <div
          className="flex h-14 w-14 items-center justify-center rounded-full"
          style={{ background: "rgba(96,232,74,0.14)", boxShadow: "0 0 24px 4px rgba(96,232,74,0.20)" }}
        >
          <ScanLine size={28} strokeWidth={2} color="#60E84A" />
        </div>

        <p className="mt-3 text-xl font-bold text-white">Отправить ставку</p>
        <p className="mt-1 text-sm text-slate-300">Скриншот или текст</p>
        <p className="mt-2 text-xs text-slate-500">AI проверит события, коэффициенты и сумму</p>
      </button>

      {/* Compact summary — one bar, not three separate cards */}
      <div
        className="mt-5 flex items-stretch justify-between rounded-2xl px-2 py-3"
        style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)" }}
      >
        <SummaryItem label="Доступно" value={availableCredit} />
        <div className="w-px self-stretch" style={{ background: "rgba(255,255,255,0.08)" }} />
        <SummaryItem label="В игре" value={exposure} />
        <div className="w-px self-stretch" style={{ background: "rgba(255,255,255,0.08)" }} />
        <SummaryItem label="Ожидает" value={pendingExposure} />
      </div>

      {/* Last activity — at most two rows, full history lives in its own tab */}
      <div className="mt-5">
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
          Последняя активность
        </p>

        {recentActivity.length === 0 ? (
          <p className="mt-2 text-sm text-slate-500">Здесь появятся ваши последние ставки</p>
        ) : (
          <div className="mt-2 space-y-2">
            {recentActivity.map((bet) => {
              // Stage 12.2 — displayTitle replaces the old direct bet.event
              // read, which was literally null for a real EXPRESS bet (or a
              // legacy zero-selection row) — see lib/bets/mapBetForDisplay.ts.
              const display = mapBetForDisplay(bet);
              const isExpress = display.selectionCount > 1;

              return (
                <div
                  key={bet.id}
                  className="flex items-center justify-between gap-3 rounded-xl px-3 py-2.5"
                  style={{ background: "rgba(255,255,255,0.03)" }}
                >
                  <div className="flex min-w-0 flex-1 items-center gap-2">
                    <span
                      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl"
                      style={{ background: "rgba(59,130,246,0.14)" }}
                    >
                      {/* EXPRESS can span multiple sports — a single sport
                          icon would misrepresent it. */}
                      {isExpress ? (
                        <ExpressIcon size={28} className="text-slate-200" />
                      ) : (
                        <SportIcon sport={bet.sport} size={28} className="text-slate-200" />
                      )}
                    </span>
                    <p className="min-w-0 truncate text-sm font-medium text-white">{display.displayTitle}</p>
                  </div>
                  <span className="shrink-0 text-xs text-slate-400">
                    {(bet.selections && bet.selections.length > 1 ? bet.totalOdds : bet.odds) ?? "—"}
                  </span>
                  <StatusBadge status={bet.status} />
                </div>
              );
            })}
          </div>
        )}
      </div>

      <p className="mt-5 text-center text-xs text-slate-500">
        AI проверяет коэффициенты перед подтверждением
      </p>

      <BetActionSheet
        open={isSheetOpen}
        onClose={closeSheet}
        onSelectScreenshot={openScreenshotForm}
        onSelectText={openTextForm}
      />
    </div>
  );
}

function SummaryItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-1 flex-col items-center px-1">
      <p className="text-[11px] text-slate-400">{label}</p>
      <p className="mt-0.5 text-sm font-semibold text-white">{value}</p>
    </div>
  );
}
