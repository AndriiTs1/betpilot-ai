import { test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import type { PrismaClient } from "@/lib/generated/prisma/client";
import { handleTelegramWebhook } from "./route";
import type { OcrProvider, OcrResult } from "@/lib/ocr/ocrTypes";

// Route-level tests — everything screenshot-intake-specific is already
// covered in depth by lib/telegram/handleScreenshotMessage.test.ts and
// lib/telegram/selectScreenshotSource.test.ts against fake/injected
// dependencies. This file only proves the webhook route itself: wires
// image handling in ahead of text handling, still authenticates, still
// serves the existing text-only flow unchanged, tolerates malformed
// payloads, and deduplicates a repeated update_id. Uses
// handleTelegramWebhook's injectable `db` option (same DI shape as
// handleBetConfirm/handleSettleBet elsewhere) so this never touches the
// real shared production database; Telegram network calls are stubbed the
// same way app/api/bets/settle.route.test.ts stubs global.fetch.

const WEBHOOK_SECRET = "test-webhook-secret";
const originalEnv = { ...process.env };
const originalFetch = global.fetch;

let sentMessages: Array<{ chatId: string; text: string }> = [];

interface FakePlayerRow {
  id: string;
  telegramId: string | null;
}

// Stage 14.2 — deterministic fake OCR provider (Part 8: no real provider, no
// real API key, no real network in any route-level test either). Every
// postUpdate() call below defaults to a provider that always "recognizes"
// fixed text, so a route test that doesn't care about OCR specifically
// never touches ANTHROPIC_API_KEY or the real Claude adapter.
let ocrRecognizeCallCount = 0;

function defaultFakeOcrProvider(): OcrProvider {
  return {
    name: "fake-route-ocr-provider",
    recognize: async (): Promise<OcrResult> => {
      ocrRecognizeCallCount += 1;
      return {
        kind: "SUCCESS",
        provider: "fake-route-ocr-provider",
        rawText: "Real Madrid vs Barcelona",
        normalizedText: "Real Madrid vs Barcelona",
        durationMs: 1,
      };
    },
  };
}

function fakeDb(players: FakePlayerRow[] = []): PrismaClient {
  return {
    player: {
      findUnique: async ({ where }: { where: { telegramId: string } }) => {
        const found = players.find((p) => p.telegramId === where.telegramId);
        return found ? { id: found.id } : null;
      },
      // bindInvitedPlayerByTelegramUsername's own no-match/no-username
      // paths never call updateMany when this returns 0 invited rows —
      // covered directly by lib/telegram/bindInvitedPlayer.test.ts already,
      // not re-tested here.
      updateMany: async () => ({ count: 0 }),
    },
  } as unknown as PrismaClient;
}

test.beforeEach(() => {
  process.env.TELEGRAM_WEBHOOK_SECRET = WEBHOOK_SECRET;
  process.env.TELEGRAM_BOT_TOKEN = "test-bot-token";
  sentMessages = [];
  ocrRecognizeCallCount = 0;

  global.fetch = (async (url: string | URL, init?: RequestInit) => {
    const urlStr = String(url);
    if (urlStr.includes("/sendMessage")) {
      const body = JSON.parse(String(init?.body)) as { chat_id: string; text: string };
      sentMessages.push({ chatId: body.chat_id, text: body.text });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    if (urlStr.includes("/getFile")) {
      return new Response(
        JSON.stringify({ ok: true, result: { file_path: "photos/file_1.jpg", file_size: 2048 } }),
        { status: 200 },
      );
    }
    // The actual file body download for an ACCEPTED screenshot.
    return new Response(Buffer.from("fake-bytes"), { status: 200 });
  }) as typeof fetch;
});

test.afterEach(() => {
  process.env = { ...originalEnv };
  global.fetch = originalFetch;
});

function postUpdate(
  body: unknown,
  db: PrismaClient = fakeDb(),
  ocrProvider: OcrProvider = defaultFakeOcrProvider(),
): Promise<Response> {
  const request = new NextRequest("https://example.com/api/webhooks/telegram", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-telegram-bot-api-secret-token": WEBHOOK_SECRET,
    },
    body: JSON.stringify(body),
  });
  return handleTelegramWebhook(request, { db, ocrProvider });
}

test("webhook: rejects a request missing the secret token", async () => {
  const request = new NextRequest("https://example.com/api/webhooks/telegram", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ update_id: 1 }),
  });

  const response = await handleTelegramWebhook(request, { db: fakeDb() });
  assert.equal(response.status, 401);
});

test("webhook: a text-only message still uses the existing redirect flow unchanged", async () => {
  const response = await postUpdate({
    update_id: 100,
    message: {
      message_id: 1,
      date: 1700000000,
      text: "hello",
      chat: { id: 777 },
      from: { id: 42 },
    },
  });

  assert.equal(response.status, 200);
  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0].text, "Для работы откройте приложение BetPilot AI.");
});

test("webhook: a completely malformed payload (null) does not crash", async () => {
  const request = new NextRequest("https://example.com/api/webhooks/telegram", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-telegram-bot-api-secret-token": WEBHOOK_SECRET,
    },
    body: "null",
  });

  const response = await handleTelegramWebhook(request, { db: fakeDb() });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
});

test("webhook: an update with no message field does not crash", async () => {
  const response = await postUpdate({ update_id: 101 });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
});

test("webhook: invalid JSON body does not crash", async () => {
  const request = new NextRequest("https://example.com/api/webhooks/telegram", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-telegram-bot-api-secret-token": WEBHOOK_SECRET,
    },
    body: "{not valid json",
  });

  const response = await handleTelegramWebhook(request, { db: fakeDb() });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
});

test("webhook: a repeated update_id is deduplicated on the second delivery", async () => {
  const update = {
    update_id: 555444,
    message: {
      message_id: 2,
      date: 1700000000,
      text: "hello again",
      chat: { id: 778 },
      from: { id: 43 },
    },
  };

  const first = await postUpdate(update);
  const second = await postUpdate(update);

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  // Only the first delivery actually triggers the redirect reply.
  assert.equal(sentMessages.length, 1);
});

test("webhook: a photo message for an unregistered account does not fall through to text handling", async () => {
  // This exercises the route wiring itself: even though there's no text
  // field for the redirect branch to react to, the image branch alone must
  // return 200 without ever reaching the redirect reply — proving the route
  // reaches handleScreenshotMessage first and returns on any non-NO_IMAGE
  // outcome rather than continuing into the text branch and crashing on a
  // missing tgMessage.text.
  const response = await postUpdate(
    {
      update_id: 202,
      message: {
        message_id: 3,
        date: 1700000000,
        chat: { id: 779 },
        from: { id: 44 },
        photo: [{ file_id: "ph-1", file_unique_id: "u-ph-1", width: 100, height: 100, file_size: 1000 }],
      },
    },
    fakeDb([]),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0].text, "⚠️ Ваш Telegram-аккаунт не зарегистрирован в BetPilot.");
  // Never the text-flow's redirect message — confirms the route did not
  // fall through to the text branch for an image-bearing update.
  assert.ok(!sentMessages.some((m) => m.text === "Для работы откройте приложение BetPilot AI."));
});

test("webhook: a photo message for a registered account is recognized end-to-end through the route", async () => {
  const response = await postUpdate(
    {
      update_id: 203,
      message: {
        message_id: 4,
        date: 1700000000,
        chat: { id: 780 },
        from: { id: 45 },
        photo: [{ file_id: "ph-1", file_unique_id: "u-ph-1", width: 100, height: 100, file_size: 1000 }],
      },
    },
    fakeDb([{ id: "player-synthetic-route", telegramId: "45" }]),
  );

  assert.equal(response.status, 200);
  assert.equal(sentMessages.length, 1);
  assert.match(sentMessages[0].text, /^✅ Текст со скриншота распознан/);
  assert.equal(ocrRecognizeCallCount, 1);
});

test("webhook: a repeated update_id does not cause a duplicate OCR call on the same warm instance", async () => {
  const update = {
    update_id: 204,
    message: {
      message_id: 5,
      date: 1700000000,
      chat: { id: 781 },
      from: { id: 46 },
      photo: [{ file_id: "ph-1", file_unique_id: "u-ph-1", width: 100, height: 100, file_size: 1000 }],
    },
  };
  const db = fakeDb([{ id: "player-synthetic-route-2", telegramId: "46" }]);

  const first = await postUpdate(update, db);
  const second = await postUpdate(update, db);

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(ocrRecognizeCallCount, 1, "the OCR provider must only be invoked once, for the first delivery");
  assert.equal(sentMessages.length, 1);
});
