"use client";

import { useState } from "react";
import { ScanLine, Zap } from "lucide-react";
import StatusBadge from "@/components/bets/StatusBadge";
import BetActionSheet from "./BetActionSheet";
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
// Neither method has a real handler yet — see BetActionSheet's callbacks
// below, which only close the sheet. That mirrors exactly what the previous
// two ActionCard buttons did (visually clickable, intentionally no-op); no
// upload/OCR/AI/API wiring exists anywhere in the app yet, so there is
// nothing to preserve or reuse beyond that placeholder behavior.
export default function BetScreen({
  availableCredit,
  exposure,
  pendingExposure,
  recentBets,
}: BetScreenProps) {
  const [isSheetOpen, setSheetOpen] = useState(false);
  const recentActivity = recentBets.slice(0, RECENT_ACTIVITY_LIMIT);

  const closeSheet = () => setSheetOpen(false);

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
                <p className="min-w-0 flex-1 truncate text-sm font-medium text-white">{bet.event}</p>
                <span className="shrink-0 text-xs text-slate-400">{bet.odds ?? "—"}</span>
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
        onSelectScreenshot={closeSheet}
        onSelectText={closeSheet}
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
