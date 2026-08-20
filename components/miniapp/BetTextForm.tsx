"use client";

import { useEffect, useRef, useState } from "react";
import {
  fetchBetPreview,
  fetchExpressLegExclusionPreview,
  getBetPreviewErrorMessage,
  isAiTimeoutFailure,
  type BetPreviewSuccess,
} from "./betPreviewApi";
import {
  fetchBetConfirm,
  getBetConfirmErrorMessage,
  shouldResetPreviewAfterConfirmFailure,
  buildOddsChangedReconfirm,
  type AnyConfirmedBet,
} from "./betConfirmApi";
import { OddsStatus, PreviewCard } from "./BetPreviewCard";
import { canConfirmBetSlip, getConfirmButtonLabel, isOddsUnavailableForConfirm } from "./canConfirmBetSlip";

interface BetTextFormProps {
  onBack: () => void;
  onConfirmed: (bet: AnyConfirmedBet) => void;
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

// Purely visual bet-type selector for the top of the "Place a bet" screen.
// Not read by handlePreviewSubmit or sent to the API — actual SINGLE/EXPRESS
// type is still decided entirely by the AI parser server-side
// (preview.preview.type). Wiring this to the request is a separate,
// out-of-scope change.
type BetTypeTab = "single" | "express";

// "Place a bet" screen: free-text message -> POST /api/miniapp/bets/text/preview
// -> read-only preview + odds status -> POST .../confirm -> a real Bet
// (Stage 4.4B). `phase` is the single source of truth for which block is
// rendered; `preview !== null` is the single source of truth for whether a
// still-usable previewToken exists (never duplicated elsewhere).
export default function BetTextForm({ onBack, onConfirmed }: BetTextFormProps) {
  const [message, setMessage] = useState("");
  const [betTypeTab, setBetTypeTab] = useState<BetTypeTab>("single");
  const [phase, setPhase] = useState<FormPhase>("editing");
  // preview.previewToken (Stage 4.3) lives here in memory only — never
  // rendered, decoded, logged, or persisted to storage. Cleared on confirm
  // success, on PREVIEW_EXPIRED/PREVIEW_INVALID/auth/registration failures,
  // and whenever the user edits the message or the odds no longer match the
  // text on screen. Kept across transient confirm failures (network/500/
  // timeout) so a retry doesn't require re-previewing.
  const [preview, setPreview] = useState<BetPreviewSuccess | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Step 15J.3 — true only for a preview failure specifically caused by an
  // AI-provider timeout (AI_TIMEOUT), so the editing block can swap its
  // generic red error line for the dedicated "AI service timed out / Try
  // again" treatment. Never derived from `error`'s string content — always
  // set from isAiTimeoutFailure(result.failure), the same structured check
  // betPreviewApi.ts itself exports. Reset everywhere `error` is reset, so
  // it can never outlive the failure that set it.
  const [isTimeoutError, setIsTimeoutError] = useState(false);
  // Sector 1 (ADR-0002) — non-null exactly while a leg-exclusion request for
  // that leg index is in flight; drives the Remove button's disabled/label
  // state (BetPreviewCard.tsx) and additionally gates canConfirm below, so
  // Confirm can't be tapped while the preview is about to change underneath
  // it.
  const [excludingLegIndex, setExcludingLegIndex] = useState<number | null>(null);

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
  // Sector 1 (ADR-0002) — separate from inFlightRef (preview/confirm) so a
  // double-tap on Remove can't fire two overlapping exclusion requests,
  // without overloading the existing preview/confirm in-flight guard or its
  // FormPhase state machine.
  const excludeInFlightRef = useRef(false);

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
  // Stage 12, Phase 4, Step 5 — EXPRESS confirm is now implemented
  // end-to-end (buildBetSlipPreview.ts signs an EXPRESS previewToken
  // whenever every selection's odds are known; the confirm route redeems
  // either token type). previewToken !== null is still the real guard —
  // it's null exactly when there's nothing valid to submit (e.g. an
  // EXPRESS slip missing some selection's odds), regardless of type.
  // Sector 1 (ADR-0002) — additionally false while a leg exclusion is
  // in-flight: the preview/token this button would submit is about to be
  // replaced, so Confirm must not be tappable in that window.
  const canConfirm = canConfirmBetSlip(phase === "ready", preview) && excludingLegIndex === null;
  // Stage M4.5 — CLEAN UNAVAILABLE-ODDS UX. When the odds themselves are
  // unavailable, there is no genuine confirmation action to offer, so the
  // button is omitted entirely rather than rendered disabled (see
  // isOddsUnavailableForConfirm's own comment for why this is independent
  // of phase/isReady).
  const oddsUnavailable = isOddsUnavailableForConfirm(preview);

  function handleMessageChange(value: string) {
    setMessage(value);
    // Never show a preview (or keep a token) that no longer matches the
    // text on screen.
    if (preview) {
      setPreview(null);
      setPhase("editing");
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
    setIsTimeoutError(false);

    const result = await fetchBetPreview(tg.initData, message.trim());

    inFlightRef.current = false;
    if (!isMountedRef.current || requestTokenRef.current !== myRequest) return;

    if (!result.ok) {
      // Step 15J.3 — the original text is never cleared/touched here (only
      // `phase`/`error`/`isTimeoutError` change), no preview/token is ever
      // created on this path, and `canSubmitPreview` (phase === "editing")
      // is what makes tapping the button again — now labeled "Try again"
      // for this specific failure — a genuine retry of the same message,
      // guarded by the same inFlightRef/canSubmitPreview double-submit
      // protection every other preview attempt already has.
      setPhase("editing");
      setIsTimeoutError(isAiTimeoutFailure(result.failure));
      setError(getBetPreviewErrorMessage(result.failure));
      triggerHaptic("error");
      return;
    }

    setPreview(result.data);
    setPhase("ready");

    const hasOddsChanged = result.data.preview.selections.some(
      (selection) => selection.oddsStatus === "ODDS_CHANGED",
    );
    if (hasOddsChanged) {
      triggerHaptic("warning-light");
    } else {
      triggerHaptic("success");
    }
  }

  // Sector 1 (ADR-0002) — EXPRESS per-leg unavailable recovery. Called only
  // with the index of a leg BetPreviewCard.tsx has already determined is
  // recoverable (isRecoverableLeg) — the server independently re-verifies
  // this (lib/bets/buildExpressLegExclusionPreview.ts), so a stale/forged
  // call still fails safe. Sends only [legIndex] and the already-signed
  // previewToken — never any odds/market/event data.
  async function handleExcludeLeg(legIndex: number) {
    if (excludeInFlightRef.current || !preview || preview.previewToken === null) return;

    let tg: NonNullable<typeof window.Telegram>["WebApp"] | undefined;
    let initDataValue = "";
    try {
      tg = window.Telegram?.WebApp;
      initDataValue = tg?.initData ?? "";
    } catch {
      setError("Telegram WebApp is unavailable.");
      return;
    }
    if (!tg) return;

    excludeInFlightRef.current = true;
    // Shares requestTokenRef with preview/confirm — a stale preview or
    // confirm response that lands after this exclusion request starts must
    // never overwrite the state this request is about to produce, and vice
    // versa; this is the same single "latest request wins" discipline every
    // other async operation in this form already uses.
    const myRequest = ++requestTokenRef.current;

    setExcludingLegIndex(legIndex);
    setError(null);
    setIsTimeoutError(false);

    const result = await fetchExpressLegExclusionPreview(initDataValue, preview.previewToken, [legIndex]);

    excludeInFlightRef.current = false;
    if (!isMountedRef.current || requestTokenRef.current !== myRequest) return;
    setExcludingLegIndex(null);

    if (!result.ok) {
      setError(getBetPreviewErrorMessage(result.failure));
      triggerHaptic("error");

      // The current preview's token is genuinely no longer usable — same
      // reset every other PREVIEW_EXPIRED/PREVIEW_INVALID failure in this
      // form already gets, so the player can't retry against a dead token.
      if (
        result.failure.kind === "http" &&
        (result.failure.code === "PREVIEW_EXPIRED" || result.failure.code === "PREVIEW_INVALID")
      ) {
        setPreview(null);
        setPhase("editing");
      }
      return;
    }

    // Atomically replaces the entire previous preview+token with the new
    // one — the old token is never separately retained anywhere in this
    // component; there is no second state slot it could linger in.
    setPreview(result.data);
    setPhase("ready");
    triggerHaptic("success");
  }

  function handleEditMessage() {
    if (phase === "confirming") return;
    setPreview(null);
    setPhase("editing");
    setError(null);
    setIsTimeoutError(false);
  }

  async function handleConfirm() {
    if (!canConfirm || !preview || inFlightRef.current) return;

    // canConfirm already guards preview.previewToken !== null, but that's a
    // separate boolean — TS can't infer it back onto `preview` here, so
    // this re-checks explicitly rather than asserting with `!`.
    const previewToken = preview.previewToken;
    if (previewToken === null) return;

    // window.Telegram?.WebApp / .initData are property reads on an object
    // injected by Telegram's own script — wrapped so a broken WebView
    // implementation can't crash the handler outright.
    let tg: NonNullable<typeof window.Telegram>["WebApp"] | undefined;
    let initDataValue = "";
    try {
      tg = window.Telegram?.WebApp;
      initDataValue = tg?.initData ?? "";
    } catch {
      setError("Telegram WebApp is unavailable.");
      return;
    }

    if (!tg) return;

    inFlightRef.current = true;
    const myRequest = ++requestTokenRef.current;

    const controller = new AbortController();
    confirmControllerRef.current = controller;

    setPhase("confirming");
    setError(null);
    setIsTimeoutError(false);

    let result;
    try {
      result = await fetchBetConfirm(initDataValue, previewToken, controller.signal);
    } catch {
      // fetchBetConfirm always returns a BetConfirmResult and never throws
      // under normal operation — this is a defensive fallback only, so an
      // unexpected exception can't leave the button stuck on "Confirming...".
      inFlightRef.current = false;
      confirmControllerRef.current = null;
      setPhase("ready");
      setError("Something went wrong. Please try again.");
      return;
    }

    inFlightRef.current = false;
    confirmControllerRef.current = null;
    if (!isMountedRef.current || requestTokenRef.current !== myRequest) return;

    if (!result.ok) {
      // Intentional cancellation (unmount/replacement) — never a real error.
      if (result.failure.kind === "aborted") return;

      // Step 15B — odds changed since the preview was generated: never
      // reuse the stale token, never auto-submit. Stage the server's fresh
      // refreshedPreview/refreshedPreviewToken and return to the ready
      // state so the existing "Confirm bet" button is what the player must
      // explicitly tap again — this is the exact same control-flow shape
      // every other ready-state confirm already goes through.
      // Stage M4.7 — SILENT CURRENT-ODDS PLAYER UX: no visible "offer
      // refreshed"/odds-changed message is shown for this — the refreshed
      // PreviewCard/OddsStatus above already display the new current
      // odds/potential win from the staged preview; the player is never
      // told a comparison happened, only shown today's price and asked to
      // confirm it (again) explicitly. Safety is unchanged: setPreview
      // still replaces the stale token with the fresh one, phase still
      // returns to "ready" (never auto-confirms), and Confirm bet still
      // requires its own explicit tap.
      if (result.failure.kind === "odds_changed") {
        const update = buildOddsChangedReconfirm(result.failure);
        setPreview(update.preview);
        setPhase("ready");
        triggerHaptic("warning-light");
        return;
      }

      if (shouldResetPreviewAfterConfirmFailure(result.failure)) {
        setPreview(null);
        setPhase("editing");
      } else {
        setPhase("ready");
      }

      setError(getBetConfirmErrorMessage(result.failure));
      triggerHaptic("error");
      return;
    }

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

      <div
        role="tablist"
        aria-label="Bet type"
        className="mt-3 flex items-center gap-1 rounded-2xl p-1"
        style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)" }}
      >
        <button
          type="button"
          role="tab"
          aria-selected={betTypeTab === "single"}
          onClick={() => setBetTypeTab("single")}
          className="min-h-9 flex-1 rounded-xl text-sm font-semibold transition-colors active:opacity-80"
          style={
            betTypeTab === "single"
              ? { background: "#60E84A", color: "#04170C" }
              : { background: "transparent", color: "#94A3B8" }
          }
        >
          Ординар
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={betTypeTab === "express"}
          onClick={() => setBetTypeTab("express")}
          className="min-h-9 flex-1 rounded-xl text-sm font-semibold transition-colors active:opacity-80"
          style={
            betTypeTab === "express"
              ? { background: "#60E84A", color: "#04170C" }
              : { background: "transparent", color: "#94A3B8" }
          }
        >
          Экспресс
        </button>
      </div>

      {showEditingBlock && (
        <div className="mt-4">
          <textarea
            value={message}
            onChange={(event) => handleMessageChange(event.target.value)}
            maxLength={MESSAGE_MAX_LENGTH}
            placeholder="Команда, исход, ставка"
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
            aria-label={isTimeoutError ? "Try again" : "Preview bet"}
            className="mt-3 min-h-11 w-full rounded-2xl text-[15px] font-semibold disabled:opacity-50"
            style={{
              background: "#60E84A",
              color: "#04170C",
            }}
          >
            {phase === "previewing" ? "Checking bet..." : isTimeoutError ? "Try again" : "Preview bet"}
          </button>

          {/* Step 15J.3 — a dedicated, non-alarming block for AI_TIMEOUT:
              the message was fine, nothing was rejected, the player just
              needs to tap the (now "Try again"-labeled) button above once
              more. Message text is left exactly as typed — this block
              never clears or touches it, and the button above resubmits
              that same, still-editable text. */}
          {isTimeoutError ? (
            <div
              role="alert"
              className="mt-3 rounded-2xl p-4"
              style={{ background: "rgba(255,255,255,0.03)", border: "1px solid #E8B84A33" }}
            >
              <p className="text-sm font-semibold" style={{ color: "#E8B84A" }}>
                AI service timed out
              </p>
              <p className="mt-1 text-xs leading-relaxed text-slate-400">
                Your bet was not rejected. The analysis took too long. Please try again.
              </p>
            </div>
          ) : (
            error && (
              <p role="alert" className="mt-3 whitespace-pre-line text-sm text-red-400">
                {error}
              </p>
            )
          )}
        </div>
      )}

      {showPreviewBlock && preview && (
        <div className="mt-3">
          <PreviewCard preview={preview.preview} onExcludeLeg={handleExcludeLeg} excludingLegIndex={excludingLegIndex} />
          <OddsStatus preview={preview.preview} />

          {/* Stage M4.7 — SILENT CURRENT-ODDS PLAYER UX: no separate
              odds-changed/"offer refreshed" banner — a confirm-time price
              move silently replaces `preview` above with the refreshed
              current odds/potential win; only a genuine confirm error
              (never a price change) shows here. */}
          {error && (
            <p role="alert" className="mt-3 whitespace-pre-line text-sm text-red-400">
              {error}
            </p>
          )}

          {!oddsUnavailable && (
            <button
              type="button"
              onClick={handleConfirm}
              disabled={!canConfirm}
              aria-label="Confirm bet"
              className="mt-2.5 min-h-11 w-full rounded-2xl text-[15px] font-semibold disabled:opacity-50"
              style={{
                background: "#60E84A",
                color: "#04170C",
              }}
            >
              {getConfirmButtonLabel(phase === "confirming", preview)}
            </button>
          )}

          <button
            type="button"
            onClick={handleEditMessage}
            disabled={phase === "confirming"}
            aria-label="Edit message"
            className="mt-2.5 min-h-11 w-full rounded-2xl text-[15px] font-medium text-slate-400 disabled:opacity-50"
            style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)" }}
          >
            Edit message
          </button>
        </div>
      )}
    </div>
  );
}
