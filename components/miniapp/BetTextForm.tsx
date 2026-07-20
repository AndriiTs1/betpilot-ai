"use client";

import { useEffect, useRef, useState } from "react";
import { fetchBetPreview, getBetPreviewErrorMessage, type BetPreviewSuccess } from "./betPreviewApi";
import {
  fetchBetConfirm,
  getBetConfirmErrorMessage,
  shouldResetPreviewAfterConfirmFailure,
  type ConfirmedBet,
} from "./betConfirmApi";
import { OddsStatus, PreviewCard } from "./BetPreviewCard";

interface BetTextFormProps {
  onBack: () => void;
  onConfirmed: (bet: ConfirmedBet) => void;
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

type FormPhase = "editing" | "previewing" | "ready" | "confirming";

// "Place a bet" screen: free-text message -> POST /api/miniapp/bets/text/preview
// -> read-only preview + odds status -> POST .../confirm -> a real Bet
// (Stage 4.4B). `phase` is the single source of truth for which block is
// rendered; `preview !== null` is the single source of truth for whether a
// still-usable previewToken exists (never duplicated elsewhere).
export default function BetTextForm({ onBack, onConfirmed }: BetTextFormProps) {
  const [message, setMessage] = useState("");
  const [phase, setPhase] = useState<FormPhase>("editing");
  // preview.previewToken (Stage 4.3) lives here in memory only — never
  // rendered, decoded, logged, or persisted to storage. Cleared on confirm
  // success, on PREVIEW_EXPIRED/PREVIEW_INVALID/auth/registration failures,
  // and whenever the user edits the message or the odds no longer match the
  // text on screen. Kept across transient confirm failures (network/500/
  // timeout) so a retry doesn't require re-previewing.
  const [preview, setPreview] = useState<BetPreviewSuccess | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Stage 7.2 — temporary diagnostic status, visible under Confirm bet, so
  // the confirm flow can be observed without Telegram WebView console
  // access. Not part of normal UX; remove once the root cause is found.
  const [debugStatus, setDebugStatus] = useState<{ text: string; isError: boolean } | null>(null);

  // inFlightRef guards against a double click firing two requests: React
  // state updates aren't guaranteed to be visible to a second synchronous
  // click handler in the same tick, so the disabled-button prop alone isn't
  // enough. requestTokenRef + isMountedRef discard a response that's been
  // superseded (component unmounted, or a newer request started) so a late
  // reply can never overwrite a more recent state.
  const isMountedRef = useRef(true);
  const requestTokenRef = useRef(0);
  const inFlightRef = useRef(false);
  const confirmControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    // Explicitly reset on (re)mount, not just at useRef(true) declaration —
    // React Strict Mode's dev-only mount->cleanup->mount replay would
    // otherwise leave this permanently false after the very first render,
    // since a ref mutation survives that replay while the effect re-runs.
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      confirmControllerRef.current?.abort();
    };
  }, []);

  const trimmedLength = message.trim().length;
  const canSubmitPreview = phase === "editing" && trimmedLength >= MESSAGE_MIN_LENGTH;
  const canConfirm = phase === "ready" && preview !== null;

  function handleMessageChange(value: string) {
    setMessage(value);
    // Never show a preview (or keep a token) that no longer matches the
    // text on screen.
    if (preview) {
      setPreview(null);
      setPhase("editing");
      setDebugStatus(null);
    }
  }

  async function handlePreviewSubmit() {
    if (!canSubmitPreview || inFlightRef.current) return;

    const tg = window.Telegram?.WebApp;
    if (!tg) return;

    inFlightRef.current = true;
    const myRequest = ++requestTokenRef.current;

    setPhase("previewing");
    setError(null);

    const result = await fetchBetPreview(tg.initData, message.trim());

    inFlightRef.current = false;
    if (!isMountedRef.current || requestTokenRef.current !== myRequest) return;

    if (!result.ok) {
      setPhase("editing");
      setError(getBetPreviewErrorMessage(result.failure));
      triggerHaptic("error");
      return;
    }

    setPreview(result.data);
    setPhase("ready");

    if (result.data.oddsCheck && result.data.oddsCheck.matched && result.data.oddsCheck.withinTolerance === false) {
      triggerHaptic("warning-light");
    } else {
      triggerHaptic("success");
    }
  }

  function handleEditMessage() {
    if (phase === "confirming") return;
    setPreview(null);
    setPhase("editing");
    setError(null);
    setDebugStatus(null);
  }

  // Stage 7.2 — temporary diagnostic logging throughout this function (tag
  // "[ConfirmBet]") plus the debugStatus text shown under the Confirm bet
  // button. Never logs initData/previewToken in full, only presence/length.
  // No business logic changed — every setPhase/setPreview/setError call and
  // every early-return condition below is identical to before Stage 7.2.
  async function handleConfirm() {
    console.log("[ConfirmBet] handleConfirm: entered", {
      phase,
      hasPreview: preview !== null,
      canConfirm,
      inFlight: inFlightRef.current,
    });

    if (!canConfirm || !preview || inFlightRef.current) {
      console.log("[ConfirmBet] handleConfirm: blocked by guard clause — no request will be sent", {
        canConfirm,
        hasPreview: preview !== null,
        inFlight: inFlightRef.current,
      });
      return;
    }

    // window.Telegram?.WebApp / .initData are property reads on an object
    // injected by Telegram's own script — wrapped so a broken WebView
    // implementation surfaces as a visible diagnostic instead of a silent,
    // unexplained no-op.
    let tg: NonNullable<typeof window.Telegram>["WebApp"] | undefined;
    let initDataValue = "";
    try {
      tg = window.Telegram?.WebApp;
      initDataValue = tg?.initData ?? "";
    } catch (err) {
      const e = err as Partial<Error>;
      console.error("[ConfirmBet] handleConfirm: reading window.Telegram.WebApp/initData threw", {
        name: e?.name,
        message: e?.message,
        stack: e?.stack,
      });
      setDebugStatus({ text: "Telegram WebApp is unavailable.", isError: true });
      return;
    }

    if (!tg) {
      console.log("[ConfirmBet] handleConfirm: window.Telegram.WebApp is undefined — no request will be sent");
      setDebugStatus({ text: "Telegram WebApp is unavailable.", isError: true });
      return;
    }

    console.log("[ConfirmBet] handleConfirm: pre-flight check", {
      initDataPresent: initDataValue.length > 0,
      initDataLength: initDataValue.length,
      previewTokenPresent: preview.previewToken.length > 0,
      previewTokenLength: preview.previewToken.length,
    });

    setDebugStatus({ text: "Confirm handler started", isError: false });

    inFlightRef.current = true;
    const myRequest = ++requestTokenRef.current;

    const controller = new AbortController();
    confirmControllerRef.current = controller;

    setPhase("confirming");
    setError(null);

    setDebugStatus({ text: "Sending request...", isError: false });
    console.log("[ConfirmBet] handleConfirm: calling fetchBetConfirm");

    let result;
    try {
      result = await fetchBetConfirm(initDataValue, preview.previewToken, controller.signal);
    } catch (err) {
      // fetchBetConfirm always returns a BetConfirmResult and never throws
      // under normal operation — this catch is a diagnostic safety net only,
      // in case something unexpected escapes it.
      const e = err as Partial<Error> & { cause?: unknown };
      console.error("[ConfirmBet] handleConfirm: fetchBetConfirm threw unexpectedly", {
        name: e?.name,
        message: e?.message,
        stack: e?.stack,
        cause: e?.cause,
      });
      inFlightRef.current = false;
      confirmControllerRef.current = null;
      setPhase("ready");
      setDebugStatus({ text: `Unexpected error: ${e?.message ?? "unknown"}`, isError: true });
      return;
    }

    inFlightRef.current = false;
    confirmControllerRef.current = null;
    if (!isMountedRef.current || requestTokenRef.current !== myRequest) {
      console.log("[ConfirmBet] handleConfirm: result discarded (unmounted or superseded by a newer request)");
      return;
    }

    if (!result.ok) {
      console.error("[ConfirmBet] handleConfirm: fetchBetConfirm failed", result.failure);

      // Intentional cancellation (unmount/replacement) — never a real error.
      if (result.failure.kind === "aborted") {
        setDebugStatus(null);
        return;
      }

      if (shouldResetPreviewAfterConfirmFailure(result.failure)) {
        setPreview(null);
        setPhase("editing");
      } else {
        setPhase("ready");
      }

      const diagnosticText =
        result.failure.kind === "timeout" ? "Confirm request timed out." : getBetConfirmErrorMessage(result.failure);

      setError(getBetConfirmErrorMessage(result.failure));
      setDebugStatus({ text: diagnosticText, isError: true });
      triggerHaptic("error");
      return;
    }

    console.log("[ConfirmBet] handleConfirm: success", {
      betId: result.data.bet.id,
      idempotent: result.data.idempotent,
    });
    setDebugStatus({ text: "Bet submitted", isError: false });

    triggerHaptic("success");
    setPreview(null);
    onConfirmed(result.data.bet);
  }

  const showEditingBlock = phase === "editing" || phase === "previewing";
  const showPreviewBlock = phase === "ready" || phase === "confirming";

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

      {showEditingBlock && (
        <div className="mt-4">
          <textarea
            value={message}
            onChange={(event) => handleMessageChange(event.target.value)}
            maxLength={MESSAGE_MAX_LENGTH}
            placeholder="Real Madrid win, stake 100, odds 2.10"
            aria-label="Bet message"
            disabled={phase === "previewing"}
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
            onClick={handlePreviewSubmit}
            disabled={!canSubmitPreview}
            aria-label="Preview bet"
            className="mt-3 min-h-11 w-full rounded-2xl text-[15px] font-semibold disabled:opacity-50"
            style={{
              background: "#60E84A",
              color: "#04170C",
            }}
          >
            {phase === "previewing" ? "Checking bet..." : "Preview bet"}
          </button>

          {error && (
            <p role="alert" className="mt-3 text-sm text-red-400">
              {error}
            </p>
          )}
        </div>
      )}

      {showPreviewBlock && preview && (
        <div className="mt-4">
          <PreviewCard preview={preview.preview} />
          <OddsStatus oddsCheck={preview.oddsCheck} />

          {error && (
            <p role="alert" className="mt-3 text-sm text-red-400">
              {error}
            </p>
          )}

          <button
            type="button"
            onClick={handleConfirm}
            disabled={!canConfirm}
            aria-label="Confirm bet"
            className="mt-3 min-h-11 w-full rounded-2xl text-[15px] font-semibold disabled:opacity-50"
            style={{
              background: "#60E84A",
              color: "#04170C",
            }}
          >
            {phase === "confirming" ? "Confirming..." : "Confirm bet"}
          </button>

          {/* Stage 7.2 — temporary diagnostic status, remove once the root
              cause of the missing confirm request is found. */}
          {debugStatus && (
            <p
              className={`mt-1.5 text-center text-xs ${debugStatus.isError ? "text-red-400" : "text-slate-500"}`}
            >
              {debugStatus.text}
            </p>
          )}

          <button
            type="button"
            onClick={handleEditMessage}
            disabled={phase === "confirming"}
            aria-label="Edit message"
            className="mt-3 min-h-11 w-full rounded-2xl text-[15px] font-medium text-slate-400 disabled:opacity-50"
            style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)" }}
          >
            Edit message
          </button>
        </div>
      )}
    </div>
  );
}
