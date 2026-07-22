import { test } from "node:test";
import assert from "node:assert/strict";
import type { PrismaClient } from "@/lib/generated/prisma/client";
import { handleScreenshotMessage, MAX_SCREENSHOT_SIZE_BYTES } from "./handleScreenshotMessage";
import type { TelegramMessage } from "./telegramTypes";

// Same hand-written-fake-db convention as
// lib/telegram/bindInvitedPlayer.test.ts / app/api/bets/settle.route.test.ts
// — the fake db only implements the one Prisma call this module actually
// makes (player.findUnique). It deliberately has no bet/transaction/wallet
// methods at all: if handleScreenshotMessage ever attempted to create a
// Bet, a Transaction, or mutate a balance, calling a method this fake
// doesn't implement would throw immediately, which is exactly the
// "no Bet is created / no financial mutation occurs" guarantee tests 18/19
// below rely on.
const BOT_TOKEN = "test-bot-token-98765";

interface FakePlayerRow {
  id: string;
  telegramId: string | null;
}

function fakeDb(players: FakePlayerRow[]) {
  return {
    player: {
      findUnique: async ({ where }: { where: { telegramId: string } }) => {
        const found = players.find((p) => p.telegramId === where.telegramId);
        return found ? { id: found.id } : null;
      },
    },
  } as unknown as PrismaClient;
}

const REGISTERED_TELEGRAM_ID = "700000001"; // synthetic — not Andrii or Denis
const PLAYER_ID = "player-synthetic-1";

function registeredDb() {
  return fakeDb([{ id: PLAYER_ID, telegramId: REGISTERED_TELEGRAM_ID }]);
}

function baseMessage(overrides: Partial<TelegramMessage> = {}): TelegramMessage {
  return {
    message_id: 501,
    date: 1700000000,
    chat: { id: 900001 },
    from: { id: Number(REGISTERED_TELEGRAM_ID) },
    ...overrides,
  };
}

const originalFetch = global.fetch;
const originalConsoleError = console.error;
const originalEnvToken = process.env.TELEGRAM_BOT_TOKEN;
let sentMessages: Array<{ chatId: string; text: string }> = [];
let consoleErrorCalls: unknown[][] = [];
let downloadRequestCount = 0;

test.beforeEach(() => {
  sentMessages = [];
  consoleErrorCalls = [];
  downloadRequestCount = 0;

  // sendTelegramMessage (used for every player-facing reply this module
  // sends) always reads process.env.TELEGRAM_BOT_TOKEN directly — it has no
  // injectable token parameter, unlike downloadTelegramFile. Node's test
  // runner isolates env vars per file, so this must be set here
  // independently of the `botToken` passed to handleScreenshotMessage's
  // options (that one only ever reaches downloadTelegramFile).
  process.env.TELEGRAM_BOT_TOKEN = BOT_TOKEN;

  console.error = (...args: unknown[]) => {
    consoleErrorCalls.push(args);
  };

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

    // The actual file body download.
    downloadRequestCount += 1;
    return new Response(Buffer.from("fake-screenshot-bytes"), { status: 200 });
  }) as typeof fetch;
});

test.afterEach(() => {
  global.fetch = originalFetch;
  console.error = originalConsoleError;
  if (originalEnvToken !== undefined) {
    process.env.TELEGRAM_BOT_TOKEN = originalEnvToken;
  } else {
    delete process.env.TELEGRAM_BOT_TOKEN;
  }
});

// ---------------------------------------------------------------------
// 1/2/17 — valid photo accepted, correct acknowledgement sent
// ---------------------------------------------------------------------

test("handleScreenshotMessage: a valid photo is accepted and the correct acknowledgement is sent", async () => {
  const message = baseMessage({
    photo: [{ file_id: "ph-1", file_unique_id: "u-ph-1", width: 1280, height: 1280, file_size: 2048 }],
  });

  const outcome = await handleScreenshotMessage(message, { db: registeredDb(), botToken: BOT_TOKEN });

  assert.equal(outcome.kind, "ACCEPTED");
  if (outcome.kind !== "ACCEPTED") return;
  assert.equal(outcome.intake.source, "TELEGRAM_PHOTO");
  assert.equal(outcome.intake.playerId, PLAYER_ID);
  assert.equal(outcome.intake.telegramId, REGISTERED_TELEGRAM_ID);
  assert.equal(outcome.intake.mimeType, "image/jpeg");
  assert.equal(outcome.intake.fileId, "ph-1");
  assert.ok(outcome.intake.receivedAt instanceof Date);

  assert.equal(sentMessages.length, 1);
  assert.match(sentMessages[0].text, /^✅ Скриншот получен/);
  assert.match(sentMessages[0].text, /На следующем этапе BetPilot распознает данные ставки\.$/);
  // Never claims recognition happened or a bet was created.
  assert.doesNotMatch(sentMessages[0].text, /распознал/i);
  assert.doesNotMatch(sentMessages[0].text, /ставка создана/i);
});

// ---------------------------------------------------------------------
// 3/4/5 — JPEG / PNG / WEBP documents accepted
// ---------------------------------------------------------------------

for (const mimeType of ["image/jpeg", "image/png", "image/webp"] as const) {
  test(`handleScreenshotMessage: a valid ${mimeType} document is accepted`, async () => {
    const message = baseMessage({
      document: { file_id: "doc-1", file_unique_id: "u-doc-1", mime_type: mimeType, file_size: 2048 },
    });

    const outcome = await handleScreenshotMessage(message, { db: registeredDb(), botToken: BOT_TOKEN });

    assert.equal(outcome.kind, "ACCEPTED");
    if (outcome.kind !== "ACCEPTED") return;
    assert.equal(outcome.intake.source, "TELEGRAM_DOCUMENT");
    assert.equal(outcome.intake.mimeType, mimeType);
  });
}

// ---------------------------------------------------------------------
// 6 — unsupported document MIME type rejected
// ---------------------------------------------------------------------

test("handleScreenshotMessage: an unsupported document MIME type is rejected with the exact Russian message", async () => {
  const message = baseMessage({
    document: { file_id: "doc-1", file_unique_id: "u-doc-1", mime_type: "application/pdf", file_name: "slip.pdf" },
  });

  const outcome = await handleScreenshotMessage(message, { db: registeredDb(), botToken: BOT_TOKEN });

  assert.equal(outcome.kind, "UNSUPPORTED_FORMAT");
  assert.equal(sentMessages.length, 1);
  assert.equal(
    sentMessages[0].text,
    "⚠️ Неподдерживаемый формат.\nОтправьте изображение в формате JPG, PNG или WEBP.",
  );
  assert.equal(downloadRequestCount, 0, "must not attempt to download a rejected file type");
});

// ---------------------------------------------------------------------
// 7/8 — oversized photo/document rejected before download
// ---------------------------------------------------------------------

test("handleScreenshotMessage: an oversized photo (by Telegram-reported file_size) is rejected before download", async () => {
  const message = baseMessage({
    photo: [
      { file_id: "huge", file_unique_id: "u-huge", width: 4000, height: 4000, file_size: MAX_SCREENSHOT_SIZE_BYTES + 1 },
    ],
  });

  const outcome = await handleScreenshotMessage(message, { db: registeredDb(), botToken: BOT_TOKEN });

  assert.equal(outcome.kind, "FILE_TOO_LARGE");
  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0].text, "⚠️ Файл слишком большой.\nМаксимальный размер изображения — 10 МБ.");
  assert.equal(downloadRequestCount, 0, "must not call getFile/download for an oversized photo");
});

test("handleScreenshotMessage: an oversized document (by Telegram-reported file_size) is rejected before download", async () => {
  const message = baseMessage({
    document: {
      file_id: "doc-huge",
      file_unique_id: "u-doc-huge",
      mime_type: "image/png",
      file_size: MAX_SCREENSHOT_SIZE_BYTES + 1,
    },
  });

  const outcome = await handleScreenshotMessage(message, { db: registeredDb(), botToken: BOT_TOKEN });

  assert.equal(outcome.kind, "FILE_TOO_LARGE");
  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0].text, "⚠️ Файл слишком большой.\nМаксимальный размер изображения — 10 МБ.");
  assert.equal(downloadRequestCount, 0);
});

// ---------------------------------------------------------------------
// 10/11/12 — getFile failure / download failure / missing file_path
// ---------------------------------------------------------------------

test("handleScreenshotMessage: a Telegram getFile failure is handled without crashing", async () => {
  global.fetch = (async (url: string | URL, init?: RequestInit) => {
    const urlStr = String(url);
    if (urlStr.includes("/sendMessage")) {
      const body = JSON.parse(String(init?.body)) as { chat_id: string; text: string };
      sentMessages.push({ chatId: body.chat_id, text: body.text });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    if (urlStr.includes("/getFile")) {
      return new Response(JSON.stringify({ ok: false }), { status: 400 });
    }
    throw new Error("should not reach file download");
  }) as typeof fetch;

  const message = baseMessage({
    photo: [{ file_id: "ph-1", file_unique_id: "u-ph-1", width: 1280, height: 1280, file_size: 2048 }],
  });

  const outcome = await handleScreenshotMessage(message, { db: registeredDb(), botToken: BOT_TOKEN });

  assert.equal(outcome.kind, "DOWNLOAD_FAILED");
  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0].text, "⚠️ Не удалось загрузить изображение. Попробуйте отправить его ещё раз.");
});

test("handleScreenshotMessage: missing file_path in getFile's response is handled without crashing", async () => {
  global.fetch = (async (url: string | URL, init?: RequestInit) => {
    const urlStr = String(url);
    if (urlStr.includes("/sendMessage")) {
      const body = JSON.parse(String(init?.body)) as { chat_id: string; text: string };
      sentMessages.push({ chatId: body.chat_id, text: body.text });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    if (urlStr.includes("/getFile")) {
      return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
    }
    throw new Error("should not reach file download");
  }) as typeof fetch;

  const message = baseMessage({
    photo: [{ file_id: "ph-1", file_unique_id: "u-ph-1", width: 1280, height: 1280, file_size: 2048 }],
  });

  const outcome = await handleScreenshotMessage(message, { db: registeredDb(), botToken: BOT_TOKEN });

  assert.equal(outcome.kind, "DOWNLOAD_FAILED");
});

test("handleScreenshotMessage: a Telegram file download failure is handled without crashing", async () => {
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
    return new Response("server error", { status: 500 });
  }) as typeof fetch;

  const message = baseMessage({
    photo: [{ file_id: "ph-1", file_unique_id: "u-ph-1", width: 1280, height: 1280, file_size: 2048 }],
  });

  const outcome = await handleScreenshotMessage(message, { db: registeredDb(), botToken: BOT_TOKEN });

  assert.equal(outcome.kind, "DOWNLOAD_FAILED");
});

// ---------------------------------------------------------------------
// 9 — downloaded body exceeding 10 MB is rejected
// ---------------------------------------------------------------------

test("handleScreenshotMessage: an actual downloaded body over 10 MB is rejected even without Telegram-reported size", async () => {
  global.fetch = (async (url: string | URL, init?: RequestInit) => {
    const urlStr = String(url);
    if (urlStr.includes("/sendMessage")) {
      const body = JSON.parse(String(init?.body)) as { chat_id: string; text: string };
      sentMessages.push({ chatId: body.chat_id, text: body.text });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    if (urlStr.includes("/getFile")) {
      return new Response(JSON.stringify({ ok: true, result: { file_path: "photos/big.jpg" } }), { status: 200 });
    }
    return new Response(Buffer.alloc(MAX_SCREENSHOT_SIZE_BYTES + 1, 1), { status: 200 });
  }) as typeof fetch;

  const message = baseMessage({
    photo: [{ file_id: "ph-1", file_unique_id: "u-ph-1", width: 1280, height: 1280 }],
  });

  const outcome = await handleScreenshotMessage(message, { db: registeredDb(), botToken: BOT_TOKEN });

  assert.equal(outcome.kind, "FILE_TOO_LARGE");
  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0].text, "⚠️ Файл слишком большой.\nМаксимальный размер изображения — 10 МБ.");
});

// ---------------------------------------------------------------------
// 13 — unregistered telegramId rejected
// ---------------------------------------------------------------------

test("handleScreenshotMessage: an unregistered telegramId is rejected without downloading anything", async () => {
  const message = baseMessage({
    from: { id: 999999999 }, // not the registered synthetic player
    photo: [{ file_id: "ph-1", file_unique_id: "u-ph-1", width: 1280, height: 1280, file_size: 2048 }],
  });

  const outcome = await handleScreenshotMessage(message, { db: registeredDb(), botToken: BOT_TOKEN });

  assert.equal(outcome.kind, "PLAYER_NOT_FOUND");
  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0].text, "⚠️ Ваш Telegram-аккаунт не зарегистрирован в BetPilot.");
  assert.equal(downloadRequestCount, 0, "must not download the file for an unregistered account");
});

// ---------------------------------------------------------------------
// 14 — malformed payload does not crash
// ---------------------------------------------------------------------

test("handleScreenshotMessage: a message with neither photo nor document does not crash and reports NO_IMAGE", async () => {
  const outcome = await handleScreenshotMessage(baseMessage({ text: "hi" }), {
    db: registeredDb(),
    botToken: BOT_TOKEN,
  });
  assert.deepEqual(outcome, { kind: "NO_IMAGE" });
  assert.equal(sentMessages.length, 0);
});

test("handleScreenshotMessage: an empty photo array does not crash and reports NO_IMAGE", async () => {
  const outcome = await handleScreenshotMessage(baseMessage({ photo: [] }), {
    db: registeredDb(),
    botToken: BOT_TOKEN,
  });
  assert.deepEqual(outcome, { kind: "NO_IMAGE" });
});

// ---------------------------------------------------------------------
// 16 — image with a caption is processed once, as an image
// ---------------------------------------------------------------------

test("handleScreenshotMessage: a photo with a caption is processed once, as an image, ignoring the caption", async () => {
  const message = baseMessage({
    caption: "here's my bet slip, 100 on Real Madrid",
    photo: [{ file_id: "ph-1", file_unique_id: "u-ph-1", width: 1280, height: 1280, file_size: 2048 }],
  });

  const outcome = await handleScreenshotMessage(message, { db: registeredDb(), botToken: BOT_TOKEN });

  assert.equal(outcome.kind, "ACCEPTED");
  assert.equal(sentMessages.length, 1, "exactly one reply, not a caption-driven second one");
});

// ---------------------------------------------------------------------
// 18/19 — no Bet/settlement/transaction/balance side effect
// ---------------------------------------------------------------------

test("handleScreenshotMessage: accepting a screenshot never touches Bet/Transaction/balance (fake db has no such methods)", async () => {
  const message = baseMessage({
    photo: [{ file_id: "ph-1", file_unique_id: "u-ph-1", width: 1280, height: 1280, file_size: 2048 }],
  });

  // registeredDb() only implements player.findUnique — if the handler ever
  // reached for db.bet.create / db.transaction.create / any balance write,
  // this call would throw a TypeError instead of resolving.
  const outcome = await handleScreenshotMessage(message, { db: registeredDb(), botToken: BOT_TOKEN });

  assert.equal(outcome.kind, "ACCEPTED");
});

// ---------------------------------------------------------------------
// 20 — bot token absent from logs and returned errors
// ---------------------------------------------------------------------

test("handleScreenshotMessage: the bot token never appears in console.error output or the returned outcome", async () => {
  global.fetch = (async (url: string | URL, init?: RequestInit) => {
    const urlStr = String(url);
    if (urlStr.includes("/sendMessage")) {
      const body = JSON.parse(String(init?.body)) as { chat_id: string; text: string };
      sentMessages.push({ chatId: body.chat_id, text: body.text });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    if (urlStr.includes("/getFile")) {
      return new Response(JSON.stringify({ ok: false }), { status: 500 });
    }
    throw new Error("should not reach file download");
  }) as typeof fetch;

  const message = baseMessage({
    photo: [{ file_id: "ph-1", file_unique_id: "u-ph-1", width: 1280, height: 1280, file_size: 2048 }],
  });

  const outcome = await handleScreenshotMessage(message, { db: registeredDb(), botToken: BOT_TOKEN });

  assert.equal(outcome.kind, "DOWNLOAD_FAILED");
  assert.equal(JSON.stringify(outcome).includes(BOT_TOKEN), false);
  for (const call of consoleErrorCalls) {
    assert.equal(JSON.stringify(call).includes(BOT_TOKEN), false);
  }
});

test("handleScreenshotMessage: TELEGRAM_BOT_TOKEN unset is handled without crashing and without leaking anything", async () => {
  const originalEnvToken = process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_BOT_TOKEN;

  try {
    const message = baseMessage({
      photo: [{ file_id: "ph-1", file_unique_id: "u-ph-1", width: 1280, height: 1280, file_size: 2048 }],
    });

    const outcome = await handleScreenshotMessage(message, { db: registeredDb() });

    assert.equal(outcome.kind, "DOWNLOAD_FAILED");
    assert.equal(sentMessages.length, 0);
  } finally {
    if (originalEnvToken !== undefined) process.env.TELEGRAM_BOT_TOKEN = originalEnvToken;
  }
});
