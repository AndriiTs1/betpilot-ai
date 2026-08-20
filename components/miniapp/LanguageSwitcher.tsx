"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { useLocale } from "./LocaleProvider";
import type { Locale } from "@/lib/i18n/locale";

// Compact, anchored language control for the two supported locales.
// The collapsed pill shows the current locale ("RU" / "EN"); opening it
// reveals only the alternate locale directly underneath at the same width.
// No flags, full language names, or selected-state decoration are needed.
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

  const alternateLocale: Locale = locale === "ru" ? "en" : "ru";

  return (
    <div ref={containerRef} className="relative w-[62px] shrink-0">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={t("common.language")}
        className="flex min-h-9 w-full items-center justify-center gap-1 rounded-full px-2 text-[13px] font-semibold text-white"
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
          className="absolute right-0 top-[calc(100%+6px)] z-30 w-full overflow-hidden rounded-full"
          style={{
            background: "#0B1220",
            border: "1px solid rgba(145,190,220,0.14)",
            boxShadow: "0 12px 32px rgba(0,0,0,0.45)",
          }}
        >
          <button
            type="button"
            role="option"
            aria-selected={false}
            onClick={() => handleSelect(alternateLocale)}
            className="flex min-h-9 w-full items-center justify-center px-2 text-[13px] font-semibold text-white"
          >
            {alternateLocale.toUpperCase()}
          </button>
        </div>
      )}
    </div>
  );
}
