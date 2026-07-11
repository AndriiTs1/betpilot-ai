import { z } from "zod";

const OLLAMA_HOST = process.env.OLLAMA_HOST ?? "http://localhost:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? "llama3.2";
const REQUEST_TIMEOUT_MS = 8000;

const SYSTEM_PROMPT = `You extract structured sports betting data from a WhatsApp message sent by a player to their bookmaker.

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

const validBetSchema = z.object({
  valid: z.literal(true),
  sport: z.string().min(1),
  event: z.string().min(1),
  selection: z.string().min(1),
  stake: z.number().positive(),
  odds: z.number().positive().nullable(),
});

const invalidBetSchema = z.object({
  valid: z.literal(false),
});

const modelResponseSchema = z.union([validBetSchema, invalidBetSchema]);

export type ParsedBet = z.infer<typeof validBetSchema>;

export type ParseBetResult = ParsedBet | { valid: false; error: string };

interface OllamaChatResponse {
  message?: {
    content?: string;
  };
}

export async function parseBetMessage(
  text: string,
  _playerId: string,
): Promise<ParseBetResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

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
          { role: "system", content: SYSTEM_PROMPT },
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
        ? `Ollama request timed out after ${REQUEST_TIMEOUT_MS}ms`
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
