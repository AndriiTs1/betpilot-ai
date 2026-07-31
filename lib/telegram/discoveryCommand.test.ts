import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import type { PrismaClient } from "@/lib/generated/prisma/client";
import { handleDiscoveryCommand, isTelegramDiscoveryReadOnlyEnabled } from "./discoveryCommand";
import type { TelegramMessage } from "./telegramTypes";
import type { CandidateResolver, ResolvedEventCandidate } from "@/lib/odds/discovery/candidateResolver";

const originalEnv = { ...process.env };

test.afterEach(() => {
  process.env = { ...originalEnv };
});

function makeCandidate(overrides: Partial<ResolvedEventCandidate> = {}): ResolvedEventCandidate {
  return {
    provider: "THE_ODDS_API",
    providerEventId: "evt-1",
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

function makeMessage(text: string, overrides: Partial<TelegramMessage> = {}): TelegramMessage {
  return {
    message_id: 1,
    date: 1700000000,
    text,
    chat: { id: 777 },
    from: { id: 42, is_bot: false },
    ...overrides,
  };
}

// Narrow on purpose — only the methods handleDiscoveryCommand is allowed to
// call. If the handler ever tried to call any other Prisma method (e.g. an
// update that would mutate balance/player state), this fake throws.
function fakeDb(players: Array<{ id: string; telegramId: string }> = []): PrismaClient {
  return {
    player: {
      findUnique: async ({ where }: { where: { telegramId: string } }) => {
        const found = players.find((p) => p.telegramId === where.telegramId);
        return found ? { id: found.id } : null;
      },
    },
  } as unknown as PrismaClient;
}

function fakeResolver(overrides: Partial<CandidateResolver> = {}): Pick<CandidateResolver, "buildDependencies" | "resolve"> {
  return {
    buildDependencies: async () => ({ status: "SUCCESS" }),
    resolve: () => ({ kind: "TEAM_RESOLVED", candidate: makeCandidate() }),
    ...overrides,
  };
}

let sent: Array<{ chatId: string; text: string }>;
function fakeSend() {
  sent = [];
  return async (chatId: string, text: string) => {
    sent.push({ chatId, text });
    return true;
  };
}

test("isTelegramDiscoveryReadOnlyEnabled: defaults to false when unset", () => {
  delete process.env.TELEGRAM_DISCOVERY_READ_ONLY_ENABLED;
  assert.equal(isTelegramDiscoveryReadOnlyEnabled(), false);
});

test("isTelegramDiscoveryReadOnlyEnabled: false for anything other than exact 'true'", () => {
  process.env.TELEGRAM_DISCOVERY_READ_ONLY_ENABLED = "TRUE";
  assert.equal(isTelegramDiscoveryReadOnlyEnabled(), false);
  process.env.TELEGRAM_DISCOVERY_READ_ONLY_ENABLED = "1";
  assert.equal(isTelegramDiscoveryReadOnlyEnabled(), false);
});

test("isTelegramDiscoveryReadOnlyEnabled: true only for exact 'true'", () => {
  process.env.TELEGRAM_DISCOVERY_READ_ONLY_ENABLED = "true";
  assert.equal(isTelegramDiscoveryReadOnlyEnabled(), true);
});

test("handleDiscoveryCommand: bot-authored messages are ignored, no reply sent", async () => {
  const send = fakeSend();
  const outcome = await handleDiscoveryCommand(makeMessage("/find Arsenal", { from: { id: 1, is_bot: true } }), {
    db: fakeDb(),
    sendMessage: send,
    resolver: fakeResolver(),
  });

  assert.equal(outcome.kind, "IGNORED_BOT");
  assert.equal(sent.length, 0);
});

test("handleDiscoveryCommand: empty payload is rejected before touching the DB or resolver", async () => {
  const send = fakeSend();
  let dbCalled = false;
  let resolverCalled = false;
  const db = {
    player: {
      findUnique: async () => {
        dbCalled = true;
        return null;
      },
    },
  } as unknown as PrismaClient;

  const outcome = await handleDiscoveryCommand(makeMessage("/find"), {
    db,
    sendMessage: send,
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
  });

  assert.equal(outcome.kind, "USAGE");
  assert.equal(dbCalled, false);
  assert.equal(resolverCalled, false);
  assert.match(sent[0].text, /Использование/);
});

test("handleDiscoveryCommand: whitespace-only payload is rejected", async () => {
  const send = fakeSend();
  const outcome = await handleDiscoveryCommand(makeMessage("/find    "), {
    db: fakeDb(),
    sendMessage: send,
    resolver: fakeResolver(),
  });

  assert.equal(outcome.kind, "USAGE");
});

test("handleDiscoveryCommand: /find MU (2-char payload) is accepted, not rejected as too short", async () => {
  const send = fakeSend();
  let receivedQuery: string | undefined;
  const outcome = await handleDiscoveryCommand(makeMessage("/find MU"), {
    db: fakeDb([{ id: "p1", telegramId: "42" }]),
    sendMessage: send,
    resolver: fakeResolver({
      resolve: (query: string) => {
        receivedQuery = query;
        return { kind: "TEAM_RESOLVED", candidate: makeCandidate({ homeTeam: "Manchester United" }) };
      },
    }),
  });

  assert.equal(outcome.kind, "TEAM_RESOLVED");
  assert.equal(receivedQuery, "MU");
});

test("handleDiscoveryCommand: supports the '@BotName' command suffix form", async () => {
  const send = fakeSend();
  let receivedQuery: string | undefined;
  await handleDiscoveryCommand(makeMessage("/find@BetPilotAI_bot Arsenal"), {
    db: fakeDb([{ id: "p1", telegramId: "42" }]),
    sendMessage: send,
    resolver: fakeResolver({
      resolve: (query: string) => {
        receivedQuery = query;
        return { kind: "TEAM_RESOLVED", candidate: makeCandidate() };
      },
    }),
  });

  // This handler strips the entire leading whitespace-delimited token
  // (including any "@BotName" suffix) exactly like extractCommandPayload.ts
  // does for /odds — the payload passed to the resolver is clean either way.
  assert.equal(receivedQuery, "Arsenal");
});

test("handleDiscoveryCommand: unauthorized player (no Player row) gets a generic response, never created", async () => {
  const send = fakeSend();
  const outcome = await handleDiscoveryCommand(makeMessage("/find Arsenal"), {
    db: fakeDb([]),
    sendMessage: send,
    resolver: fakeResolver(),
  });

  assert.equal(outcome.kind, "UNAUTHORIZED");
  assert.match(sent[0].text, /not registered/);
});

test("handleDiscoveryCommand: buildDependencies() FAILED returns a generic FAILED response, never calls resolve()", async () => {
  const send = fakeSend();
  let resolveCalled = false;
  const outcome = await handleDiscoveryCommand(makeMessage("/find Arsenal"), {
    db: fakeDb([{ id: "p1", telegramId: "42" }]),
    sendMessage: send,
    resolver: {
      buildDependencies: async () => ({ status: "FAILED", source: "TEAM_INDEX", reason: "ALL_LEAGUES_UNAVAILABLE" }),
      resolve: () => {
        resolveCalled = true;
        return { kind: "NOT_FOUND", reason: "x" };
      },
    },
  });

  assert.equal(outcome.kind, "FAILED");
  assert.equal(resolveCalled, false);
  assert.match(sent[0].text, /временно недоступен/);
  assert.doesNotMatch(sent[0].text, /ALL_LEAGUES_UNAVAILABLE/);
  assert.doesNotMatch(sent[0].text, /TEAM_INDEX/);
});

test("handleDiscoveryCommand: resolve() TEAM_RESOLVED is formatted and sent", async () => {
  const send = fakeSend();
  const outcome = await handleDiscoveryCommand(makeMessage("/find Arsenal"), {
    db: fakeDb([{ id: "p1", telegramId: "42" }]),
    sendMessage: send,
    resolver: fakeResolver({
      resolve: () => ({ kind: "TEAM_RESOLVED", candidate: makeCandidate() }),
    }),
  });

  assert.equal(outcome.kind, "TEAM_RESOLVED");
  assert.match(sent[0].text, /Найден матч/);
});

test("handleDiscoveryCommand: resolve() AMBIGUOUS is formatted and sent", async () => {
  const send = fakeSend();
  const outcome = await handleDiscoveryCommand(makeMessage("/find Inter"), {
    db: fakeDb([{ id: "p1", telegramId: "42" }]),
    sendMessage: send,
    resolver: fakeResolver({
      resolve: () => ({
        kind: "AMBIGUOUS",
        candidates: [makeCandidate({ providerEventId: "e1" }), makeCandidate({ providerEventId: "e2" })],
        reason: "x",
      }),
    }),
  });

  assert.equal(outcome.kind, "AMBIGUOUS");
  assert.match(sent[0].text, /несколько матчей/);
});

test("handleDiscoveryCommand: resolve() NOT_FOUND is formatted and sent", async () => {
  const send = fakeSend();
  const outcome = await handleDiscoveryCommand(makeMessage("/find Nonexistent"), {
    db: fakeDb([{ id: "p1", telegramId: "42" }]),
    sendMessage: send,
    resolver: fakeResolver({ resolve: () => ({ kind: "NOT_FOUND", reason: "x" }) }),
  });

  assert.equal(outcome.kind, "NOT_FOUND");
  assert.match(sent[0].text, /не найдены/);
});

test("handleDiscoveryCommand: resolve() INVALID_QUERY is formatted and sent", async () => {
  const send = fakeSend();
  const outcome = await handleDiscoveryCommand(makeMessage("/find A vs B vs C"), {
    db: fakeDb([{ id: "p1", telegramId: "42" }]),
    sendMessage: send,
    resolver: fakeResolver({ resolve: () => ({ kind: "INVALID_QUERY", reason: "x" }) }),
  });

  assert.equal(outcome.kind, "INVALID_QUERY");
  assert.match(sent[0].text, /Использование/);
});

test("handleDiscoveryCommand: resolve() FAILED is formatted and sent generically", async () => {
  const send = fakeSend();
  const outcome = await handleDiscoveryCommand(makeMessage("/find Arsenal"), {
    db: fakeDb([{ id: "p1", telegramId: "42" }]),
    sendMessage: send,
    resolver: fakeResolver({ resolve: () => ({ kind: "FAILED", source: "RESOLVER", reason: "SECRET" }) }),
  });

  assert.equal(outcome.kind, "FAILED");
  assert.doesNotMatch(sent[0].text, /SECRET/);
});

// Static import-audit — proves, at the source level, that this read-only
// command handler and its formatter never reference the paid odds path, the
// AI parser, or bet creation. Mirrors the same "scan only actual import
// lines, not prose comments" technique already used elsewhere in the
// Discovery Engine's own test suite.
const FORBIDDEN_IMPORT_FRAGMENTS = [
  "betParser",
  "buildBetSlipPreview",
  "createBetFromPreview",
  "OddsVerificationService",
  "oddsCommand",
];

function importLines(filePath: string): string[] {
  const source = readFileSync(filePath, "utf8");
  return source.split("\n").filter((line) => /^\s*import\b/.test(line));
}

test("discoveryCommand.ts never imports the AI parser, odds preview, bet creation, or /odds pipeline", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const lines = importLines(path.join(here, "discoveryCommand.ts"));

  for (const fragment of FORBIDDEN_IMPORT_FRAGMENTS) {
    const offending = lines.filter((line) => line.includes(fragment));
    assert.deepEqual(offending, [], `discoveryCommand.ts must not import anything matching "${fragment}"`);
  }
});

test("formatDiscoveryReply.ts never imports the AI parser, odds preview, or bet creation", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const lines = importLines(path.join(here, "formatDiscoveryReply.ts"));

  for (const fragment of FORBIDDEN_IMPORT_FRAGMENTS) {
    const offending = lines.filter((line) => line.includes(fragment));
    assert.deepEqual(offending, [], `formatDiscoveryReply.ts must not import anything matching "${fragment}"`);
  }
});
