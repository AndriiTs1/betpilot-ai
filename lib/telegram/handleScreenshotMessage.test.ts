import { test } from "node:test";
import assert from "node:assert/strict";
import type { PrismaClient } from "@/lib/generated/prisma/client";
import { handleScreenshotMessage, MAX_SCREENSHOT_SIZE_BYTES } from "./handleScreenshotMessage";
import type { TelegramMessage } from "./telegramTypes";
import type { OcrProvider, OcrResult } from "@/lib/ocr/ocrTypes";

// Same hand-written-fake-db convention as
// lib/telegram/bindInvitedPlayer.test.ts / app/api/bets/settle.route.test.ts
// — the fake db only implements the one Prisma call this module actually
// makes (player.findUnique). It deliberately has no bet/transaction/wallet
// methods at all: if handleScreenshotMessage ever attempted to create a
// Bet, a Transaction, or mutate a balance, calling a method this fake
// doesn't implement would throw immediately, which is exactly the
// "no Bet is created / no financial mutation occurs" guarantee tests 21-24
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

// Deterministic fake OCR provider — Part 8's explicit requirement: no real
// provider, no real API key, no real network in any test in this file. This
// is the *only* thing every test here injects for OCR; every scenario below
// is driven purely by what this fake returns, never by an actual Claude call.
function fakeOcrProvider(recognize: (input: { buffer: Buffer }) => Promise<OcrResult> | OcrResult): OcrProvider {
  return { name: "fake-ocr-provider", recognize: async (input) => recognize(input) };
}

function ocrSuccess(rawText: string): OcrResult {
  return { kind: "SUCCESS", provider: "fake-ocr-provider", rawText, normalizedText: rawText, durationMs: 1 };
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

    // The actual file body download. This must never be reached by an OCR
    // network call — every test injects a fake ocrProvider, so if this
    // counter fires more than once per test, something is (wrongly) calling
    // a real provider's own network path instead of the fake.
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
// 1/2/16/17 — valid photo accepted, OCR success, correct acknowledgement
// ---------------------------------------------------------------------

test("handleScreenshotMessage: a valid photo with recognized text returns OCR_SUCCESS and sends the escaped result", async () => {
  const message = baseMessage({
    photo: [{ file_id: "ph-1", file_unique_id: "u-ph-1", width: 1280, height: 1280, file_size: 2048 }],
  });

  const outcome = await handleScreenshotMessage(message, {
    db: registeredDb(),
    botToken: BOT_TOKEN,
    ocrProvider: fakeOcrProvider(() => ocrSuccess("Real Madrid vs Barcelona\nOver 2.5")),
  });

  assert.equal(outcome.kind, "OCR_SUCCESS");
  if (outcome.kind !== "OCR_SUCCESS") return;
  assert.equal(outcome.intake.source, "TELEGRAM_PHOTO");
  assert.equal(outcome.intake.playerId, PLAYER_ID);
  assert.equal(outcome.intake.telegramId, REGISTERED_TELEGRAM_ID);
  assert.equal(outcome.intake.mimeType, "image/jpeg");
  assert.equal(outcome.intake.fileId, "ph-1");
  assert.ok(outcome.intake.receivedAt instanceof Date);
  assert.equal(outcome.ocr.normalizedText, "Real Madrid vs Barcelona\nOver 2.5");

  assert.equal(sentMessages.length, 1);
  assert.match(sentMessages[0].text, /^✅ Текст со скриншота распознан/);
  assert.match(sentMessages[0].text, /Real Madrid vs Barcelona/);
  assert.match(sentMessages[0].text, /На следующем этапе BetPilot преобразует этот текст в ставку\.$/);
  // Never claims a bet was created — only that text was recognized.
  assert.doesNotMatch(sentMessages[0].text, /ставка создана/i);
});

// ---------------------------------------------------------------------
// 3/4/5 — JPEG / PNG / WEBP documents accepted
// ---------------------------------------------------------------------

for (const mimeType of ["image/jpeg", "image/png", "image/webp"] as const) {
  test(`handleScreenshotMessage: a valid ${mimeType} document with recognized text returns OCR_SUCCESS`, async () => {
    const message = baseMessage({
      document: { file_id: "doc-1", file_unique_id: "u-doc-1", mime_type: mimeType, file_size: 2048 },
    });

    const outcome = await handleScreenshotMessage(message, {
      db: registeredDb(),
      botToken: BOT_TOKEN,
      ocrProvider: fakeOcrProvider(() => ocrSuccess("slip text")),
    });

    assert.equal(outcome.kind, "OCR_SUCCESS");
    if (outcome.kind !== "OCR_SUCCESS") return;
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

  const outcome = await handleScreenshotMessage(message, {
    db: registeredDb(),
    botToken: BOT_TOKEN,
    ocrProvider: fakeOcrProvider(() => ocrSuccess("unreachable")),
  });

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

  const outcome = await handleScreenshotMessage(message, {
    db: registeredDb(),
    botToken: BOT_TOKEN,
    ocrProvider: fakeOcrProvider(() => ocrSuccess("unreachable")),
  });

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

  const outcome = await handleScreenshotMessage(message, {
    db: registeredDb(),
    botToken: BOT_TOKEN,
    ocrProvider: fakeOcrProvider(() => ocrSuccess("unreachable")),
  });

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

  const outcome = await handleScreenshotMessage(message, {
    db: registeredDb(),
    botToken: BOT_TOKEN,
    ocrProvider: fakeOcrProvider(() => ocrSuccess("unreachable")),
  });

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

  const outcome = await handleScreenshotMessage(message, {
    db: registeredDb(),
    botToken: BOT_TOKEN,
    ocrProvider: fakeOcrProvider(() => ocrSuccess("unreachable")),
  });

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

  const outcome = await handleScreenshotMessage(message, {
    db: registeredDb(),
    botToken: BOT_TOKEN,
    ocrProvider: fakeOcrProvider(() => ocrSuccess("unreachable")),
  });

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

  const outcome = await handleScreenshotMessage(message, {
    db: registeredDb(),
    botToken: BOT_TOKEN,
    ocrProvider: fakeOcrProvider(() => ocrSuccess("unreachable")),
  });

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

  const outcome = await handleScreenshotMessage(message, {
    db: registeredDb(),
    botToken: BOT_TOKEN,
    ocrProvider: fakeOcrProvider(() => ocrSuccess("unreachable")),
  });

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
    ocrProvider: fakeOcrProvider(() => ocrSuccess("unreachable")),
  });
  assert.deepEqual(outcome, { kind: "NO_IMAGE" });
  assert.equal(sentMessages.length, 0);
});

test("handleScreenshotMessage: an empty photo array does not crash and reports NO_IMAGE", async () => {
  const outcome = await handleScreenshotMessage(baseMessage({ photo: [] }), {
    db: registeredDb(),
    botToken: BOT_TOKEN,
    ocrProvider: fakeOcrProvider(() => ocrSuccess("unreachable")),
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

  const outcome = await handleScreenshotMessage(message, {
    db: registeredDb(),
    botToken: BOT_TOKEN,
    ocrProvider: fakeOcrProvider(() => ocrSuccess("recognized text")),
  });

  assert.equal(outcome.kind, "OCR_SUCCESS");
  assert.equal(sentMessages.length, 1, "exactly one reply, not a caption-driven second one");
});

// ---------------------------------------------------------------------
// 12/29 — OCR finds no text / OCR provider failure -> one safe message each
// ---------------------------------------------------------------------

test("handleScreenshotMessage: OCR finding no text returns OCR_NO_TEXT with the exact Russian message", async () => {
  const message = baseMessage({
    photo: [{ file_id: "ph-1", file_unique_id: "u-ph-1", width: 1280, height: 1280, file_size: 2048 }],
  });

  const outcome = await handleScreenshotMessage(message, {
    db: registeredDb(),
    botToken: BOT_TOKEN,
    ocrProvider: fakeOcrProvider(() => ({
      kind: "SUCCESS",
      provider: "fake-ocr-provider",
      rawText: "   ",
      normalizedText: "",
      durationMs: 1,
    })),
  });

  assert.equal(outcome.kind, "OCR_NO_TEXT");
  assert.equal(sentMessages.length, 1);
  assert.equal(
    sentMessages[0].text,
    "⚠️ Не удалось распознать текст на изображении.\nПопробуйте отправить более чёткий скриншот.",
  );
});

test("handleScreenshotMessage: an OCR provider failure returns OCR_FAILED with exactly one safe retry message", async () => {
  const message = baseMessage({
    photo: [{ file_id: "ph-1", file_unique_id: "u-ph-1", width: 1280, height: 1280, file_size: 2048 }],
  });

  const outcome = await handleScreenshotMessage(message, {
    db: registeredDb(),
    botToken: BOT_TOKEN,
    ocrProvider: fakeOcrProvider(() => ({
      kind: "FAILURE",
      code: "PROVIDER_TIMEOUT",
      provider: "fake-ocr-provider",
      durationMs: 1,
      safeMessage: "internal detail that must never reach the player",
    })),
  });

  assert.equal(outcome.kind, "OCR_FAILED");
  if (outcome.kind !== "OCR_FAILED") return;
  assert.equal(outcome.code, "PROVIDER_TIMEOUT");
  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0].text, "⚠️ Не удалось распознать изображение.\nПопробуйте отправить скриншот ещё раз позже.");
  assert.doesNotMatch(sentMessages[0].text, /internal detail/);
});

// ---------------------------------------------------------------------
// 21/22/23/24 — no Bet/BetDraft/Transaction/balance side effect
// ---------------------------------------------------------------------

test("handleScreenshotMessage: a successful OCR intake never touches Bet/BetDraft/Transaction/balance (fake db has no such methods)", async () => {
  const message = baseMessage({
    photo: [{ file_id: "ph-1", file_unique_id: "u-ph-1", width: 1280, height: 1280, file_size: 2048 }],
  });

  // registeredDb() only implements player.findUnique — if the handler ever
  // reached for db.bet.create / db.betDraft.create / db.transaction.create /
  // any balance write, this call would throw a TypeError instead of
  // resolving.
  const outcome = await handleScreenshotMessage(message, {
    db: registeredDb(),
    botToken: BOT_TOKEN,
    ocrProvider: fakeOcrProvider(() => ocrSuccess("recognized text")),
  });

  assert.equal(outcome.kind, "OCR_SUCCESS");
});

// ---------------------------------------------------------------------
// 20/30 — bot token / OCR provider fully mocked, nothing real touched
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

  const outcome = await handleScreenshotMessage(message, {
    db: registeredDb(),
    botToken: BOT_TOKEN,
    ocrProvider: fakeOcrProvider(() => ocrSuccess("unreachable")),
  });

  assert.equal(outcome.kind, "DOWNLOAD_FAILED");
  assert.equal(JSON.stringify(outcome).includes(BOT_TOKEN), false);
  for (const call of consoleErrorCalls) {
    assert.equal(JSON.stringify(call).includes(BOT_TOKEN), false);
  }
});

test("handleScreenshotMessage: TELEGRAM_BOT_TOKEN unset is handled without crashing and without leaking anything", async () => {
  const originalToken = process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_BOT_TOKEN;

  try {
    const message = baseMessage({
      photo: [{ file_id: "ph-1", file_unique_id: "u-ph-1", width: 1280, height: 1280, file_size: 2048 }],
    });

    const outcome = await handleScreenshotMessage(message, {
      db: registeredDb(),
      ocrProvider: fakeOcrProvider(() => ocrSuccess("unreachable")),
    });

    assert.equal(outcome.kind, "DOWNLOAD_FAILED");
    assert.equal(sentMessages.length, 0);
  } finally {
    if (originalToken !== undefined) process.env.TELEGRAM_BOT_TOKEN = originalToken;
  }
});

test("handleScreenshotMessage: OCR text is never written to console.error, even on a successful, verbose recognition", async () => {
  const secretLookingText = "SUPER_SECRET_OCR_MARKER Real Madrid vs Barcelona Over 2.5";
  const message = baseMessage({
    photo: [{ file_id: "ph-1", file_unique_id: "u-ph-1", width: 1280, height: 1280, file_size: 2048 }],
  });

  await handleScreenshotMessage(message, {
    db: registeredDb(),
    botToken: BOT_TOKEN,
    ocrProvider: fakeOcrProvider(() => ocrSuccess(secretLookingText)),
  });

  for (const call of consoleErrorCalls) {
    assert.equal(JSON.stringify(call).includes("SUPER_SECRET_OCR_MARKER"), false);
  }
});

test("handleScreenshotMessage: a very long recognized text is truncated with the expected suffix, never sent unbounded", async () => {
  const longText = "A".repeat(5000);
  const message = baseMessage({
    photo: [{ file_id: "ph-1", file_unique_id: "u-ph-1", width: 1280, height: 1280, file_size: 2048 }],
  });

  const outcome = await handleScreenshotMessage(message, {
    db: registeredDb(),
    botToken: BOT_TOKEN,
    ocrProvider: fakeOcrProvider(() => ocrSuccess(longText)),
  });

  assert.equal(outcome.kind, "OCR_SUCCESS");
  assert.equal(sentMessages.length, 1);
  // <= 4096, not strictly less — the new budget-based truncation fills the
  // available room exactly rather than leaving an arbitrary safety margin,
  // and Telegram's own limit is inclusive ("up to 4096 characters").
  assert.ok(sentMessages[0].text.length <= 4096, "must stay within Telegram's own message length cap");
  assert.match(sentMessages[0].text, /…текст сокращён/);
});

// ---------------------------------------------------------------------
// Verification pass — HTML-entity expansion vs. Telegram's 4096-char cap.
//
// escapeHtml() can turn one raw character into up to 5 (& -> &amp;,
// < -> &lt;, > -> &gt;). Truncating the *raw* OCR text to a fixed length
// before escaping (the original Stage 14.2 implementation) could still
// overflow Telegram's 4096-character limit once escaped, if the OCR text
// happened to be dense in those characters. These tests attack exactly that
// case, using pathological OCR text a real screenshot misread could
// plausibly produce, and assert on `sentMessages[0].text` — the literal
// string handed to sendTelegramMessage, i.e. what Telegram actually
// receives — never an intermediate value.
// ---------------------------------------------------------------------

const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;

// After escaping, every "&" in the message must be the start of one of the
// three entities escapeHtml() ever produces — a "&" not immediately
// followed by "amp;", "lt;", or "gt;" means truncation cut through the
// middle of one, leaking a broken fragment (e.g. "&am") into what the
// player sees.
function assertNoBrokenHtmlEntities(text: string) {
  const brokenEntity = /&(?!amp;|lt;|gt;)/;
  assert.doesNotMatch(text, brokenEntity, "must never cut in the middle of an HTML entity");
}

test("handleScreenshotMessage: thousands of ampersands never push the final message over Telegram's 4096-char limit", async () => {
  const message = baseMessage({
    photo: [{ file_id: "ph-1", file_unique_id: "u-ph-1", width: 1280, height: 1280, file_size: 2048 }],
  });

  const outcome = await handleScreenshotMessage(message, {
    db: registeredDb(),
    botToken: BOT_TOKEN,
    ocrProvider: fakeOcrProvider(() => ocrSuccess("&".repeat(5000))),
  });

  assert.equal(outcome.kind, "OCR_SUCCESS");
  assert.equal(sentMessages.length, 1);
  assert.ok(
    sentMessages[0].text.length <= TELEGRAM_MAX_MESSAGE_LENGTH,
    `message length ${sentMessages[0].text.length} exceeds Telegram's ${TELEGRAM_MAX_MESSAGE_LENGTH}-char limit`,
  );
  assertNoBrokenHtmlEntities(sentMessages[0].text);
  assert.match(sentMessages[0].text, /…текст сокращён/);
});

test("handleScreenshotMessage: thousands of < and > characters never push the final message over Telegram's 4096-char limit", async () => {
  const message = baseMessage({
    photo: [{ file_id: "ph-1", file_unique_id: "u-ph-1", width: 1280, height: 1280, file_size: 2048 }],
  });

  const outcome = await handleScreenshotMessage(message, {
    db: registeredDb(),
    botToken: BOT_TOKEN,
    ocrProvider: fakeOcrProvider(() => ocrSuccess("<>".repeat(3000))),
  });

  assert.equal(outcome.kind, "OCR_SUCCESS");
  assert.equal(sentMessages.length, 1);
  assert.ok(
    sentMessages[0].text.length <= TELEGRAM_MAX_MESSAGE_LENGTH,
    `message length ${sentMessages[0].text.length} exceeds Telegram's ${TELEGRAM_MAX_MESSAGE_LENGTH}-char limit`,
  );
  assertNoBrokenHtmlEntities(sentMessages[0].text);
  assert.match(sentMessages[0].text, /…текст сокращён/);
});

test("handleScreenshotMessage: a mix of &, <, > and ordinary text never pushes the final message over Telegram's 4096-char limit", async () => {
  const message = baseMessage({
    photo: [{ file_id: "ph-1", file_unique_id: "u-ph-1", width: 1280, height: 1280, file_size: 2048 }],
  });

  const mixed = "Team A & Team B <Over> 2.5 & Under <1.5> ".repeat(200);

  const outcome = await handleScreenshotMessage(message, {
    db: registeredDb(),
    botToken: BOT_TOKEN,
    ocrProvider: fakeOcrProvider(() => ocrSuccess(mixed)),
  });

  assert.equal(outcome.kind, "OCR_SUCCESS");
  assert.equal(sentMessages.length, 1);
  assert.ok(
    sentMessages[0].text.length <= TELEGRAM_MAX_MESSAGE_LENGTH,
    `message length ${sentMessages[0].text.length} exceeds Telegram's ${TELEGRAM_MAX_MESSAGE_LENGTH}-char limit`,
  );
  assertNoBrokenHtmlEntities(sentMessages[0].text);
  assert.match(sentMessages[0].text, /…текст сокращён/);
});

test("handleScreenshotMessage: a normal long Cyrillic string (no HTML-special characters) stays within Telegram's 4096-char limit", async () => {
  const message = baseMessage({
    photo: [{ file_id: "ph-1", file_unique_id: "u-ph-1", width: 1280, height: 1280, file_size: 2048 }],
  });

  const cyrillic = "Реал Мадрид против Барселоны, тотал больше 2.5, коэффициент 1.85. ".repeat(100);

  const outcome = await handleScreenshotMessage(message, {
    db: registeredDb(),
    botToken: BOT_TOKEN,
    ocrProvider: fakeOcrProvider(() => ocrSuccess(cyrillic)),
  });

  assert.equal(outcome.kind, "OCR_SUCCESS");
  assert.equal(sentMessages.length, 1);
  assert.ok(
    sentMessages[0].text.length <= TELEGRAM_MAX_MESSAGE_LENGTH,
    `message length ${sentMessages[0].text.length} exceeds Telegram's ${TELEGRAM_MAX_MESSAGE_LENGTH}-char limit`,
  );
  // No HTML-special characters at all in this input, so no entity to ever
  // land on a broken boundary — asserted anyway as a baseline sanity check.
  assertNoBrokenHtmlEntities(sentMessages[0].text);
});

test("handleScreenshotMessage: text just under the escaped-body budget is sent whole, with no truncation suffix", async () => {
  const message = baseMessage({
    photo: [{ file_id: "ph-1", file_unique_id: "u-ph-1", width: 1280, height: 1280, file_size: 2048 }],
  });

  // Short enough that even after escaping it can't possibly need truncation
  // — proves the untruncated path also respects the 4096 cap and sends the
  // text back verbatim (escaped), with no suffix appended.
  const shortText = "Real Madrid vs Barcelona\nOver 2.5 & Under 3.5";

  const outcome = await handleScreenshotMessage(message, {
    db: registeredDb(),
    botToken: BOT_TOKEN,
    ocrProvider: fakeOcrProvider(() => ocrSuccess(shortText)),
  });

  assert.equal(outcome.kind, "OCR_SUCCESS");
  assert.equal(sentMessages.length, 1);
  assert.ok(sentMessages[0].text.length <= TELEGRAM_MAX_MESSAGE_LENGTH);
  assert.doesNotMatch(sentMessages[0].text, /текст сокращён/);
  assert.match(sentMessages[0].text, /Real Madrid vs Barcelona\nOver 2\.5 &amp; Under 3\.5/);
});
