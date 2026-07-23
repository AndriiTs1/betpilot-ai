"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Image from "next/image";
import Script from "next/script";
import BottomNav from "@/components/miniapp/BottomNav";
import BetScreen from "@/components/miniapp/BetScreen";
import ActiveBetsScreen from "@/components/miniapp/ActiveBetsScreen";
import HistoryScreen from "@/components/miniapp/HistoryScreen";
import BalanceScreen from "@/components/miniapp/BalanceScreen";
import WelcomeBanner from "@/components/miniapp/WelcomeBanner";
import type { MiniAppTab, MeResponse } from "@/components/miniapp/types";
import type { AnyConfirmedBet } from "@/components/miniapp/betConfirmApi";
import { applyMiniAppDataAction } from "@/components/miniapp/mergeConfirmedBet";
import { isTelegramAuthErrorReason, getTelegramAuthErrorMessage } from "@/components/miniapp/telegramAuthError";

interface TelegramWebApp {
  initData: string;
  viewportStableHeight: number;
  ready: () => void;
  expand: () => void;
  onEvent: (eventType: "viewportChanged", callback: (event: { isStateStable: boolean }) => void) => void;
  offEvent: (eventType: "viewportChanged", callback: (event: { isStateStable: boolean }) => void) => void;
  MainButton: {
    color: string;
    textColor: string;
    setText: (text: string) => void;
    setParams: (params: { text?: string; color?: string; text_color?: string }) => void;
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
  | { status: "error"; reason: "not_registered" | "expired" | "auth_invalid" | "invalid" | "network" }
  | { status: "ready"; data: MeResponse };

export default function MiniAppPage() {
  const [scriptReady, setScriptReady] = useState(false);
  const [screen, setScreen] = useState<"banner" | "data">("banner");
  const [fetchState, setFetchState] = useState<FetchState>({ status: "loading" });
  const [viewportStableHeight, setViewportStableHeight] = useState<number | null>(null);
  const mainButtonHandlerRef = useRef<(() => void) | null>(null);
  const viewportChangedHandlerRef = useRef<((event: { isStateStable: boolean }) => void) | null>(
    null,
  );

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
            typeof body === "object" && body !== null ? (body as { error?: unknown }).error : undefined;

          if (typeof errorCode === "string" && isTelegramAuthErrorReason(errorCode)) {
            setFetchState({ status: "error", reason: errorCode === "expired" ? "expired" : "auth_invalid" });
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

      if (!response.ok) return;

      const data = (await response.json()) as MeResponse;
      setFetchState((prev) =>
        prev.status !== "ready"
          ? prev
          : { status: "ready", data: applyMiniAppDataAction(prev.data, { type: "BACKGROUND_REFRESH_SUCCESS", data }) },
      );
    } catch {
      // Best-effort — see this function's own header comment.
    }
  }, []);

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
          : { status: "ready", data: applyMiniAppDataAction(prev.data, { type: "BET_CONFIRMED", bet }) },
      );
      void refreshDataSilently();
    },
    [refreshDataSilently],
  );

  const handleScriptReady = useCallback(() => {
    const tg = window.Telegram?.WebApp;
    if (!tg) return;

    tg.ready();
    tg.expand();

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
  }, [loadData]);

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

  return (
    <>
      <Script
        src="https://telegram.org/js/telegram-web-app.js"
        strategy="afterInteractive"
        onReady={handleScriptReady}
      />

      {screen === "banner" ? (
        <BannerScreen ready={scriptReady} viewportHeight={viewportStableHeight} />
      ) : (
        <DataScreen state={fetchState} onRetry={loadData} onBetConfirmed={handleBetConfirmed} />
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
  // Fallback to 100dvh when the Telegram SDK hasn't reported a height yet
  // (or reports 0) — e.g. opened outside Telegram, or before onReady fires.
  const containerHeight =
    viewportHeight && viewportHeight > 0 ? `${viewportHeight}px` : "100dvh";

  return (
    <div
      className="flex flex-col items-center justify-center min-[480px]:justify-start min-[480px]:pt-16"
      style={{ minHeight: containerHeight }}
    >
      {/* object-cover crops the sides instead of stretching. Above ~480px
          the box is capped at max-w-[420px] so it keeps cropping the
          sides only, not the logo/tagline at the top/bottom. */}
      <div
        className="relative w-full overflow-hidden min-[480px]:mx-auto min-[480px]:max-w-[420px]"
        style={{ height: 288 }}
      >
        <Image
          src="/miniapp/banner.jpg"
          alt="BetPilot AI — AI Betting Assistant"
          fill
          priority
          className="object-cover object-center"
        />

        {/* Fades into #07111F — MiniAppBackground's own top color — to
            blend the banner's bottom edge into the page background. */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 bottom-0"
          style={{
            height: 48,
            background: "linear-gradient(180deg, rgba(7,17,31,0) 0%, #07111F 100%)",
          }}
        />
      </div>

      <div className="mt-4 flex flex-col items-center px-6 text-center">
        <h2 className="text-2xl font-bold text-white">
          Ваш AI-ассистент
          <br />
          для ставок на спорт
        </h2>

        <ul className="mt-6 flex flex-col items-center gap-3 text-sm text-slate-300">
          <li>📷 Отправьте купон или текст</li>
          <li>🔍 Проверка коэффициентов</li>
          <li>✅ Быстрое подтверждение</li>
        </ul>
      </div>

      {!ready && <p className="mt-6 text-sm text-slate-500">Загрузка...</p>}
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
  const [activeTab, setActiveTab] = useState<MiniAppTab>("bet");

  if (state.status === "loading") {
    return <CenteredMessage text="Загрузка..." />;
  }

  if (state.status === "error") {
    if (state.reason === "not_registered") {
      return <CenteredMessage text="Вы ещё не зарегистрированы. Обратитесь к оператору." />;
    }

    // Neither "expired" nor "auth_invalid" gets a Retry action — resending
    // the exact same initData cannot succeed (see
    // components/miniapp/telegramAuthError.ts), only reopening through the
    // bot can.
    if (state.reason === "expired") {
      return <CenteredMessage text={getTelegramAuthErrorMessage("expired")} />;
    }

    if (state.reason === "auth_invalid") {
      return <CenteredMessage text={getTelegramAuthErrorMessage("malformed")} />;
    }

    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 px-6 text-center">
        <p className="text-slate-400">Не удалось загрузить данные.</p>
        <button
          type="button"
          onClick={onRetry}
          className="rounded-xl bg-blue-500 px-5 py-2 font-semibold text-white"
        >
          Повторить
        </button>
      </div>
    );
  }

  const { data } = state;

  return (
    <div className="min-h-screen px-4 py-6 pb-24">
      <WelcomeBanner playerName={data.player.name} />

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
        {activeTab === "active" && <ActiveBetsScreen recentBets={data.recentBets} />}
        {activeTab === "history" && <HistoryScreen recentBets={data.recentBets} />}
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
