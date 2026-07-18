"use client";

import { useEffect, useRef, useState } from "react";
import { ScanLine, MessageSquareText } from "lucide-react";

interface BetActionSheetProps {
  open: boolean;
  onClose: () => void;
  onSelectScreenshot: () => void;
  onSelectText: () => void;
}

// Hand-rolled bottom sheet — no library, this is the only place in the Mini
// App that needs one. Mounted only while `open` is true (no exit animation);
// `entered` flips true one frame after mount so the backdrop/panel actually
// have something to transition from, since a brand-new DOM node can't
// animate its own initial style application.
export default function BetActionSheet({
  open,
  onClose,
  onSelectScreenshot,
  onSelectText,
}: BetActionSheetProps) {
  const [entered, setEntered] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    const raf = requestAnimationFrame(() => setEntered(true));
    return () => {
      cancelAnimationFrame(raf);
      // Reset for next time the sheet opens — this only runs when `open`
      // flips back to false (or on unmount), not synchronously in the
      // effect body, so it doesn't trigger a cascading render on mount.
      setEntered(false);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKeyDown);

    // Move focus into the sheet so Escape and screen readers pick it up
    // immediately, without building a full focus-trap/tab-cycle.
    panelRef.current?.focus();

    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center">
      <div
        aria-hidden="true"
        onClick={onClose}
        className={`absolute inset-0 bg-black/60 transition-opacity duration-200 motion-reduce:transition-none ${
          entered ? "opacity-100" : "opacity-0"
        }`}
      />

      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Способ отправки ставки"
        tabIndex={-1}
        className={`relative w-full max-w-md rounded-t-3xl transition-transform duration-200 ease-out motion-reduce:transition-none ${
          entered ? "translate-y-0" : "translate-y-full"
        }`}
        style={{
          background: "#0B1220",
          border: "1px solid rgba(145,190,220,0.14)",
          borderBottom: "none",
          paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 16px)",
          boxShadow: "0 -20px 60px rgba(0,0,0,0.45)",
        }}
      >
        <div className="mx-auto mt-3 h-1 w-10 rounded-full bg-slate-700" aria-hidden="true" />

        <p className="px-5 pt-4 text-sm font-semibold text-white">Как отправить ставку?</p>

        <div className="mt-3 space-y-2 px-4">
          <button
            type="button"
            onClick={onSelectScreenshot}
            className="flex w-full items-center gap-3 rounded-2xl p-4 text-left"
            style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(145,190,220,0.10)" }}
          >
            <ScanLine size={22} strokeWidth={2} color="#60E84A" />
            <span className="text-[15px] font-medium text-white">Отправить скриншот</span>
          </button>

          <button
            type="button"
            onClick={onSelectText}
            className="flex w-full items-center gap-3 rounded-2xl p-4 text-left"
            style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(145,190,220,0.10)" }}
          >
            <MessageSquareText size={22} strokeWidth={2} color="#60E84A" />
            <span className="text-[15px] font-medium text-white">Написать ставку</span>
          </button>
        </div>

        <div className="mt-2 px-4 pb-1">
          <button
            type="button"
            onClick={onClose}
            className="w-full rounded-2xl py-3 text-center text-[15px] font-medium text-slate-400"
            style={{ background: "rgba(255,255,255,0.03)" }}
          >
            Отмена
          </button>
        </div>
      </div>
    </div>
  );
}
