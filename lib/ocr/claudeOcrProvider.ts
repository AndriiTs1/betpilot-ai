import Anthropic from "@anthropic-ai/sdk";
import type { OcrImageInput, OcrProvider, OcrResult } from "./ocrTypes";

// Stage 14.2 — provider decision: reuse the already-configured Anthropic
// (Claude) integration (ANTHROPIC_API_KEY already exists and is already
// billed for image calls via lib/ai/betParser.ts's parseImageWithClaude,
// used by the Mini App screenshot flow). No new credential, no new
// third-party account, no native OCR binary (Tesseract etc. are unreliable
// on Vercel serverless — no persistent filesystem, no guaranteed system
// packages) and no local model to ship. See this stage's final report for
// the full billing/privacy writeup.
//
// Deliberately a *separate* client and prompt from lib/ai/betParser.ts, not
// a shared import — this call only ever asks Claude to transcribe visible
// text, never to classify a sport, extract a stake, or identify an event.
// Keeping this prompt boundary in its own file is what keeps OCR and bet
// parsing genuinely separate modules, not just separate functions sharing
// one call site.

const CLAUDE_OCR_MODEL = "claude-sonnet-4-6";
const CLAUDE_OCR_TIMEOUT_MS = 20000;
const PROVIDER_NAME = "claude";

const OCR_SYSTEM_PROMPT =
  "You transcribe visible text from an image exactly as it appears, nothing " +
  "more. Output only the raw text you can read, preserving line breaks, " +
  "numbers, decimal separators, plus/minus signs, punctuation, and symbols " +
  "exactly as shown. Do not translate, summarize, classify, interpret, or " +
  "add any commentary of your own. If the image contains no legible text, " +
  "respond with nothing.";

let anthropicClient: Anthropic | null = null;

function getAnthropicClient(apiKey: string): Anthropic {
  if (!anthropicClient) {
    // maxRetries: 0 — this request carries a paid image upload; letting the
    // SDK silently retry on our behalf would multiply both latency and
    // billing without our own timeout/error handling ever seeing it.
    // recognizeScreenshot.ts wraps every provider call in its own
    // independent timeout race regardless, so a single, non-retried attempt
    // here is deliberate, not a missed safety net.
    anthropicClient = new Anthropic({ apiKey, maxRetries: 0 });
  }
  return anthropicClient;
}

function isTextBlock(block: unknown): block is Anthropic.TextBlock {
  return typeof block === "object" && block !== null && (block as { type?: unknown }).type === "text";
}

export interface CreateClaudeOcrProviderOptions {
  // Test-only override — production always uses CLAUDE_OCR_TIMEOUT_MS.
  // recognizeScreenshot.ts's own Promise.race timeout is what actually
  // governs production behavior end-to-end; this one only bounds this
  // adapter's direct Anthropic SDK call.
  timeoutMs?: number;
}

// Only ever constructed here — the orchestrator (recognizeScreenshot.ts)
// re-measures and re-stamps durationMs on every result it receives anyway,
// so this provider's own timer only needs to be roughly right, not
// authoritative.
export function createClaudeOcrProvider(options: CreateClaudeOcrProviderOptions = {}): OcrProvider {
  const timeoutMs = options.timeoutMs ?? CLAUDE_OCR_TIMEOUT_MS;

  return {
    name: PROVIDER_NAME,

    async recognize(input: OcrImageInput): Promise<OcrResult> {
      const startedAt = Date.now();

      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) {
        // Server-side only — never the image, never a stack trace, never a
        // key value (there isn't one to leak here).
        console.error("claudeOcrProvider: ANTHROPIC_API_KEY is not set");
        return {
          kind: "FAILURE",
          code: "PROVIDER_UNAVAILABLE",
          provider: PROVIDER_NAME,
          durationMs: Date.now() - startedAt,
          safeMessage: "OCR provider is not configured",
        };
      }

      try {
        const client = getAnthropicClient(apiKey);

        const response = await client.messages.create(
          {
            model: CLAUDE_OCR_MODEL,
            max_tokens: 2048,
            system: OCR_SYSTEM_PROMPT,
            messages: [
              {
                role: "user",
                content: [
                  {
                    type: "image",
                    source: { type: "base64", media_type: input.mimeType, data: input.buffer.toString("base64") },
                  },
                  { type: "text", text: "Transcribe all visible text from this image." },
                ],
              },
            ],
          },
          { timeout: timeoutMs },
        );

        const textBlock = response.content.find(isTextBlock);
        const rawText = textBlock?.text ?? "";

        return {
          kind: "SUCCESS",
          provider: PROVIDER_NAME,
          rawText,
          // The orchestrator (recognizeScreenshot.ts) re-normalizes this
          // authoritatively — normalization is explicitly kept out of every
          // provider adapter (Part 4).
          normalizedText: rawText,
          durationMs: Date.now() - startedAt,
        };
      } catch (err) {
        const durationMs = Date.now() - startedAt;

        if (err instanceof Anthropic.APIConnectionTimeoutError) {
          return {
            kind: "FAILURE",
            code: "PROVIDER_TIMEOUT",
            provider: PROVIDER_NAME,
            durationMs,
            safeMessage: "OCR provider timed out",
          };
        }

        // Logs the error's class/name only — never response bodies, never
        // request details, never the image, never the API key.
        console.error(
          "claudeOcrProvider: recognize failed:",
          err instanceof Anthropic.APIError ? `APIError(${err.status})` : err instanceof Error ? err.name : "unknown error",
        );

        return {
          kind: "FAILURE",
          code: "PROVIDER_ERROR",
          provider: PROVIDER_NAME,
          durationMs,
          safeMessage: "OCR provider error",
        };
      }
    },
  };
}
