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

export type TelegramAuthErrorReason = "expired" | "malformed" | "invalid_signature";

const TELEGRAM_AUTH_ERROR_REASONS: ReadonlySet<string> = new Set([
  "expired",
  "malformed",
  "invalid_signature",
]);

export function isTelegramAuthErrorReason(code: string): code is TelegramAuthErrorReason {
  return TELEGRAM_AUTH_ERROR_REASONS.has(code);
}

export function getTelegramAuthErrorMessage(reason: TelegramAuthErrorReason): string {
  if (reason === "expired") {
    return "Your Telegram session has expired. Close and reopen the Mini App through the bot.";
  }

  // malformed / invalid_signature — the player never needs to tell these
  // apart; the server-side route still logs/returns the precise reason for
  // diagnostics, this is only the display text.
  return "Unable to verify your Telegram session. Close and reopen the Mini App through the bot.";
}
