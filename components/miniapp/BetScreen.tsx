"use client";

import { useState } from "react";
import { ScanLine } from "lucide-react";
import { STATUS_BADGES } from "@/components/bets/StatusBadge";
import BetActionSheet from "./BetActionSheet";
import BetTextForm from "./BetTextForm";
import BetScreenshotForm from "./BetScreenshotForm";
import BetTicket, { type BetTicketData, type BetTicketStatus } from "./BetTicket";
import type { AnyConfirmedBet } from "./betConfirmApi";
import type { RecentBet } from "./types";
import { SportIcon, ExpressIcon } from "./sportIcons";
import { mapBetForDisplay } from "@/lib/bets/mapBetForDisplay";
import { useLocale } from "./LocaleProvider";

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
//
// Status sync fix — `liveStatus`, when supplied, overrides the "submitted"
// default. `bet` (AnyConfirmedBet) itself is a frozen snapshot from the
// moment of confirm and can never carry anything but PENDING — the actual,
// possibly-since-changed status has to come from the caller, which derives
// it from `recentBets` (see resolveLiveTicketStatus below). Omitted (the
// default, used by every pre-existing call site/test), this is
// byte-for-byte the original always-"submitted" behavior.
export function toBetTicketData(
  bet: AnyConfirmedBet,
  playerName: string,
  availableCredit: string,
  liveStatus?: BetTicketStatus,
): BetTicketData {
  if (bet.type === "SINGLE") {
    return {
      id: bet.id,
      status: liveStatus ?? "submitted",
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
    status: liveStatus ?? "submitted",
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

// Status sync fix — root cause: the open BetTicket rendered exclusively
// from `confirmedBet`, a local snapshot frozen at submit time (always
// PENDING), and never looked at `recentBets` at all — even though
// `recentBets` was already being kept fresh by app/miniapp/page.tsx's own
// existing background polling (refreshIfIdle, gated on hasPendingBet, see
// that file's own PENDING_BET_POLL_INTERVAL_MS effect) the whole time.
// This maps a fresh, reconciled RecentBet.status (server truth) onto the
// existing BetTicketStatus vocabulary BetTicket.tsx's STATUS_CONFIG already
// renders. Only PENDING/CONFIRMED/REJECTED/SETTLED_WIN/SETTLED_LOSS/VOID
// have a real, existing ticket visual state — SETTLED_HALF_WIN/
// SETTLED_HALF_LOSS (and anything unrecognized) return null, meaning "keep
// whatever this ticket already shows" rather than fabricate a status this
// ticket has no visual representation for (adding one would be a redesign,
// explicitly out of this fix's scope).
export function resolveLiveTicketStatus(status: string): BetTicketStatus | null {
  switch (status) {
    case "PENDING":
      return "submitted";
    case "CONFIRMED":
      return "confirmed";
    case "REJECTED":
      return "rejected";
    case "SETTLED_WIN":
      return "settled_won";
    case "SETTLED_LOSS":
      return "settled_lost";
    case "VOID":
      return "void";
    default:
      return null;
  }
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
  const { t } = useLocale();
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
    // Status sync fix — `recentBets` is the exact same array
    // app/miniapp/page.tsx's existing polling (refreshIfIdle, every
    // PENDING_BET_POLL_INTERVAL_MS while any bet is PENDING) already keeps
    // reconciled with the backend; no second polling loop is started here.
    // The optimistic merge that runs in the same state update as
    // `setConfirmedBet` (see handleConfirmed above / page.tsx's
    // handleBetConfirmed → mergeConfirmedBetIntoRecentBets) means this bet's
    // id is present in `recentBets` from the very first render onward, so
    // `liveTicket` is only ever undefined in the single, brief instant
    // before that merge has run — toBetTicketData's own `liveStatus ??
    // "submitted"` fallback covers exactly that instant safely.
    const liveTicket = recentBets.find((bet) => bet.id === confirmedBet.id);
    const liveStatus = liveTicket ? resolveLiveTicketStatus(liveTicket.status) : null;

    // Regression note (supersedes the old Stage M5.5B compact-spacing
    // wrapper): the global Mini App header (app/miniapp/page.tsx) owns top
    // spacing for every tab — its own h-8 header row plus a single mt-2
    // before BetScreen. A confirmed ticket must stay in normal document
    // flow below that, with no negative top offset of its own — the old
    // -mt-4 wrapper here was written against an earlier shell that used a
    // larger mt-4 gap; once the shell's own offset shrank to mt-2, that
    // same -mt-4 over-cancelled it and pulled the ticket up into the
    // header, overlapping the LanguageSwitcher (most visibly on a tall
    // EXPRESS ticket). The shell's own py-6/h-8/mt-2 tokens are the single
    // source of vertical layout here — this branch must not reintroduce a
    // second one.
    return (
      <BetTicket
        ticket={toBetTicketData(confirmedBet, playerName, availableCredit, liveStatus ?? undefined)}
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
      {/* Main action zone — the single primary CTA on this screen */}
      <button
        type="button"
        onClick={() => setSheetOpen(true)}
        aria-haspopup="dialog"
        aria-label={t("home.sendBetAriaLabel")}
        className="mt-5 flex w-full flex-col items-center rounded-3xl px-6 py-6 text-center"
        style={{
          background: "linear-gradient(160deg, rgba(96,232,74,0.10), rgba(20,30,48,0.6))",
          border: "1px solid rgba(96,232,74,0.20)",
          boxShadow: "0 20px 50px rgba(0,0,0,0.35)",
        }}
      >
        <div
          className="flex h-12 w-12 items-center justify-center rounded-full"
          style={{ background: "rgba(96,232,74,0.14)", boxShadow: "0 0 24px 4px rgba(96,232,74,0.20)" }}
        >
          <ScanLine size={24} strokeWidth={2} color="#60E84A" />
        </div>

        <p className="mt-2.5 text-xl font-bold text-white">{t("home.sendBet")}</p>
        <p className="mt-1 text-sm text-slate-300">{t("home.screenshotOrText")}</p>
      </button>

      {/* Compact summary — one bar, not three separate cards */}
      <div
        className="mt-4 flex items-stretch justify-between rounded-2xl px-2 py-2.5"
        style={{ background: "rgba(255,255,255,0.025)", border: "1px solid rgba(255,255,255,0.05)" }}
      >
        <SummaryItem label={t("home.available")} value={availableCredit} />
        <div className="w-px self-stretch" style={{ background: "rgba(255,255,255,0.08)" }} />
        <SummaryItem label={t("home.exposure")} value={exposure} />
        <div className="w-px self-stretch" style={{ background: "rgba(255,255,255,0.08)" }} />
        <SummaryItem label={t("home.pending")} value={pendingExposure} />
      </div>

      {/* Last activity — at most two rows, full history lives in its own tab */}
      <div className="mt-5">
        <p className="text-sm font-medium text-slate-300">
          {t("home.lastActivity")}
        </p>

        {recentActivity.length === 0 ? (
          <p className="mt-2 text-sm text-slate-500">{t("home.noActivityYet")}</p>
        ) : (
          <div className="mt-2 space-y-2">
            {recentActivity.map((bet) => {
              // Stage 12.2 — displayTitle replaces the old direct bet.event
              // read, which was literally null for a real EXPRESS bet (or a
              // legacy zero-selection row) — see lib/bets/mapBetForDisplay.ts.
              const display = mapBetForDisplay(bet);
              const isExpress = display.selectionCount > 1;
              const betTypeLabel = isExpress
                ? t("preview.expressCount", { count: String(display.selectionCount) })
                : t("bet.single");

              const activityStatusKey = {
                PENDING: "home.activityPending",
                CONFIRMED: "home.activityAccepted",
                REJECTED: "home.activityRejected",
                SETTLED_WIN: "home.activityWon",
                SETTLED_LOSS: "home.activityLost",
                VOID: "home.activityVoid",
                SETTLED_HALF_WIN: "home.activityHalfWon",
                SETTLED_HALF_LOSS: "home.activityHalfLost",
              } as const;

              const statusKey = activityStatusKey[bet.status as keyof typeof activityStatusKey];
              const statusLabel = statusKey ? t(statusKey) : bet.status;
              const statusBadge = STATUS_BADGES[bet.status] ?? {
                dot: "bg-slate-500",
                text: "text-slate-400",
              };

              return (
                <div
                  key={bet.id}
                  className="flex items-center gap-3 rounded-xl px-3 py-3"
                  style={{ background: "rgba(255,255,255,0.03)" }}
                >
                  <span
                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl"
                    style={{ background: "rgba(59,130,246,0.14)" }}
                  >
                    {isExpress ? (
                      <ExpressIcon size={26} className="text-slate-200" />
                    ) : (
                      <SportIcon sport={bet.sport} size={26} className="text-slate-200" />
                    )}
                  </span>

                  <span className="min-w-0 flex-1 truncate text-sm font-semibold text-white">
                    {betTypeLabel}
                  </span>

                  <span className="shrink-0 text-sm font-medium text-slate-300">
                    {(isExpress ? bet.totalOdds : bet.odds) ?? "—"}
                  </span>

                  <span className="inline-flex shrink-0 items-center gap-1.5 text-xs">
                    <span className={`h-2 w-2 rounded-full ${statusBadge.dot}`} />
                    <span className={statusBadge.text}>{statusLabel}</span>
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>

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
      <p className="mt-0.5 text-sm font-bold text-white">{value}</p>
    </div>
  );
}
