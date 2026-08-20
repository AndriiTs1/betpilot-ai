// Mini App localization foundation — UI language only. This has no
// relationship to bet-input language, AI parser behavior, odds matching, or
// any provider/team-name normalization: a player can select an English UI
// and still type "Интер победа 5", and the parser must keep processing that
// text exactly as it does today. Nothing in this file (or lib/i18n/
// translations.ts) is ever read by lib/ai/betParser.ts, lib/bets/*, or
// lib/odds/* — this is a presentation-only concern.

export type Locale = "ru" | "en";

// Deterministic bootstrap value used for BOTH the server-rendered HTML and
// the first client render, before any client-only signal (localStorage,
// Telegram's own initDataUnsafe.user.language_code) has been read. Using
// the same fixed value on both sides avoids a hydration mismatch — see
// components/miniapp/LocaleProvider.tsx's own header comment for how the
// real locale is then resolved, client-side only, after mount. "ru" is
// chosen because it matches this app's own current (pre-localization)
// hardcoded copy, so existing Russian-speaking players see zero flash on
// first paint; only a fresh, non-Russian Telegram user briefly sees the
// "ru" bootstrap frame before the Telegram-derived "en" default lands.
export const DEFAULT_LOCALE: Locale = "ru";

export const LOCALE_STORAGE_KEY = "betpilot:locale";

export function isLocale(value: unknown): value is Locale {
  return value === "ru" || value === "en";
}

// Pure, side-effect-free — testable without any DOM/localStorage/Telegram
// mock. `storedValue` is whatever localStorage.getItem() returned (or null/
// undefined if unavailable/never set); `telegramLanguageCode` is Telegram's
// own initDataUnsafe.user.language_code (or undefined if not yet known —
// see LocaleProvider's own header comment for why that's routinely the case
// on first mount). An explicit stored choice always wins, regardless of
// Telegram language, on every subsequent visit — this function's caller
// (LocaleProvider) is responsible for never calling this with a Telegram
// code once a stored value has already been applied.
export function resolveInitialLocale(
  storedValue: string | null | undefined,
  telegramLanguageCode: string | null | undefined,
): Locale {
  if (isLocale(storedValue)) return storedValue;

  if (telegramLanguageCode && telegramLanguageCode.trim().toLowerCase().startsWith("ru")) {
    return "ru";
  }

  return "en";
}
