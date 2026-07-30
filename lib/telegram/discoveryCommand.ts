// Stage 9.1 — /find command orchestration. Read-only: never calls
// parseBetSlipMessage, buildBetSlipPreview, OddsVerificationService, or
// /odds; never creates a Bet/BetSelection/Preview; never touches balance.
// Uses the existing Candidate Resolver singleton — no new cache, no new
// Event Catalog/Team Index access, no Redis, no session storage.

import { createHash } from "node:crypto";

import type { PrismaClient } from "@/lib/generated/prisma/client";
import { prisma } from "@/lib/db/client";
import type { TelegramMessage } from "./telegramTypes";
import { sendTelegramMessage } from "./sendMessage";
import { formatDiscoveryReply, DISCOVERY_USAGE_TEXT, DISCOVERY_FAILED_TEXT } from "./formatDiscoveryReply";
import {
  candidateResolver as defaultCandidateResolver,
  type CandidateResolver,
  type ResolveQueryResult,
  type CandidateMatchMethod,
  type CandidateResolverFailureSource,
} from "@/lib/odds/discovery/candidateResolver";

const NOT_AUTHORIZED_TEXT = "⚠️ This Telegram account is not registered in BetPilot.";

// Default false even when the env var is unset — mirrors
// lib/telegram/betStatusNotifications.ts's isBetStatusNotificationsEnabled().
// Requires the exact literal "true"; any other value stays disabled.
export function isTelegramDiscoveryReadOnlyEnabled(): boolean {
  return process.env.TELEGRAM_DISCOVERY_READ_ONLY_ENABLED === "true";
}

// Same stripping algorithm as extractCommandPayload.ts (leading
// "/cmd[@Bot]" token removed, remainder trimmed) but with its own MIN
// length of 1 — extractCommandPayload's MIN_ODDS_PAYLOAD_LENGTH=3 would
// reject legitimate short curated aliases like "MU".
function extractDiscoveryPayload(text: string): { ok: true; payload: string } | { ok: false } {
  const firstWhitespaceIndex = text.search(/\s/);
  const remainder = firstWhitespaceIndex === -1 ? "" : text.slice(firstWhitespaceIndex + 1);
  const trimmed = remainder.trim();
  if (trimmed.length === 0) return { ok: false };
  return { ok: true, payload: trimmed };
}

export type DiscoveryCommandOutcome =
  | { kind: "IGNORED_BOT" }
  | { kind: "UNAUTHORIZED" }
  | { kind: "USAGE" }
  | { kind: "TEAM_RESOLVED" }
  | { kind: "MATCH_RESOLVED" }
  | { kind: "AMBIGUOUS" }
  | { kind: "NOT_FOUND" }
  | { kind: "INVALID_QUERY" }
  | { kind: "FAILED" };

export interface HandleDiscoveryCommandOptions {
  db?: PrismaClient;
  sendMessage?: typeof sendTelegramMessage;
  resolver?: Pick<CandidateResolver, "buildDependencies" | "resolve">;
  now?: () => number;
}

// Safe, content-free structured log — telegramUserId is hashed, the raw
// query text is never logged (only its length), and a FAILED outcome logs
// only its typed source, never the internal reason string. Not reusing
// lib/logging/structuredLog.ts: its ScreenshotPipelineEvent/metadata types
// are scoped to the OCR pipeline and don't fit this shape — adding a
// narrow local log here avoids widening that shared type.
interface DiscoveryLogFields {
  telegramUserId: string;
  queryLength: number;
  resultKind: ResolveQueryResult["kind"] | "FAILED";
  candidateCount?: number;
  matchMethod?: CandidateMatchMethod;
  durationMs: number;
  failureSource?: CandidateResolverFailureSource;
}

function hashTelegramId(telegramId: string): string {
  return createHash("sha256").update(telegramId).digest("hex").slice(0, 16);
}

function logDiscoveryEvent(fields: DiscoveryLogFields): void {
  console.log(JSON.stringify({ event: "telegram_find_command", ...fields }));
}

function candidateCountOf(result: ResolveQueryResult): number | undefined {
  if (result.kind === "AMBIGUOUS") return result.candidates.length;
  if (result.kind === "TEAM_RESOLVED" || result.kind === "MATCH_RESOLVED") return 1;
  return undefined;
}

function matchMethodOf(result: ResolveQueryResult): CandidateMatchMethod | undefined {
  if (result.kind === "TEAM_RESOLVED" || result.kind === "MATCH_RESOLVED") return result.candidate.matchMethod;
  return undefined;
}

function outcomeFor(kind: ResolveQueryResult["kind"]): DiscoveryCommandOutcome {
  switch (kind) {
    case "TEAM_RESOLVED":
      return { kind: "TEAM_RESOLVED" };
    case "MATCH_RESOLVED":
      return { kind: "MATCH_RESOLVED" };
    case "AMBIGUOUS":
      return { kind: "AMBIGUOUS" };
    case "NOT_FOUND":
      return { kind: "NOT_FOUND" };
    case "INVALID_QUERY":
      return { kind: "INVALID_QUERY" };
    case "FAILED":
      return { kind: "FAILED" };
  }
}

export async function handleDiscoveryCommand(
  tgMessage: TelegramMessage,
  options: HandleDiscoveryCommandOptions = {},
): Promise<DiscoveryCommandOutcome> {
  // Same bot guard as oddsCommand.ts, checked first, before any payload
  // parsing/DB/resolver access, so a bot-authored update is never replied to.
  if (tgMessage.from.is_bot) {
    return { kind: "IGNORED_BOT" };
  }

  const send = options.sendMessage ?? sendTelegramMessage;
  const chatId = String(tgMessage.chat.id);
  const telegramId = String(tgMessage.from.id);
  const now = options.now ?? (() => Date.now());
  const startedAt = now();

  const payloadResult = extractDiscoveryPayload(tgMessage.text ?? "");
  if (!payloadResult.ok) {
    // Never reaches the resolver — an empty query is rejected here.
    await send(chatId, DISCOVERY_USAGE_TEXT);
    return { kind: "USAGE" };
  }
  const query = payloadResult.payload;

  // Same raw-webhook authorization pattern as oddsCommand.ts's
  // runOddsLookup: a Player row must already exist for this telegramId.
  // Never creates/binds a player here.
  const db = options.db ?? prisma;
  const player = await db.player.findUnique({ where: { telegramId }, select: { id: true } });
  if (!player) {
    await send(chatId, NOT_AUTHORIZED_TEXT);
    return { kind: "UNAUTHORIZED" };
  }

  // The existing Discovery Engine singleton — no new instance, no new
  // cache. buildDependencies() is called unconditionally on every request;
  // Event Catalog/League Catalog's own TTL cache absorbs repeated calls
  // (0 HTTP requests on a warm, already-built instance).
  const resolver = options.resolver ?? defaultCandidateResolver;

  const buildResult = await resolver.buildDependencies();
  if (buildResult.status === "FAILED") {
    logDiscoveryEvent({
      telegramUserId: hashTelegramId(telegramId),
      queryLength: query.length,
      resultKind: "FAILED",
      failureSource: buildResult.source,
      durationMs: now() - startedAt,
    });
    await send(chatId, DISCOVERY_FAILED_TEXT);
    return { kind: "FAILED" };
  }

  const result = resolver.resolve(query);

  logDiscoveryEvent({
    telegramUserId: hashTelegramId(telegramId),
    queryLength: query.length,
    resultKind: result.kind,
    candidateCount: candidateCountOf(result),
    matchMethod: matchMethodOf(result),
    failureSource: result.kind === "FAILED" ? result.source : undefined,
    durationMs: now() - startedAt,
  });

  await send(chatId, formatDiscoveryReply(result));

  return outcomeFor(result.kind);
}
