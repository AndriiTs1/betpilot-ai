"use client";

import { useEffect, useState } from "react";
import { Zap } from "lucide-react";

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
        transform: isExiting ? "translateY(-4px)" : "translateY(0)",
        maxHeight: isExiting ? 0 : 64,
        marginBottom: isExiting ? 0 : 16,
      }}
    >
      <div className="flex gap-3">
        {/* Accent bar with a soft radial glow bleeding from behind it — the
            only "premium" flourish, no card chrome around the whole strip. */}
        <div className="relative w-[3px] shrink-0 rounded-full" style={{ backgroundColor: "#60E84A" }}>
          <div
            className="absolute left-1/2 top-1/2 h-9 w-9 -translate-x-1/2 -translate-y-1/2 rounded-full blur-md"
            style={{ backgroundColor: "rgba(96,232,74,0.08)" }}
          />
        </div>

        <div className="min-w-0 flex-1 py-1.5">
          <div className="flex items-center gap-1.5">
            <Zap size={14} strokeWidth={2} style={{ color: "rgba(96,232,74,0.65)" }} />
            <span
              className="text-[10px] font-semibold uppercase tracking-wide"
              style={{ color: "rgba(96,232,74,0.65)" }}
            >
              BetPilot AI
            </span>
            <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: "#60E84A" }} />
            <span
              className="text-[10px] font-semibold uppercase tracking-wide"
              style={{ color: "rgba(96,232,74,0.65)" }}
            >
              Online
            </span>
          </div>

          <p className="mt-0.5 truncate text-[15px] font-semibold" style={{ color: "#F7F9FC" }}>
            Добро пожаловать, {playerName}
          </p>
        </div>
      </div>
    </div>
  );
}
