import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { NextRequest } from "next/server";
import { GET } from "./route";

// GET /api/miniapp/me — unlike the other three Mini App routes
// (text/preview, text/confirm, screenshot/preview), this route has no
// injectable `db`/`botToken` options (it calls the module-level `prisma`
// singleton and reads `process.env.TELEGRAM_BOT_TOKEN` directly, with no
// `handleXxx(request, options)` seam). Adding that seam would be a change
// to route.ts itself, outside this task's scope. This file is therefore
// scoped to what's safely testable without a real database connection:
// the three auth-failure paths (malformed/invalid_signature/expired), each
// of which the route's own control flow resolves *before* ever touching
// Prisma (the `try { prisma... }` block only starts after the `if
// (!verification.ok)` early return). A full "valid session -> 200 with
// real player data" test is intentionally not included here — it would
// require either a real database (this codebase's tests never do that,
// and BetPilot has a single shared production database with no dev/test
// split — see docs/decisions/ADR-0001) or a DI seam route.ts doesn't have.

const BOT_TOKEN = "test-bot-token-miniapp-me";
const originalBotToken = process.env.TELEGRAM_BOT_TOKEN;

test.before(() => {
  process.env.TELEGRAM_BOT_TOKEN = BOT_TOKEN;
});

test.after(() => {
  if (originalBotToken !== undefined) {
    process.env.TELEGRAM_BOT_TOKEN = originalBotToken;
  } else {
    delete process.env.TELEGRAM_BOT_TOKEN;
  }
});

function buildInitData(botToken: string, userId: number, authDateOverride?: number): string {
  const authDate = authDateOverride ?? Math.floor(Date.now() / 1000);
  const params = new URLSearchParams();
  params.set("auth_date", String(authDate));
  params.set("user", JSON.stringify({ id: userId, first_name: "Test" }));

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

  const secretKey = createHmac("sha256", "WebAppData").update(botToken).digest();
  const hash = createHmac("sha256", secretKey).update(dataCheckString).digest("hex");

  params.set("hash", hash);
  return params.toString();
}

function buildRequest(initData?: string): NextRequest {
  return new NextRequest("https://example.com/api/miniapp/me", {
    headers: initData ? { authorization: `tma ${initData}` } : {},
  });
}

test("GET /api/miniapp/me: a missing initData is rejected as malformed, before any database access", async () => {
  const response = await GET(buildRequest());
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "malformed" });
});

test("GET /api/miniapp/me: an initData signed with the wrong bot token is rejected as invalid_signature, before any database access", async () => {
  const initData = buildInitData("a-different-bot-token", 700000002);
  const response = await GET(buildRequest(initData));
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "invalid_signature" });
});

test("GET /api/miniapp/me: an expired initData (older than the 1h TTL) is rejected as expired, before any database access", async () => {
  const staleAuthDate = Math.floor(Date.now() / 1000) - (60 * 60 + 1); // 1h + 1s old
  const initData = buildInitData(BOT_TOKEN, 700000002, staleAuthDate);

  const response = await GET(buildRequest(initData));
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "expired" });
});
