"use client";

import { useEffect, useRef, useState } from "react";
import { Camera, Images, ScanLine } from "lucide-react";
import {
  fetchBetScreenshotPreview,
  getBetScreenshotErrorMessage,
  type BetScreenshotFailure,
} from "./betScreenshotApi";
import {
  fetchBetConfirm,
  getBetConfirmErrorMessage,
  shouldResetPreviewAfterConfirmFailure,
  type ConfirmedBet,
} from "./betConfirmApi";
import { OddsStatus, PreviewCard } from "./BetPreviewCard";
import type { BetPreviewSuccess } from "./betPreviewApi";

interface BetScreenshotFormProps {
  onBack: () => void;
  onConfirmed: (bet: ConfirmedBet) => void;
}

// Mirrors the screenshot preview endpoint's own limits
// (app/api/miniapp/bets/text/../screenshot/preview/route.ts) — checked here
// only for fast client-side feedback; the server remains the real authority.
const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;
const ALLOWED_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

// Duplicated from BetTextForm.tsx rather than shared — same reasoning as
// this project's established small-helper duplication (e.g. each route's
// own extractInitData): it's a self-contained ~15-line guarded accessor,
// not worth a new shared file for.
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

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

type FormPhase = "idle" | "selected" | "recognizing" | "ready" | "confirming";

// "Send a screenshot" screen: pick an image -> POST .../screenshot/preview
// -> the exact same preview UI (BetPreviewCard.tsx) BetTextForm uses -> POST
// .../text/confirm (fetchBetConfirm, unchanged, reused as-is: the screenshot
// preview endpoint signs the same kind of previewToken the confirm route
// already accepts). Mirrors BetTextForm's phase/guard-ref architecture
// (Stage 4.4B) rather than inventing a new pattern.
export default function BetScreenshotForm({ onBack, onConfirmed }: BetScreenshotFormProps) {
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [phase, setPhase] = useState<FormPhase>("idle");
  // preview.previewToken lives here in memory only, same discipline as
  // BetTextForm — never rendered, decoded, logged, or persisted.
  const [preview, setPreview] = useState<BetPreviewSuccess | null>(null);
  const [error, setError] = useState<string | null>(null);

  const isMountedRef = useRef(true);
  const requestTokenRef = useRef(0);
  const inFlightRef = useRef(false);
  const confirmControllerRef = useRef<AbortController | null>(null);
  // Mirrors `previewUrl` state so the unmount cleanup effect (which only
  // runs once, with a stale closure) can always revoke whatever the latest
  // object URL actually was, not just the one from initial mount.
  const previewUrlRef = useRef<string | null>(null);

  const galleryInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      confirmControllerRef.current?.abort();
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    };
  }, []);

  function setPreviewUrlTracked(url: string | null) {
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    previewUrlRef.current = url;
    setPreviewUrl(url);
  }

  function showClientValidationError(failure: BetScreenshotFailure) {
    setError(getBetScreenshotErrorMessage(failure));
    triggerHaptic("error");
  }

  function handleFileSelected(selected: File) {
    if (!ALLOWED_MIME_TYPES.has(selected.type)) {
      showClientValidationError({ kind: "http", code: "UNSUPPORTED_FILE_TYPE" });
      return;
    }

    if (selected.size === 0) {
      showClientValidationError({ kind: "http", code: "EMPTY_FILE" });
      return;
    }

    if (selected.size > MAX_FILE_SIZE_BYTES) {
      showClientValidationError({ kind: "http", code: "FILE_TOO_LARGE" });
      return;
    }

    setError(null);
    setPreview(null);
    setFile(selected);
    setPreviewUrlTracked(URL.createObjectURL(selected));
    setPhase("selected");
  }

  function handleGalleryChange(event: React.ChangeEvent<HTMLInputElement>) {
    const selected = event.target.files?.[0];
    event.target.value = ""; // allow re-selecting the same file later
    if (selected) handleFileSelected(selected);
  }

  function handleCameraChange(event: React.ChangeEvent<HTMLInputElement>) {
    const selected = event.target.files?.[0];
    event.target.value = "";
    if (selected) handleFileSelected(selected);
  }

  function handleRemove() {
    if (phase === "recognizing" || phase === "confirming") return;
    setFile(null);
    setPreviewUrlTracked(null);
    setPreview(null);
    setError(null);
    setPhase("idle");
  }

  const canRecognize = phase === "selected" && file !== null;
  // Stage 12, Phase 3 — EXPRESS confirm isn't implemented yet
  // (createBetFromPreview.ts only models one selection, and
  // buildBetSlipPreview.ts deliberately never signs a token for EXPRESS —
  // see that file's own comment). previewToken !== null is the real
  // technical guard; preview.type === "SINGLE" is checked too so this
  // reads as the actual business rule, not just "a token happened to exist".
  const canConfirm =
    phase === "ready" && preview !== null && preview.preview.type === "SINGLE" && preview.previewToken !== null;

  async function handleRecognize() {
    if (!canRecognize || !file || inFlightRef.current) return;

    const tg = window.Telegram?.WebApp;
    if (!tg) return;

    inFlightRef.current = true;
    const myRequest = ++requestTokenRef.current;

    setPhase("recognizing");
    setError(null);

    const result = await fetchBetScreenshotPreview(tg.initData, file);

    inFlightRef.current = false;
    if (!isMountedRef.current || requestTokenRef.current !== myRequest) return;

    if (!result.ok) {
      // Every screenshot-preview failure is a failed recognition attempt on
      // the same file, not a stale-token situation like confirm's — always
      // return to "selected" so the user can retry or pick a different
      // image, never force them back to choosing from scratch.
      setPhase("selected");
      setError(getBetScreenshotErrorMessage(result.failure));
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

  function handleChooseDifferent() {
    if (phase === "confirming") return;
    setFile(null);
    setPreviewUrlTracked(null);
    setPreview(null);
    setError(null);
    setPhase("idle");
  }

  async function handleConfirm() {
    if (!canConfirm || !preview || inFlightRef.current) return;

    // canConfirm already guards preview.previewToken !== null, but that's a
    // separate boolean — TS can't infer it back onto `preview` here, so
    // this re-checks explicitly rather than asserting with `!`.
    const previewToken = preview.previewToken;
    if (previewToken === null) return;

    const tg = window.Telegram?.WebApp;
    if (!tg) return;

    inFlightRef.current = true;
    const myRequest = ++requestTokenRef.current;

    const controller = new AbortController();
    confirmControllerRef.current = controller;

    setPhase("confirming");
    setError(null);

    const result = await fetchBetConfirm(tg.initData, previewToken, controller.signal);

    inFlightRef.current = false;
    confirmControllerRef.current = null;
    if (!isMountedRef.current || requestTokenRef.current !== myRequest) return;

    if (!result.ok) {
      if (result.failure.kind === "aborted") return;

      if (shouldResetPreviewAfterConfirmFailure(result.failure)) {
        setPreview(null);
        setPhase(file ? "selected" : "idle");
      } else {
        setPhase("ready");
      }

      setError(getBetConfirmErrorMessage(result.failure));
      triggerHaptic("error");
      return;
    }

    triggerHaptic("success");
    setPreview(null);
    setPreviewUrlTracked(null);
    setFile(null);
    onConfirmed(result.data.bet);
  }

  const showSelectionBlock = phase === "idle" || phase === "selected" || phase === "recognizing";
  const showPreviewBlock = phase === "ready" || phase === "confirming";

  return (
    // min-h-[70dvh]: this component doesn't own its page shell (the
    // surrounding WelcomeBanner/BottomNav layout lives in page.tsx/
    // BetScreen.tsx, out of scope here), so there's no exact "remaining
    // viewport height" this file can compute. 70dvh is a deliberate,
    // documented approximation — tall enough that the flex-1 group below
    // reads as genuinely centered on real phone screens, conservative
    // enough to avoid pushing content under the fixed bottom nav before
    // that's even a concern.
    <div className="mx-auto flex min-h-[70dvh] w-full max-w-[420px] flex-col">
      <button
        type="button"
        onClick={onBack}
        className="text-sm font-medium text-slate-400"
        aria-label="Back"
      >
        ‹ Back
      </button>

      {/* Both inputs stay mounted (hidden) regardless of phase, so the
          trigger buttons below can always ref.click() them reliably. */}
      <input
        ref={galleryInputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        onChange={handleGalleryChange}
        aria-label="Choose image from gallery"
        className="hidden"
      />
      <input
        ref={cameraInputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        capture="environment"
        onChange={handleCameraChange}
        aria-label="Take a photo"
        className="hidden"
      />

      {/* Everything below Back is one vertical group — hero icon, title,
          subtitle, and whichever action content the current phase shows
          (the two choice buttons, or the selected-image/preview states) —
          centered together in the remaining space below Back, not just a
          centered text block sitting at the top. Same ScanLine icon as the
          action sheet entry (BetActionSheet.tsx) and BetScreen's own main
          CTA, so the visual thread carries through from "tap Send
          screenshot" to landing here. */}
      <div className="flex flex-1 flex-col items-center justify-center text-center">
        <div
          className="flex h-16 w-16 items-center justify-center rounded-full"
          style={{ background: "rgba(96,232,74,0.14)", boxShadow: "0 0 28px 6px rgba(96,232,74,0.22)" }}
        >
          <ScanLine size={32} strokeWidth={2} color="#60E84A" aria-hidden="true" />
        </div>
        <p className="mt-5 text-xl font-bold text-white">Upload your bet slip</p>
        <p className="mt-2 text-sm text-slate-400">Choose a photo from your gallery or take a new one.</p>

        {showSelectionBlock && (
          <div className="mt-8 w-full">
            {!file && (
              <div className="flex flex-col gap-2">
                <button
                  type="button"
                  onClick={() => galleryInputRef.current?.click()}
                  aria-label="Choose image from gallery"
                  className="flex min-h-11 w-full items-center justify-center gap-2 rounded-2xl text-[15px] font-semibold"
                  style={{
                    background: "#60E84A",
                    color: "#04170C",
                  }}
                >
                  <Images size={18} strokeWidth={2} aria-hidden="true" />
                  Choose from gallery
                </button>

                <button
                  type="button"
                  onClick={() => cameraInputRef.current?.click()}
                  aria-label="Take a photo"
                  className="flex min-h-11 w-full items-center justify-center gap-2 rounded-2xl text-[15px] font-medium text-slate-400"
                  style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)" }}
                >
                  <Camera size={18} strokeWidth={2} aria-hidden="true" />
                  Take photo
                </button>
              </div>
            )}

            {file && previewUrl && (
              <div>
                <div
                  className="overflow-hidden rounded-2xl"
                  style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)" }}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element -- a
                      local blob: object URL, not an optimizable remote image */}
                  <img
                    src={previewUrl}
                    alt="Selected bet slip screenshot"
                    className="max-h-64 w-full object-contain"
                  />
                </div>

                <div className="mt-2 flex items-center justify-between gap-3">
                  <p className="min-w-0 flex-1 truncate text-sm text-slate-300">{file.name}</p>
                  <span className="shrink-0 text-xs text-slate-500">{formatFileSize(file.size)}</span>
                </div>

                <button
                  type="button"
                  onClick={handleRecognize}
                  disabled={!canRecognize}
                  aria-label="Recognize bet"
                  className="mt-3 min-h-11 w-full rounded-2xl text-[15px] font-semibold disabled:opacity-50"
                  style={{
                    background: "#60E84A",
                    color: "#04170C",
                  }}
                >
                  {phase === "recognizing" ? "Recognizing..." : "Recognize bet"}
                </button>

                <button
                  type="button"
                  onClick={handleRemove}
                  disabled={phase === "recognizing"}
                  aria-label="Remove image"
                  className="mt-3 min-h-11 w-full rounded-2xl text-[15px] font-medium text-slate-400 disabled:opacity-50"
                  style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)" }}
                >
                  Remove
                </button>
              </div>
            )}

            {error && (
              <p role="alert" className="mt-3 whitespace-pre-line text-sm text-red-400">
                {error}
              </p>
            )}
          </div>
        )}

        {showPreviewBlock && preview && (
          <div className="mt-4 w-full">
            <PreviewCard preview={preview.preview} />
            <OddsStatus preview={preview.preview} />

            {error && (
              <p role="alert" className="mt-3 whitespace-pre-line text-sm text-red-400">
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

            {/* Stage 12, Phase 3 — EXPRESS confirm isn't implemented yet;
                see the canConfirm comment above for why. */}
            {preview.preview.type === "EXPRESS" && (
              <p className="mt-2 text-center text-xs text-slate-500">
                Express confirmation will be enabled in the next phase.
              </p>
            )}

            <button
              type="button"
              onClick={handleChooseDifferent}
              disabled={phase === "confirming"}
              aria-label="Choose different image"
              className="mt-3 min-h-11 w-full rounded-2xl text-[15px] font-medium text-slate-400 disabled:opacity-50"
              style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)" }}
            >
              Choose different image
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
