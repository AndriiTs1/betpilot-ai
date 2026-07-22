import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
// betSlip.ts's own import of this file's types is `import type`-only (erased
// at compile time), so this is not a real runtime circular dependency —
// only this file ends up depending on betSlip.ts at runtime, not the
// reverse.
import { normalizeParsedBet, type ParsedBetSlip } from "@/lib/bets/betSlip";
import { chatPrompt, ocrPrompt } from "./betParserPrompt";

const OLLAMA_HOST = process.env.OLLAMA_HOST ?? "http://localhost:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? "llama3.2";
const OLLAMA_TIMEOUT_MS = 8000;

const CLAUDE_MODEL = "claude-sonnet-4-6";
const CLAUDE_TIMEOUT_MS = 8000;

// Shared across every odds field this file validates (SINGLE, EXPRESS legs,
// both CHAT and OCR mode) — a single ceiling, not a per-schema guess. Real
// bookmaker decimal odds essentially never reach four figures; this exists
// to catch an obvious OCR/decimal-separator misread (e.g. "2,10" read as
// 210, or "10.50" read as 1050) rather than to model a genuine odds limit —
// see SCREENSHOT_RECOGNITION_REPORT.md.
export const MAX_DECIMAL_ODDS = 1000;

const betFieldsSchema = z.object({
  sport: z.string().min(1),
  event: z.string().min(1),
  selection: z.string().min(1),
  stake: z.number().positive(),
  odds: z.number().finite().positive().max(MAX_DECIMAL_ODDS, "Decimal odds exceed the supported maximum").nullable(),
});

const validBetSchema = betFieldsSchema.extend({ valid: z.literal(true) });

const invalidBetSchema = z.object({ valid: z.literal(false) });

const modelResponseSchema = z.union([validBetSchema, invalidBetSchema]);

export type ParsedBet = z.infer<typeof validBetSchema>;

export type ParseBetResult = ParsedBet | { valid: false; error: string };

/* -------------------------------------------------------------------------- */
/* Ollama                                                                      */
/* -------------------------------------------------------------------------- */

const OLLAMA_SYSTEM_PROMPT = `You extract structured sports betting data from a WhatsApp message sent by a player to their bookmaker.

Return a single strict JSON object, with no extra text, matching one of these two shapes:

1. The message is a bet request:
{"valid": true, "sport": string, "event": string, "selection": string, "stake": number, "odds": number | null}

- "sport": the sport being bet on (e.g. "Football", "Tennis").
- "event": the match or event (e.g. "Real Madrid vs Barcelona").
- "selection": the specific outcome the player is betting on (e.g. "Real Madrid Win").
- "stake": the amount the player wants to bet, as a number.
- "odds": the odds the player mentioned, as a number. If the player did not mention odds, set this to null — it will be verified separately.

2. The message does not look like a bet request:
{"valid": false}`;

interface OllamaChatResponse {
  message?: {
    content?: string;
  };
}

async function parseWithOllama(text: string): Promise<ParseBetResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OLLAMA_TIMEOUT_MS);

  let rawContent: string;

  try {
    const response = await fetch(`${OLLAMA_HOST}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        stream: false,
        format: "json",
        messages: [
          { role: "system", content: OLLAMA_SYSTEM_PROMPT },
          { role: "user", content: text },
        ],
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      return {
        valid: false,
        error: `Ollama request failed with status ${response.status}`,
      };
    }

    const data = (await response.json()) as OllamaChatResponse;
    rawContent = data.message?.content ?? "";
  } catch (err) {
    const message =
      err instanceof Error && err.name === "AbortError"
        ? `Ollama request timed out after ${OLLAMA_TIMEOUT_MS}ms`
        : err instanceof Error
          ? err.message
          : "Unknown error calling Ollama";

    return { valid: false, error: message };
  } finally {
    clearTimeout(timeout);
  }

  let parsedJson: unknown;

  try {
    parsedJson = JSON.parse(rawContent);
  } catch {
    return { valid: false, error: "Ollama returned invalid JSON" };
  }

  const result = modelResponseSchema.safeParse(parsedJson);

  if (!result.success) {
    return { valid: false, error: result.error.message };
  }

  if (!result.data.valid) {
    return { valid: false, error: "Message does not appear to be a bet request" };
  }

  return result.data;
}

/* -------------------------------------------------------------------------- */
/* Claude                                                                      */
/* -------------------------------------------------------------------------- */

const CLAUDE_SYSTEM_PROMPT = `You extract structured sports betting data from a WhatsApp message sent by a player to their bookmaker.

Call "extract_bet" if the message is a bet request. If the player did not mention odds, pass odds as null — it will be verified separately.

Call "reject_bet" if the message does not look like a bet request.`;

export const extractBetTool: Anthropic.Beta.BetaTool = {
  name: "extract_bet",
  description: "Record the structured details of a sports bet extracted from the player's message.",
  strict: true,
  input_schema: {
    type: "object",
    properties: {
      sport: { type: "string", description: "The sport being bet on, e.g. Football, Tennis." },
      event: { type: "string", description: "The match or event, e.g. Real Madrid vs Barcelona." },
      selection: { type: "string", description: "The outcome the player is betting on, e.g. Real Madrid Win." },
      stake: { type: "number", description: "The amount the player wants to bet." },
      odds: {
        type: ["number", "null"],
        description: "The odds the player mentioned, or null if not mentioned.",
      },
    },
    required: ["sport", "event", "selection", "stake", "odds"],
    additionalProperties: false,
  },
};

export const rejectBetTool: Anthropic.Beta.BetaTool = {
  name: "reject_bet",
  description: "Call this when the message does not look like a sports betting request.",
  strict: true,
  input_schema: {
    type: "object",
    properties: {
      reason: { type: "string", description: "Why the message isn't a bet request." },
    },
    required: ["reason"],
    additionalProperties: false,
  },
};

let anthropicClient: Anthropic | null = null;

function getAnthropicClient(): Anthropic {
  if (!anthropicClient) {
    // maxRetries: 0 — matches lib/ocr/claudeOcrProvider.ts's existing
    // client. Without this, the SDK's default (2 retries, each getting its
    // own fresh `timeout` budget plus backoff) makes any `timeout` value
    // meaningless: a transient 5xx could cost up to ~3x the configured
    // timeout in real wall-clock time. Timeout behavior must be
    // deterministic, so retries are handled by the caller (or not at all),
    // never silently by the SDK underneath a timeout value that's
    // supposed to be a hard ceiling.
    anthropicClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 0 });
  }
  return anthropicClient;
}

async function parseWithClaude(text: string): Promise<ParseBetResult> {
  const client = getAnthropicClient();

  let response: Anthropic.Beta.BetaMessage;

  try {
    response = await client.beta.messages.create(
      {
        model: CLAUDE_MODEL,
        max_tokens: 1024,
        system: CLAUDE_SYSTEM_PROMPT,
        tools: [extractBetTool, rejectBetTool],
        tool_choice: { type: "any" },
        messages: [{ role: "user", content: text }],
      },
      { timeout: CLAUDE_TIMEOUT_MS },
    );
  } catch (err) {
    const message =
      err instanceof Anthropic.APIError
        ? err.message
        : err instanceof Error
          ? err.message
          : "Unknown error calling Claude";

    return { valid: false, error: message };
  }

  const toolUse = response.content.find(
    (block): block is Anthropic.Beta.BetaToolUseBlock => block.type === "tool_use",
  );

  if (!toolUse) {
    return { valid: false, error: "Claude did not return a tool call" };
  }

  if (toolUse.name === "reject_bet") {
    return { valid: false, error: "Message does not appear to be a bet request" };
  }

  const result = betFieldsSchema.safeParse(toolUse.input);

  if (!result.success) {
    return { valid: false, error: result.error.message };
  }

  return { valid: true, ...result.data };
}

/* -------------------------------------------------------------------------- */
/* Public entry point                                                          */
/* -------------------------------------------------------------------------- */

export async function parseBetMessage(
  text: string,
  _playerId: string,
): Promise<ParseBetResult> {
  const provider = process.env.AI_PROVIDER ?? "ollama";

  if (provider === "claude") {
    return parseWithClaude(text);
  }

  return parseWithOllama(text);
}

// Shared by the text EXPRESS path (extract_express_bet, below) — no
// image-specific parsing remains in this file as of Stage 14.3 (see
// betParserPrompt.ts / recognizeScreenshot.ts for how a screenshot's text
// now reaches this same module instead).
const parlaySelectionFieldsSchema = z.object({
  sport: z.string().trim().min(1),
  event: z.string().trim().min(1),
  selection: z.string().trim().min(1),
  odds: z.number().finite().positive().max(MAX_DECIMAL_ODDS, "Decimal odds exceed the supported maximum").nullable(),
});

const parlayBetFieldsSchema = z.object({
  stake: z.number().positive().finite(),
  selections: z.array(parlaySelectionFieldsSchema).min(2),
});

/* -------------------------------------------------------------------------- */
/* Text SINGLE/EXPRESS parsing — Stage 12, Phase 3. Stage 14.3 extended this  */
/* single entry point to also serve OCR-transcribed screenshot text, rather  */
/* than adding a second parser.                                              */
/* -------------------------------------------------------------------------- */
//
// Purely additive: parseBetMessage()/parseWithClaude()/parseWithOllama()
// above are byte-for-byte unchanged, so every existing caller keeps working
// exactly as before. This is a new, separate entry point.
//
// EXPRESS detection is Claude-only — Ollama's default model has no tool-use
// reliability proven for a 3-way (single/express/reject) branch, so on
// Ollama this normalizes the existing SINGLE-only parseBetMessage() result
// instead of attempting to detect EXPRESS (or OCR-specific parsing) at all.
// Production runs AI_PROVIDER=claude, so this only affects local
// Ollama-provider dev.

export type ParseBetSlipResult =
  | ({ valid: true } & ParsedBetSlip)
  | { valid: false; error: string; code?: "timeout" };

// Stage 14.3 — one parser, two prompts (lib/ai/betParserPrompt.ts), never
// two parsers. CHAT is a player's own free-form message (unchanged
// behavior/callers from Stage 12); OCR is text transcribed from a bet-slip
// screenshot by lib/ocr/recognizeScreenshot.ts. Both modes call the exact
// same three tools below (extract_bet / extract_express_bet / reject_bet) —
// only the system prompt differs, so both modes produce byte-identical
// output shapes and nothing downstream (buildBetSlipPreview, previewToken,
// confirm, Prisma) needs to know or care which mode produced a given
// ParsedBetSlip.
export type BetSlipParseMode = "CHAT" | "OCR";

// Stage 14.4A — OCR mode gets its own, larger timeout. ocrPrompt is ~5x
// chatPrompt by size and OCR-mode input (transcribed screen text) is
// typically both longer and noisier than a short chat message, so the
// original single 8000ms budget (still used for CHAT below) was sized for
// a case OCR-mode never actually is.
//
// 15000ms is an INITIAL OPERATIONAL VALUE, not a permanent architectural
// constant. It's reasoned from confirmed prompt-size ratios and known
// Claude tool-use latency characteristics (output-token-generation-bound,
// not input-size-bound), not from real production measurements — this
// codebase had no per-stage timing before this same stage added it (see
// the screenshot preview route's new timing instrumentation). Once enough
// production durationMs samples exist to compute real p50/p95/p99 for the
// OCR-mode parser call, this value must be re-evaluated against that data
// rather than left as a one-time guess.
const CLAUDE_OCR_PARSER_TIMEOUT_MS = 15000;

// Deliberately the same shape as extract_bet's — reuses betFieldsSchema.
export const extractExpressBetTool: Anthropic.Beta.BetaTool = {
  name: "extract_express_bet",
  description: "Record a multi-selection (accumulator/express) bet described in the player's message.",
  strict: true,
  input_schema: {
    type: "object",
    properties: {
      stake: { type: "number", description: "The total stake amount for the express." },
      selections: {
        type: "array",
        description: "Every leg of the express, in the order mentioned.",
        items: {
          type: "object",
          properties: {
            sport: { type: "string" },
            event: { type: "string" },
            selection: { type: "string" },
            odds: { type: ["number", "null"] },
          },
          required: ["sport", "event", "selection", "odds"],
          additionalProperties: false,
        },
        // No minItems here — Anthropic's strict tool schema only supports
        // minItems 0 or 1 (a value >1 makes the entire messages.create()
        // call fail with a 400 before any tool is even selected, confirmed
        // against production logs — see the regression test in
        // betParser.test.ts). The real "at least 2" rule lives at the
        // application layer instead: parlayBetFieldsSchema's `.min(2)`
        // below, and one layer further downstream,
        // lib/bets/betSlipRules.ts's validateBetSlipType().
      },
    },
    required: ["stake", "selections"],
    additionalProperties: false,
  },
};

async function parseTextSlipWithClaude(
  text: string,
  mode: BetSlipParseMode,
  // Test-only override — production always uses CLAUDE_TIMEOUT_MS (CHAT)
  // or CLAUDE_OCR_PARSER_TIMEOUT_MS (OCR). Lets tests verify mode-based
  // timeout selection deterministically (tiny values) instead of waiting
  // out real timeouts — same convention as
  // lib/ocr/claudeOcrProvider.ts's CreateClaudeOcrProviderOptions.timeoutMs.
  timeoutMsOverride?: number,
): Promise<ParseBetSlipResult> {
  const client = getAnthropicClient();
  const timeoutMs = timeoutMsOverride ?? (mode === "OCR" ? CLAUDE_OCR_PARSER_TIMEOUT_MS : CLAUDE_TIMEOUT_MS);

  let response: Anthropic.Beta.BetaMessage;

  try {
    response = await client.beta.messages.create(
      {
        model: CLAUDE_MODEL,
        max_tokens: 1024,
        // Only the system prompt varies by mode — both share the exact
        // same `tools` array immediately below, which is what guarantees
        // CHAT and OCR always produce the identical JSON schema.
        system: mode === "OCR" ? ocrPrompt : chatPrompt,
        tools: [extractBetTool, extractExpressBetTool, rejectBetTool],
        tool_choice: { type: "any" },
        messages: [{ role: "user", content: text }],
      },
      { timeout: timeoutMs },
    );
  } catch (err) {
    // A timeout is reported with a discriminated `code` (rather than left
    // to blend into the same opaque `error` string every other failure
    // uses) so a caller like the screenshot preview route can correctly
    // map it to a "took too long, try again" response instead of folding
    // it into "we couldn't recognize a bet slip" — the old image-specific
    // parseImageWithClaude() made this same distinction before Stage 14.3
    // routed screenshots through this shared function instead.
    if (err instanceof Anthropic.APIConnectionTimeoutError) {
      return { valid: false, error: err.message, code: "timeout" };
    }

    const message =
      err instanceof Anthropic.APIError
        ? err.message
        : err instanceof Error
          ? err.message
          : "Unknown error calling Claude";

    return { valid: false, error: message };
  }

  const toolUse = response.content.find(
    (block): block is Anthropic.Beta.BetaToolUseBlock => block.type === "tool_use",
  );

  if (!toolUse) {
    return { valid: false, error: "Claude did not return a tool call" };
  }

  if (toolUse.name === "reject_bet") {
    return { valid: false, error: "Message does not appear to be a bet request" };
  }

  if (toolUse.name === "extract_bet") {
    const result = betFieldsSchema.safeParse(toolUse.input);
    if (!result.success) {
      return { valid: false, error: result.error.message };
    }
    return {
      valid: true,
      type: "SINGLE",
      stake: result.data.stake,
      selections: [
        {
          sport: result.data.sport,
          event: result.data.event,
          market: null,
          selection: result.data.selection,
          submittedOdds: result.data.odds,
        },
      ],
    };
  }

  if (toolUse.name === "extract_express_bet") {
    const result = parlayBetFieldsSchema.safeParse(toolUse.input);
    if (!result.success) {
      return { valid: false, error: result.error.message };
    }
    return {
      valid: true,
      type: "EXPRESS",
      stake: result.data.stake,
      selections: result.data.selections.map((selection) => ({
        sport: selection.sport,
        event: selection.event,
        market: null,
        selection: selection.selection,
        submittedOdds: selection.odds,
      })),
    };
  }

  return { valid: false, error: `Unexpected tool call: ${toolUse.name}` };
}

// mode defaults to "CHAT" — every existing caller (the text-bet preview
// route) keeps calling this with just a string, unchanged. timeoutMsOverride
// is test-only (see parseTextSlipWithClaude's own comment) and never passed
// by any production call site.
export async function parseBetSlipMessage(
  text: string,
  mode: BetSlipParseMode = "CHAT",
  timeoutMsOverride?: number,
): Promise<ParseBetSlipResult> {
  const provider = process.env.AI_PROVIDER ?? "ollama";

  if (provider !== "claude") {
    // No OCR-tuned prompt exists for the Ollama fallback — same
    // Claude-only limitation this file already documents for EXPRESS
    // detection above. Local dev without AI_PROVIDER=claude falls back to
    // the same chat-oriented legacy parser regardless of mode; production
    // always runs AI_PROVIDER=claude.
    const legacy = await parseBetMessage(text, "");
    if (!legacy.valid) {
      return { valid: false, error: legacy.error };
    }
    return { valid: true, ...normalizeParsedBet(legacy) };
  }

  return parseTextSlipWithClaude(text, mode, timeoutMsOverride);
}
