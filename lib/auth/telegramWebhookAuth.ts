import { timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";

function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);

  if (bufA.length !== bufB.length) return false;

  return timingSafeEqual(bufA, bufB);
}

export function isTelegramWebhookAuthorized(request: NextRequest): boolean {
  const expected = process.env.TELEGRAM_WEBHOOK_SECRET?.trim();
  if (!expected) return false;

  const actual = request.headers.get("x-telegram-bot-api-secret-token");
  if (!actual) return false;

  return safeCompare(actual, expected);
}
