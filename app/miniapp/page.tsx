"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Image from "next/image";
import Script from "next/script";
import StatusBadge from "@/components/bets/StatusBadge";

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

interface RecentBet {
  id: string;
  sport: string;
  event: string;
  outcome: string;
  stake: string;
  odds: string | null;
  status: string;
  createdAt: string;
}

interface MeResponse {
  player: { id: string; name: string };
  creditLimit: string;
  currentCredit: string;
  remainingCredit: string;
  exposure: string;
  pendingExposure: string;
  availableCredit: string;
  recentBets: RecentBet[];
}

type FetchState =
  | { status: "loading" }
  | { status: "error"; reason: "not_registered" | "expired" | "invalid" | "network" }
  | { status: "ready"; data: MeResponse };

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("ru-RU", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

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
        const body = await response.json().catch(() => null);
        const reason = body?.error === "expired" ? "expired" : "invalid";
        setFetchState({ status: "error", reason });
        return;
      }

      const data = (await response.json()) as MeResponse;
      setFetchState({ status: "ready", data });
    } catch {
      setFetchState({ status: "error", reason: "network" });
    }
  }, []);

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

    const handler = () => setScreen("data");
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
        <DataScreen state={fetchState} onRetry={loadData} />
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
      className="flex flex-col items-center justify-center"
      style={{ minHeight: containerHeight }}
    >
      {/* Banner art already contains the logo and tagline — no redundant text on top. */}
      <Image
        src="/miniapp/banner.jpg"
        alt="BetPilot AI — AI Betting Assistant"
        width={1212}
        height={820}
        priority
        className="w-full h-auto"
      />
      {!ready && <p className="mt-6 text-sm text-slate-500">Загрузка...</p>}
    </div>
  );
}

function DataScreen({ state, onRetry }: { state: FetchState; onRetry: () => void }) {
  if (state.status === "loading") {
    return <CenteredMessage text="Загрузка..." />;
  }

  if (state.status === "error") {
    if (state.reason === "not_registered") {
      return <CenteredMessage text="Вы ещё не зарегистрированы. Обратитесь к оператору." />;
    }

    if (state.reason === "expired") {
      return <CenteredMessage text="Сессия устарела. Переоткройте приложение через бота." />;
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
    <div className="min-h-screen px-4 py-6">
      <h2 className="text-xl font-semibold">{data.player.name}</h2>

      <div className="mt-4 grid grid-cols-2 gap-3">
        <MiniStat label="Доступно" value={data.availableCredit} />
        <MiniStat label="Лимит" value={data.creditLimit} />
        <MiniStat label="В игре" value={data.exposure} />
        <MiniStat label="В ожидании" value={data.pendingExposure} />
      </div>

      <div className="mt-6">
        <p className="mb-3 text-sm text-slate-400">Последние ставки</p>

        {data.recentBets.length === 0 ? (
          <p className="text-sm text-slate-500">Ставок пока нет.</p>
        ) : (
          <div className="space-y-3">
            {data.recentBets.map((bet) => (
              <div key={bet.id} className="rounded-xl border border-slate-800 p-3">
                <p className="font-semibold">{bet.event}</p>
                <p className="text-sm text-slate-400">{bet.outcome}</p>
                <div className="mt-2 flex items-center justify-between text-sm">
                  <span>
                    {bet.stake} @ {bet.odds ?? "—"}
                  </span>
                  <StatusBadge status={bet.status} />
                  <span className="text-slate-400">{formatDate(bet.createdAt)}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-950/50 p-4 text-center">
      <p className="text-xs text-slate-400">{label}</p>
      <p className="mt-2 text-xl font-bold">{value}</p>
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
