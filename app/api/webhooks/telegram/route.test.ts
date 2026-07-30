import { test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import type { PrismaClient } from "@/lib/generated/prisma/client";
import { handleTelegramWebhook } from "./route";
import type { OcrProvider, OcrResult } from "@/lib/ocr/ocrTypes";
import type { HandleOddsCommandOptions } from "@/lib/telegram/oddsCommand";
import type { ParseBetSlipResult } from "@/lib/ai/betParser";
import type { HandleDiscoveryCommandOptions } from "@/lib/telegram/discoveryCommand";
import type { CandidateResolver, ResolvedEventCandidate } from "@/lib/odds/discovery/candidateResolver";

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
  oddsCommandOptions?: Omit<HandleOddsCommandOptions, "db">,
): Promise<Response> {
  const request = new NextRequest("https://example.com/api/webhooks/telegram", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-telegram-bot-api-secret-token": WEBHOOK_SECRET,
    },
    body: JSON.stringify(body),
  });
  return handleTelegramWebhook(request, { db, ocrProvider, oddsCommandOptions });
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

/* -------------------------------------------------------------------------- */
/* Stage 14.5 — /odds command route wiring                                    */
/* -------------------------------------------------------------------------- */
// The command's own authorization/cooldown/parsing/formatting behavior is
// fully covered by lib/telegram/oddsCommand.test.ts against fakes — these
// tests only prove the ROUTE dispatches to it correctly and doesn't disturb
// any other branch. A fresh, never-reused telegramId per test avoids the
// module-scoped odds-cooldown store (lib/telegram/oddsCommand.ts) leaking
// between tests, exactly as in oddsCommand.test.ts itself.

let nextOddsTelegramId = 900000001;
function uniqueOddsTelegramId(): string {
  nextOddsTelegramId += 1;
  return String(nextOddsTelegramId);
}

function fakeOddsOptions(overrides: Partial<HandleOddsCommandOptions> = {}): Omit<HandleOddsCommandOptions, "db"> {
  const validParse: ParseBetSlipResult = {
    valid: true,
    type: "SINGLE",
    stake: 50,
    selections: [{ sport: "Football", event: "Real Madrid vs Barcelona", market: null, selection: "Real Madrid", submittedOdds: 2.05 }],
  };
  return {
    previewTokenSecret: "test-route-preview-secret",
    parseBetSlip: async () => validParse,
    verifyOddsFn: async () => ({
      matched: true,
      withinTolerance: true,
      sourceOdds: 2.05,
      submittedOdds: 2.05,
      discrepancyPercent: 0,
      bookmaker: "Pinnacle",
      note: null,
    }),
    ...overrides,
  };
}

test("webhook: /odds with a valid payload invokes the odds handler and sends its reply, not the redirect", async () => {
  const telegramId = uniqueOddsTelegramId();
  const db = fakeDb([{ id: "player-odds-route-1", telegramId }]);

  const response = await postUpdate(
    {
      update_id: 300,
      message: { message_id: 10, date: 1700000000, text: "/odds Real Madrid vs Barcelona, odds 2.05", chat: { id: 900 }, from: { id: Number(telegramId) } },
    },
    db,
    undefined,
    fakeOddsOptions(),
  );

  assert.equal(response.status, 200);
  assert.equal(sentMessages.length, 1);
  assert.match(sentMessages[0].text, /Odds confirmed/);
  assert.notEqual(sentMessages[0].text, "Для работы откройте приложение BetPilot AI.");
});

test("webhook: /odds@BotName with a valid payload also invokes the odds handler", async () => {
  const telegramId = uniqueOddsTelegramId();
  const db = fakeDb([{ id: "player-odds-route-2", telegramId }]);

  const response = await postUpdate(
    {
      update_id: 301,
      message: {
        message_id: 11,
        date: 1700000000,
        text: "/odds@BetPilotAI_bot Real Madrid vs Barcelona, odds 2.05",
        chat: { id: 901 },
        from: { id: Number(telegramId) },
      },
    },
    db,
    undefined,
    fakeOddsOptions(),
  );

  assert.equal(response.status, 200);
  assert.equal(sentMessages.length, 1);
  assert.match(sentMessages[0].text, /Odds confirmed/);
});

test("webhook: /odds for an unregistered account gets the odds handler's own rejection, not the generic redirect", async () => {
  const response = await postUpdate(
    {
      update_id: 302,
      message: { message_id: 12, date: 1700000000, text: "/odds Real Madrid vs Barcelona, odds 2.05", chat: { id: 902 }, from: { id: Number(uniqueOddsTelegramId()) } },
    },
    fakeDb([]),
    undefined,
    fakeOddsOptions(),
  );

  assert.equal(response.status, 200);
  assert.equal(sentMessages.length, 1);
  assert.match(sentMessages[0].text, /not registered/i);
});

test("webhook: a repeated update_id for /odds invokes the odds handler at most once", async () => {
  const telegramId = uniqueOddsTelegramId();
  const db = fakeDb([{ id: "player-odds-route-3", telegramId }]);
  let parseCallCount = 0;
  const options = fakeOddsOptions({
    parseBetSlip: async () => {
      parseCallCount += 1;
      return {
        valid: true,
        type: "SINGLE",
        stake: 50,
        selections: [{ sport: "Football", event: "Real Madrid vs Barcelona", market: null, selection: "Real Madrid", submittedOdds: 2.05 }],
      };
    },
  });
  const update = {
    update_id: 303,
    message: { message_id: 13, date: 1700000000, text: "/odds Real Madrid vs Barcelona, odds 2.05", chat: { id: 903 }, from: { id: Number(telegramId) } },
  };

  const first = await postUpdate(update, db, undefined, options);
  const second = await postUpdate(update, db, undefined, options);

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(parseCallCount, 1, "the odds handler's parser must only run once, for the first delivery");
  assert.equal(sentMessages.length, 1);
});

test("webhook: /start behavior is unchanged after adding the /odds branch", async () => {
  const response = await postUpdate({
    update_id: 304,
    message: { message_id: 14, date: 1700000000, text: "/start", chat: { id: 904 }, from: { id: 99887766 } },
  });

  assert.equal(response.status, 200);
  assert.equal(sentMessages.length, 1);
  assert.match(sentMessages[0].text, /Добро пожаловать/);
});

test("webhook: ordinary text still receives REDIRECT_TEXT after adding the /odds branch", async () => {
  const response = await postUpdate({
    update_id: 305,
    message: { message_id: 15, date: 1700000000, text: "hello there", chat: { id: 905 }, from: { id: 99887767 } },
  });

  assert.equal(response.status, 200);
  assert.equal(sentMessages[0].text, "Для работы откройте приложение BetPilot AI.");
});

test("webhook: an unrelated command still receives REDIRECT_TEXT after adding the /odds branch", async () => {
  const response = await postUpdate({
    update_id: 306,
    message: { message_id: 16, date: 1700000000, text: "/help", chat: { id: 906 }, from: { id: 99887768 } },
  });

  assert.equal(response.status, 200);
  assert.equal(sentMessages[0].text, "Для работы откройте приложение BetPilot AI.");
});

/* -------------------------------------------------------------------------- */
/* Step 10B — natural-language betting text route wiring                     */
/* -------------------------------------------------------------------------- */
// looksLikeBettingText()'s own decision logic is fully covered by
// lib/telegram/looksLikeBettingText.test.ts; handleNaturalLanguageOdds's own
// authorization/cooldown/parsing/formatting behavior is fully covered by
// lib/telegram/oddsCommand.test.ts. These tests only prove the ROUTE wires
// the gate and handler in correctly, in the right place, and doesn't
// disturb any other branch. Fresh, never-reused telegramIds avoid the
// shared module-scoped cooldown store leaking between tests.

const BETTING_TEXT = "Real Madrid to win vs Barcelona, odds 2.05";

test("webhook: ordinary betting text (no command) invokes the natural-language handler and sends its reply, not the redirect", async () => {
  const telegramId = uniqueOddsTelegramId();
  const db = fakeDb([{ id: "player-nl-route-1", telegramId }]);

  const response = await postUpdate(
    {
      update_id: 400,
      message: { message_id: 20, date: 1700000000, text: BETTING_TEXT, chat: { id: 950 }, from: { id: Number(telegramId) } },
    },
    db,
    undefined,
    fakeOddsOptions(),
  );

  assert.equal(response.status, 200);
  assert.equal(sentMessages.length, 1);
  assert.match(sentMessages[0].text, /Odds confirmed/);
  assert.notEqual(sentMessages[0].text, "Для работы откройте приложение BetPilot AI.");
});

test("webhook: text that fails the intent gate never invokes the parser/provider and keeps the existing redirect", async () => {
  let parseCallCount = 0;
  const response = await postUpdate(
    {
      update_id: 401,
      message: { message_id: 21, date: 1700000000, text: "Hello, how are you?", chat: { id: 951 }, from: { id: 99887769 } },
    },
    undefined,
    undefined,
    fakeOddsOptions({ parseBetSlip: async () => { parseCallCount += 1; throw new Error("must not be called"); } }),
  );

  assert.equal(response.status, 200);
  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0].text, "Для работы откройте приложение BetPilot AI.");
  assert.equal(parseCallCount, 0);
});

test("webhook: an unsupported command whose payload looks bet-like never reaches the natural-language gate", async () => {
  let parseCallCount = 0;
  const response = await postUpdate(
    {
      update_id: 402,
      message: {
        message_id: 22,
        date: 1700000000,
        text: `/oddswrong ${BETTING_TEXT}`,
        chat: { id: 952 },
        from: { id: 99887770 },
      },
    },
    undefined,
    undefined,
    fakeOddsOptions({ parseBetSlip: async () => { parseCallCount += 1; throw new Error("must not be called"); } }),
  );

  assert.equal(response.status, 200);
  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0].text, "Для работы откройте приложение BetPilot AI.");
  assert.equal(parseCallCount, 0);
});

test("webhook: bot-authored betting-looking text is ignored entirely by the shared core — no reply at all, not even the redirect", async () => {
  const response = await postUpdate(
    {
      update_id: 403,
      message: {
        message_id: 23,
        date: 1700000000,
        text: BETTING_TEXT,
        chat: { id: 953 },
        from: { id: 99887771, is_bot: true },
      },
    },
    undefined,
    undefined,
    fakeOddsOptions(),
  );

  assert.equal(response.status, 200);
  assert.equal(sentMessages.length, 0);
});

test("webhook: an unauthorized user's betting-looking text gets the odds handler's own rejection, not the generic redirect", async () => {
  const response = await postUpdate(
    {
      update_id: 404,
      message: {
        message_id: 24,
        date: 1700000000,
        text: BETTING_TEXT,
        chat: { id: 954 },
        from: { id: Number(uniqueOddsTelegramId()) },
      },
    },
    fakeDb([]),
    undefined,
    fakeOddsOptions(),
  );

  assert.equal(response.status, 200);
  assert.equal(sentMessages.length, 1);
  assert.match(sentMessages[0].text, /not registered/i);
});

test("webhook: a repeated update_id for natural-language betting text invokes the handler at most once", async () => {
  const telegramId = uniqueOddsTelegramId();
  const db = fakeDb([{ id: "player-nl-route-2", telegramId }]);
  let parseCallCount = 0;
  const options = fakeOddsOptions({
    parseBetSlip: async () => {
      parseCallCount += 1;
      return {
        valid: true,
        type: "SINGLE",
        stake: 50,
        selections: [{ sport: "Football", event: "Real Madrid vs Barcelona", market: null, selection: "Real Madrid", submittedOdds: 2.05 }],
      };
    },
  });
  const update = {
    update_id: 405,
    message: { message_id: 25, date: 1700000000, text: BETTING_TEXT, chat: { id: 955 }, from: { id: Number(telegramId) } },
  };

  const first = await postUpdate(update, db, undefined, options);
  const second = await postUpdate(update, db, undefined, options);

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(parseCallCount, 1, "the natural-language handler's parser must only run once, for the first delivery");
  assert.equal(sentMessages.length, 1);
});

test("webhook: gate-rejected ordinary text does not consume cooldown — an immediate /odds request from the same user proceeds", async () => {
  const telegramId = uniqueOddsTelegramId();
  const db = fakeDb([{ id: "player-nl-route-3", telegramId }]);

  const rejectedResponse = await postUpdate(
    {
      update_id: 406,
      message: { message_id: 26, date: 1700000000, text: "Hello there, just saying hi", chat: { id: 956 }, from: { id: Number(telegramId) } },
    },
    db,
    undefined,
    fakeOddsOptions(),
  );
  assert.equal(rejectedResponse.status, 200);
  assert.equal(sentMessages[0].text, "Для работы откройте приложение BetPilot AI.");

  const oddsResponse = await postUpdate(
    {
      update_id: 407,
      message: { message_id: 27, date: 1700000000, text: `/odds ${BETTING_TEXT}`, chat: { id: 956 }, from: { id: Number(telegramId) } },
    },
    db,
    undefined,
    fakeOddsOptions(),
  );

  assert.equal(oddsResponse.status, 200);
  assert.equal(sentMessages.length, 2);
  assert.match(sentMessages[1].text, /Odds confirmed/);
});

test("webhook: a bot-authored bare /odds gets no reply at all, not even HELP_TEXT, and never reaches the parser", async () => {
  let parseCallCount = 0;

  const response = await postUpdate(
    {
      update_id: 408,
      message: { message_id: 28, date: 1700000000, text: "/odds", chat: { id: 957 }, from: { id: 99887772, is_bot: true } },
    },
    undefined,
    undefined,
    fakeOddsOptions({ parseBetSlip: async () => { parseCallCount += 1; throw new Error("must not be called"); } }),
  );

  assert.equal(response.status, 200);
  assert.equal(sentMessages.length, 0, "no HELP_TEXT or any other reply may be sent for a bot-authored bare /odds");
  assert.equal(parseCallCount, 0);
});

/* -------------------------------------------------------------------------- */
/* Stage 9.1 — /find (Event Discovery Engine, read-only) route wiring        */
/* -------------------------------------------------------------------------- */
// handleDiscoveryCommand's own authorization/payload/formatting behavior is
// fully covered by lib/telegram/discoveryCommand.test.ts and
// lib/telegram/formatDiscoveryReply.test.ts against fakes — these tests only
// prove the ROUTE respects the feature flag, dispatches to the handler
// correctly, and never disturbs the /odds or natural-language branches.

let nextFindTelegramId = 950000001;
function uniqueFindTelegramId(): string {
  nextFindTelegramId += 1;
  return String(nextFindTelegramId);
}

function makeCandidate(overrides: Partial<ResolvedEventCandidate> = {}): ResolvedEventCandidate {
  return {
    provider: "THE_ODDS_API",
    providerEventId: "evt-route-1",
    sportKey: "soccer_epl",
    league: "English Premier League",
    commenceTime: null,
    homeTeam: "Arsenal",
    awayTeam: "Coventry City",
    matchedTeamNames: ["Arsenal"],
    matchMethod: "EXACT",
    score: 1,
    diagnostics: [],
    ...overrides,
  };
}

function fakeDiscoveryResolver(
  overrides: Partial<Pick<CandidateResolver, "buildDependencies" | "resolve">> = {},
): Pick<CandidateResolver, "buildDependencies" | "resolve"> {
  return {
    buildDependencies: async () => ({ status: "SUCCESS" }),
    resolve: () => ({ kind: "TEAM_RESOLVED", candidate: makeCandidate() }),
    ...overrides,
  };
}

// Bypasses the shared postUpdate() helper (which has no discoveryCommandOptions
// parameter) rather than widening its signature, so none of the ~40 existing
// call sites above need to change.
function postFindUpdate(
  body: unknown,
  db: PrismaClient,
  discoveryCommandOptions: Omit<HandleDiscoveryCommandOptions, "db">,
  oddsCommandOptions?: Omit<HandleOddsCommandOptions, "db">,
): Promise<Response> {
  const request = new NextRequest("https://example.com/api/webhooks/telegram", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-telegram-bot-api-secret-token": WEBHOOK_SECRET,
    },
    body: JSON.stringify(body),
  });
  return handleTelegramWebhook(request, { db, discoveryCommandOptions, oddsCommandOptions });
}

test("webhook: /find is a no-op fallback (existing REDIRECT_TEXT) when the feature flag is off", async () => {
  delete process.env.TELEGRAM_DISCOVERY_READ_ONLY_ENABLED;
  let resolverCalled = false;
  const telegramId = uniqueFindTelegramId();

  const response = await postFindUpdate(
    {
      update_id: 500,
      message: { message_id: 30, date: 1700000000, text: "/find Arsenal", chat: { id: 1000 }, from: { id: Number(telegramId) } },
    },
    fakeDb([{ id: "player-find-flag-off", telegramId }]),
    {
      resolver: {
        buildDependencies: async () => {
          resolverCalled = true;
          return { status: "SUCCESS" };
        },
        resolve: () => {
          resolverCalled = true;
          return { kind: "TEAM_RESOLVED", candidate: makeCandidate() };
        },
      },
    },
  );

  assert.equal(response.status, 200);
  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0].text, "Для работы откройте приложение BetPilot AI.");
  assert.equal(resolverCalled, false, "the Discovery Engine must not be touched when the flag is off");
});

test("webhook: /find Arsenal invokes the discovery handler when the flag is on", async () => {
  process.env.TELEGRAM_DISCOVERY_READ_ONLY_ENABLED = "true";
  const telegramId = uniqueFindTelegramId();

  const response = await postFindUpdate(
    {
      update_id: 501,
      message: { message_id: 31, date: 1700000000, text: "/find Arsenal", chat: { id: 1001 }, from: { id: Number(telegramId) } },
    },
    fakeDb([{ id: "player-find-1", telegramId }]),
    { resolver: fakeDiscoveryResolver() },
  );

  assert.equal(response.status, 200);
  assert.equal(sentMessages.length, 1);
  assert.match(sentMessages[0].text, /Найден матч/);
  assert.notEqual(sentMessages[0].text, "Для работы откройте приложение BetPilot AI.");
});

test("webhook: /find@BotName Arsenal also invokes the discovery handler", async () => {
  process.env.TELEGRAM_DISCOVERY_READ_ONLY_ENABLED = "true";
  const telegramId = uniqueFindTelegramId();

  const response = await postFindUpdate(
    {
      update_id: 502,
      message: {
        message_id: 32,
        date: 1700000000,
        text: "/find@BetPilotAI_bot Arsenal",
        chat: { id: 1002 },
        from: { id: Number(telegramId) },
      },
    },
    fakeDb([{ id: "player-find-2", telegramId }]),
    { resolver: fakeDiscoveryResolver() },
  );

  assert.equal(response.status, 200);
  assert.match(sentMessages[0].text, /Найден матч/);
});

test("webhook: /find MU (short curated-alias-length query) is accepted", async () => {
  process.env.TELEGRAM_DISCOVERY_READ_ONLY_ENABLED = "true";
  const telegramId = uniqueFindTelegramId();
  let receivedQuery: string | undefined;

  const response = await postFindUpdate(
    {
      update_id: 503,
      message: { message_id: 33, date: 1700000000, text: "/find MU", chat: { id: 1003 }, from: { id: Number(telegramId) } },
    },
    fakeDb([{ id: "player-find-3", telegramId }]),
    {
      resolver: fakeDiscoveryResolver({
        resolve: (query: string) => {
          receivedQuery = query;
          return { kind: "TEAM_RESOLVED", candidate: makeCandidate({ homeTeam: "Manchester United" }) };
        },
      }),
    },
  );

  assert.equal(response.status, 200);
  assert.equal(receivedQuery, "MU");
  assert.match(sentMessages[0].text, /Manchester United/);
});

test("webhook: an empty /find gets the usage message, never reaches the resolver", async () => {
  process.env.TELEGRAM_DISCOVERY_READ_ONLY_ENABLED = "true";
  const telegramId = uniqueFindTelegramId();
  let resolverCalled = false;

  const response = await postFindUpdate(
    {
      update_id: 504,
      message: { message_id: 34, date: 1700000000, text: "/find", chat: { id: 1004 }, from: { id: Number(telegramId) } },
    },
    fakeDb([{ id: "player-find-4", telegramId }]),
    {
      resolver: {
        buildDependencies: async () => {
          resolverCalled = true;
          return { status: "SUCCESS" };
        },
        resolve: () => {
          resolverCalled = true;
          return { kind: "NOT_FOUND", reason: "x" };
        },
      },
    },
  );

  assert.equal(response.status, 200);
  assert.match(sentMessages[0].text, /Использование/);
  assert.equal(resolverCalled, false);
});

test("webhook: /find TEAM_RESOLVED result is formatted and sent", async () => {
  process.env.TELEGRAM_DISCOVERY_READ_ONLY_ENABLED = "true";
  const telegramId = uniqueFindTelegramId();
  const response = await postFindUpdate(
    {
      update_id: 505,
      message: { message_id: 35, date: 1700000000, text: "/find Arsenal", chat: { id: 1005 }, from: { id: Number(telegramId) } },
    },
    fakeDb([{ id: "player-find-5", telegramId }]),
    { resolver: fakeDiscoveryResolver({ resolve: () => ({ kind: "TEAM_RESOLVED", candidate: makeCandidate() }) }) },
  );
  assert.equal(response.status, 200);
  assert.match(sentMessages[0].text, /Найден матч/);
});

test("webhook: /find MATCH_RESOLVED result is formatted and sent", async () => {
  process.env.TELEGRAM_DISCOVERY_READ_ONLY_ENABLED = "true";
  const telegramId = uniqueFindTelegramId();
  const response = await postFindUpdate(
    {
      update_id: 506,
      message: {
        message_id: 36,
        date: 1700000000,
        text: "/find Real Madrid vs Barcelona",
        chat: { id: 1006 },
        from: { id: Number(telegramId) },
      },
    },
    fakeDb([{ id: "player-find-6", telegramId }]),
    {
      resolver: fakeDiscoveryResolver({
        resolve: () => ({
          kind: "MATCH_RESOLVED",
          candidate: makeCandidate({ homeTeam: "Real Madrid", awayTeam: "Barcelona", league: "La Liga" }),
        }),
      }),
    },
  );
  assert.equal(response.status, 200);
  assert.match(sentMessages[0].text, /Real Madrid/);
  assert.match(sentMessages[0].text, /Barcelona/);
});

test("webhook: /find AMBIGUOUS result is formatted and sent, no candidate auto-picked", async () => {
  process.env.TELEGRAM_DISCOVERY_READ_ONLY_ENABLED = "true";
  const telegramId = uniqueFindTelegramId();
  const response = await postFindUpdate(
    {
      update_id: 507,
      message: { message_id: 37, date: 1700000000, text: "/find Inter", chat: { id: 1007 }, from: { id: Number(telegramId) } },
    },
    fakeDb([{ id: "player-find-7", telegramId }]),
    {
      resolver: fakeDiscoveryResolver({
        resolve: () => ({
          kind: "AMBIGUOUS",
          candidates: [makeCandidate({ providerEventId: "e1" }), makeCandidate({ providerEventId: "e2", homeTeam: "Inter Miami" })],
          reason: "x",
        }),
      }),
    },
  );
  assert.equal(response.status, 200);
  assert.match(sentMessages[0].text, /несколько матчей/);
});

test("webhook: /find NOT_FOUND result is formatted and sent", async () => {
  process.env.TELEGRAM_DISCOVERY_READ_ONLY_ENABLED = "true";
  const telegramId = uniqueFindTelegramId();
  const response = await postFindUpdate(
    {
      update_id: 508,
      message: { message_id: 38, date: 1700000000, text: "/find Nonexistent", chat: { id: 1008 }, from: { id: Number(telegramId) } },
    },
    fakeDb([{ id: "player-find-8", telegramId }]),
    { resolver: fakeDiscoveryResolver({ resolve: () => ({ kind: "NOT_FOUND", reason: "x" }) }) },
  );
  assert.equal(response.status, 200);
  assert.match(sentMessages[0].text, /не найдены/);
});

test("webhook: /find INVALID_QUERY result is formatted and sent", async () => {
  process.env.TELEGRAM_DISCOVERY_READ_ONLY_ENABLED = "true";
  const telegramId = uniqueFindTelegramId();
  const response = await postFindUpdate(
    {
      update_id: 509,
      message: { message_id: 39, date: 1700000000, text: "/find A vs B vs C", chat: { id: 1009 }, from: { id: Number(telegramId) } },
    },
    fakeDb([{ id: "player-find-9", telegramId }]),
    { resolver: fakeDiscoveryResolver({ resolve: () => ({ kind: "INVALID_QUERY", reason: "x" }) }) },
  );
  assert.equal(response.status, 200);
  assert.match(sentMessages[0].text, /Использование/);
});

test("webhook: /find FAILED (Discovery Engine unavailable) gets a generic reply, never an internal reason", async () => {
  process.env.TELEGRAM_DISCOVERY_READ_ONLY_ENABLED = "true";
  const telegramId = uniqueFindTelegramId();
  const response = await postFindUpdate(
    {
      update_id: 510,
      message: { message_id: 40, date: 1700000000, text: "/find Arsenal", chat: { id: 1010 }, from: { id: Number(telegramId) } },
    },
    fakeDb([{ id: "player-find-10", telegramId }]),
    {
      resolver: {
        buildDependencies: async () => ({ status: "FAILED", source: "TEAM_INDEX", reason: "ALL_LEAGUES_UNAVAILABLE" }),
        resolve: () => ({ kind: "NOT_FOUND", reason: "x" }),
      },
    },
  );
  assert.equal(response.status, 200);
  assert.match(sentMessages[0].text, /временно недоступен/);
  assert.doesNotMatch(sentMessages[0].text, /ALL_LEAGUES_UNAVAILABLE/);
});

test("webhook: a repeated update_id for /find invokes the resolver at most once", async () => {
  process.env.TELEGRAM_DISCOVERY_READ_ONLY_ENABLED = "true";
  const telegramId = uniqueFindTelegramId();
  const db = fakeDb([{ id: "player-find-11", telegramId }]);
  let resolveCallCount = 0;
  const discoveryCommandOptions = {
    resolver: fakeDiscoveryResolver({
      resolve: () => {
        resolveCallCount += 1;
        return { kind: "TEAM_RESOLVED" as const, candidate: makeCandidate() };
      },
    }),
  };
  const update = {
    update_id: 511,
    message: { message_id: 41, date: 1700000000, text: "/find Arsenal", chat: { id: 1011 }, from: { id: Number(telegramId) } },
  };

  const first = await postFindUpdate(update, db, discoveryCommandOptions);
  const second = await postFindUpdate(update, db, discoveryCommandOptions);

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(resolveCallCount, 1, "the resolver must only be invoked once, for the first delivery");
  assert.equal(sentMessages.length, 1);
});

test("webhook: /odds continues on its own pipeline unaffected by the /find branch", async () => {
  const telegramId = uniqueOddsTelegramId();
  const db = fakeDb([{ id: "player-find-vs-odds-1", telegramId }]);

  const response = await postUpdate(
    {
      update_id: 512,
      message: { message_id: 42, date: 1700000000, text: "/odds Real Madrid vs Barcelona, odds 2.05", chat: { id: 1012 }, from: { id: Number(telegramId) } },
    },
    db,
    undefined,
    fakeOddsOptions(),
  );

  assert.equal(response.status, 200);
  assert.match(sentMessages[0].text, /Odds confirmed/);
});

test("webhook: natural-language betting text continues on its own pipeline unaffected by the /find branch", async () => {
  process.env.TELEGRAM_DISCOVERY_READ_ONLY_ENABLED = "true";
  const telegramId = uniqueOddsTelegramId();
  const db = fakeDb([{ id: "player-find-vs-nl-1", telegramId }]);

  const response = await postUpdate(
    {
      update_id: 513,
      message: { message_id: 43, date: 1700000000, text: BETTING_TEXT, chat: { id: 1013 }, from: { id: Number(telegramId) } },
    },
    db,
    undefined,
    fakeOddsOptions(),
  );

  assert.equal(response.status, 200);
  assert.match(sentMessages[0].text, /Odds confirmed/);
});

test("webhook: /find never invokes parseBetSlip/buildBetSlipPreview (the paid odds pipeline)", async () => {
  process.env.TELEGRAM_DISCOVERY_READ_ONLY_ENABLED = "true";
  const telegramId = uniqueFindTelegramId();
  let oddsParseCalled = false;

  const response = await postFindUpdate(
    {
      update_id: 514,
      message: { message_id: 44, date: 1700000000, text: "/find Arsenal", chat: { id: 1014 }, from: { id: Number(telegramId) } },
    },
    fakeDb([{ id: "player-find-12", telegramId }]),
    { resolver: fakeDiscoveryResolver() },
    fakeOddsOptions({
      parseBetSlip: async () => {
        oddsParseCalled = true;
        throw new Error("must not be called for /find");
      },
    }),
  );

  assert.equal(response.status, 200);
  assert.equal(oddsParseCalled, false);
  assert.match(sentMessages[0].text, /Найден матч/);
});

test("webhook: /find never mutates Player (only findUnique is available on the fake db)", async () => {
  process.env.TELEGRAM_DISCOVERY_READ_ONLY_ENABLED = "true";
  const telegramId = uniqueFindTelegramId();
  const readOnlyDb = {
    player: {
      findUnique: async ({ where }: { where: { telegramId: string } }) =>
        where.telegramId === telegramId ? { id: "player-find-readonly" } : null,
      // Deliberately no update/updateMany/create — a call to any of them
      // throws "not a function", which would fail this test loudly.
    },
  } as unknown as PrismaClient;

  const response = await postFindUpdate(
    {
      update_id: 515,
      message: { message_id: 45, date: 1700000000, text: "/find Arsenal", chat: { id: 1015 }, from: { id: Number(telegramId) } },
    },
    readOnlyDb,
    { resolver: fakeDiscoveryResolver() },
  );

  assert.equal(response.status, 200);
  assert.match(sentMessages[0].text, /Найден матч/);
});
