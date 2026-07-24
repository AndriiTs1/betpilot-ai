// Step 9B — /odds command orchestration. This file is a thin coordinator:
// authorize -> validate payload -> cooldown-gate -> parseBetSlipMessage ->
// buildBetSlipPreview -> formatOddsReply -> sendTelegramMessage. It never
// talks to Claude, The Odds API, or a provider-specific type directly —
// buildBetSlipPreview() (lib/bets/buildBetSlipPreview.ts, unmodified) is the
// only odds-orchestration boundary. It never writes Bet/BetSelection, never
// confirms/submits, and never signs/redeems a preview token beyond what
// buildBetSlipPreview() itself already does internally.

import type { PrismaClient } from "@/lib/generated/prisma/client";
import { prisma } from "@/lib/db/client";
import type { TelegramMessage } from "./telegramTypes";
import { extractCommandPayload } from "./extractCommandPayload";
import { formatOddsReply } from "./formatOddsReply";
import { sendTelegramMessage } from "./sendMessage";
import { parseBetSlipMessage, type ParseBetSlipResult } from "@/lib/ai/betParser";
import { buildBetSlipPreview, BetSlipValidationError, type BuildBetSlipPreviewOptions } from "@/lib/bets/buildBetSlipPreview";

const DEFAULT_COOLDOWN_MS = 10_000;

// Bounded, in-memory, module-scoped — same "best-effort, process-local,
// resets on cold start" characteristic as the webhook route's own
// update_id dedup Set (app/api/webhooks/telegram/route.ts). NOT a
// distributed lock, NOT persisted to Prisma, NOT a substitute for
// infrastructure-level rate limiting. A user hitting a different warm
// instance (or any cold start) gets a fresh cooldown window.
const MAX_TRACKED_COOLDOWN_USERS = 500;
const lastRequestAtByUser = new Map<string, number>();

interface CooldownConfig {
  now: () => number;
  cooldownMs: number;
}

// Sweeps stale entries (older than the current cooldown window) whenever
// the map has grown past the tracked-user cap, keyed off the CURRENT call's
// `now` — piggybacked on every check rather than a separate timer, so this
// needs no setInterval that could leak across test runs or serverless
// invocations.
function isOnCooldown(telegramUserId: string, config: CooldownConfig): boolean {
  const now = config.now();

  if (lastRequestAtByUser.size > MAX_TRACKED_COOLDOWN_USERS) {
    for (const [key, timestamp] of lastRequestAtByUser) {
      if (now - timestamp > config.cooldownMs) {
        lastRequestAtByUser.delete(key);
      }
    }
  }

  const last = lastRequestAtByUser.get(telegramUserId);
  if (last !== undefined && now - last < config.cooldownMs) {
    return true;
  }

  // Claims this slot immediately — a rapid-fire second call (even one that
  // arrives before the first finishes) is blocked, not just calls that
  // start after the first one completes.
  lastRequestAtByUser.set(telegramUserId, now);
  return false;
}

const HELP_TEXT =
  "ℹ️ Usage: <code>/odds &lt;bet description&gt;</code>\nExample: <code>/odds Real Madrid to win vs Barcelona, odds 2.05</code>";
const INVALID_PAYLOAD_TEXT = "⚠️ That bet description is too short or too long. Please try again.";
const NOT_AUTHORIZED_TEXT = "⚠️ This Telegram account is not registered in BetPilot.";
const COOLDOWN_TEXT = "⏳ Please wait a few seconds before checking odds again.";
const PARSE_FAILED_TEXT = "⚠️ Couldn't understand that bet. Try: /odds Team A vs Team B, selection, odds 2.05";
const PARSE_TIMEOUT_TEXT = "⚠️ Odds check is taking too long. Please try again shortly.";
const CONFIG_UNAVAILABLE_TEXT = "⚠️ Odds check is temporarily unavailable. Please try again later.";
const INVALID_SLIP_TEXT = "⚠️ Couldn't build an odds check for that bet.";
const UNEXPECTED_ERROR_TEXT = "⚠️ Something went wrong while checking odds. Please try again later.";

export type OddsCommandOutcome =
  | { kind: "IGNORED_BOT" }
  | { kind: "UNAUTHORIZED" }
  | { kind: "COOLDOWN" }
  | { kind: "HELP" }
  | { kind: "INVALID_PAYLOAD" }
  | { kind: "PARSE_FAILED" }
  | { kind: "PARSE_TIMEOUT" }
  | { kind: "CONFIG_UNAVAILABLE" }
  | { kind: "INVALID_SLIP" }
  | { kind: "UNEXPECTED_ERROR" }
  | { kind: "SUCCESS" };

export interface HandleOddsCommandOptions {
  db?: PrismaClient;
  parseBetSlip?: typeof parseBetSlipMessage;
  sendMessage?: typeof sendTelegramMessage;
  previewTokenSecret?: string;
  verifyOddsFn?: BuildBetSlipPreviewOptions["verifyOddsFn"];
  oddsVerificationService?: BuildBetSlipPreviewOptions["oddsVerificationService"];
  now?: () => number;
  cooldownMs?: number;
}

export async function handleOddsCommand(
  tgMessage: TelegramMessage,
  options: HandleOddsCommandOptions = {},
): Promise<OddsCommandOutcome> {
  // Bot guard — first, before any DB/Claude/provider access, and before any
  // reply is sent (a bot-authored update is ignored entirely, never
  // replied to).
  if (tgMessage.from.is_bot) {
    return { kind: "IGNORED_BOT" };
  }

  const db = options.db ?? prisma;
  const parseBetSlip = options.parseBetSlip ?? parseBetSlipMessage;
  const send = options.sendMessage ?? sendTelegramMessage;
  const chatId = String(tgMessage.chat.id);
  const telegramId = String(tgMessage.from.id);

  // Authorization — the same raw-webhook pattern already proven by
  // lib/telegram/handleScreenshotMessage.ts: a Player row must already
  // exist for this exact telegramId. Never binds/creates a player here.
  // Completes before any parser or provider call, and before the cooldown
  // check (rate-limiting an unauthorized user's Claude usage is moot — they
  // never reach that call at all).
  const player = await db.player.findUnique({ where: { telegramId }, select: { id: true } });
  if (!player) {
    // Generic wording only — never reveals whether some OTHER Telegram
    // account is registered, never a player ID, never invitation state.
    await send(chatId, NOT_AUTHORIZED_TEXT);
    return { kind: "UNAUTHORIZED" };
  }

  const payloadResult = extractCommandPayload(tgMessage.text ?? "");
  if (!payloadResult.ok) {
    if (payloadResult.reason === "MISSING") {
      await send(chatId, HELP_TEXT);
      return { kind: "HELP" };
    }
    await send(chatId, INVALID_PAYLOAD_TEXT);
    return { kind: "INVALID_PAYLOAD" };
  }

  // Preview-token secret — same configuration source and validation
  // semantics as app/api/miniapp/bets/text/preview/route.ts and
  // app/api/miniapp/bets/screenshot/preview/route.ts: read
  // BET_PREVIEW_TOKEN_SECRET from the environment (injectable for tests,
  // exactly like the screenshot route's own `options.previewTokenSecret`
  // seam), and refuse to proceed at all if it's unset — never a dummy,
  // empty, or borrowed value from another secret. Checked BEFORE the
  // cooldown gate: a request that can't possibly reach the parser (missing
  // config) must never consume a cooldown slot either — only a request that
  // actually starts (or is about to start) an expensive Claude/provider
  // call may do that.
  const previewTokenSecret = options.previewTokenSecret ?? process.env.BET_PREVIEW_TOKEN_SECRET;
  if (!previewTokenSecret) {
    console.error("handleOddsCommand: telegram_odds_command_failed", "CONFIG_MISSING_PREVIEW_TOKEN_SECRET");
    await send(chatId, CONFIG_UNAVAILABLE_TEXT);
    return { kind: "CONFIG_UNAVAILABLE" };
  }

  // Cooldown — checked and RESERVED synchronously (isOnCooldown both reads
  // and, on a pass, writes the timestamp in the same synchronous call, with
  // no `await` in between) immediately before the first expensive call
  // (Claude). This is what makes two concurrent requests from the same user
  // safe: whichever one reaches this line first claims the slot before this
  // function ever yields control (the next `await` is parseBetSlip below),
  // so a second, near-simultaneous call for the same user is guaranteed to
  // observe the reservation and be rejected — never a second Claude call.
  // Never rolled back on a later parser/provider failure (see the comments
  // on those branches below): a malformed or failing request still spent
  // Claude/provider resources, so its cooldown must stick.
  const cooldownConfig: CooldownConfig = {
    now: options.now ?? (() => Date.now()),
    cooldownMs: options.cooldownMs ?? DEFAULT_COOLDOWN_MS,
  };
  if (isOnCooldown(telegramId, cooldownConfig)) {
    await send(chatId, COOLDOWN_TEXT);
    return { kind: "COOLDOWN" };
  }

  let parsed: ParseBetSlipResult;
  try {
    // Cooldown is already reserved above — every outcome from here on
    // (valid:false, timeout, throw, preview/provider failure, or success)
    // keeps that reservation. None of the branches below ever deletes or
    // resets lastRequestAtByUser.
    parsed = await parseBetSlip(payloadResult.payload, "CHAT");
  } catch {
    // parseBetSlipMessage is designed to never throw — this is
    // defense-in-depth only, matching buildBetSlipPreview's own
    // "unexpected errors must produce a generic response" requirement.
    console.error("handleOddsCommand: telegram_odds_command_failed", "PARSER_THREW");
    await send(chatId, UNEXPECTED_ERROR_TEXT);
    return { kind: "UNEXPECTED_ERROR" };
  }

  if (!parsed.valid) {
    // parsed.error can contain provider/model/timeout/SDK detail — never
    // forwarded to Telegram, same discipline as
    // app/api/miniapp/bets/text/preview/route.ts.
    if (parsed.code === "timeout") {
      console.error("handleOddsCommand: telegram_odds_command_failed", "PARSE_TIMEOUT");
      await send(chatId, PARSE_TIMEOUT_TEXT);
      return { kind: "PARSE_TIMEOUT" };
    }
    console.error("handleOddsCommand: telegram_odds_command_failed", "PARSE_REJECTED");
    await send(chatId, PARSE_FAILED_TEXT);
    return { kind: "PARSE_FAILED" };
  }

  // The only odds-orchestration boundary this file uses — never
  // TheOddsApiProvider, never OddsVerificationService, never verifyOdds,
  // directly. Production passes neither seam, so buildBetSlipPreview()
  // falls through to its own default (real) provider/service.
  const previewOptions: BuildBetSlipPreviewOptions = {};
  if (options.oddsVerificationService) {
    previewOptions.oddsVerificationService = options.oddsVerificationService;
  } else if (options.verifyOddsFn) {
    previewOptions.verifyOddsFn = options.verifyOddsFn;
  }

  try {
    const result = await buildBetSlipPreview(parsed, player.id, previewTokenSecret, previewOptions);

    await send(chatId, formatOddsReply(result.preview));

    // Safe, content-free logging only — status/type/count, never the
    // submitted bet text, event names, or selections.
    console.log("telegram_odds_command_succeeded", {
      type: result.preview.type,
      selectionCount: result.preview.selections.length,
    });

    return { kind: "SUCCESS" };
  } catch (err) {
    if (err instanceof BetSlipValidationError) {
      console.error("handleOddsCommand: telegram_odds_command_failed", "INVALID_SLIP", err.code);
      await send(chatId, INVALID_SLIP_TEXT);
      return { kind: "INVALID_SLIP" };
    }
    // Never logs err.message/err itself — an unexpected error's own text
    // must not leak into logs or the Telegram reply.
    console.error("handleOddsCommand: telegram_odds_command_failed", "UNEXPECTED_ERROR");
    await send(chatId, UNEXPECTED_ERROR_TEXT);
    return { kind: "UNEXPECTED_ERROR" };
  }
}
