"use client";

import { useState } from "react";
import { ScanLine, Zap } from "lucide-react";
import StatusBadge from "@/components/bets/StatusBadge";
import BetActionSheet from "./BetActionSheet";
import BetTextForm from "./BetTextForm";
import BetScreenshotForm from "./BetScreenshotForm";
import type { ConfirmedBet } from "./betConfirmApi";
import type { RecentBet } from "./types";

interface BetScreenProps {
  availableCredit: string;
  exposure: string;
  pendingExposure: string;
  recentBets: RecentBet[];
}

const RECENT_ACTIVITY_LIMIT = 2;

// "AI Assistant First" composition: one large action zone opens a bottom
// sheet with the two submission methods, instead of two competing cards.
// "Написать ставку" opens BetTextForm and "Отправить скриншот" opens
// BetScreenshotForm — both preview -> confirm -> real Bet (Stage 4.4B /
// 4.5D), sharing the same confirmed-Bet success screen below.
export default function BetScreen({
  availableCredit,
  exposure,
  pendingExposure,
  recentBets,
}: BetScreenProps) {
  const [isSheetOpen, setSheetOpen] = useState(false);
  const [isTextFormOpen, setTextFormOpen] = useState(false);
  const [isScreenshotFormOpen, setScreenshotFormOpen] = useState(false);
  // Set only after a real POST .../confirm success (Stage 4.4B) — holds the
  // whitelisted server response only, never previewId/playerId/previewToken.
  const [confirmedBet, setConfirmedBet] = useState<ConfirmedBet | null>(null);
  const recentActivity = recentBets.slice(0, RECENT_ACTIVITY_LIMIT);

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
      <BetConfirmedCard
        bet={confirmedBet}
        onCreateNew={() => setConfirmedBet(null)}
        onBack={closeToDashboard}
      />
    );
  }

  if (isTextFormOpen) {
    return <BetTextForm onBack={() => setTextFormOpen(false)} onConfirmed={setConfirmedBet} />;
  }

  if (isScreenshotFormOpen) {
    return (
      <BetScreenshotForm onBack={() => setScreenshotFormOpen(false)} onConfirmed={setConfirmedBet} />
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
            {recentActivity.map((bet) => (
              <div
                key={bet.id}
                className="flex items-center justify-between gap-3 rounded-xl px-3 py-2.5"
                style={{ background: "rgba(255,255,255,0.03)" }}
              >
                <p className="min-w-0 flex-1 truncate text-sm font-medium text-white">
                  {bet.selections && bet.selections.length > 1
                    ? `Экспресс ×${bet.selections.length} · ${bet.event}`
                    : bet.event}
                </p>
                <span className="shrink-0 text-xs text-slate-400">
                  {(bet.selections && bet.selections.length > 1 ? bet.totalOdds : bet.odds) ?? "—"}
                </span>
                <StatusBadge status={bet.status} />
              </div>
            ))}
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

// Shown once after a successful POST .../confirm — deliberately excludes
// Bet.id, previewId, playerId and every other internal field; potentialWin
// is a client-side calculation, never trusted from any server field.
function BetConfirmedCard({
  bet,
  onCreateNew,
  onBack,
}: {
  bet: ConfirmedBet;
  onCreateNew: () => void;
  onBack: () => void;
}) {
  const potentialWin =
    bet.totalOdds !== null && Number.isFinite(bet.totalOdds) && Number.isFinite(bet.stake)
      ? bet.stake * bet.totalOdds
      : null;

  return (
    <div>
      <button
        type="button"
        onClick={onBack}
        className="text-sm font-medium text-slate-400"
        aria-label="Back"
      >
        ‹ Back
      </button>

      <div
        className="mt-4 flex flex-col items-center rounded-3xl px-6 py-7 text-center"
        style={{
          background: "linear-gradient(160deg, rgba(96,232,74,0.10), rgba(20,30,48,0.6))",
          border: "1px solid rgba(96,232,74,0.20)",
        }}
      >
        <p className="text-xl font-bold text-white">Bet request created</p>
        <p className="mt-1 text-sm text-slate-300">Pending — awaiting operator confirmation</p>
      </div>

      <div
        className="mt-4 rounded-2xl p-4"
        style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)" }}
      >
        <ConfirmedRow label="Sport" value={bet.sport} />
        <ConfirmedRow label="Event" value={bet.event} wrap />
        <ConfirmedRow label="Selection" value={bet.outcome} wrap />
        <ConfirmedRow label="Stake" value={bet.stake.toFixed(2)} />
        <ConfirmedRow label="Odds" value={bet.totalOdds !== null ? bet.totalOdds.toFixed(2) : "Not provided"} />
        <ConfirmedRow
          label="Potential win"
          value={potentialWin !== null ? potentialWin.toFixed(2) : "Not available"}
          last
        />
      </div>

      <button
        type="button"
        onClick={onCreateNew}
        aria-label="Create new bet"
        className="mt-4 min-h-11 w-full rounded-2xl text-[15px] font-semibold"
        style={{ background: "#60E84A", color: "#04170C" }}
      >
        Create new bet
      </button>
    </div>
  );
}

function ConfirmedRow({
  label,
  value,
  wrap = false,
  last = false,
}: {
  label: string;
  value: string;
  wrap?: boolean;
  last?: boolean;
}) {
  return (
    <div className={`flex items-start justify-between gap-3 ${last ? "" : "mb-2"}`}>
      <span className="shrink-0 text-xs text-slate-400">{label}</span>
      <span className={`min-w-0 text-right text-sm font-medium text-white ${wrap ? "break-words" : ""}`}>
        {value}
      </span>
    </div>
  );
}
