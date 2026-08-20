// Shared across every Mini App API client (betPreviewApi.ts,
// betScreenshotApi.ts, betConfirmApi.ts) and app/miniapp/page.tsx — the one
// place lib/telegram/verifyInitData.ts's three failure reasons
// ("expired" | "malformed" | "invalid_signature") are turned into a
// player-facing message. Previously each of the four call sites mapped
// these independently, producing four different message sets for the same
// underlying server condition. A reopen (through the bot) is the only
// thing that actually fixes any of these three — retrying with the same
// initData cannot succeed, since the value itself never changes within one
// Mini App launch — so callers must never offer a plain "Retry" action for
// them.

import { translate } from "@/lib/i18n/translations";
import type { Locale } from "@/lib/i18n/locale";

export type TelegramAuthErrorReason = "expired" | "malformed" | "invalid_signature";

const TELEGRAM_AUTH_ERROR_REASONS: ReadonlySet<string> = new Set([
  "expired",
  "malformed",
  "invalid_signature",
]);

export function isTelegramAuthErrorReason(code: string): code is TelegramAuthErrorReason {
  return TELEGRAM_AUTH_ERROR_REASONS.has(code);
}

// Localization completion pass — `locale` defaults to "en" so every
// pre-existing call site that doesn't pass one keeps returning the exact
// same English text as before this pass (zero behavior change, zero test
// churn for untouched callers); every UI call site now explicitly passes
// the player's real current locale (from useLocale()).
export function getTelegramAuthErrorMessage(reason: TelegramAuthErrorReason, locale: Locale = "en"): string {
  if (reason === "expired") {
    return translate(locale, "error.telegramExpired");
  }

  // malformed / invalid_signature — the player never needs to tell these
  // apart; the server-side route still logs/returns the precise reason for
  // diagnostics, this is only the display text.
  return translate(locale, "error.telegramInvalid");
}
