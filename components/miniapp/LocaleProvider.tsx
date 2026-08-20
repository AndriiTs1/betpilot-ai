"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { DEFAULT_LOCALE, isLocale, resolveInitialLocale, LOCALE_STORAGE_KEY, type Locale } from "@/lib/i18n/locale";
import { translate, type TranslationKey } from "@/lib/i18n/translations";

interface LocaleContextValue {
  locale: Locale;
  // Explicit player action — persists to localStorage and, from this point
  // on, is never again overridden by a Telegram-derived default (see
  // applyTelegramLanguageCode below).
  setLocale: (next: Locale) => void;
  // Called once by app/miniapp/page.tsx's handleScriptReady — the one place
  // that actually knows Telegram's WebApp SDK has finished loading (see
  // this file's own header for why LocaleProvider can't reliably read
  // window.Telegram itself at mount time). A no-op once an explicit choice
  // (stored or player-selected) is already in effect.
  applyTelegramLanguageCode: (languageCode: string | null | undefined) => void;
  t: (key: TranslationKey, params?: Record<string, string>) => string;
}

const LocaleContext = createContext<LocaleContextValue | null>(null);

// Mini App UI-language source of truth. Deliberately mounted from
// app/miniapp/layout.tsx (wrapping the whole /miniapp route) rather than
// inside app/miniapp/page.tsx itself, so it's a single instance shared by
// every tab (Bet/Active/History/Balance) — never re-created on tab switch.
//
// Why this can't just read window.Telegram.WebApp on mount: the actual
// Telegram WebApp SDK (telegram-web-app.js) is loaded by page.tsx via
// next/script strategy="afterInteractive" — an async external script fetch
// that has essentially never finished by the time THIS component's own
// mount effect runs (LocaleProvider, in layout.tsx, mounts before that
// script tag even starts loading). Reading
// window.Telegram?.WebApp?.initDataUnsafe here would almost always see
// `undefined` and silently default every first-time Russian Telegram user
// to English — not a hydration bug, just the wrong data at the wrong time.
// Instead, page.tsx's handleScriptReady (the one place that already knows,
// synchronously, that tg.ready() has been called and initDataUnsafe is
// real) calls applyTelegramLanguageCode once real data exists.
//
// Hydration safety: `locale` starts at the same fixed DEFAULT_LOCALE on
// every render — server and first client paint alike — so there is no
// server/client markup mismatch. The mount effect below (localStorage) and
// applyTelegramLanguageCode (Telegram) only ever run client-side, after
// hydration, and only ever change state going forward — never during the
// render that produces the initial HTML.
export function LocaleProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(DEFAULT_LOCALE);
  // True once an EXPLICIT source (persisted player choice, or a fresh
  // in-session player selection) has determined `locale` — from that point
  // on, applyTelegramLanguageCode must never override it. Starts false: the
  // DEFAULT_LOCALE above is a bootstrap value, not an explicit choice.
  const hasExplicitLocaleRef = useRef(false);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(LOCALE_STORAGE_KEY);
      if (isLocale(stored)) {
        // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate: localStorage is only safely readable client-side, so syncing it into state must happen post-mount, in an effect, specifically to avoid a server/client hydration mismatch (see this file's own header comment). Not a cascading-render bug — it's the one-time bootstrap correction the hydration-safety design requires.
        setLocaleState(stored);
        hasExplicitLocaleRef.current = true;
      }
    } catch {
      // Storage can throw (privacy mode, disabled storage in some Telegram
      // WebViews) — never let a locale lookup break the Mini App. Falls
      // through to the Telegram-derived default via
      // applyTelegramLanguageCode, same as a genuinely empty first visit.
    }
  }, []);

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    hasExplicitLocaleRef.current = true;
    try {
      window.localStorage.setItem(LOCALE_STORAGE_KEY, next);
    } catch {
      // Best-effort persistence only — an explicit choice still applies for
      // the rest of this session even if it can't be saved for next time.
    }
  }, []);

  const applyTelegramLanguageCode = useCallback((languageCode: string | null | undefined) => {
    if (hasExplicitLocaleRef.current) return;
    setLocaleState(resolveInitialLocale(undefined, languageCode));
  }, []);

  const t = useCallback(
    (key: TranslationKey, params?: Record<string, string>) => translate(locale, key, params),
    [locale],
  );

  return (
    <LocaleContext.Provider value={{ locale, setLocale, applyTelegramLanguageCode, t }}>
      {children}
    </LocaleContext.Provider>
  );
}

export function useLocale(): LocaleContextValue {
  const ctx = useContext(LocaleContext);
  if (!ctx) {
    throw new Error("useLocale must be used within a LocaleProvider");
  }
  return ctx;
}
