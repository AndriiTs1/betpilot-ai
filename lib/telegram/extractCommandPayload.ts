// Step 9B — pure command-payload extraction for /odds. Deliberately does
// NOT re-implement command-name matching: app/api/webhooks/telegram/route.ts's
// own extractCommand() already decides *which* command a message is (name,
// lowercased, "@BotName" stripped) before this function is ever called, so
// this only ever strips the leading "/cmd[@Bot]" token and validates what
// remains. Not imported from route.ts because this module lives in lib/ and
// nothing in this codebase imports app/api code into lib/ — that dependency
// direction only ever runs the other way.

export const MIN_ODDS_PAYLOAD_LENGTH = 3;
export const MAX_ODDS_PAYLOAD_LENGTH = 2000;

export type ExtractCommandPayloadResult =
  | { ok: true; payload: string }
  | { ok: false; reason: "MISSING" | "TOO_SHORT" | "TOO_LONG" };

// Same bounds as app/api/miniapp/bets/text/preview/route.ts's
// MESSAGE_MIN_LENGTH/MESSAGE_MAX_LENGTH — not imported (that route has no
// exported constant for them), but deliberately kept numerically identical.
export function extractCommandPayload(text: string): ExtractCommandPayloadResult {
  const firstWhitespaceIndex = text.search(/\s/);
  const remainder = firstWhitespaceIndex === -1 ? "" : text.slice(firstWhitespaceIndex + 1);

  // Only the leading command token is removed; the remainder's internal
  // whitespace and Unicode content pass through completely untouched —
  // only leading/trailing whitespace around the whole remainder is
  // stripped, never reinterpreted as bet content.
  const trimmed = remainder.trim();

  if (trimmed.length === 0) {
    return { ok: false, reason: "MISSING" };
  }
  if (trimmed.length < MIN_ODDS_PAYLOAD_LENGTH) {
    return { ok: false, reason: "TOO_SHORT" };
  }
  if (trimmed.length > MAX_ODDS_PAYLOAD_LENGTH) {
    return { ok: false, reason: "TOO_LONG" };
  }

  return { ok: true, payload: trimmed };
}
