"use client";

import { useState, type ReactNode } from "react";
import {
  fetchBetPreview,
  getBetPreviewErrorMessage,
  type BetOddsCheck,
  type BetPreview,
  type BetPreviewSuccess,
} from "./betPreviewApi";

interface BetTextFormProps {
  onBack: () => void;
}

const MESSAGE_MIN_LENGTH = 3;
const MESSAGE_MAX_LENGTH = 2000;

// Telegram's HapticFeedback isn't part of the TelegramWebApp type declared
// in app/miniapp/page.tsx (that file isn't touched here) — accessed through
// a narrow, runtime-checked local shape instead of widening the global type
// or blindly asserting it.
interface TelegramHapticFeedback {
  notificationOccurred?: (type: "error" | "success" | "warning") => void;
  impactOccurred?: (style: "light" | "medium" | "heavy") => void;
}

function triggerHaptic(kind: "success" | "error" | "warning-light"): void {
  try {
    const tg = window.Telegram?.WebApp;
    if (!tg || !("HapticFeedback" in tg)) return;

    const haptic = (tg as unknown as { HapticFeedback: TelegramHapticFeedback }).HapticFeedback;

    if (kind === "warning-light") {
      haptic.impactOccurred?.("light");
    } else {
      haptic.notificationOccurred?.(kind);
    }
  } catch {
    // Never let a haptics quirk on some Telegram client break the form.
  }
}

function formatAmount(value: number): string {
  return value.toFixed(2);
}

// "Place a bet" screen: free-text message -> POST /api/miniapp/bets/text/preview
// -> read-only preview + odds status. No confirm/create action exists yet —
// see BetActionSheet's "Написать ставку" for how this is reached.
export default function BetTextForm({ onBack }: BetTextFormProps) {
  const [message, setMessage] = useState("");
  // previewResponse.previewToken (Stage 4.3) lives here in memory only —
  // never rendered, decoded, logged, or persisted to storage.
  const [previewResponse, setPreviewResponse] = useState<BetPreviewSuccess | null>(null);
  const [isSubmitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const trimmedLength = message.trim().length;
  const canSubmit = trimmedLength >= MESSAGE_MIN_LENGTH && !isSubmitting;

  function handleMessageChange(value: string) {
    setMessage(value);
    // Never show a preview that no longer matches the text on screen.
    if (previewResponse) setPreviewResponse(null);
  }

  async function handleSubmit() {
    if (!canSubmit) return;

    const tg = window.Telegram?.WebApp;
    if (!tg) return;

    setSubmitting(true);
    setErrorMessage(null);
    setPreviewResponse(null);

    const result = await fetchBetPreview(tg.initData, message.trim());

    setSubmitting(false);

    if (!result.ok) {
      setErrorMessage(getBetPreviewErrorMessage(result.failure));
      triggerHaptic("error");
      return;
    }

    setPreviewResponse(result.data);

    if (result.data.oddsCheck && result.data.oddsCheck.matched && result.data.oddsCheck.withinTolerance === false) {
      triggerHaptic("warning-light");
    } else {
      triggerHaptic("success");
    }
  }

  function handleEditMessage() {
    setPreviewResponse(null);
  }

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

      <p className="mt-3 text-xl font-bold text-white">Place a bet</p>
      <p className="mt-1 text-sm text-slate-400">Describe your bet in one message</p>

      {!previewResponse && (
        <div className="mt-4">
          <textarea
            value={message}
            onChange={(event) => handleMessageChange(event.target.value)}
            maxLength={MESSAGE_MAX_LENGTH}
            placeholder="Real Madrid win, stake 100, odds 2.10"
            aria-label="Bet message"
            disabled={isSubmitting}
            className="w-full resize-none rounded-2xl p-3 text-base text-white placeholder:text-slate-500"
            style={{
              minHeight: 110,
              background: "rgba(255,255,255,0.03)",
              border: "1px solid rgba(255,255,255,0.08)",
            }}
          />

          <p className="mt-1 text-right text-xs text-slate-500">
            {message.length} / {MESSAGE_MAX_LENGTH}
          </p>

          <button
            type="button"
            onClick={handleSubmit}
            disabled={!canSubmit}
            aria-label="Preview bet"
            className="mt-3 min-h-11 w-full rounded-2xl text-[15px] font-semibold disabled:opacity-50"
            style={{
              background: "#60E84A",
              color: "#04170C",
            }}
          >
            {isSubmitting ? "Checking bet..." : "Preview bet"}
          </button>

          {errorMessage && (
            <p role="alert" className="mt-3 text-sm text-red-400">
              {errorMessage}
            </p>
          )}
        </div>
      )}

      {previewResponse && (
        <div className="mt-4">
          <PreviewCard preview={previewResponse.preview} />
          <OddsStatus oddsCheck={previewResponse.oddsCheck} />

          <button
            type="button"
            onClick={handleEditMessage}
            className="mt-3 min-h-11 w-full rounded-2xl text-[15px] font-medium text-slate-400"
            style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)" }}
          >
            Edit message
          </button>
        </div>
      )}
    </div>
  );
}

function PreviewCard({ preview }: { preview: BetPreview }) {
  return (
    <div
      className="rounded-2xl p-4"
      style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)" }}
    >
      <PreviewRow label="Bet type" value="Single" />
      <PreviewRow label="Sport" value={preview.sport} />
      <PreviewRow label="Event" value={preview.event} wrap />
      <PreviewRow label="Selection" value={preview.outcome} wrap />
      <PreviewRow label="Stake" value={formatAmount(preview.stake)} />
      <PreviewRow
        label="Submitted odds"
        value={preview.odds !== null ? formatAmount(preview.odds) : "Not provided"}
      />
      <PreviewRow
        label="Potential win"
        value={preview.potentialWin !== null ? formatAmount(preview.potentialWin) : "Not available"}
        last
      />
    </div>
  );
}

function PreviewRow({
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

function OddsStatus({ oddsCheck }: { oddsCheck: BetOddsCheck | null }) {
  if (!oddsCheck) {
    return (
      <StatusBox
        tone="neutral"
        label="Odds not provided"
        description="Add odds to verify them against the bookmaker feed."
      />
    );
  }

  if (!oddsCheck.matched) {
    return (
      <StatusBox
        tone="warning"
        label="Odds could not be verified"
        description={oddsCheck.note ?? "No matching market was found."}
      />
    );
  }

  const discrepancy =
    oddsCheck.discrepancyPercent !== null ? Math.abs(oddsCheck.discrepancyPercent).toFixed(2) : "—";

  if (oddsCheck.withinTolerance === true) {
    return (
      <StatusBox
        tone="success"
        label="Odds verified"
        description={
          <>
            Bookmaker odds: {oddsCheck.sourceOdds !== null ? formatAmount(oddsCheck.sourceOdds) : "—"}
            <br />
            Difference: {discrepancy}%
            {oddsCheck.bookmaker ? (
              <>
                <br />
                {oddsCheck.bookmaker}
              </>
            ) : null}
          </>
        }
      />
    );
  }

  // matched === true && withinTolerance === false
  return (
    <StatusBox
      tone="warning"
      label="Odds changed"
      description={
        <>
          Submitted: {formatAmount(oddsCheck.submittedOdds)}
          <br />
          Current: {oddsCheck.sourceOdds !== null ? formatAmount(oddsCheck.sourceOdds) : "—"}
          <br />
          Difference: {discrepancy}%
          {oddsCheck.bookmaker ? (
            <>
              <br />
              {oddsCheck.bookmaker}
            </>
          ) : null}
        </>
      }
    />
  );
}

function StatusBox({
  tone,
  label,
  description,
}: {
  tone: "neutral" | "success" | "warning";
  label: string;
  description: ReactNode;
}) {
  const color = tone === "success" ? "#60E84A" : tone === "warning" ? "#E8B84A" : "#94a3b8";

  return (
    <div
      className="mt-2 rounded-2xl p-4"
      style={{ background: "rgba(255,255,255,0.03)", border: `1px solid ${color}33` }}
    >
      <p className="text-sm font-semibold" style={{ color }}>
        {label}
      </p>
      <p className="mt-1 text-xs leading-relaxed text-slate-400">{description}</p>
    </div>
  );
}
