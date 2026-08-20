"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDown, Check } from "lucide-react";
import { useLocale } from "./LocaleProvider";
import type { Locale } from "@/lib/i18n/locale";

const OPTIONS: readonly Locale[] = ["ru", "en"];

// Compact, anchored language control — collapsed state is a small pill
// ("RU ˅" / "EN ˅"), never a bright filled button: green is reserved for
// the selected-state checkmark inside the open menu only, so this control
// never competes visually with the primary CTA/AI Online/balances. No
// flags, no globe icon. Hand-rolled (no popover library) — same convention
// as BetActionSheet.tsx's own hand-rolled overlay, just a much smaller
// anchored panel instead of a full-screen sheet, so it doesn't reuse that
// component.
export default function LanguageSwitcher() {
  const { locale, setLocale, t } = useLocale();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    function handlePointerDown(event: MouseEvent | TouchEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("touchstart", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("touchstart", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  function handleSelect(next: Locale) {
    setLocale(next);
    setOpen(false);
  }

  return (
    <div ref={containerRef} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={t("common.language")}
        className="flex min-h-9 items-center gap-1 rounded-full px-3 text-[13px] font-semibold text-white"
        style={{
          background: "rgba(255,255,255,0.05)",
          border: "1px solid rgba(255,255,255,0.10)",
        }}
      >
        {locale.toUpperCase()}
        <ChevronDown size={14} strokeWidth={2.25} style={{ opacity: 0.6 }} aria-hidden="true" />
      </button>

      {/* Anchored absolute panel, not a modal/sheet — never shifts layout
          (position: absolute takes it out of flow) and never pushes page
          content down. Dismiss-on-outside-click/Escape/selection only. */}
      {open && (
        <div
          role="listbox"
          aria-label={t("common.language")}
          className="absolute right-0 top-[calc(100%+6px)] z-30 min-w-[132px] overflow-hidden rounded-2xl py-1"
          style={{
            background: "#0B1220",
            border: "1px solid rgba(145,190,220,0.14)",
            boxShadow: "0 12px 32px rgba(0,0,0,0.45)",
          }}
        >
          {OPTIONS.map((option) => {
            const isSelected = option === locale;
            return (
              <button
                key={option}
                type="button"
                role="option"
                aria-selected={isSelected}
                onClick={() => handleSelect(option)}
                className="flex min-h-9 w-full items-center justify-between gap-3 px-3.5 py-2 text-left text-[14px] font-medium text-white"
              >
                {t(option === "ru" ? "common.russian" : "common.english")}
                {isSelected && (
                  <Check size={15} strokeWidth={2.5} style={{ color: "#60E84A" }} aria-hidden="true" />
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
