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
import { useLocale } from "./LocaleProvider";

interface BetTextFormProps {
  onBack: () => void;
  onConfirmed: (bet: AnyConfirmedBet) => void;
}


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

// Bet-type selector for the top of the "Place a bet" screen. Its literal
// value is never sent to the API, and the AI parser server-side is still
// the sole authority on the actual SINGLE/EXPRESS classification
// (preview.preview.type) — this tab only decides which LOCAL structured
// input UI is shown (one Event/Selection/Stake form vs. a multi-leg list +
// shared Stake) and, from there, which composed text handlePreviewSubmit
// sends. A player who types an EXPRESS-shaped sentence into SINGLE's
// composed text (or vice versa) still gets whatever the parser actually
// determines, unaffected by which tab was active.
type BetTypeTab = "single" | "express";

// Structured SINGLE input — Event / Selection / Stake. Exported as pure
// functions (same convention as e.g. BetPreviewCard.tsx's
// isProviderUnavailable, SelectionRow.tsx's getOddsPresentation) so the
// validation/composition logic is directly unit-testable without this
// project's deliberately absent DOM-rendering test infra.

// A stake must be a real, finite, positive number — the exact same
// "genuinely usable amount" bar the free-text flow's own AI parser already
// enforces server-side (lib/ai/betParser.ts's stake: z.number().positive());
// checked here only so the Review bet button can honestly reflect
// readiness before ever reaching the network.
export function isValidStakeInput(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0) return false;
  const numeric = Number(trimmed);
  return Number.isFinite(numeric) && numeric > 0;
}

export function isSingleBetReady(eventValue: string, selectionValue: string, stakeValue: string): boolean {
  return eventValue.trim().length > 0 && selectionValue.trim().length > 0 && isValidStakeInput(stakeValue);
}

// The AI parser/preview endpoint (POST .../text/preview) only ever accepts
// one free-text string — this is the one, minimal seam that lets the new
// structured SINGLE fields reuse that exact same, otherwise completely
// unmodified endpoint/parser/preview pipeline. A simple comma-joined
// composition of the player's own three raw values, structurally identical
// to bet slips the parser already handles today (e.g. "Real Madrid win,
// stake 100") — no locale-specific phrasing, so it behaves identically
// regardless of UI language.
export function buildSingleSubmissionText(eventValue: string, selectionValue: string, stakeValue: string): string {
  return `${eventValue.trim()}, ${selectionValue.trim()}, ${stakeValue.trim()}`;
}

// Structured EXPRESS input — a variable number of legs (Event + Selection
// each) sharing exactly one Stake. Mirrors the MIN/MAX_EXPRESS_SELECTIONS
// bounds the backend already enforces (lib/bets/betSlipRules.ts,
// lib/betPreview/previewToken.ts's signExpressPreviewToken) so the "+ Add
// event"/remove-leg UI can never build something the parser's own
// extract_express_bet tool or buildBetSlipPreview.ts would reject purely on
// leg count — duplicated as literals here for the same reason those two
// files already duplicate it from each other rather than importing.
export const MIN_EXPRESS_LEGS = 2;
export const MAX_EXPRESS_LEGS = 10;

export interface ExpressLegInput {
  event: string;
  selection: string;
}

// UI-only shape: `id` is a stable React key/removal handle, never sent to
// the parser or read by any of the pure functions above (they all take
// plain ExpressLegInput[], id-free) — kept local to this file rather than
// exported.
interface ExpressLeg extends ExpressLegInput {
  id: number;
}

export function isExpressLegComplete(leg: ExpressLegInput): boolean {
  return leg.event.trim().length > 0 && leg.selection.trim().length > 0;
}

export function isExpressBetReady(legs: ExpressLegInput[], stakeValue: string): boolean {
  return (
    legs.length >= MIN_EXPRESS_LEGS &&
    legs.length <= MAX_EXPRESS_LEGS &&
    legs.every(isExpressLegComplete) &&
    isValidStakeInput(stakeValue)
  );
}

// Same seam as buildSingleSubmissionText — one free-text string for the
// unmodified preview endpoint/parser. Each leg is joined "Event, Selection",
// legs are separated by "; ", and the shared stake is named explicitly
// ("stake 100") since — unlike SINGLE's single implicit trailing number —
// EXPRESS has several numbers-shaped fragments in play (odds/scorelines
// inside event names) and only one of them is actually the stake; this is
// the same disambiguating convention buildSingleSubmissionText's own comment
// already cites the parser as handling today (e.g. "Real Madrid win, stake
// 100").
export function buildExpressSubmissionText(legs: ExpressLegInput[], stakeValue: string): string {
  const legsText = legs.map((leg) => `${leg.event.trim()}, ${leg.selection.trim()}`).join("; ");
  return `${legsText}; stake ${stakeValue.trim()}`;
}

// "Place a bet" screen: free-text message -> POST /api/miniapp/bets/text/preview
// -> read-only preview + odds status -> POST .../confirm -> a real Bet
// (Stage 4.4B). `phase` is the single source of truth for which block is
// rendered; `preview !== null` is the single source of truth for whether a
// still-usable previewToken exists (never duplicated elsewhere).
export default function BetTextForm({ onBack, onConfirmed }: BetTextFormProps) {
  const { t, locale } = useLocale();
  // Structured SINGLE input. Independent state (not derived from/synced
  // with the EXPRESS state below) so switching tabs never mixes the two
  // modes' input together.
  const [eventValue, setEventValue] = useState("");
  const [selectionValue, setSelectionValue] = useState("");
  const [stakeValue, setStakeValue] = useState("");
  // Structured EXPRESS input — a variable-length list of legs (each with
  // its own stable `id`, never the array index, so removing a leg from the
  // middle can't cause React to rebind a later leg's inputs onto the
  // removed one's DOM node) plus one shared stake, completely independent
  // of SINGLE's fields above.
  const legIdRef = useRef(2);
  const [expressLegs, setExpressLegs] = useState<ExpressLeg[]>(() => [
    { id: 0, event: "", selection: "" },
    { id: 1, event: "", selection: "" },
  ]);
  const [expressStakeValue, setExpressStakeValue] = useState("");
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

  // SINGLE's readiness comes from its three structured fields; EXPRESS's
  // comes from its leg list + shared stake. Never both at once —
  // betTypeTab picks exactly one.
  const canSubmitPreview =
    phase === "editing" &&
    (betTypeTab === "single"
      ? isSingleBetReady(eventValue, selectionValue, stakeValue)
      : isExpressBetReady(expressLegs, expressStakeValue));
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

  // Shared by every input change below (message, and now the three
  // structured SINGLE fields) — never show a preview (or keep a token)
  // that no longer matches what's on screen.
  function resetPreviewIfShown() {
    if (preview) {
      setPreview(null);
      setPhase("editing");
    }
  }

  function handleEventChange(value: string) {
    setEventValue(value);
    resetPreviewIfShown();
  }

  function handleSelectionChange(value: string) {
    setSelectionValue(value);
    resetPreviewIfShown();
  }

  function handleStakeChange(value: string) {
    setStakeValue(value);
    resetPreviewIfShown();
  }

  function handleExpressLegEventChange(id: number, value: string) {
    setExpressLegs((legs) => legs.map((leg) => (leg.id === id ? { ...leg, event: value } : leg)));
    resetPreviewIfShown();
  }

  function handleExpressLegSelectionChange(id: number, value: string) {
    setExpressLegs((legs) => legs.map((leg) => (leg.id === id ? { ...leg, selection: value } : leg)));
    resetPreviewIfShown();
  }

  function handleExpressStakeChange(value: string) {
    setExpressStakeValue(value);
    resetPreviewIfShown();
  }

  function handleAddExpressLeg() {
    if (expressLegs.length >= MAX_EXPRESS_LEGS) return;
    const nextId = legIdRef.current;
    legIdRef.current += 1;
    setExpressLegs((legs) => [...legs, { id: nextId, event: "", selection: "" }]);
    resetPreviewIfShown();
  }

  // Never removes below MIN_EXPRESS_LEGS — the remove control itself is
  // only rendered once a leg count exceeds the minimum (see the JSX below),
  // but this guard makes that the actual invariant rather than a UI-only
  // convention.
  function handleRemoveExpressLeg(id: number) {
    if (expressLegs.length <= MIN_EXPRESS_LEGS) return;
    setExpressLegs((legs) => legs.filter((leg) => leg.id !== id));
    resetPreviewIfShown();
  }

  // SINGLE and EXPRESS now hold genuinely different underlying data (three
  // structured fields vs. one free-text message) — switching tabs must
  // invalidate a stale preview from the mode being left, same principle as
  // editing any field above.
  function handleBetTypeChange(tab: BetTypeTab) {
    setBetTypeTab(tab);
    resetPreviewIfShown();
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

    // Both modes compose their structured fields into one free-text
    // string — the AI parser/preview endpoint (POST .../text/preview)
    // never sees a difference between a structured submission and a
    // hand-typed one.
    const textToSubmit =
      betTypeTab === "single"
        ? buildSingleSubmissionText(eventValue, selectionValue, stakeValue)
        : buildExpressSubmissionText(expressLegs, expressStakeValue);
    const result = await fetchBetPreview(tg.initData, textToSubmit);

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
      setError(getBetPreviewErrorMessage(result.failure, locale));
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
      setError(t("error.telegramUnavailable"));
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
      setError(getBetPreviewErrorMessage(result.failure, locale));
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
      setError(t("error.telegramUnavailable"));
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
      setError(t("error.generic"));
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

      setError(getBetConfirmErrorMessage(result.failure, locale));
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
        aria-label={t("bet.back")}
      >
        ‹ {t("bet.back")}
      </button>

      <p className="mt-3 text-xl font-bold text-white">{t("bet.placeBet")}</p>

      <div
        role="tablist"
        aria-label={t("bet.typeAriaLabel")}
        className="mt-3 flex items-center gap-1 rounded-2xl p-1"
        style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)" }}
      >
        <button
          type="button"
          role="tab"
          aria-selected={betTypeTab === "single"}
          onClick={() => handleBetTypeChange("single")}
          className="min-h-9 flex-1 rounded-xl text-sm font-semibold transition-colors active:opacity-80"
          style={
            betTypeTab === "single"
              ? { background: "#60E84A", color: "#04170C" }
              : { background: "transparent", color: "#94A3B8" }
          }
        >
          {t("bet.single")}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={betTypeTab === "express"}
          onClick={() => handleBetTypeChange("express")}
          className="min-h-9 flex-1 rounded-xl text-sm font-semibold transition-colors active:opacity-80"
          style={
            betTypeTab === "express"
              ? { background: "#60E84A", color: "#04170C" }
              : { background: "transparent", color: "#94A3B8" }
          }
        >
          {t("bet.express")}
        </button>
      </div>

      {showEditingBlock && (
        <div className="mt-4">
          {betTypeTab === "single" ? (
            // Structured SINGLE input — one compact vertical form, not
            // three independent cards. Same dark/slate tokens as the
            // EXPRESS textarea below (rgba(255,255,255,0.03) background,
            // rgba(255,255,255,0.08) border, rounded-2xl) so it reads as a
            // natural evolution of this screen, not a new design.
            <div className="space-y-3">
              <div>
                <label className="mb-1 block text-xs text-slate-500">{t("bet.eventLabel")}</label>
                <input
                  type="text"
                  value={eventValue}
                  onChange={(event) => handleEventChange(event.target.value)}
                  placeholder={t("bet.eventPlaceholder")}
                  aria-label={t("bet.eventLabel")}
                  disabled={phase === "previewing"}
                  className="w-full rounded-2xl px-3 py-3 text-base text-white placeholder:text-slate-600 focus:outline-none"
                  style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)" }}
                />
              </div>

              <div>
                <label className="mb-1 block text-xs text-slate-500">{t("bet.selectionLabel")}</label>
                <input
                  type="text"
                  value={selectionValue}
                  onChange={(event) => handleSelectionChange(event.target.value)}
                  placeholder={t("bet.selectionPlaceholder")}
                  aria-label={t("bet.selectionLabel")}
                  disabled={phase === "previewing"}
                  className="w-full rounded-2xl px-3 py-3 text-base text-white placeholder:text-slate-600 focus:outline-none"
                  style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)" }}
                />
              </div>

              <div>
                <label className="mb-1 block text-xs text-slate-500">{t("bet.stakeLabel")}</label>
                {/* USDC is this product's one fixed stake currency — the
                    exact same fixed asset ticker BetPreviewCard.tsx's/
                    BetTicket.tsx's Potential-win figures already display
                    elsewhere in this flow. Kept as a literal, not a
                    translation key, same convention as any other asset
                    ticker: it never changes by locale. */}
                <div
                  className="flex items-center rounded-2xl px-3 py-3"
                  style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)" }}
                >
                  <input
                    type="number"
                    inputMode="decimal"
                    min="0"
                    step="0.01"
                    value={stakeValue}
                    onChange={(event) => handleStakeChange(event.target.value)}
                    placeholder="0"
                    aria-label={t("bet.stakeLabel")}
                    disabled={phase === "previewing"}
                    className="w-full bg-transparent text-base text-white placeholder:text-slate-600 focus:outline-none"
                  />
                  <span className="shrink-0 pl-2 text-sm font-medium text-slate-400">USDC</span>
                </div>
              </div>
            </div>
          ) : (
            // Structured EXPRESS input — a compact, variable-length list of
            // legs (each just a small "Event N" title + Event/Selection
            // inputs, same dark/slate tokens as SINGLE above) followed by
            // "+ Add event" and exactly one shared Stake field. No per-leg
            // stake, no currency selector — mirrors SINGLE's Stake block
            // verbatim below.
            <div className="space-y-3">
              <div className="space-y-2">
                {expressLegs.map((leg, index) => (
                  <div
                    key={leg.id}
                    className="rounded-2xl p-3"
                    style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)" }}
                  >
                    <div className="mb-2 flex items-center justify-between">
                      <p className="text-xs font-semibold text-slate-500">
                        {t("bet.expressLegTitle", { number: String(index + 1) })}
                      </p>
                      {expressLegs.length > MIN_EXPRESS_LEGS && (
                        <button
                          type="button"
                          onClick={() => handleRemoveExpressLeg(leg.id)}
                          aria-label={t("bet.removeEvent", { number: String(index + 1) })}
                          disabled={phase === "previewing"}
                          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-sm text-slate-500 disabled:opacity-50"
                          style={{ background: "rgba(255,255,255,0.05)" }}
                        >
                          ×
                        </button>
                      )}
                    </div>

                    <input
                      type="text"
                      value={leg.event}
                      onChange={(event) => handleExpressLegEventChange(leg.id, event.target.value)}
                      placeholder={t("bet.expressEventPlaceholder")}
                      aria-label={t("bet.eventLabel")}
                      disabled={phase === "previewing"}
                      className="w-full rounded-xl px-3 py-2.5 text-base text-white placeholder:text-slate-600 focus:outline-none"
                      style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)" }}
                    />
                    <input
                      type="text"
                      value={leg.selection}
                      onChange={(event) => handleExpressLegSelectionChange(leg.id, event.target.value)}
                      placeholder={t("bet.expressSelectionPlaceholder")}
                      aria-label={t("bet.selectionLabel")}
                      disabled={phase === "previewing"}
                      className="mt-2 w-full rounded-xl px-3 py-2.5 text-base text-white placeholder:text-slate-600 focus:outline-none"
                      style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)" }}
                    />
                  </div>
                ))}
              </div>

              {expressLegs.length < MAX_EXPRESS_LEGS && (
                <button
                  type="button"
                  onClick={handleAddExpressLeg}
                  disabled={phase === "previewing"}
                  className="min-h-9 w-full rounded-xl text-sm font-semibold disabled:opacity-50"
                  style={{
                    background: "rgba(96,232,74,0.08)",
                    border: "1px solid rgba(96,232,74,0.25)",
                    color: "#60E84A",
                  }}
                >
                  {t("bet.addEvent")}
                </button>
              )}

              <div>
                <label className="mb-1 block text-xs text-slate-500">{t("bet.stakeLabel")}</label>
                {/* USDC is this product's one fixed stake currency — see the
                    identical SINGLE Stake block above for the full rationale. */}
                <div
                  className="flex items-center rounded-2xl px-3 py-3"
                  style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)" }}
                >
                  <input
                    type="number"
                    inputMode="decimal"
                    min="0"
                    step="0.01"
                    value={expressStakeValue}
                    onChange={(event) => handleExpressStakeChange(event.target.value)}
                    placeholder="0"
                    aria-label={t("bet.stakeLabel")}
                    disabled={phase === "previewing"}
                    className="w-full bg-transparent text-base text-white placeholder:text-slate-600 focus:outline-none"
                  />
                  <span className="shrink-0 pl-2 text-sm font-medium text-slate-400">USDC</span>
                </div>
              </div>
            </div>
          )}

          <button
            type="button"
            onClick={handlePreviewSubmit}
            disabled={!canSubmitPreview}
            aria-label={
              isTimeoutError ? t("bet.tryAgain") : betTypeTab === "single" ? t("bet.reviewBet") : t("bet.reviewExpress")
            }
            className="mt-3 min-h-11 w-full rounded-2xl text-[15px] font-semibold disabled:opacity-50"
            style={{
              background: "#60E84A",
              color: "#04170C",
            }}
          >
            {phase === "previewing"
              ? t("bet.checking")
              : isTimeoutError
                ? t("bet.tryAgain")
                : betTypeTab === "single"
                  ? t("bet.reviewBet")
                  : t("bet.reviewExpress")}
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
                {t("bet.timeoutTitle")}
              </p>
              <p className="mt-1 text-xs leading-relaxed text-slate-400">
                {t("bet.timeoutBody")}
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
              aria-label={t("confirm.confirmBet")}
              className="mt-2.5 min-h-11 w-full rounded-2xl text-[15px] font-semibold disabled:opacity-50"
              style={{
                background: "#60E84A",
                color: "#04170C",
              }}
            >
              {getConfirmButtonLabel(phase === "confirming", preview, locale)}
            </button>
          )}

          <button
            type="button"
            onClick={handleEditMessage}
            disabled={phase === "confirming"}
            aria-label={t("bet.editMessage")}
            className="mt-2.5 min-h-11 w-full rounded-2xl text-[15px] font-medium text-slate-400 disabled:opacity-50"
            style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)" }}
          >
            {t("bet.editMessage")}
          </button>
        </div>
      )}
    </div>
  );
}
