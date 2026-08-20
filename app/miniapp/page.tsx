"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Image from "next/image";
import Script from "next/script";
import BottomNav from "@/components/miniapp/BottomNav";
import BetScreen from "@/components/miniapp/BetScreen";
import ActiveBetsScreen from "@/components/miniapp/ActiveBetsScreen";
import HistoryScreen from "@/components/miniapp/HistoryScreen";
import BalanceScreen from "@/components/miniapp/BalanceScreen";
import type { MiniAppTab, MeResponse } from "@/components/miniapp/types";
import type { AnyConfirmedBet } from "@/components/miniapp/betConfirmApi";
import { applyMiniAppDataAction } from "@/components/miniapp/mergeConfirmedBet";
import {
  isTelegramAuthErrorReason,
  getTelegramAuthErrorMessage,
} from "@/components/miniapp/telegramAuthError";
import { hasPendingBet } from "@/components/miniapp/hasPendingBet";
import { useLocale } from "@/components/miniapp/LocaleProvider";
import LanguageSwitcher from "@/components/miniapp/LanguageSwitcher";

// Phase 1 — investor-demo end-to-end flow: while the player has at least
// one PENDING bet, poll for the operator's confirm/reject decision every
// 5s so it shows up without the player closing and reopening the Mini App.
// Same silent-reconciliation mechanism as refreshDataSilently below, not a
// second data-loading system — this only decides *when* to call it.
const PENDING_BET_POLL_INTERVAL_MS = 5000;

interface TelegramWebApp {
  initData: string;
  // Localization foundation — Telegram's own already-parsed, UNVERIFIED
  // convenience object (distinct from the raw `initData` string used for
  // real HMAC auth verification, which this never touches). Read only for
  // a first-visit UI-language default (see LocaleProvider.tsx's
  // applyTelegramLanguageCode) — never for auth, never for bet parsing.
  initDataUnsafe?: { user?: { language_code?: string } };
  viewportStableHeight: number;
  ready: () => void;
  expand: () => void;
  onEvent: (
    eventType: "viewportChanged",
    callback: (event: { isStateStable: boolean }) => void,
  ) => void;
  offEvent: (
    eventType: "viewportChanged",
    callback: (event: { isStateStable: boolean }) => void,
  ) => void;
  MainButton: {
    color: string;
    textColor: string;
    setText: (text: string) => void;
    setParams: (params: {
      text?: string;
      color?: string;
      text_color?: string;
    }) => void;
    show: () => void;
    hide: () => void;
    onClick: (cb: () => void) => void;
    offClick: (cb: () => void) => void;
  };
}

declare global {
  interface Window {
    Telegram?: { WebApp: TelegramWebApp };
  }
}

// "expired" and "auth_invalid" both come from a 401 response carrying one
// of lib/telegram/verifyInitData.ts's three reasons ("expired" is kept as
// its own case since it gets a distinct message; "malformed"/
// "invalid_signature" share the "auth_invalid" bucket and message, per
// components/miniapp/telegramAuthError.ts). "invalid" is unchanged from
// before — it's the catch-all for every other non-ok response (e.g. a
// genuine 500), which still gets the existing generic Retry UI below,
// since a retry can actually help there, unlike an auth failure.
type FetchState =
  | { status: "loading" }
  | {
      status: "error";
      reason:
        | "not_registered"
        | "expired"
        | "auth_invalid"
        | "invalid"
        | "network";
    }
  | { status: "ready"; data: MeResponse };

export default function MiniAppPage() {
  const { applyTelegramLanguageCode } = useLocale();
  const [scriptReady, setScriptReady] = useState(false);
  const [screen, setScreen] = useState<"banner" | "data">("banner");
  const [fetchState, setFetchState] = useState<FetchState>({
    status: "loading",
  });
  const [viewportStableHeight, setViewportStableHeight] = useState<
    number | null
  >(null);
  const mainButtonHandlerRef = useRef<(() => void) | null>(null);
  const viewportChangedHandlerRef = useRef<
    ((event: { isStateStable: boolean }) => void) | null
  >(null);
  // Single-flight guard shared by every background-refresh trigger (polling
  // tick, visibilitychange, and the player's own confirm) — never more than
  // one /api/miniapp/me request in flight at once, regardless of which
  // trigger fired.
  const isBackgroundRefreshingRef = useRef(false);
  // True for as long as this component instance is mounted — set in the
  // mount effect below, flipped to false in its cleanup. A background
  // refresh's fetch can still resolve after unmount (clearInterval/
  // removeEventListener only stop *new* ticks, not one already in flight);
  // refreshDataSilently checks this ref after every await, before touching
  // React state, so a post-unmount resolution is a safe no-op instead of a
  // setState call.
  const isMountedRef = useRef(false);

  const loadData = useCallback(async () => {
    const tg = window.Telegram?.WebApp;
    if (!tg) return;

    setFetchState({ status: "loading" });

    try {
      const response = await fetch("/api/miniapp/me", {
        headers: { Authorization: `tma ${tg.initData}` },
      });

      if (response.status === 404) {
        setFetchState({ status: "error", reason: "not_registered" });
        return;
      }

      if (!response.ok) {
        // /api/miniapp/me returns 401 only for one of verifyInitData's
        // three reasons — anything else not-ok (e.g. a genuine 500) falls
        // through to the existing generic "invalid" retry path unchanged.
        if (response.status === 401) {
          const body: unknown = await response.json().catch(() => null);
          const errorCode =
            typeof body === "object" && body !== null
              ? (body as { error?: unknown }).error
              : undefined;

          if (
            typeof errorCode === "string" &&
            isTelegramAuthErrorReason(errorCode)
          ) {
            setFetchState({
              status: "error",
              reason: errorCode === "expired" ? "expired" : "auth_invalid",
            });
            return;
          }
        }

        setFetchState({ status: "error", reason: "invalid" });
        return;
      }

      const data = (await response.json()) as MeResponse;
      setFetchState({ status: "ready", data });
    } catch {
      setFetchState({ status: "error", reason: "network" });
    }
  }, []);

  // Background reconciliation (data-freshness fix) — deliberately never
  // sets `status: "loading"` (that would blank the whole screen) and never
  // sets `status: "error"` on failure (the player already sees the
  // optimistically-confirmed bet; a failed background refresh must not
  // take that away or show an error page over it). A no-op on any failure
  // path — whatever's already in `fetchState` (including an optimistic
  // BET_CONFIRMED merge) simply stays.
  const refreshDataSilently = useCallback(async () => {
    const tg = window.Telegram?.WebApp;
    if (!tg) return;

    try {
      const response = await fetch("/api/miniapp/me", {
        headers: { Authorization: `tma ${tg.initData}` },
      });

      // The component may have unmounted while this fetch was in flight —
      // clearInterval/removeEventListener (see the polling/visibilitychange
      // effects below) only prevent a *new* refresh from starting, they
      // can't cancel one already awaiting a response. Bail out before
      // touching React state (or even parsing the body) if that happened.
      if (!isMountedRef.current) return;
      if (!response.ok) return;

      const data = (await response.json()) as MeResponse;

      // Same race, second await — unmount could have happened while
      // response.json() was resolving.
      if (!isMountedRef.current) return;

      setFetchState((prev) =>
        prev.status !== "ready"
          ? prev
          : {
              status: "ready",
              data: applyMiniAppDataAction(prev.data, {
                type: "BACKGROUND_REFRESH_SUCCESS",
                data,
              }),
            },
      );
    } catch {
      // Best-effort — see this function's own header comment.
    }
  }, []);

  // Thin wrapper around refreshDataSilently — adds only single-flight
  // dedupe (via isBackgroundRefreshingRef), no new fetch/merge logic.
  // Every background-refresh trigger (polling, visibilitychange, and the
  // post-confirm reconciliation below) goes through this one function, so
  // two of them can never overlap.
  const refreshIfIdle = useCallback(async () => {
    if (isBackgroundRefreshingRef.current) return;

    isBackgroundRefreshingRef.current = true;
    try {
      await refreshDataSilently();
    } finally {
      isBackgroundRefreshingRef.current = false;
    }
  }, [refreshDataSilently]);

  // The one shared confirmation-update path both BetTextForm and
  // BetScreenshotForm now feed into via BetScreen.tsx's single
  // onBetConfirmed prop — never duplicated between the two forms. Merges
  // the confirmed bet in immediately (synchronous, so it's visible before
  // the player ever taps Done/View History — no waiting on the network),
  // then fires a background reconciliation fetch without awaiting it.
  const handleBetConfirmed = useCallback(
    (bet: AnyConfirmedBet) => {
      setFetchState((prev) =>
        prev.status !== "ready"
          ? prev
          : {
              status: "ready",
              data: applyMiniAppDataAction(prev.data, {
                type: "BET_CONFIRMED",
                bet,
              }),
            },
      );
      void refreshIfIdle();
    },
    [refreshIfIdle],
  );

  const handleScriptReady = useCallback(() => {
    const tg = window.Telegram?.WebApp;
    if (!tg) return;

    tg.ready();
    tg.expand();

    // Localization foundation — the one place tg.initDataUnsafe is actually
    // populated by the time it's read (see LocaleProvider.tsx's own header
    // for why LocaleProvider can't read this itself at mount time). A no-op
    // if the player already has an explicit stored language choice.
    applyTelegramLanguageCode(tg.initDataUnsafe?.user?.language_code);

    // setParams sets text+colors in one atomic native call — more reliable
    // across Telegram client versions than assigning .color/.textColor
    // directly (which didn't visibly take effect on a real device).
    tg.MainButton.setParams({
      text: "Start",
      color: "#78C85A",
      text_color: "#000000",
    });
    tg.MainButton.show();

    // MainButton ("Start") is only relevant on the banner — DataScreen has
    // its own in-page "Отправить купон" action, so hide the native button
    // once the player has moved past the welcome screen.
    const handler = () => {
      tg.MainButton.hide();
      setScreen("data");
    };
    mainButtonHandlerRef.current = handler;
    tg.MainButton.onClick(handler);

    // Initial reading — viewportStableHeight is already settled by the time
    // the script's onReady fires. viewportChanged (below) keeps it in sync
    // afterwards (e.g. Telegram Desktop window resize).
    setViewportStableHeight(tg.viewportStableHeight);

    const viewportChangedHandler = (event: { isStateStable: boolean }) => {
      // Only commit height while Telegram reports a stable state — ignore
      // in-between frames of an ongoing resize/expand animation.
      if (event.isStateStable) {
        setViewportStableHeight(tg.viewportStableHeight);
      }
    };
    viewportChangedHandlerRef.current = viewportChangedHandler;
    tg.onEvent("viewportChanged", viewportChangedHandler);

    setScriptReady(true);
    loadData();
  }, [loadData, applyTelegramLanguageCode]);

  // Detach the MainButton and viewportChanged handlers on unmount — mirrors
  // the interval/fetch cleanup pattern used elsewhere in this app (e.g.
  // BetQueue's setInterval).
  useEffect(() => {
    return () => {
      const tg = window.Telegram?.WebApp;
      if (!tg) return;

      if (mainButtonHandlerRef.current) {
        tg.MainButton.offClick(mainButtonHandlerRef.current);
      }

      if (viewportChangedHandlerRef.current) {
        tg.offEvent("viewportChanged", viewportChangedHandlerRef.current);
      }
    };
  }, []);

  // Mount-lifetime tracker for refreshDataSilently's post-await guards
  // above — true for the entire time this component instance is mounted,
  // set back to false in the cleanup that runs on unmount (and, under
  // Strict Mode's dev-only double-invoke, on the synthetic
  // mount→cleanup→mount cycle, which this correctly survives: the second
  // setup sets it back to true, same as any other ref/state Strict Mode
  // intentionally preserves across that cycle).
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const hasPending =
    fetchState.status === "ready" && hasPendingBet(fetchState.data.recentBets);

  // Polling only exists while a PENDING bet is outstanding — starts the
  // moment one appears (via BET_CONFIRMED or a background refresh) and
  // stops the moment none remain, including mid-poll (the effect re-runs,
  // clearing this interval, as soon as `hasPending` flips to false).
  useEffect(() => {
    if (!hasPending) return;

    const intervalId = setInterval(() => {
      void refreshIfIdle();
    }, PENDING_BET_POLL_INTERVAL_MS);

    return () => {
      clearInterval(intervalId);
    };
  }, [hasPending, refreshIfIdle]);

  // Silent refresh when the player returns to the Mini App (e.g. switches
  // back from another Telegram chat) — independent of `hasPending`, since
  // returning to the app is itself a reasonable moment to reconcile,
  // matching Telegram's own visibility semantics for a webview. Guarded by
  // the same isBackgroundRefreshingRef single-flight lock as polling, so
  // this can never double up with an in-flight poll tick.
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void refreshIfIdle();
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [refreshIfIdle]);

  return (
    <>
      <Script
        src="https://telegram.org/js/telegram-web-app.js"
        strategy="afterInteractive"
        onReady={handleScriptReady}
      />

      {screen === "banner" ? (
        <BannerScreen
          ready={scriptReady}
          viewportHeight={viewportStableHeight}
        />
      ) : (
        <DataScreen
          state={fetchState}
          onRetry={loadData}
          onBetConfirmed={handleBetConfirmed}
        />
      )}
    </>
  );
}

function BannerScreen({
  ready,
  viewportHeight,
}: {
  ready: boolean;
  viewportHeight: number | null;
}) {
  const { t } = useLocale();

  // Fallback to 100dvh when the Telegram SDK hasn't reported a height yet
  // (or reports 0) — e.g. opened outside Telegram, or before onReady fires.
  const containerHeight =
    viewportHeight && viewportHeight > 0 ? `${viewportHeight}px` : "100dvh";

  return (
    <div
      className="flex flex-col items-center justify-center px-5 pb-10 min-[480px]:justify-start min-[480px]:pt-14"
      style={{ minHeight: containerHeight }}
    >
      {/* betpilotshow.png is the full visual banner (logo, robot, info
          panels, bottom slogan) at a 35/24 aspect ratio — object-contain,
          not object-cover, so nothing is ever cropped; the wrapper's own
          matching aspect-[35/24] means the sub-1% ratio difference between
          the asset (1.4572) and 35/24 (1.4583) only ever produces a
          negligible letterbox sliver, which bg-[#07111F] (matching
          MiniAppBackground's own top color) blends away. No gradient here
          — the slogan sits right at the image's bottom edge, and the
          asset's own near-black background already blends into the page
          without one; keeping it would have darkened/covered real banner
          content.

          Design pass: inset from the screen edge (px-5 on the outer
          container) + rounded corners + a soft dark shadow and a hairline
          ring turn this from an edge-to-edge website hero into a single
          elevated card — the same treatment Telegram uses for media
          previews and Stripe uses for hero visuals, so it reads as native
          app chrome rather than a banner bleeding off the screen. */}
      <div className="relative w-full aspect-[35/24] overflow-hidden rounded-[28px] bg-[#07111F] shadow-[0_20px_50px_-12px_rgba(0,0,0,0.65)] ring-1 ring-white/8 min-[480px]:mx-auto min-[480px]:max-w-[420px]">
        <Image
          src="/miniapp/betpilotshow.png"
          alt="BetPilot AI — AI Betting Assistant"
          fill
          priority
          className="object-contain object-center"
          sizes="(max-width: 479px) 100vw, 420px"
        />
      </div>

      {/* Headline sits close under the card (tight coupling, mt-7) so it
          reads as this card's own caption rather than a separate section;
          the feature row is pushed further down (mt-8) to create one clear
          break in the rhythm instead of three evenly-spaced blocks. */}
      <div className="mt-7 flex flex-col items-center px-4 text-center">
        <h2 className="text-[26px] font-bold leading-[1.15] tracking-[-0.01em] text-white">
          {t("banner.headlineLine1")}
          <br />
          {t("banner.headlineLine2")}
        </h2>

        <div className="mt-8 flex flex-wrap items-center justify-center gap-2">
          {[
            { icon: "📷", label: t("banner.feature1") },
            { icon: "🔍", label: t("banner.feature2") },
            { icon: "✅", label: t("banner.feature3") },
          ].map(({ icon, label }) => (
            <span
              key={label}
              className="flex items-center gap-1.5 rounded-full bg-white/6 px-3.5 py-2 text-[13px] font-medium text-slate-200 ring-1 ring-white/8"
            >
              <span aria-hidden="true">{icon}</span>
              {label}
            </span>
          ))}
        </div>
      </div>

      {!ready && <p className="mt-8 text-sm text-slate-500">{t("banner.loading")}</p>}
    </div>
  );
}

function DataScreen({
  state,
  onRetry,
  onBetConfirmed,
}: {
  state: FetchState;
  onRetry: () => void;
  onBetConfirmed: (bet: AnyConfirmedBet) => void;
}) {
  const { t, locale } = useLocale();
  const [activeTab, setActiveTab] = useState<MiniAppTab>("bet");

  if (state.status === "loading") {
    return <CenteredMessage text={t("home.loading")} />;
  }

  if (state.status === "error") {
    if (state.reason === "not_registered") {
      return (
        <CenteredMessage text={t("home.notRegistered")} />
      );
    }

    // Neither "expired" nor "auth_invalid" gets a Retry action — resending
    // the exact same initData cannot succeed (see
    // components/miniapp/telegramAuthError.ts), only reopening through the
    // bot can.
    if (state.reason === "expired") {
      return <CenteredMessage text={getTelegramAuthErrorMessage("expired", locale)} />;
    }

    if (state.reason === "auth_invalid") {
      return (
        <CenteredMessage text={getTelegramAuthErrorMessage("malformed", locale)} />
      );
    }

    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 px-6 text-center">
        <p className="text-slate-400">{t("home.failedToLoad")}</p>
        <button
          type="button"
          onClick={onRetry}
          className="rounded-xl bg-blue-500 px-5 py-2 font-semibold text-white"
        >
          {t("home.retry")}
        </button>
      </div>
    );
  }

  const { data } = state;

  return (
    <div className="min-h-screen px-4 py-6 pb-24">
      {/* Global Mini App header — brand/status stay visible across all tabs,
          while the language control remains an application-wide setting. */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center">
          <span
            className="mr-2 h-2 w-2 shrink-0 rounded-full"
            style={{ background: "#60E84A" }}
            aria-hidden="true"
          />
          <span className="text-sm font-semibold uppercase tracking-wide text-white">
            BetPilot AI
          </span>
        </div>

        <LanguageSwitcher />
      </div>

      <div className="mt-4">
        {activeTab === "bet" && (
          <BetScreen
            playerName={data.player.name}
            availableCredit={data.availableCredit}
            exposure={data.exposure}
            pendingExposure={data.pendingExposure}
            recentBets={data.recentBets}
            onBetConfirmed={onBetConfirmed}
            onNavigateToHistory={() => setActiveTab("history")}
          />
        )}
        {activeTab === "active" && (
          <ActiveBetsScreen recentBets={data.recentBets} />
        )}
        {activeTab === "history" && (
          <HistoryScreen recentBets={data.recentBets} />
        )}
        {activeTab === "balance" && (
          <BalanceScreen
            creditLimit={data.creditLimit}
            availableCredit={data.availableCredit}
            exposure={data.exposure}
            pendingExposure={data.pendingExposure}
          />
        )}
      </div>

      <BottomNav activeTab={activeTab} onTabChange={setActiveTab} />
    </div>
  );
}

function CenteredMessage({ text }: { text: string }) {
  return (
    <div className="flex min-h-screen items-center justify-center px-6 text-center text-slate-400">
      {text}
    </div>
  );
}
