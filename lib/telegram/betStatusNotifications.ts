import { sendTelegramMessage } from "./sendMessage";

// Bet-lifecycle status notifications (confirmed / rejected / settled
// win-loss-void) are temporarily disabled — they duplicate information
// already visible in the Mini App / Dashboard and were adding noise while
// the core product is still being finished. This gate does NOT touch
// sendTelegramMessage/sendTelegramPhoto themselves, which remain fully
// active for the bot's interactive dialog (welcome, /odds, screenshot
// OCR replies) — those are direct responses to something the player just
// sent, not lifecycle notifications, and must keep working regardless of
// this flag.
//
// Defaults to disabled even when the env var is entirely unset, so an
// accidental deploy without explicitly setting it can never silently
// re-enable these. Requires the exact literal "true" — any other value
// (missing, empty, wrong case, typo) stays disabled, never fails open.
function isBetStatusNotificationsEnabled(): boolean {
  return process.env.BET_TELEGRAM_NOTIFICATIONS_ENABLED === "true";
}

// Drop-in replacement for a direct sendTelegramMessage() call at a bet
// status change site — same signature, same boolean result — so call
// sites need no other change beyond swapping the import. Returns false
// (never throws) when notifications are disabled, matching
// sendTelegramMessage's own "never throw, return success boolean"
// contract, so existing try/catch-around-the-call code at every call site
// keeps working unmodified.
export async function sendBetStatusNotification(chatId: string, text: string): Promise<boolean> {
  if (!isBetStatusNotificationsEnabled()) return false;
  return sendTelegramMessage(chatId, text);
}
