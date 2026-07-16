import { createHmac, timingSafeEqual } from "node:crypto";

const INIT_DATA_MAX_AGE_SECONDS = 5 * 60;

export interface TelegramInitDataUser {
  id: number;
  first_name?: string;
  username?: string;
}

export type VerifyInitDataResult =
  | { ok: true; user: TelegramInitDataUser }
  | { ok: false; reason: "malformed" | "invalid_signature" | "expired" };

function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);

  if (bufA.length !== bufB.length) return false;

  return timingSafeEqual(bufA, bufB);
}

// Telegram's documented algorithm for validating Mini App initData:
// https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
export function verifyInitData(initData: string, botToken: string): VerifyInitDataResult {
  const params = new URLSearchParams(initData);

  const hash = params.get("hash");
  if (!hash) return { ok: false, reason: "malformed" };
  params.delete("hash");

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

  // Key is the literal string "WebAppData", message is the bot token — easy
  // to get backwards, this order is what Telegram's docs specify.
  const secretKey = createHmac("sha256", "WebAppData").update(botToken).digest();
  const computedHash = createHmac("sha256", secretKey).update(dataCheckString).digest("hex");

  if (!safeCompare(computedHash, hash)) {
    return { ok: false, reason: "invalid_signature" };
  }

  const authDateRaw = params.get("auth_date");
  const authDate = authDateRaw ? Number(authDateRaw) : NaN;
  if (!Number.isFinite(authDate)) return { ok: false, reason: "malformed" };

  const ageSeconds = Date.now() / 1000 - authDate;
  if (ageSeconds > INIT_DATA_MAX_AGE_SECONDS) {
    return { ok: false, reason: "expired" };
  }

  const userRaw = params.get("user");
  if (!userRaw) return { ok: false, reason: "malformed" };

  try {
    const parsed = JSON.parse(userRaw) as { id?: unknown };
    if (typeof parsed.id !== "number") return { ok: false, reason: "malformed" };

    return { ok: true, user: parsed as TelegramInitDataUser };
  } catch {
    return { ok: false, reason: "malformed" };
  }
}
