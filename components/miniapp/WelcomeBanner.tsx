"use client";

import { useEffect, useState } from "react";
import { Sparkles } from "lucide-react";

interface WelcomeBannerProps {
  playerName: string;
}

const VISIBLE_DURATION_MS = 2400;
const EXIT_ANIMATION_MS = 350;

type Phase = "visible" | "exiting" | "gone";

// One-shot greeting shown when DataScreen first mounts. Deliberately has no
// dependency on which BottomNav tab is active, so switching tabs re-renders
// the parent without remounting this component or resetting its phase —
// it never reappears from a tab switch, only from a fresh Mini App open.
export default function WelcomeBanner({ playerName }: WelcomeBannerProps) {
  const [phase, setPhase] = useState<Phase>("visible");

  useEffect(() => {
    const prefersReducedMotion =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    if (prefersReducedMotion) {
      // Skip the animated exit entirely — jump straight to removed after
      // the same visible duration, no opacity/translateY/height transition.
      const timer = setTimeout(() => setPhase("gone"), VISIBLE_DURATION_MS);
      return () => clearTimeout(timer);
    }

    const timer = setTimeout(() => setPhase("exiting"), VISIBLE_DURATION_MS);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (phase !== "exiting") return;

    const timer = setTimeout(() => setPhase("gone"), EXIT_ANIMATION_MS);
    return () => clearTimeout(timer);
  }, [phase]);

  if (phase === "gone") return null;

  const isExiting = phase === "exiting";

  return (
    <div
      className="overflow-hidden transition-[opacity,transform,max-height,margin-bottom] ease-out motion-reduce:transition-none"
      style={{
        transitionDuration: `${EXIT_ANIMATION_MS}ms`,
        opacity: isExiting ? 0 : 1,
        transform: isExiting ? "translateY(-8px)" : "translateY(0)",
        maxHeight: isExiting ? 0 : 96,
        marginBottom: isExiting ? 0 : 16,
      }}
    >
      <div className="flex items-center gap-3 rounded-2xl border border-slate-800 bg-slate-900 px-4 py-3 shadow-[0_0_24px_-10px_rgba(120,200,90,0.4)]">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#78C85A]/15">
          <Sparkles size={18} strokeWidth={2} color="#78C85A" />
        </div>

        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-white">
            Добро пожаловать, {playerName}
          </p>
          <p className="text-xs text-slate-400">BetPilot готов к работе</p>
        </div>
      </div>
    </div>
  );
}
