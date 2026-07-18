"use client";

import { Activity, History, ScanText, Wallet, type LucideIcon } from "lucide-react";
import type { MiniAppTab } from "./types";

interface NavTab {
  key: MiniAppTab;
  label: string;
  icon: LucideIcon;
}

const TABS: NavTab[] = [
  { key: "bet", label: "Новая ставка", icon: ScanText },
  { key: "active", label: "Активные", icon: Activity },
  { key: "history", label: "История", icon: History },
  { key: "balance", label: "Баланс", icon: Wallet },
];

const ACTIVE_COLOR = "#78C85A";
// Telegram exposes the client's own secondary/hint text color as this CSS
// variable (set on :root by telegram-web-app.js); falls back to a slate
// tone outside Telegram (e.g. plain browser preview).
const INACTIVE_COLOR = "var(--tg-theme-hint-color, #94a3b8)";

interface BottomNavProps {
  activeTab: MiniAppTab;
  onTabChange: (tab: MiniAppTab) => void;
}

// Visual scaffolding only — selecting a tab does not trigger any business
// logic or data fetching by itself; the parent decides what that means.
export default function BottomNav({ activeTab, onTabChange }: BottomNavProps) {
  return (
    <nav
      className="fixed inset-x-0 bottom-0 z-10 flex border-t border-slate-800 bg-slate-950"
      style={{ paddingBottom: "env(safe-area-inset-bottom, 0px)" }}
    >
      {TABS.map((tab) => {
        const isActive = tab.key === activeTab;
        const Icon = tab.icon;
        const color = isActive ? ACTIVE_COLOR : INACTIVE_COLOR;

        return (
          <button
            key={tab.key}
            type="button"
            onClick={() => onTabChange(tab.key)}
            className="flex flex-1 flex-col items-center justify-center gap-1"
            style={{ height: 68 }}
          >
            <Icon size={22} strokeWidth={2} color={color} />
            <span className="text-[11px] font-medium" style={{ color }}>
              {tab.label}
            </span>
          </button>
        );
      })}
    </nav>
  );
}
