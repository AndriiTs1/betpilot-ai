import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";

const OLLAMA_HOST = process.env.OLLAMA_HOST ?? "http://localhost:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? "llama3.2";
const OLLAMA_TIMEOUT_MS = 8000;

const CLAUDE_MODEL = "claude-sonnet-4-6";
const CLAUDE_TIMEOUT_MS = 8000;

const betFieldsSchema = z.object({
  sport: z.string().min(1),
  event: z.string().min(1),
  selection: z.string().min(1),
  stake: z.number().positive(),
  odds: z.number().positive().nullable(),
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
