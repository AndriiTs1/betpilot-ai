import { test } from "node:test";
import assert from "node:assert/strict";
import type { PrismaClient } from "@/lib/generated/prisma/client";
import { handleOddsCommand, handleNaturalLanguageOdds } from "./oddsCommand";
import type { TelegramMessage } from "./telegramTypes";
import type { ParseBetSlipResult } from "@/lib/ai/betParser";
import type { OddsVerificationInput } from "@/lib/odds/oddsVerifier";
import type { OddsCheckResult } from "@/types/oddsSnapshot";

// Same hand-written-fake-db convention as
// lib/telegram/handleScreenshotMessage.test.ts / bindInvitedPlayer.test.ts —
// only implements the one Prisma call this module actually makes
// (player.findUnique). No bet/transaction methods at all: if
// handleOddsCommand ever attempted to write anything, calling a method this
// fake doesn't implement would throw immediately.
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

// The cooldown store (lib/telegram/oddsCommand.ts) is module-scoped, exactly
// like the webhook route's own update_id dedup Set — there is no reset hook
// anywhere in this codebase for that kind of state (confirmed: no existing
// test file resets internal module state between tests). Every test below
// that isn't specifically about cooldown behavior therefore uses its own
// never-reused synthetic telegramId, so it can never collide with another
// test's cooldown window regardless of real execution speed or ordering.
let nextTelegramId = 800000001;
function uniqueTelegramId(): string {
  nextTelegramId += 1;
  return String(nextTelegramId);
}

const TEST_SECRET = "test-preview-token-secret-odds";

function registeredDb(telegramId: string, playerId = "player-odds-test") {
  return fakeDb([{ id: playerId, telegramId }]);
}

function baseMessage(telegramId: string, overrides: Partial<TelegramMessage> = {}, fromOverrides: Partial<TelegramMessage["from"]> = {}): TelegramMessage {
  return {
    message_id: 1,
    date: 1700000000,
    chat: { id: 555001 },
    from: { id: Number(telegramId), ...fromOverrides },
    ...overrides,
  };
}

function verified(sourceOdds: number, submittedOdds: number, bookmaker = "Pinnacle"): OddsCheckResult {
  return {
    matched: true,
    withinTolerance: true,
    sourceOdds,
    submittedOdds,
    discrepancyPercent: 0,
    bookmaker,
    note: null,
  };
}

// Same "keyed by event name" convention as lib/bets/buildBetSlipPreview.test.ts.
function fakeVerifyOddsFn(byEvent: Record<string, OddsCheckResult | "reject">) {
  return async (input: OddsVerificationInput): Promise<OddsCheckResult> => {
    const outcome = byEvent[input.event];
    if (outcome === undefined) throw new Error(`No fake outcome configured for event "${input.event}"`);
    if (outcome === "reject") throw new Error(`Simulated odds-check failure for "${input.event}"`);
    return outcome;
  };
}

function fakeParseBetSlip(result: ParseBetSlipResult) {
  let callCount = 0;
  const fn = async (): Promise<ParseBetSlipResult> => {
    callCount += 1;
    return result;
  };
  return { fn, getCallCount: () => callCount };
}

function validSingleParse(overrides: Partial<Extract<ParseBetSlipResult, { valid: true }>> = {}): ParseBetSlipResult {
  return {
    valid: true,
    type: "SINGLE",
    stake: 50,
    selections: [{ sport: "Football", event: "Real Madrid vs Barcelona", market: null, selection: "Real Madrid", submittedOdds: 2.05 }],
    ...overrides,
  };
}

let sent: Array<{ chatId: string; text: string }> = [];
function fakeSend() {
  sent = [];
  return async (chatId: string, text: string) => {
    sent.push({ chatId, text });
    return true;
  };
}

const originalConsoleError = console.error;
const originalConsoleLog = console.log;
test.beforeEach(() => {
  sent = [];
  console.error = () => {};
  console.log = () => {};
});
test.afterEach(() => {
  console.error = originalConsoleError;
  console.log = originalConsoleLog;
});

/* -------------------------------------------------------------------------- */
/* B. Bot and authorization                                                   */
/* -------------------------------------------------------------------------- */

test("handleOddsCommand: is_bot:true is ignored before DB/parser/provider", async () => {
  const { fn: parseBetSlip, getCallCount } = fakeParseBetSlip(validSingleParse());
  let dbCalled = false;

  const outcome = await handleOddsCommand(baseMessage(uniqueTelegramId(), { text: "/odds Real Madrid vs Barcelona" }, { is_bot: true }), {
    db: { player: { findUnique: async () => { dbCalled = true; return null; } } } as unknown as PrismaClient,
    parseBetSlip,
    sendMessage: fakeSend(),
    previewTokenSecret: TEST_SECRET,
  });

  assert.deepEqual(outcome, { kind: "IGNORED_BOT" });
  assert.equal(dbCalled, false);
  assert.equal(getCallCount(), 0);
  assert.deepEqual(sent, []);
});

test("handleOddsCommand: an unauthorized (unregistered) Telegram user is rejected before parser/provider calls", async () => {
  const { fn: parseBetSlip, getCallCount } = fakeParseBetSlip(validSingleParse());

  const outcome = await handleOddsCommand(baseMessage(uniqueTelegramId(), { text: "/odds Real Madrid vs Barcelona, odds 2.05" }), {
    db: fakeDb([]), // nobody registered
    parseBetSlip,
    sendMessage: fakeSend(),
    previewTokenSecret: TEST_SECRET,
  });

  assert.deepEqual(outcome, { kind: "UNAUTHORIZED" });
  assert.equal(getCallCount(), 0);
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /not registered/i);
});

test("handleOddsCommand: an authorized player with a valid payload proceeds through parser and provider", async () => {
  const telegramId = uniqueTelegramId();
  const { fn: parseBetSlip } = fakeParseBetSlip(validSingleParse());

  const outcome = await handleOddsCommand(baseMessage(telegramId, { text: "/odds Real Madrid vs Barcelona, odds 2.05" }), {
    db: registeredDb(telegramId),
    parseBetSlip,
    sendMessage: fakeSend(),
    previewTokenSecret: TEST_SECRET,
    verifyOddsFn: fakeVerifyOddsFn({ "Real Madrid vs Barcelona": verified(2.05, 2.05) }),
  });

  assert.deepEqual(outcome, { kind: "SUCCESS" });
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /Odds confirmed/);
});

/* -------------------------------------------------------------------------- */
/* C. Cooldown                                                                */
/* -------------------------------------------------------------------------- */

test("handleOddsCommand: a second request from the same user inside the cooldown window is rejected without calling parser/provider", async () => {
  const telegramId = uniqueTelegramId();
  let clock = 1_000_000;
  const now = () => clock;
  const { fn: parseBetSlip, getCallCount } = fakeParseBetSlip(validSingleParse());
  const send = fakeSend();
  const verifyOddsFn = fakeVerifyOddsFn({ "Real Madrid vs Barcelona": verified(2.05, 2.05) });
  const db = registeredDb(telegramId);

  const first = await handleOddsCommand(baseMessage(telegramId, { text: "/odds Real Madrid vs Barcelona, odds 2.05" }), {
    db,
    parseBetSlip,
    sendMessage: send,
    previewTokenSecret: TEST_SECRET,
    verifyOddsFn,
    now,
    cooldownMs: 10_000,
  });
  assert.deepEqual(first, { kind: "SUCCESS" });
  assert.equal(getCallCount(), 1);

  clock += 5_000; // still inside the 10s window
  const second = await handleOddsCommand(baseMessage(telegramId, { text: "/odds Real Madrid vs Barcelona, odds 2.05" }), {
    db,
    parseBetSlip,
    sendMessage: send,
    previewTokenSecret: TEST_SECRET,
    verifyOddsFn,
    now,
    cooldownMs: 10_000,
  });

  assert.deepEqual(second, { kind: "COOLDOWN" });
  assert.equal(getCallCount(), 1, "parser must not be called again during cooldown");
  assert.equal(sent.length, 2);
  assert.match(sent[1].text, /wait/i);
});

test("handleOddsCommand: a request after the cooldown window elapses proceeds normally", async () => {
  const telegramId = uniqueTelegramId();
  let clock = 2_000_000;
  const now = () => clock;
  const { fn: parseBetSlip, getCallCount } = fakeParseBetSlip(validSingleParse());
  const send = fakeSend();
  const verifyOddsFn = fakeVerifyOddsFn({ "Real Madrid vs Barcelona": verified(2.05, 2.05) });
  const db = registeredDb(telegramId);

  await handleOddsCommand(baseMessage(telegramId, { text: "/odds Real Madrid vs Barcelona, odds 2.05" }), {
    db,
    parseBetSlip,
    sendMessage: send,
    previewTokenSecret: TEST_SECRET,
    verifyOddsFn,
    now,
    cooldownMs: 10_000,
  });

  clock += 10_001; // just past the window
  const second = await handleOddsCommand(baseMessage(telegramId, { text: "/odds Real Madrid vs Barcelona, odds 2.05" }), {
    db,
    parseBetSlip,
    sendMessage: send,
    previewTokenSecret: TEST_SECRET,
    verifyOddsFn,
    now,
    cooldownMs: 10_000,
  });

  assert.deepEqual(second, { kind: "SUCCESS" });
  assert.equal(getCallCount(), 2);
});

test("handleOddsCommand: different authorized users do not block each other under cooldown", async () => {
  const telegramIdA = uniqueTelegramId();
  const telegramIdB = uniqueTelegramId();
  const db = fakeDb([
    { id: "player-a", telegramId: telegramIdA },
    { id: "player-b", telegramId: telegramIdB },
  ]);
  const clock = 3_000_000;
  const now = () => clock;
  const { fn: parseBetSlip, getCallCount } = fakeParseBetSlip(validSingleParse());
  const send = fakeSend();
  const verifyOddsFn = fakeVerifyOddsFn({ "Real Madrid vs Barcelona": verified(2.05, 2.05) });

  const first = await handleOddsCommand(baseMessage(telegramIdA, { text: "/odds Real Madrid vs Barcelona, odds 2.05" }), {
    db,
    parseBetSlip,
    sendMessage: send,
    previewTokenSecret: TEST_SECRET,
    verifyOddsFn,
    now,
    cooldownMs: 10_000,
  });

  const second = await handleOddsCommand(baseMessage(telegramIdB, { text: "/odds Real Madrid vs Barcelona, odds 2.05" }), {
    db,
    parseBetSlip,
    sendMessage: send,
    previewTokenSecret: TEST_SECRET,
    verifyOddsFn,
    now,
    cooldownMs: 10_000,
  });

  assert.deepEqual(first, { kind: "SUCCESS" });
  assert.deepEqual(second, { kind: "SUCCESS" });
  assert.equal(getCallCount(), 2);
});

test("handleOddsCommand: cooldown uses the injected clock, not real wall-clock time", async () => {
  const telegramId = uniqueTelegramId();
  let clock = 4_000_000;
  const now = () => clock;
  const { fn: parseBetSlip, getCallCount } = fakeParseBetSlip(validSingleParse());
  const send = fakeSend();
  const verifyOddsFn = fakeVerifyOddsFn({ "Real Madrid vs Barcelona": verified(2.05, 2.05) });
  const db = registeredDb(telegramId);

  await handleOddsCommand(baseMessage(telegramId, { text: "/odds Real Madrid vs Barcelona, odds 2.05" }), {
    db,
    parseBetSlip,
    sendMessage: send,
    previewTokenSecret: TEST_SECRET,
    verifyOddsFn,
    now,
    cooldownMs: 1,
  });

  clock += 2; // past a 1ms cooldown, instantly, with no real waiting
  const second = await handleOddsCommand(baseMessage(telegramId, { text: "/odds Real Madrid vs Barcelona, odds 2.05" }), {
    db,
    parseBetSlip,
    sendMessage: send,
    previewTokenSecret: TEST_SECRET,
    verifyOddsFn,
    now,
    cooldownMs: 1,
  });

  assert.deepEqual(second, { kind: "SUCCESS" });
  assert.equal(getCallCount(), 2);
});

/* -------------------------------------------------------------------------- */
/* D. Parser                                                                  */
/* -------------------------------------------------------------------------- */

test("handleOddsCommand: a valid SINGLE parse reaches buildBetSlipPreview and produces a reply", async () => {
  const telegramId = uniqueTelegramId();
  const { fn: parseBetSlip } = fakeParseBetSlip(validSingleParse());

  const outcome = await handleOddsCommand(baseMessage(telegramId, { text: "/odds Real Madrid vs Barcelona, odds 2.05" }), {
    db: registeredDb(telegramId),
    parseBetSlip,
    sendMessage: fakeSend(),
    previewTokenSecret: TEST_SECRET,
    verifyOddsFn: fakeVerifyOddsFn({ "Real Madrid vs Barcelona": verified(2.05, 2.05) }),
  });

  assert.deepEqual(outcome, { kind: "SUCCESS" });
});

test("handleOddsCommand: a valid EXPRESS parse reaches buildBetSlipPreview and produces a reply", async () => {
  const telegramId = uniqueTelegramId();
  const expressParse: ParseBetSlipResult = {
    valid: true,
    type: "EXPRESS",
    stake: 30,
    selections: [
      { sport: "Football", event: "Real Madrid vs Barcelona", market: null, selection: "Real Madrid", submittedOdds: 1.8 },
      { sport: "Football", event: "Inter vs Juventus", market: null, selection: "Juventus", submittedOdds: 2.1 },
    ],
  };
  const { fn: parseBetSlip } = fakeParseBetSlip(expressParse);

  const outcome = await handleOddsCommand(baseMessage(telegramId, { text: "/odds Real Madrid and Juventus express" }), {
    db: registeredDb(telegramId),
    parseBetSlip,
    sendMessage: fakeSend(),
    previewTokenSecret: TEST_SECRET,
    verifyOddsFn: fakeVerifyOddsFn({
      "Real Madrid vs Barcelona": verified(1.8, 1.8),
      "Inter vs Juventus": verified(2.1, 2.1),
    }),
  });

  assert.deepEqual(outcome, { kind: "SUCCESS" });
  assert.match(sent[0].text, /Selection 1/);
  assert.match(sent[0].text, /Selection 2/);
});

test("handleOddsCommand: parser rejection sends a generic failure without the internal error text", async () => {
  const telegramId = uniqueTelegramId();
  const { fn: parseBetSlip } = fakeParseBetSlip({ valid: false, error: "internal Claude schema validation detail xyz" });

  const outcome = await handleOddsCommand(baseMessage(telegramId, { text: "/odds not really a bet at all" }), {
    db: registeredDb(telegramId),
    parseBetSlip,
    sendMessage: fakeSend(),
    previewTokenSecret: TEST_SECRET,
  });

  assert.deepEqual(outcome, { kind: "PARSE_FAILED" });
  assert.equal(sent.length, 1);
  assert.doesNotMatch(sent[0].text, /internal Claude schema/);
});

test("handleOddsCommand: a parser timeout sends a generic temporary-failure reply", async () => {
  const telegramId = uniqueTelegramId();
  const { fn: parseBetSlip } = fakeParseBetSlip({ valid: false, error: "Claude request timed out after 8000ms", code: "timeout" });

  const outcome = await handleOddsCommand(baseMessage(telegramId, { text: "/odds Real Madrid vs Barcelona, odds 2.05" }), {
    db: registeredDb(telegramId),
    parseBetSlip,
    sendMessage: fakeSend(),
    previewTokenSecret: TEST_SECRET,
  });

  assert.deepEqual(outcome, { kind: "PARSE_TIMEOUT" });
  assert.equal(sent.length, 1);
  assert.doesNotMatch(sent[0].text, /8000ms/);
});

/* -------------------------------------------------------------------------- */
/* E. Preview secret                                                         */
/* -------------------------------------------------------------------------- */

test("handleOddsCommand: an injected test secret is honored (no dummy fallback is used)", async () => {
  const telegramId = uniqueTelegramId();
  const { fn: parseBetSlip } = fakeParseBetSlip(validSingleParse());

  // Indirect proof: buildBetSlipPreview() only succeeds when it receives a
  // truthy secret string at all — passing one through here and getting
  // SUCCESS (rather than CONFIG_UNAVAILABLE) proves handleOddsCommand
  // actually forwards options.previewTokenSecret into buildBetSlipPreview()
  // rather than substituting a fabricated value.
  const outcome = await handleOddsCommand(baseMessage(telegramId, { text: "/odds Real Madrid vs Barcelona, odds 2.05" }), {
    db: registeredDb(telegramId),
    parseBetSlip,
    sendMessage: fakeSend(),
    previewTokenSecret: TEST_SECRET,
    verifyOddsFn: fakeVerifyOddsFn({ "Real Madrid vs Barcelona": verified(2.05, 2.05) }),
  });

  assert.deepEqual(outcome, { kind: "SUCCESS" });
});

test("handleOddsCommand: a missing preview-token secret prevents parser and provider invocation", async () => {
  const telegramId = uniqueTelegramId();
  const originalEnv = process.env.BET_PREVIEW_TOKEN_SECRET;
  delete process.env.BET_PREVIEW_TOKEN_SECRET;
  try {
    const { fn: parseBetSlip, getCallCount } = fakeParseBetSlip(validSingleParse());

    const outcome = await handleOddsCommand(baseMessage(telegramId, { text: "/odds Real Madrid vs Barcelona, odds 2.05" }), {
      db: registeredDb(telegramId),
      parseBetSlip,
      sendMessage: fakeSend(),
      // previewTokenSecret deliberately omitted — falls through to the
      // (now-deleted) environment variable.
    });

    assert.deepEqual(outcome, { kind: "CONFIG_UNAVAILABLE" });
    assert.equal(getCallCount(), 0, "the parser must never be called when the secret is missing");
    assert.equal(sent.length, 1);
  } finally {
    if (originalEnv !== undefined) process.env.BET_PREVIEW_TOKEN_SECRET = originalEnv;
  }
});

test("handleOddsCommand: the preview-token secret never appears in the sent Telegram text", async () => {
  const telegramId = uniqueTelegramId();
  const { fn: parseBetSlip } = fakeParseBetSlip(validSingleParse());

  await handleOddsCommand(baseMessage(telegramId, { text: "/odds Real Madrid vs Barcelona, odds 2.05" }), {
    db: registeredDb(telegramId),
    parseBetSlip,
    sendMessage: fakeSend(),
    previewTokenSecret: TEST_SECRET,
    verifyOddsFn: fakeVerifyOddsFn({ "Real Madrid vs Barcelona": verified(2.05, 2.05) }),
  });

  for (const message of sent) {
    assert.doesNotMatch(message.text, new RegExp(TEST_SECRET));
  }
});

/* -------------------------------------------------------------------------- */
/* Payload validation (help / invalid)                                       */
/* -------------------------------------------------------------------------- */

test("handleOddsCommand: /odds with no payload sends help text without calling the parser", async () => {
  const telegramId = uniqueTelegramId();
  const { fn: parseBetSlip, getCallCount } = fakeParseBetSlip(validSingleParse());

  const outcome = await handleOddsCommand(baseMessage(telegramId, { text: "/odds" }), {
    db: registeredDb(telegramId),
    parseBetSlip,
    sendMessage: fakeSend(),
    previewTokenSecret: TEST_SECRET,
  });

  assert.deepEqual(outcome, { kind: "HELP" });
  assert.equal(getCallCount(), 0);
  assert.match(sent[0].text, /Usage/i);
});

test("handleOddsCommand: an out-of-bounds payload is rejected without calling the parser", async () => {
  const telegramId = uniqueTelegramId();
  const { fn: parseBetSlip, getCallCount } = fakeParseBetSlip(validSingleParse());

  const outcome = await handleOddsCommand(baseMessage(telegramId, { text: "/odds ab" }), {
    db: registeredDb(telegramId),
    parseBetSlip,
    sendMessage: fakeSend(),
    previewTokenSecret: TEST_SECRET,
  });

  assert.deepEqual(outcome, { kind: "INVALID_PAYLOAD" });
  assert.equal(getCallCount(), 0);
});

/* -------------------------------------------------------------------------- */
/* F. Verification and formatting wiring, G. EXPRESS wiring                  */
/* -------------------------------------------------------------------------- */

test("handleOddsCommand: an unresolved leg (NOT_FOUND) does not prevent the reply from being sent", async () => {
  const telegramId = uniqueTelegramId();
  const { fn: parseBetSlip } = fakeParseBetSlip(validSingleParse());

  const outcome = await handleOddsCommand(baseMessage(telegramId, { text: "/odds Real Madrid vs Barcelona, odds 2.05" }), {
    db: registeredDb(telegramId),
    parseBetSlip,
    sendMessage: fakeSend(),
    previewTokenSecret: TEST_SECRET,
    verifyOddsFn: fakeVerifyOddsFn({ "Real Madrid vs Barcelona": "reject" }),
  });

  assert.deepEqual(outcome, { kind: "SUCCESS" });
  assert.match(sent[0].text, /Odds check unavailable|Event or selection not found/);
});

test("handleOddsCommand: an unexpected error from buildBetSlipPreview produces a generic reply, never the raw error text", async () => {
  const telegramId = uniqueTelegramId();
  const { fn: parseBetSlip } = fakeParseBetSlip(validSingleParse());

  const outcome = await handleOddsCommand(baseMessage(telegramId, { text: "/odds Real Madrid vs Barcelona, odds 2.05" }), {
    db: registeredDb(telegramId),
    parseBetSlip,
    sendMessage: fakeSend(),
    previewTokenSecret: TEST_SECRET,
    oddsVerificationService: {
      verifyMany: async () => {
        throw new Error("some internal provider stack trace detail");
      },
    },
  });

  assert.deepEqual(outcome, { kind: "UNEXPECTED_ERROR" });
  assert.equal(sent.length, 1);
  assert.doesNotMatch(sent[0].text, /stack trace/);
});

test("handleOddsCommand: sends exactly one final message for a normal successful request", async () => {
  const telegramId = uniqueTelegramId();
  const { fn: parseBetSlip } = fakeParseBetSlip(validSingleParse());

  await handleOddsCommand(baseMessage(telegramId, { text: "/odds Real Madrid vs Barcelona, odds 2.05" }), {
    db: registeredDb(telegramId),
    parseBetSlip,
    sendMessage: fakeSend(),
    previewTokenSecret: TEST_SECRET,
    verifyOddsFn: fakeVerifyOddsFn({ "Real Madrid vs Barcelona": verified(2.05, 2.05) }),
  });

  assert.equal(sent.length, 1);
});

/* -------------------------------------------------------------------------- */
/* Pre-commit ordering review — Section 5.A: requests that must NOT consume  */
/* a cooldown slot, proven by a valid follow-up from the same user           */
/* succeeding immediately afterward (same `now`, same cooldownMs).           */
/* -------------------------------------------------------------------------- */

test("handleOddsCommand: a missing payload does not consume cooldown — a valid follow-up proceeds immediately", async () => {
  const telegramId = uniqueTelegramId();
  const now = () => 5_000_000; // frozen — proves no cooldown slot was reserved, not just that time passed
  const db = registeredDb(telegramId);
  const { fn: parseBetSlip, getCallCount } = fakeParseBetSlip(validSingleParse());

  const first = await handleOddsCommand(baseMessage(telegramId, { text: "/odds" }), {
    db,
    parseBetSlip,
    sendMessage: fakeSend(),
    previewTokenSecret: TEST_SECRET,
    now,
    cooldownMs: 10_000,
  });
  assert.deepEqual(first, { kind: "HELP" });

  const second = await handleOddsCommand(baseMessage(telegramId, { text: "/odds Real Madrid vs Barcelona, odds 2.05" }), {
    db,
    parseBetSlip,
    sendMessage: fakeSend(),
    previewTokenSecret: TEST_SECRET,
    verifyOddsFn: fakeVerifyOddsFn({ "Real Madrid vs Barcelona": verified(2.05, 2.05) }),
    now,
    cooldownMs: 10_000,
  });

  assert.deepEqual(second, { kind: "SUCCESS" });
  assert.equal(getCallCount(), 1);
});

test("handleOddsCommand: a too-short payload does not consume cooldown", async () => {
  const telegramId = uniqueTelegramId();
  const now = () => 5_000_001;
  const db = registeredDb(telegramId);
  const { fn: parseBetSlip } = fakeParseBetSlip(validSingleParse());

  const first = await handleOddsCommand(baseMessage(telegramId, { text: "/odds ab" }), {
    db,
    parseBetSlip,
    sendMessage: fakeSend(),
    previewTokenSecret: TEST_SECRET,
    now,
    cooldownMs: 10_000,
  });
  assert.deepEqual(first, { kind: "INVALID_PAYLOAD" });

  const second = await handleOddsCommand(baseMessage(telegramId, { text: "/odds Real Madrid vs Barcelona, odds 2.05" }), {
    db,
    parseBetSlip,
    sendMessage: fakeSend(),
    previewTokenSecret: TEST_SECRET,
    verifyOddsFn: fakeVerifyOddsFn({ "Real Madrid vs Barcelona": verified(2.05, 2.05) }),
    now,
    cooldownMs: 10_000,
  });
  assert.deepEqual(second, { kind: "SUCCESS" });
});

test("handleOddsCommand: a too-long payload does not consume cooldown", async () => {
  const telegramId = uniqueTelegramId();
  const now = () => 5_000_002;
  const db = registeredDb(telegramId);
  const { fn: parseBetSlip } = fakeParseBetSlip(validSingleParse());
  const tooLong = `/odds ${"a".repeat(2001)}`;

  const first = await handleOddsCommand(baseMessage(telegramId, { text: tooLong }), {
    db,
    parseBetSlip,
    sendMessage: fakeSend(),
    previewTokenSecret: TEST_SECRET,
    now,
    cooldownMs: 10_000,
  });
  assert.deepEqual(first, { kind: "INVALID_PAYLOAD" });

  const second = await handleOddsCommand(baseMessage(telegramId, { text: "/odds Real Madrid vs Barcelona, odds 2.05" }), {
    db,
    parseBetSlip,
    sendMessage: fakeSend(),
    previewTokenSecret: TEST_SECRET,
    verifyOddsFn: fakeVerifyOddsFn({ "Real Madrid vs Barcelona": verified(2.05, 2.05) }),
    now,
    cooldownMs: 10_000,
  });
  assert.deepEqual(second, { kind: "SUCCESS" });
});

test("handleOddsCommand: an unauthorized user does not consume cooldown", async () => {
  const telegramId = uniqueTelegramId();
  const now = () => 5_000_003;
  const { fn: parseBetSlip } = fakeParseBetSlip(validSingleParse());

  const first = await handleOddsCommand(baseMessage(telegramId, { text: "/odds Real Madrid vs Barcelona, odds 2.05" }), {
    db: fakeDb([]), // not registered yet
    parseBetSlip,
    sendMessage: fakeSend(),
    previewTokenSecret: TEST_SECRET,
    now,
    cooldownMs: 10_000,
  });
  assert.deepEqual(first, { kind: "UNAUTHORIZED" });

  // Same user, now registered — proves the earlier rejection never touched
  // the cooldown store keyed by this telegramId.
  const second = await handleOddsCommand(baseMessage(telegramId, { text: "/odds Real Madrid vs Barcelona, odds 2.05" }), {
    db: registeredDb(telegramId),
    parseBetSlip,
    sendMessage: fakeSend(),
    previewTokenSecret: TEST_SECRET,
    verifyOddsFn: fakeVerifyOddsFn({ "Real Madrid vs Barcelona": verified(2.05, 2.05) }),
    now,
    cooldownMs: 10_000,
  });
  assert.deepEqual(second, { kind: "SUCCESS" });
});

test("handleOddsCommand: a missing preview-token secret does not consume cooldown — a valid follow-up proceeds immediately", async () => {
  const telegramId = uniqueTelegramId();
  const now = () => 5_000_004;
  const db = registeredDb(telegramId);
  const { fn: parseBetSlip, getCallCount } = fakeParseBetSlip(validSingleParse());
  const originalEnv = process.env.BET_PREVIEW_TOKEN_SECRET;
  delete process.env.BET_PREVIEW_TOKEN_SECRET;

  try {
    const first = await handleOddsCommand(baseMessage(telegramId, { text: "/odds Real Madrid vs Barcelona, odds 2.05" }), {
      db,
      parseBetSlip,
      sendMessage: fakeSend(),
      // previewTokenSecret deliberately omitted, env deleted above.
      now,
      cooldownMs: 10_000,
    });
    assert.deepEqual(first, { kind: "CONFIG_UNAVAILABLE" });
    assert.equal(getCallCount(), 0);
  } finally {
    if (originalEnv !== undefined) process.env.BET_PREVIEW_TOKEN_SECRET = originalEnv;
  }

  const second = await handleOddsCommand(baseMessage(telegramId, { text: "/odds Real Madrid vs Barcelona, odds 2.05" }), {
    db,
    parseBetSlip,
    sendMessage: fakeSend(),
    previewTokenSecret: TEST_SECRET, // now configured
    verifyOddsFn: fakeVerifyOddsFn({ "Real Madrid vs Barcelona": verified(2.05, 2.05) }),
    now,
    cooldownMs: 10_000,
  });
  assert.deepEqual(second, { kind: "SUCCESS" });
  assert.equal(getCallCount(), 1);
});

/* -------------------------------------------------------------------------- */
/* Pre-commit ordering review — Section 5.B: once the parser has started (or */
/* is about to start), the cooldown reservation MUST stick even on failure  */
/* — a second immediate request must NOT re-invoke the parser.               */
/* -------------------------------------------------------------------------- */

test("handleOddsCommand: parser valid:false consumes the cooldown", async () => {
  const telegramId = uniqueTelegramId();
  const now = () => 6_000_000;
  const db = registeredDb(telegramId);
  const { fn: parseBetSlip, getCallCount } = fakeParseBetSlip({ valid: false, error: "not a bet" });

  const first = await handleOddsCommand(baseMessage(telegramId, { text: "/odds not really a bet at all" }), {
    db,
    parseBetSlip,
    sendMessage: fakeSend(),
    previewTokenSecret: TEST_SECRET,
    now,
    cooldownMs: 10_000,
  });
  assert.deepEqual(first, { kind: "PARSE_FAILED" });
  assert.equal(getCallCount(), 1);

  const second = await handleOddsCommand(baseMessage(telegramId, { text: "/odds Real Madrid vs Barcelona, odds 2.05" }), {
    db,
    parseBetSlip,
    sendMessage: fakeSend(),
    previewTokenSecret: TEST_SECRET,
    now,
    cooldownMs: 10_000,
  });
  assert.deepEqual(second, { kind: "COOLDOWN" });
  assert.equal(getCallCount(), 1, "the parser must not be invoked again while the cooldown from the failed attempt is still active");
});

test("handleOddsCommand: a parser timeout consumes the cooldown", async () => {
  const telegramId = uniqueTelegramId();
  const now = () => 6_000_001;
  const db = registeredDb(telegramId);
  const { fn: parseBetSlip, getCallCount } = fakeParseBetSlip({ valid: false, error: "timed out", code: "timeout" });

  const first = await handleOddsCommand(baseMessage(telegramId, { text: "/odds Real Madrid vs Barcelona, odds 2.05" }), {
    db,
    parseBetSlip,
    sendMessage: fakeSend(),
    previewTokenSecret: TEST_SECRET,
    now,
    cooldownMs: 10_000,
  });
  assert.deepEqual(first, { kind: "PARSE_TIMEOUT" });

  const second = await handleOddsCommand(baseMessage(telegramId, { text: "/odds Real Madrid vs Barcelona, odds 2.05" }), {
    db,
    parseBetSlip,
    sendMessage: fakeSend(),
    previewTokenSecret: TEST_SECRET,
    now,
    cooldownMs: 10_000,
  });
  assert.deepEqual(second, { kind: "COOLDOWN" });
  assert.equal(getCallCount(), 1);
});

test("handleOddsCommand: a parser throw consumes the cooldown", async () => {
  const telegramId = uniqueTelegramId();
  const now = () => 6_000_002;
  const db = registeredDb(telegramId);
  let callCount = 0;
  const throwingParseBetSlip = async () => {
    callCount += 1;
    throw new Error("simulated unexpected parser failure");
  };

  const first = await handleOddsCommand(baseMessage(telegramId, { text: "/odds Real Madrid vs Barcelona, odds 2.05" }), {
    db,
    parseBetSlip: throwingParseBetSlip,
    sendMessage: fakeSend(),
    previewTokenSecret: TEST_SECRET,
    now,
    cooldownMs: 10_000,
  });
  assert.deepEqual(first, { kind: "UNEXPECTED_ERROR" });
  assert.equal(callCount, 1);

  const second = await handleOddsCommand(baseMessage(telegramId, { text: "/odds Real Madrid vs Barcelona, odds 2.05" }), {
    db,
    parseBetSlip: throwingParseBetSlip,
    sendMessage: fakeSend(),
    previewTokenSecret: TEST_SECRET,
    now,
    cooldownMs: 10_000,
  });
  assert.deepEqual(second, { kind: "COOLDOWN" });
  assert.equal(callCount, 1, "the parser must not be invoked again while the cooldown from the failed attempt is still active");
});

test("handleOddsCommand: a buildBetSlipPreview/provider failure consumes the cooldown", async () => {
  const telegramId = uniqueTelegramId();
  const now = () => 6_000_003;
  const db = registeredDb(telegramId);
  const { fn: parseBetSlip, getCallCount } = fakeParseBetSlip(validSingleParse());
  const failingService = {
    verifyMany: async () => {
      throw new Error("simulated provider failure");
    },
  };

  const first = await handleOddsCommand(baseMessage(telegramId, { text: "/odds Real Madrid vs Barcelona, odds 2.05" }), {
    db,
    parseBetSlip,
    sendMessage: fakeSend(),
    previewTokenSecret: TEST_SECRET,
    oddsVerificationService: failingService,
    now,
    cooldownMs: 10_000,
  });
  assert.deepEqual(first, { kind: "UNEXPECTED_ERROR" });
  assert.equal(getCallCount(), 1);

  const second = await handleOddsCommand(baseMessage(telegramId, { text: "/odds Real Madrid vs Barcelona, odds 2.05" }), {
    db,
    parseBetSlip,
    sendMessage: fakeSend(),
    previewTokenSecret: TEST_SECRET,
    oddsVerificationService: failingService,
    now,
    cooldownMs: 10_000,
  });
  assert.deepEqual(second, { kind: "COOLDOWN" });
  assert.equal(getCallCount(), 1, "the parser must not be invoked again while the cooldown from the failed attempt is still active");
});

/* -------------------------------------------------------------------------- */
/* Pre-commit ordering review — Section 5.C: concurrency. The cooldown check */
/* and reservation must happen synchronously (no await between them), so    */
/* two near-simultaneous requests from the SAME user can never both invoke  */
/* the parser, while two DIFFERENT users remain fully independent.          */
/* -------------------------------------------------------------------------- */

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

test("handleOddsCommand: two concurrent requests from the same user invoke the parser at most once — the second observes COOLDOWN", async () => {
  const telegramId = uniqueTelegramId();
  const now = () => 7_000_000;
  const db = registeredDb(telegramId);
  const gate = deferred<ParseBetSlipResult>();
  let parseCallCount = 0;
  const deferredParseBetSlip = async (): Promise<ParseBetSlipResult> => {
    parseCallCount += 1;
    return gate.promise;
  };

  // Request A starts and reaches (and awaits) the parser call, but does not
  // resolve yet.
  const requestA = handleOddsCommand(baseMessage(telegramId, { text: "/odds Real Madrid vs Barcelona, odds 2.05" }), {
    db,
    parseBetSlip: deferredParseBetSlip,
    sendMessage: fakeSend(),
    previewTokenSecret: TEST_SECRET,
    now,
    cooldownMs: 10_000,
  });

  // Give request A's synchronous prefix (bot guard -> await db lookup ->
  // payload validation -> secret check -> cooldown reserve -> start of the
  // parser await) a chance to run before request B starts. The db lookup is
  // the only await before the parser call, so one microtask flush is enough
  // to guarantee request A has already reserved the cooldown slot.
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(parseCallCount, 1, "request A must have already invoked the parser before request B starts");

  // Request B arrives for the SAME user while request A's parser call is
  // still pending.
  const requestB = await handleOddsCommand(baseMessage(telegramId, { text: "/odds Real Madrid vs Barcelona, odds 2.05" }), {
    db,
    parseBetSlip: deferredParseBetSlip,
    sendMessage: fakeSend(),
    previewTokenSecret: TEST_SECRET,
    now,
    cooldownMs: 10_000,
  });

  assert.deepEqual(requestB, { kind: "COOLDOWN" });
  assert.equal(parseCallCount, 1, "the parser must never be invoked a second time while request A is still in flight");

  // Resolved as an invalid parse (not a valid slip) deliberately — this
  // test's assertions are entirely about the parser call count and the
  // COOLDOWN outcome above; letting request A resolve to `valid:false`
  // finishes it without ever reaching buildBetSlipPreview (which would
  // otherwise need its own fake odds dependency, irrelevant here).
  gate.resolve({ valid: false, error: "n/a" });
  const resultA = await requestA;
  assert.deepEqual(resultA, { kind: "PARSE_FAILED" });
});

test("handleOddsCommand: two different users with concurrent deferred requests both proceed independently", async () => {
  const telegramIdA = uniqueTelegramId();
  const telegramIdB = uniqueTelegramId();
  const now = () => 7_000_001;
  const db = fakeDb([
    { id: "player-concurrent-a", telegramId: telegramIdA },
    { id: "player-concurrent-b", telegramId: telegramIdB },
  ]);
  const gateA = deferred<ParseBetSlipResult>();
  const gateB = deferred<ParseBetSlipResult>();
  let callCountA = 0;
  let callCountB = 0;

  const requestA = handleOddsCommand(baseMessage(telegramIdA, { text: "/odds Real Madrid vs Barcelona, odds 2.05" }), {
    db,
    parseBetSlip: async () => {
      callCountA += 1;
      return gateA.promise;
    },
    sendMessage: fakeSend(),
    previewTokenSecret: TEST_SECRET,
    now,
    cooldownMs: 10_000,
  });

  await Promise.resolve();
  await Promise.resolve();

  const requestB = handleOddsCommand(baseMessage(telegramIdB, { text: "/odds Real Madrid vs Barcelona, odds 2.05" }), {
    db,
    parseBetSlip: async () => {
      callCountB += 1;
      return gateB.promise;
    },
    sendMessage: fakeSend(),
    previewTokenSecret: TEST_SECRET,
    now,
    cooldownMs: 10_000,
  });

  await Promise.resolve();
  await Promise.resolve();

  assert.equal(callCountA, 1, "user A's parser call must have started");
  assert.equal(callCountB, 1, "user B's parser call must have started independently of user A's cooldown");

  gateA.resolve({ valid: false, error: "n/a" });
  gateB.resolve({ valid: false, error: "n/a" });
  await requestA;
  await requestB;
});

/* -------------------------------------------------------------------------- */
/* Step 10B — handleNaturalLanguageOdds: the same shared core reused for     */
/* ordinary text that app/api/webhooks/telegram/route.ts has already        */
/* decided looksLikeBettingText() for. This module never re-runs that gate — */
/* every text passed to handleNaturalLanguageOdds below is treated as        */
/* already-accepted by the caller.                                           */
/* -------------------------------------------------------------------------- */

const NATURAL_TEXT = "Real Madrid to win vs Barcelona, odds 2.05";

test("handleNaturalLanguageOdds: authorized valid natural text succeeds and formats via formatOddsReply", async () => {
  const telegramId = uniqueTelegramId();
  const { fn: parseBetSlip } = fakeParseBetSlip(validSingleParse());

  const outcome = await handleNaturalLanguageOdds(baseMessage(telegramId, { text: NATURAL_TEXT }), {
    db: registeredDb(telegramId),
    parseBetSlip,
    sendMessage: fakeSend(),
    previewTokenSecret: TEST_SECRET,
    verifyOddsFn: fakeVerifyOddsFn({ "Real Madrid vs Barcelona": verified(2.05, 2.05) }),
  });

  assert.deepEqual(outcome, { kind: "SUCCESS" });
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /Odds confirmed/);
});

test("handleNaturalLanguageOdds: an unauthorized user never reaches the parser or provider", async () => {
  const telegramId = uniqueTelegramId();
  const { fn: parseBetSlip, getCallCount } = fakeParseBetSlip(validSingleParse());

  const outcome = await handleNaturalLanguageOdds(baseMessage(telegramId, { text: NATURAL_TEXT }), {
    db: fakeDb([]),
    parseBetSlip,
    sendMessage: fakeSend(),
    previewTokenSecret: TEST_SECRET,
  });

  assert.deepEqual(outcome, { kind: "UNAUTHORIZED" });
  assert.equal(getCallCount(), 0);
});

test("handleNaturalLanguageOdds: a bot-authored message never accesses DB/parser/provider", async () => {
  const { fn: parseBetSlip, getCallCount } = fakeParseBetSlip(validSingleParse());
  let dbCalled = false;

  const outcome = await handleNaturalLanguageOdds(
    baseMessage(uniqueTelegramId(), { text: NATURAL_TEXT }, { is_bot: true }),
    {
      db: { player: { findUnique: async () => { dbCalled = true; return null; } } } as unknown as PrismaClient,
      parseBetSlip,
      sendMessage: fakeSend(),
      previewTokenSecret: TEST_SECRET,
    },
  );

  assert.deepEqual(outcome, { kind: "IGNORED_BOT" });
  assert.equal(dbCalled, false);
  assert.equal(getCallCount(), 0);
  assert.deepEqual(sent, []);
});

test("handleNaturalLanguageOdds: a missing preview-token secret never calls the parser and consumes no cooldown", async () => {
  const telegramId = uniqueTelegramId();
  const now = () => 8_000_000;
  const db = registeredDb(telegramId);
  const { fn: parseBetSlip, getCallCount } = fakeParseBetSlip(validSingleParse());
  const originalEnv = process.env.BET_PREVIEW_TOKEN_SECRET;
  delete process.env.BET_PREVIEW_TOKEN_SECRET;

  try {
    const first = await handleNaturalLanguageOdds(baseMessage(telegramId, { text: NATURAL_TEXT }), {
      db,
      parseBetSlip,
      sendMessage: fakeSend(),
      now,
      cooldownMs: 10_000,
    });
    assert.deepEqual(first, { kind: "CONFIG_UNAVAILABLE" });
    assert.equal(getCallCount(), 0);
  } finally {
    if (originalEnv !== undefined) process.env.BET_PREVIEW_TOKEN_SECRET = originalEnv;
  }

  const second = await handleNaturalLanguageOdds(baseMessage(telegramId, { text: NATURAL_TEXT }), {
    db,
    parseBetSlip,
    sendMessage: fakeSend(),
    previewTokenSecret: TEST_SECRET,
    verifyOddsFn: fakeVerifyOddsFn({ "Real Madrid vs Barcelona": verified(2.05, 2.05) }),
    now,
    cooldownMs: 10_000,
  });
  assert.deepEqual(second, { kind: "SUCCESS" });
  assert.equal(getCallCount(), 1);
});

test("handleNaturalLanguageOdds: text shorter than the minimum never calls the parser and consumes no cooldown", async () => {
  const telegramId = uniqueTelegramId();
  const now = () => 8_000_001;
  const db = registeredDb(telegramId);
  const { fn: parseBetSlip, getCallCount } = fakeParseBetSlip(validSingleParse());

  const first = await handleNaturalLanguageOdds(baseMessage(telegramId, { text: "ab" }), {
    db,
    parseBetSlip,
    sendMessage: fakeSend(),
    previewTokenSecret: TEST_SECRET,
    now,
    cooldownMs: 10_000,
  });
  assert.deepEqual(first, { kind: "INVALID_PAYLOAD" });
  assert.equal(getCallCount(), 0);

  const second = await handleNaturalLanguageOdds(baseMessage(telegramId, { text: NATURAL_TEXT }), {
    db,
    parseBetSlip,
    sendMessage: fakeSend(),
    previewTokenSecret: TEST_SECRET,
    verifyOddsFn: fakeVerifyOddsFn({ "Real Madrid vs Barcelona": verified(2.05, 2.05) }),
    now,
    cooldownMs: 10_000,
  });
  assert.deepEqual(second, { kind: "SUCCESS" });
});

test("handleNaturalLanguageOdds: text longer than the maximum never calls the parser and consumes no cooldown", async () => {
  const telegramId = uniqueTelegramId();
  const now = () => 8_000_002;
  const db = registeredDb(telegramId);
  const { fn: parseBetSlip, getCallCount } = fakeParseBetSlip(validSingleParse());
  const tooLong = "a".repeat(2001);

  const first = await handleNaturalLanguageOdds(baseMessage(telegramId, { text: tooLong }), {
    db,
    parseBetSlip,
    sendMessage: fakeSend(),
    previewTokenSecret: TEST_SECRET,
    now,
    cooldownMs: 10_000,
  });
  assert.deepEqual(first, { kind: "INVALID_PAYLOAD" });
  assert.equal(getCallCount(), 0);

  const second = await handleNaturalLanguageOdds(baseMessage(telegramId, { text: NATURAL_TEXT }), {
    db,
    parseBetSlip,
    sendMessage: fakeSend(),
    previewTokenSecret: TEST_SECRET,
    verifyOddsFn: fakeVerifyOddsFn({ "Real Madrid vs Barcelona": verified(2.05, 2.05) }),
    now,
    cooldownMs: 10_000,
  });
  assert.deepEqual(second, { kind: "SUCCESS" });
});

test("handleNaturalLanguageOdds: parser valid:false retains the cooldown", async () => {
  const telegramId = uniqueTelegramId();
  const now = () => 8_000_003;
  const db = registeredDb(telegramId);
  const { fn: parseBetSlip, getCallCount } = fakeParseBetSlip({ valid: false, error: "not a bet" });

  const first = await handleNaturalLanguageOdds(baseMessage(telegramId, { text: NATURAL_TEXT }), {
    db,
    parseBetSlip,
    sendMessage: fakeSend(),
    previewTokenSecret: TEST_SECRET,
    now,
    cooldownMs: 10_000,
  });
  assert.deepEqual(first, { kind: "PARSE_FAILED" });
  assert.equal(getCallCount(), 1);

  const second = await handleNaturalLanguageOdds(baseMessage(telegramId, { text: NATURAL_TEXT }), {
    db,
    parseBetSlip,
    sendMessage: fakeSend(),
    previewTokenSecret: TEST_SECRET,
    now,
    cooldownMs: 10_000,
  });
  assert.deepEqual(second, { kind: "COOLDOWN" });
  assert.equal(getCallCount(), 1);
});

test("handleNaturalLanguageOdds: a parser timeout retains the cooldown", async () => {
  const telegramId = uniqueTelegramId();
  const now = () => 8_000_004;
  const db = registeredDb(telegramId);
  const { fn: parseBetSlip, getCallCount } = fakeParseBetSlip({ valid: false, error: "timed out", code: "timeout" });

  const first = await handleNaturalLanguageOdds(baseMessage(telegramId, { text: NATURAL_TEXT }), {
    db,
    parseBetSlip,
    sendMessage: fakeSend(),
    previewTokenSecret: TEST_SECRET,
    now,
    cooldownMs: 10_000,
  });
  assert.deepEqual(first, { kind: "PARSE_TIMEOUT" });

  const second = await handleNaturalLanguageOdds(baseMessage(telegramId, { text: NATURAL_TEXT }), {
    db,
    parseBetSlip,
    sendMessage: fakeSend(),
    previewTokenSecret: TEST_SECRET,
    now,
    cooldownMs: 10_000,
  });
  assert.deepEqual(second, { kind: "COOLDOWN" });
  assert.equal(getCallCount(), 1);
});

test("handleNaturalLanguageOdds: a parser throw retains the cooldown", async () => {
  const telegramId = uniqueTelegramId();
  const now = () => 8_000_005;
  const db = registeredDb(telegramId);
  let callCount = 0;
  const throwingParseBetSlip = async () => {
    callCount += 1;
    throw new Error("simulated unexpected parser failure");
  };

  const first = await handleNaturalLanguageOdds(baseMessage(telegramId, { text: NATURAL_TEXT }), {
    db,
    parseBetSlip: throwingParseBetSlip,
    sendMessage: fakeSend(),
    previewTokenSecret: TEST_SECRET,
    now,
    cooldownMs: 10_000,
  });
  assert.deepEqual(first, { kind: "UNEXPECTED_ERROR" });
  assert.equal(callCount, 1);

  const second = await handleNaturalLanguageOdds(baseMessage(telegramId, { text: NATURAL_TEXT }), {
    db,
    parseBetSlip: throwingParseBetSlip,
    sendMessage: fakeSend(),
    previewTokenSecret: TEST_SECRET,
    now,
    cooldownMs: 10_000,
  });
  assert.deepEqual(second, { kind: "COOLDOWN" });
  assert.equal(callCount, 1);
});

test("handleNaturalLanguageOdds: a buildBetSlipPreview/provider failure retains the cooldown", async () => {
  const telegramId = uniqueTelegramId();
  const now = () => 8_000_006;
  const db = registeredDb(telegramId);
  const { fn: parseBetSlip, getCallCount } = fakeParseBetSlip(validSingleParse());
  const failingService = {
    verifyMany: async () => {
      throw new Error("simulated provider failure");
    },
  };

  const first = await handleNaturalLanguageOdds(baseMessage(telegramId, { text: NATURAL_TEXT }), {
    db,
    parseBetSlip,
    sendMessage: fakeSend(),
    previewTokenSecret: TEST_SECRET,
    oddsVerificationService: failingService,
    now,
    cooldownMs: 10_000,
  });
  assert.deepEqual(first, { kind: "UNEXPECTED_ERROR" });
  assert.equal(getCallCount(), 1);

  const second = await handleNaturalLanguageOdds(baseMessage(telegramId, { text: NATURAL_TEXT }), {
    db,
    parseBetSlip,
    sendMessage: fakeSend(),
    previewTokenSecret: TEST_SECRET,
    oddsVerificationService: failingService,
    now,
    cooldownMs: 10_000,
  });
  assert.deepEqual(second, { kind: "COOLDOWN" });
  assert.equal(getCallCount(), 1);
});

test("handleNaturalLanguageOdds: SINGLE output renders via the unchanged formatOddsReply", async () => {
  const telegramId = uniqueTelegramId();
  const { fn: parseBetSlip } = fakeParseBetSlip(validSingleParse());

  await handleNaturalLanguageOdds(baseMessage(telegramId, { text: NATURAL_TEXT }), {
    db: registeredDb(telegramId),
    parseBetSlip,
    sendMessage: fakeSend(),
    previewTokenSecret: TEST_SECRET,
    verifyOddsFn: fakeVerifyOddsFn({ "Real Madrid vs Barcelona": verified(2.05, 2.05) }),
  });

  assert.match(sent[0].text, /<b>Current odds check<\/b>/);
  assert.match(sent[0].text, /Odds confirmed/);
});

test("handleNaturalLanguageOdds: EXPRESS output renders via the unchanged formatOddsReply, with no Telegram-side odds math", async () => {
  const telegramId = uniqueTelegramId();
  const expressParse: ParseBetSlipResult = {
    valid: true,
    type: "EXPRESS",
    stake: 20,
    selections: [
      { sport: "Football", event: "Real Madrid vs Barcelona", market: null, selection: "Real Madrid", submittedOdds: 1.7 },
      { sport: "Football", event: "Arsenal vs Chelsea", market: null, selection: "Arsenal", submittedOdds: 1.65 },
      { sport: "Football", event: "Inter vs Juventus", market: null, selection: "Inter", submittedOdds: 1.8 },
    ],
  };
  const { fn: parseBetSlip } = fakeParseBetSlip(expressParse);
  const multilineText = "Real Madrid to win @1.70\nArsenal to win @1.65\nInter to win @1.80\nStake 20";

  const outcome = await handleNaturalLanguageOdds(baseMessage(telegramId, { text: multilineText }), {
    db: registeredDb(telegramId),
    parseBetSlip,
    sendMessage: fakeSend(),
    previewTokenSecret: TEST_SECRET,
    verifyOddsFn: fakeVerifyOddsFn({
      "Real Madrid vs Barcelona": verified(1.7, 1.7),
      "Arsenal vs Chelsea": verified(1.65, 1.65),
      "Inter vs Juventus": verified(1.8, 1.8),
    }),
  });

  assert.deepEqual(outcome, { kind: "SUCCESS" });
  assert.match(sent[0].text, /Selection 1/);
  assert.match(sent[0].text, /Selection 2/);
  assert.match(sent[0].text, /Selection 3/);
  // Total odds shown is whatever buildBetSlipPreview computed (1.7*1.65*1.8),
  // never a value this test file (or the Telegram code under test)
  // calculated independently.
  assert.match(sent[0].text, /Total odds:/);
});

test("handleNaturalLanguageOdds: the original text, including internal newlines, reaches the parser unmodified", async () => {
  const telegramId = uniqueTelegramId();
  let capturedPayload: string | undefined;
  const parseBetSlip = async (payload: string): Promise<ParseBetSlipResult> => {
    capturedPayload = payload;
    return validSingleParse();
  };
  const multilineText = "Real Madrid to win @1.70\nArsenal to win @1.65\nInter to win @1.80\nStake 20";

  await handleNaturalLanguageOdds(baseMessage(telegramId, { text: multilineText }), {
    db: registeredDb(telegramId),
    parseBetSlip,
    sendMessage: fakeSend(),
    previewTokenSecret: TEST_SECRET,
    verifyOddsFn: fakeVerifyOddsFn({ "Real Madrid vs Barcelona": verified(2.05, 2.05) }),
  });

  assert.equal(capturedPayload, multilineText);
});

/* -------------------------------------------------------------------------- */
/* Step 10B — shared cooldown across BOTH entry points. Proves the single    */
/* module-scoped Map (declared once in oddsCommand.ts) is genuinely shared —  */
/* not a per-function or per-source store.                                    */
/* -------------------------------------------------------------------------- */

test("shared cooldown: /odds starts the parser; natural text from the same user arriving before resolution is rejected, parser called once", async () => {
  const telegramId = uniqueTelegramId();
  const now = () => 9_000_000;
  const db = registeredDb(telegramId);
  const gate = deferred<ParseBetSlipResult>();
  let parseCallCount = 0;
  const deferredParseBetSlip = async (): Promise<ParseBetSlipResult> => {
    parseCallCount += 1;
    return gate.promise;
  };

  const requestA = handleOddsCommand(baseMessage(telegramId, { text: `/odds ${NATURAL_TEXT}` }), {
    db,
    parseBetSlip: deferredParseBetSlip,
    sendMessage: fakeSend(),
    previewTokenSecret: TEST_SECRET,
    now,
    cooldownMs: 10_000,
  });

  await Promise.resolve();
  await Promise.resolve();
  assert.equal(parseCallCount, 1, "the /odds request must have already invoked the parser");

  const requestB = await handleNaturalLanguageOdds(baseMessage(telegramId, { text: NATURAL_TEXT }), {
    db,
    parseBetSlip: deferredParseBetSlip,
    sendMessage: fakeSend(),
    previewTokenSecret: TEST_SECRET,
    now,
    cooldownMs: 10_000,
  });

  assert.deepEqual(requestB, { kind: "COOLDOWN" });
  assert.equal(parseCallCount, 1, "natural text must never invoke the parser while /odds is still in flight for the same user");

  gate.resolve({ valid: false, error: "n/a" });
  await requestA;
});

test("shared cooldown: natural text starts the parser; /odds from the same user arriving before resolution is rejected, parser called once", async () => {
  const telegramId = uniqueTelegramId();
  const now = () => 9_000_001;
  const db = registeredDb(telegramId);
  const gate = deferred<ParseBetSlipResult>();
  let parseCallCount = 0;
  const deferredParseBetSlip = async (): Promise<ParseBetSlipResult> => {
    parseCallCount += 1;
    return gate.promise;
  };

  const requestA = handleNaturalLanguageOdds(baseMessage(telegramId, { text: NATURAL_TEXT }), {
    db,
    parseBetSlip: deferredParseBetSlip,
    sendMessage: fakeSend(),
    previewTokenSecret: TEST_SECRET,
    now,
    cooldownMs: 10_000,
  });

  await Promise.resolve();
  await Promise.resolve();
  assert.equal(parseCallCount, 1, "the natural-text request must have already invoked the parser");

  const requestB = await handleOddsCommand(baseMessage(telegramId, { text: `/odds ${NATURAL_TEXT}` }), {
    db,
    parseBetSlip: deferredParseBetSlip,
    sendMessage: fakeSend(),
    previewTokenSecret: TEST_SECRET,
    now,
    cooldownMs: 10_000,
  });

  assert.deepEqual(requestB, { kind: "COOLDOWN" });
  assert.equal(parseCallCount, 1, "/odds must never invoke the parser while natural text is still in flight for the same user");

  gate.resolve({ valid: false, error: "n/a" });
  await requestA;
});

test("shared cooldown: two concurrent natural-text requests from the same user invoke the parser at most once", async () => {
  const telegramId = uniqueTelegramId();
  const now = () => 9_000_002;
  const db = registeredDb(telegramId);
  const gate = deferred<ParseBetSlipResult>();
  let parseCallCount = 0;
  const deferredParseBetSlip = async (): Promise<ParseBetSlipResult> => {
    parseCallCount += 1;
    return gate.promise;
  };

  const requestA = handleNaturalLanguageOdds(baseMessage(telegramId, { text: NATURAL_TEXT }), {
    db,
    parseBetSlip: deferredParseBetSlip,
    sendMessage: fakeSend(),
    previewTokenSecret: TEST_SECRET,
    now,
    cooldownMs: 10_000,
  });

  await Promise.resolve();
  await Promise.resolve();

  const requestB = await handleNaturalLanguageOdds(baseMessage(telegramId, { text: NATURAL_TEXT }), {
    db,
    parseBetSlip: deferredParseBetSlip,
    sendMessage: fakeSend(),
    previewTokenSecret: TEST_SECRET,
    now,
    cooldownMs: 10_000,
  });

  assert.deepEqual(requestB, { kind: "COOLDOWN" });
  assert.equal(parseCallCount, 1);

  gate.resolve({ valid: false, error: "n/a" });
  await requestA;
});

test("shared cooldown: two different users, one via /odds and one via natural text, proceed independently", async () => {
  const telegramIdA = uniqueTelegramId();
  const telegramIdB = uniqueTelegramId();
  const now = () => 9_000_003;
  const db = fakeDb([
    { id: "player-mixed-a", telegramId: telegramIdA },
    { id: "player-mixed-b", telegramId: telegramIdB },
  ]);
  const gateA = deferred<ParseBetSlipResult>();
  const gateB = deferred<ParseBetSlipResult>();
  let callCountA = 0;
  let callCountB = 0;

  const requestA = handleOddsCommand(baseMessage(telegramIdA, { text: `/odds ${NATURAL_TEXT}` }), {
    db,
    parseBetSlip: async () => {
      callCountA += 1;
      return gateA.promise;
    },
    sendMessage: fakeSend(),
    previewTokenSecret: TEST_SECRET,
    now,
    cooldownMs: 10_000,
  });

  await Promise.resolve();
  await Promise.resolve();

  const requestB = handleNaturalLanguageOdds(baseMessage(telegramIdB, { text: NATURAL_TEXT }), {
    db,
    parseBetSlip: async () => {
      callCountB += 1;
      return gateB.promise;
    },
    sendMessage: fakeSend(),
    previewTokenSecret: TEST_SECRET,
    now,
    cooldownMs: 10_000,
  });

  await Promise.resolve();
  await Promise.resolve();

  assert.equal(callCountA, 1);
  assert.equal(callCountB, 1, "a different user's natural-text request must proceed independently of user A's cooldown");

  gateA.resolve({ valid: false, error: "n/a" });
  gateB.resolve({ valid: false, error: "n/a" });
  await requestA;
  await requestB;
});

/* -------------------------------------------------------------------------- */
/* Pre-commit bot-guard regression review — a bot-authored message must be   */
/* ignored BEFORE payload extraction/validation, not only before             */
/* DB/parser/provider access, so a bot-authored bare "/odds" never gets an   */
/* (extraction-dependent) HELP_TEXT reply either.                            */
/* -------------------------------------------------------------------------- */

function countingDb(telegramId: string, playerId = "player-bot-guard-test") {
  let findUniqueCallCount = 0;
  const db = {
    player: {
      findUnique: async ({ where }: { where: { telegramId: string } }) => {
        findUniqueCallCount += 1;
        return where.telegramId === telegramId ? { id: playerId } : null;
      },
    },
  } as unknown as PrismaClient;
  return { db, getFindUniqueCallCount: () => findUniqueCallCount };
}

function countingProviderOptions() {
  let providerCallCount = 0;
  const oddsVerificationService = {
    verifyMany: async () => {
      providerCallCount += 1;
      return [];
    },
  };
  return { oddsVerificationService, getProviderCallCount: () => providerCallCount };
}

test("bot guard: a bot-authored bare /odds is ignored before payload extraction — no HELP_TEXT, no DB, no parser, no provider, no cooldown", async () => {
  const telegramId = uniqueTelegramId();
  const now = () => 10_000_000;
  const { db, getFindUniqueCallCount } = countingDb(telegramId);
  const { oddsVerificationService, getProviderCallCount } = countingProviderOptions();
  const { fn: parseBetSlip, getCallCount } = fakeParseBetSlip(validSingleParse());
  const send = fakeSend();

  const outcome = await handleOddsCommand(baseMessage(telegramId, { text: "/odds" }, { is_bot: true }), {
    db,
    parseBetSlip,
    sendMessage: send,
    previewTokenSecret: TEST_SECRET,
    oddsVerificationService,
    now,
    cooldownMs: 10_000,
  });

  assert.deepEqual(outcome, { kind: "IGNORED_BOT" });
  assert.deepEqual(sent, [], "no HELP_TEXT or any other reply may be sent to a bot-authored message");
  assert.equal(getFindUniqueCallCount(), 0);
  assert.equal(getCallCount(), 0);
  assert.equal(getProviderCallCount(), 0);

  // Cooldown must not have been consumed either — a valid human /odds
  // request from the SAME telegram user ID, at the SAME frozen time, must
  // proceed immediately rather than observing COOLDOWN.
  const humanOutcome = await handleOddsCommand(baseMessage(telegramId, { text: "/odds Real Madrid vs Barcelona, odds 2.05" }), {
    db,
    parseBetSlip,
    sendMessage: send,
    previewTokenSecret: TEST_SECRET,
    verifyOddsFn: fakeVerifyOddsFn({ "Real Madrid vs Barcelona": verified(2.05, 2.05) }),
    now,
    cooldownMs: 10_000,
  });
  assert.deepEqual(humanOutcome, { kind: "SUCCESS" });
});

test("bot guard: a bot-authored /odds with a payload is ignored with the same zero side effects", async () => {
  const telegramId = uniqueTelegramId();
  const { db, getFindUniqueCallCount } = countingDb(telegramId);
  const { oddsVerificationService, getProviderCallCount } = countingProviderOptions();
  const { fn: parseBetSlip, getCallCount } = fakeParseBetSlip(validSingleParse());
  const send = fakeSend();

  const outcome = await handleOddsCommand(
    baseMessage(telegramId, { text: "/odds Real Madrid to win vs Barcelona" }, { is_bot: true }),
    { db, parseBetSlip, sendMessage: send, previewTokenSecret: TEST_SECRET, oddsVerificationService },
  );

  assert.deepEqual(outcome, { kind: "IGNORED_BOT" });
  assert.deepEqual(sent, []);
  assert.equal(getFindUniqueCallCount(), 0);
  assert.equal(getCallCount(), 0);
  assert.equal(getProviderCallCount(), 0);
});

test("bot guard: bot-authored natural betting text is ignored before any validation, DB, parser, provider, or cooldown consumption", async () => {
  const telegramId = uniqueTelegramId();
  const now = () => 10_000_001;
  const { db, getFindUniqueCallCount } = countingDb(telegramId);
  const { oddsVerificationService, getProviderCallCount } = countingProviderOptions();
  const { fn: parseBetSlip, getCallCount } = fakeParseBetSlip(validSingleParse());
  const send = fakeSend();

  const outcome = await handleNaturalLanguageOdds(
    baseMessage(telegramId, { text: "Real Madrid to win vs Barcelona" }, { is_bot: true }),
    { db, parseBetSlip, sendMessage: send, previewTokenSecret: TEST_SECRET, oddsVerificationService, now, cooldownMs: 10_000 },
  );

  assert.deepEqual(outcome, { kind: "IGNORED_BOT" });
  assert.deepEqual(sent, [], "no validation reply may be sent to a bot-authored message");
  assert.equal(getFindUniqueCallCount(), 0);
  assert.equal(getCallCount(), 0);
  assert.equal(getProviderCallCount(), 0);

  const humanOutcome = await handleNaturalLanguageOdds(baseMessage(telegramId, { text: "Real Madrid to win vs Barcelona" }), {
    db,
    parseBetSlip,
    sendMessage: send,
    previewTokenSecret: TEST_SECRET,
    verifyOddsFn: fakeVerifyOddsFn({ "Real Madrid vs Barcelona": verified(2.05, 2.05) }),
    now,
    cooldownMs: 10_000,
  });
  assert.deepEqual(humanOutcome, { kind: "SUCCESS" }, "cooldown must not have been consumed by the ignored bot message");
});

test("bot guard: a human sending a bare /odds still gets HELP_TEXT, with no parser/provider call and no cooldown consumed", async () => {
  const telegramId = uniqueTelegramId();
  const now = () => 10_000_002;
  const { db } = countingDb(telegramId);
  const { fn: parseBetSlip, getCallCount } = fakeParseBetSlip(validSingleParse());
  const send = fakeSend();

  const outcome = await handleOddsCommand(baseMessage(telegramId, { text: "/odds" }), {
    db,
    parseBetSlip,
    sendMessage: send,
    previewTokenSecret: TEST_SECRET,
    now,
    cooldownMs: 10_000,
  });

  assert.deepEqual(outcome, { kind: "HELP" });
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /Usage/i);
  assert.equal(getCallCount(), 0);

  const second = await handleOddsCommand(baseMessage(telegramId, { text: "/odds Real Madrid vs Barcelona, odds 2.05" }), {
    db,
    parseBetSlip,
    sendMessage: send,
    previewTokenSecret: TEST_SECRET,
    verifyOddsFn: fakeVerifyOddsFn({ "Real Madrid vs Barcelona": verified(2.05, 2.05) }),
    now,
    cooldownMs: 10_000,
  });
  assert.deepEqual(second, { kind: "SUCCESS" }, "cooldown must not have been consumed by the HELP_TEXT reply");
});

test("bot guard: a human sending an invalid /odds payload still gets INVALID_PAYLOAD_TEXT, unchanged", async () => {
  const telegramId = uniqueTelegramId();
  const { db } = countingDb(telegramId);
  const { fn: parseBetSlip, getCallCount } = fakeParseBetSlip(validSingleParse());

  const outcome = await handleOddsCommand(baseMessage(telegramId, { text: "/odds ab" }), {
    db,
    parseBetSlip,
    sendMessage: fakeSend(),
    previewTokenSecret: TEST_SECRET,
  });

  assert.deepEqual(outcome, { kind: "INVALID_PAYLOAD" });
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /too short or too long/i);
  assert.equal(getCallCount(), 0);
});
