import { test } from "node:test";
import assert from "node:assert/strict";
import { sendBetStatusNotification } from "./betStatusNotifications";

const originalFlag = process.env.BET_TELEGRAM_NOTIFICATIONS_ENABLED;
const originalBotToken = process.env.TELEGRAM_BOT_TOKEN;
const originalFetch = global.fetch;

let fetchCalls: Array<{ chatId: string; text: string }> = [];

test.beforeEach(() => {
  fetchCalls = [];
  process.env.TELEGRAM_BOT_TOKEN = "test-bot-token";
  global.fetch = (async (_url: string | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { chat_id: string; text: string };
    fetchCalls.push({ chatId: body.chat_id, text: body.text });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;
});

test.afterEach(() => {
  if (originalFlag !== undefined) {
    process.env.BET_TELEGRAM_NOTIFICATIONS_ENABLED = originalFlag;
  } else {
    delete process.env.BET_TELEGRAM_NOTIFICATIONS_ENABLED;
  }
});

test.after(() => {
  global.fetch = originalFetch;
  if (originalBotToken !== undefined) {
    process.env.TELEGRAM_BOT_TOKEN = originalBotToken;
  } else {
    delete process.env.TELEGRAM_BOT_TOKEN;
  }
});

test("flag unset (default) -> no Telegram send, returns false", async () => {
  delete process.env.BET_TELEGRAM_NOTIFICATIONS_ENABLED;
  const result = await sendBetStatusNotification("555000111", "test message");

  assert.equal(result, false);
  assert.equal(fetchCalls.length, 0);
});

test("flag = 'false' -> no Telegram send", async () => {
  process.env.BET_TELEGRAM_NOTIFICATIONS_ENABLED = "false";
  const result = await sendBetStatusNotification("555000111", "test message");

  assert.equal(result, false);
  assert.equal(fetchCalls.length, 0);
});

test("flag = '' (empty string) -> no Telegram send", async () => {
  process.env.BET_TELEGRAM_NOTIFICATIONS_ENABLED = "";
  const result = await sendBetStatusNotification("555000111", "test message");

  assert.equal(result, false);
  assert.equal(fetchCalls.length, 0);
});

test("flag = 'TRUE' (wrong case) -> no Telegram send — only the exact literal 'true' enables it", async () => {
  process.env.BET_TELEGRAM_NOTIFICATIONS_ENABLED = "TRUE";
  const result = await sendBetStatusNotification("555000111", "test message");

  assert.equal(result, false);
  assert.equal(fetchCalls.length, 0);
});

test("flag = 'true' -> sends via the real sendTelegramMessage, same args", async () => {
  process.env.BET_TELEGRAM_NOTIFICATIONS_ENABLED = "true";
  const result = await sendBetStatusNotification("555000111", "test message");

  assert.equal(result, true);
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].chatId, "555000111");
  assert.equal(fetchCalls[0].text, "test message");
});

test("flag = 'true' but the underlying send fails -> returns false, does not throw", async () => {
  process.env.BET_TELEGRAM_NOTIFICATIONS_ENABLED = "true";
  global.fetch = (async () => {
    throw new Error("simulated Telegram API network failure");
  }) as typeof fetch;

  const result = await sendBetStatusNotification("555000111", "test message");
  assert.equal(result, false);
});
