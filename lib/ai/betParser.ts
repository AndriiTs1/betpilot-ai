import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
// betSlip.ts's own import of this file's types is `import type`-only (erased
// at compile time), so this is not a real runtime circular dependency —
// only this file ends up depending on betSlip.ts at runtime, not the
// reverse.
import { normalizeParsedBet, type ParsedBetSlip } from "@/lib/bets/betSlip";

const OLLAMA_HOST = process.env.OLLAMA_HOST ?? "http://localhost:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? "llama3.2";
const OLLAMA_TIMEOUT_MS = 8000;

const CLAUDE_MODEL = "claude-sonnet-4-6";
const CLAUDE_TIMEOUT_MS = 8000;

// Shared across every odds field this file validates (text SINGLE, image
// SINGLE, image PARLAY legs) — a single ceiling, not a per-schema guess.
// Real bookmaker decimal odds essentially never reach four figures; this
// exists to catch an obvious OCR/decimal-separator misread (e.g. "2,10"
// read as 210, or "10.50" read as 1050) rather than to model a genuine
// odds limit — see SCREENSHOT_RECOGNITION_REPORT.md.
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

const extractBetTool: Anthropic.Beta.BetaTool = {
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

const rejectBetTool: Anthropic.Beta.BetaTool = {
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
    anthropicClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
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

/* -------------------------------------------------------------------------- */
/* Image (screenshot) parsing — Stage 4.5C                                    */
/* -------------------------------------------------------------------------- */
//
// Always Claude — Ollama's default model (llama3.2) has no vision support,
// and this project deliberately doesn't branch on AI_PROVIDER for images
// (see Stage 4.5A decision). Reuses CLAUDE_MODEL, getAnthropicClient(),
// rejectBetTool, and betFieldsSchema as-is; parseWithClaude()/
// parseBetMessage() above are untouched.

const CLAUDE_IMAGE_TIMEOUT_MS = 25000;

export interface ParsedImageSelection {
  sport: string;
  event: string;
  selection: string;
  odds: number | null;
}

export type ParseImageBetResult =
  | { valid: true; type: "SINGLE"; bet: ParsedBet }
  | { valid: true; type: "PARLAY"; stake: number; selections: ParsedImageSelection[] }
  | {
      valid: false;
      // Deterministic, Zod/tool-choice-driven — never derived from
      // sniffing Claude's own prose, so the caller can map each reason to a
      // safe public error code without guessing.
      reason: "not_a_bet" | "no_tool_call" | "incomplete" | "timeout" | "api_error";
      // Server-side diagnostic only — callers must never put this in a
      // client response.
      detail: string;
    };

// Only the fields extract_single_bet_from_image can submit — deliberately
// the same shape as betFieldsSchema (reused directly below), not redefined.
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

const CLAUDE_IMAGE_SYSTEM_PROMPT = `You extract structured sports betting data from a screenshot of a bookmaker bet slip.

Only extract data that is actually visible in the image. Never invent or guess a missing sport, league, event, selection, odds, stake, or date — if a value isn't clearly shown, treat the bet as incomplete and call "reject_bet" instead of filling it in with a plausible-looking value.

Do not confuse:
- an advertised promotion, account balance, or a "potential win"/payout figure with the actual stake the player placed;
- the combined/total odds of a multi-selection (parlay/accumulator) slip with the odds of any single leg within it.

Call "extract_single_bet_from_image" if the slip shows exactly one selection.
Call "extract_parlay_bet_from_image" if the slip shows two or more selections (an accumulator/parlay) — list every leg you can actually read, each with its own odds if shown.
Call "reject_bet" if the image is not a legible bookmaker bet slip, or if you cannot confidently read the fields a bet requires.

Respond only by calling exactly one of these tools — no free text outside the tool call.`;

const extractSingleBetFromImageTool: Anthropic.Beta.BetaTool = {
  name: "extract_single_bet_from_image",
  description: "Record a single-selection bet read from a bookmaker slip screenshot.",
  strict: true,
  input_schema: {
    type: "object",
    properties: {
      sport: { type: "string", description: "The sport being bet on, e.g. Football, Tennis." },
      event: { type: "string", description: "The match or event, e.g. Real Madrid vs Barcelona." },
      selection: { type: "string", description: "The outcome the player is betting on." },
      stake: { type: "number", description: "The stake amount actually printed on the slip." },
      odds: {
        type: ["number", "null"],
        description: "The odds printed on the slip, or null if not legible.",
      },
    },
    required: ["sport", "event", "selection", "stake", "odds"],
    additionalProperties: false,
  },
};

const extractParlayBetFromImageTool: Anthropic.Beta.BetaTool = {
  name: "extract_parlay_bet_from_image",
  description: "Record a multi-selection (accumulator/parlay) bet read from a bookmaker slip screenshot.",
  strict: true,
  input_schema: {
    type: "object",
    properties: {
      stake: { type: "number", description: "The total stake amount actually printed on the slip." },
      selections: {
        type: "array",
        description: "Every leg of the parlay, in the order shown on the slip.",
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
        minItems: 2,
      },
    },
    required: ["stake", "selections"],
    additionalProperties: false,
  },
};

// Claude's tool_use.input is already parsed JSON (never a raw string this
// function re-parses), so it can't contain a bare NaN/Infinity token — this
// only guards against whitespace-only strings slipping past betFieldsSchema/
// parlaySelectionFieldsSchema's `.min(1)` checks, without editing those
// shared schemas (parseWithClaude's text path must stay byte-for-byte
// unchanged).
function trimStringFields(input: Record<string, unknown>): Record<string, unknown> {
  const trimmed: Record<string, unknown> = { ...input };
  for (const key of Object.keys(trimmed)) {
    if (typeof trimmed[key] === "string") trimmed[key] = trimmed[key].trim();
  }
  return trimmed;
}

export async function parseImageWithClaude(input: {
  imageBase64: string;
  mediaType: "image/jpeg" | "image/png" | "image/webp";
}): Promise<ParseImageBetResult> {
  let response: Anthropic.Beta.BetaMessage;

  try {
    const client = getAnthropicClient();

    response = await client.beta.messages.create(
      {
        model: CLAUDE_MODEL,
        max_tokens: 1024,
        system: CLAUDE_IMAGE_SYSTEM_PROMPT,
        tools: [extractSingleBetFromImageTool, extractParlayBetFromImageTool, rejectBetTool],
        tool_choice: { type: "any" },
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: { type: "base64", media_type: input.mediaType, data: input.imageBase64 },
              },
              { type: "text", text: "Extract the bet details from this bookmaker slip screenshot." },
            ],
          },
        ],
      },
      { timeout: CLAUDE_IMAGE_TIMEOUT_MS },
    );
  } catch (err) {
    if (err instanceof Anthropic.APIConnectionTimeoutError) {
      return { valid: false, reason: "timeout", detail: err.message };
    }

    const detail =
      err instanceof Anthropic.APIError
        ? err.message
        : err instanceof Error
          ? err.message
          : "Unknown error calling Claude for image parsing";
    return { valid: false, reason: "api_error", detail };
  }

  const toolUse = response.content.find(
    (block): block is Anthropic.Beta.BetaToolUseBlock => block.type === "tool_use",
  );

  if (!toolUse) {
    return { valid: false, reason: "no_tool_call", detail: "Claude did not return a tool call" };
  }

  if (toolUse.name === "reject_bet") {
    return { valid: false, reason: "not_a_bet", detail: "Image does not appear to be a legible bet slip" };
  }

  if (toolUse.name === "extract_single_bet_from_image") {
    const result = betFieldsSchema.safeParse(trimStringFields(toolUse.input as Record<string, unknown>));
    if (!result.success) {
      return { valid: false, reason: "incomplete", detail: result.error.message };
    }
    return { valid: true, type: "SINGLE", bet: { valid: true, ...result.data } };
  }

  if (toolUse.name === "extract_parlay_bet_from_image") {
    const raw = toolUse.input as { stake?: unknown; selections?: unknown };
    const trimmedSelections = Array.isArray(raw.selections)
      ? raw.selections.map((selection) =>
          typeof selection === "object" && selection !== null
            ? trimStringFields(selection as Record<string, unknown>)
            : selection,
        )
      : raw.selections;

    const result = parlayBetFieldsSchema.safeParse({ stake: raw.stake, selections: trimmedSelections });
    if (!result.success) {
      return { valid: false, reason: "incomplete", detail: result.error.message };
    }
    return { valid: true, type: "PARLAY", stake: result.data.stake, selections: result.data.selections };
  }

  return { valid: false, reason: "no_tool_call", detail: `Unexpected tool call: ${toolUse.name}` };
}

/* -------------------------------------------------------------------------- */
/* Text SINGLE/EXPRESS parsing — Stage 12, Phase 3                            */
/* -------------------------------------------------------------------------- */
//
// Purely additive: parseBetMessage()/parseWithClaude()/parseWithOllama()
// above are byte-for-byte unchanged, so every existing caller keeps working
// exactly as before. This is a new, separate entry point.
//
// EXPRESS detection is Claude-only, same reasoning parseImageWithClaude
// already documents for images — Ollama's default model has no tool-use
// reliability proven for a 3-way (single/express/reject) branch, so on
// Ollama this normalizes the existing SINGLE-only parseBetMessage() result
// instead of attempting to detect EXPRESS at all. Production runs
// AI_PROVIDER=claude, so this only affects local Ollama-provider dev.

export type ParseBetSlipResult =
  | ({ valid: true } & ParsedBetSlip)
  | { valid: false; error: string };

const TEXT_SLIP_SYSTEM_PROMPT = `You extract structured sports betting data from a message sent by a player to their bookmaker.

Call "extract_bet" if the message describes exactly one selection.
Call "extract_express_bet" if the message describes two or more selections (an accumulator/express bet) — list every leg you can identify, each with its own odds if mentioned.
Call "reject_bet" if the message does not look like a bet request.

If odds for a leg are not mentioned, pass odds as null — it will be verified separately.`;

// Deliberately the same shape as extract_bet's — reuses betFieldsSchema.
const extractExpressBetTool: Anthropic.Beta.BetaTool = {
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
        minItems: 2,
      },
    },
    required: ["stake", "selections"],
    additionalProperties: false,
  },
};

async function parseTextSlipWithClaude(text: string): Promise<ParseBetSlipResult> {
  const client = getAnthropicClient();

  let response: Anthropic.Beta.BetaMessage;

  try {
    response = await client.beta.messages.create(
      {
        model: CLAUDE_MODEL,
        max_tokens: 1024,
        system: TEXT_SLIP_SYSTEM_PROMPT,
        tools: [extractBetTool, extractExpressBetTool, rejectBetTool],
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

export async function parseBetSlipMessage(text: string): Promise<ParseBetSlipResult> {
  const provider = process.env.AI_PROVIDER ?? "ollama";

  if (provider !== "claude") {
    const legacy = await parseBetMessage(text, "");
    if (!legacy.valid) {
      return { valid: false, error: legacy.error };
    }
    return { valid: true, ...normalizeParsedBet(legacy) };
  }

  return parseTextSlipWithClaude(text);
}
