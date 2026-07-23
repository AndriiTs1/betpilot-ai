import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { clampAndPadRegion, type NormalizedRegion } from "./screenshotPreprocessing";

// New module — a second, independent Claude vision call whose only job is
// to locate the betting-relevant region inside a large, noisy screenshot
// (full desktop, multiple windows, OS chrome) so the *existing*, unchanged
// OCR transcription call (lib/ocr/claudeOcrProvider.ts) only ever has to
// read a small, focused crop — exactly the input it already works well on.
//
// Deliberately its own client/prompt/tool, not shared with
// claudeOcrProvider.ts or lib/ai/betParser.ts, for the same reason those
// two are already kept separate from each other (see claudeOcrProvider.ts's
// header comment): this call classifies/locates content, the OCR call only
// ever transcribes, and mixing the two prompts would blur a boundary this
// codebase already treats as deliberate.

const CLAUDE_REGION_DETECTION_MODEL = "claude-sonnet-4-6";

// An initial operational value, not a measured one — no production timing
// exists yet for this new call (same caveat lib/ai/betParser.ts's own
// CLAUDE_OCR_PARSER_TIMEOUT_MS comment already states for the same reason).
// Shorter than the OCR stage's own 20000ms: this call sees a downscaled
// image and only has to return a small structured tool call, not transcribe
// a full page of text.
export const REGION_DETECTION_TIMEOUT_MS = 12000;

const REGION_DETECTION_SYSTEM_PROMPT = `You locate betting-relevant content inside a screenshot. The screenshot may be:
- an already-cropped bet slip or bookmaker page (in which case the relevant content fills most or all of the image);
- a full desktop screenshot containing a browser window showing a bookmaker site, MyScore, or Flashscore, alongside unrelated content (other windows, the OS desktop, a Telegram window, icons, folders, a taskbar/dock, browser tabs and navigation chrome, advertising banners);
- a mobile screenshot, possibly including a status bar or app chrome around the actual content.

Your only job is to find the single region of the image that contains the betting-relevant content: a match/event listing, a selected market and odds, a bet slip, or a MyScore/Flashscore score and odds panel. Ignore and exclude from the region: desktop icons and wallpaper, the taskbar/dock, folder windows, Telegram's own chat/window interface (unless it is itself showing a forwarded bet slip image), browser tabs/address bar/bookmarks bar, advertising banners, and any other application window that is not showing betting or match content.

If multiple betting-relevant windows or panels are visible, choose the one that most completely shows a specific match, market, and odds together.

Call "locate_betting_region" exactly once. If you cannot find any betting-relevant content in the image, set found to false and briefly say why in reason.`;

const locateBettingRegionTool: Anthropic.Beta.BetaTool = {
  name: "locate_betting_region",
  description:
    "Report the location of the betting-relevant region in the screenshot (bet slip, match/odds listing, or MyScore/Flashscore panel), as coordinates normalized between 0 and 1 relative to the image's own width/height.",
  strict: true,
  input_schema: {
    type: "object",
    properties: {
      found: { type: "boolean", description: "Whether a betting-relevant region was found." },
      confidence: { type: "number", description: "Confidence the region is correct, from 0 to 1." },
      x: { type: "number", description: "Left edge of the region, as a fraction of image width (0 to 1)." },
      y: { type: "number", description: "Top edge of the region, as a fraction of image height (0 to 1)." },
      width: { type: "number", description: "Region width, as a fraction of image width (0 to 1)." },
      height: { type: "number", description: "Region height, as a fraction of image height (0 to 1)." },
      reason: { type: "string", description: "One short sentence explaining what was found or why nothing was." },
    },
    required: ["found", "confidence", "x", "y", "width", "height", "reason"],
    additionalProperties: false,
  },
};

// Zod is only asked to validate *shape and type* (matches this repo's
// existing convention — see lib/ai/betParser.ts's betFieldsSchema). The
// geometric rules (in-bounds, minimum size, padding) are a separate,
// dedicated concern already covered by clampAndPadRegion — deliberately
// not folded into this schema, since those are safe-to-clamp adjustments,
// not pass/fail validation.
const regionDetectionResultSchema = z.object({
  found: z.boolean(),
  confidence: z.number().finite().min(0).max(1),
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().finite(),
  height: z.number().finite(),
  // Server-log-only in every caller — never returned to the client (Step
  // 3's explicit "do not expose raw model reasoning to the client").
  reason: z.string(),
});

export type RegionDetectionOutcome =
  | { kind: "FOUND"; region: NormalizedRegion; confidence: number; reason: string; durationMs: number }
  | { kind: "NOT_FOUND"; reason: string; durationMs: number }
  // The model returned found:true but with a region too degenerate to
  // safely use (out of bounds, non-finite, or too small even after
  // clamping) — distinct from NOT_FOUND (the model's own "nothing here"
  // answer) so a caller/log reader can tell "model found nothing" apart
  // from "model's answer couldn't be trusted".
  | { kind: "INVALID"; reason: string; durationMs: number }
  | { kind: "TIMEOUT"; durationMs: number }
  | { kind: "ERROR"; durationMs: number };

let anthropicClient: Anthropic | null = null;

function getAnthropicClient(apiKey: string): Anthropic {
  if (!anthropicClient) {
    // maxRetries: 0 — same reasoning as claudeOcrProvider.ts/betParser.ts:
    // this call's timeout must be a hard, deterministic ceiling, not
    // silently multiplied by the SDK's own retry/backoff behavior.
    anthropicClient = new Anthropic({ apiKey, maxRetries: 0 });
  }
  return anthropicClient;
}

export interface DetectBettingRegionParams {
  buffer: Buffer;
  mimeType: "image/jpeg" | "image/png" | "image/webp";
  timeoutMs?: number;
}

// Never throws — every failure mode (missing API key, timeout, transport
// error, malformed tool response) resolves to a RegionDetectionOutcome so
// the orchestrator can uniformly fall back to full-image OCR (Step 2C)
// without a try/catch of its own.
export async function detectBettingRegion(params: DetectBettingRegionParams): Promise<RegionDetectionOutcome> {
  const startedAt = Date.now();
  const timeoutMs = params.timeoutMs ?? REGION_DETECTION_TIMEOUT_MS;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("detectBettingRegion: ANTHROPIC_API_KEY is not set");
    return { kind: "ERROR", durationMs: Date.now() - startedAt };
  }

  let response: Anthropic.Beta.BetaMessage;
  try {
    const client = getAnthropicClient(apiKey);
    response = await client.beta.messages.create(
      {
        model: CLAUDE_REGION_DETECTION_MODEL,
        max_tokens: 512,
        system: REGION_DETECTION_SYSTEM_PROMPT,
        tools: [locateBettingRegionTool],
        tool_choice: { type: "tool", name: "locate_betting_region" },
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: { type: "base64", media_type: params.mimeType, data: params.buffer.toString("base64") },
              },
              { type: "text", text: "Locate the betting-relevant region in this screenshot." },
            ],
          },
        ],
      },
      { timeout: timeoutMs },
    );
  } catch (err) {
    const durationMs = Date.now() - startedAt;

    if (err instanceof Anthropic.APIConnectionTimeoutError) {
      return { kind: "TIMEOUT", durationMs };
    }

    // Class/name only — never response bodies, request details, the
    // image, or the API key. Same convention as claudeOcrProvider.ts.
    console.error(
      "detectBettingRegion: request failed:",
      err instanceof Anthropic.APIError ? `APIError(${err.status})` : err instanceof Error ? err.name : "unknown error",
    );
    return { kind: "ERROR", durationMs };
  }

  const durationMs = Date.now() - startedAt;

  const toolUse = response.content.find(
    (block): block is Anthropic.Beta.BetaToolUseBlock => block.type === "tool_use",
  );

  if (!toolUse) {
    return { kind: "ERROR", durationMs };
  }

  const parsed = regionDetectionResultSchema.safeParse(toolUse.input);
  if (!parsed.success) {
    return { kind: "INVALID", reason: "malformed tool response", durationMs };
  }

  if (!parsed.data.found) {
    return { kind: "NOT_FOUND", reason: parsed.data.reason, durationMs };
  }

  const region = clampAndPadRegion({
    x: parsed.data.x,
    y: parsed.data.y,
    width: parsed.data.width,
    height: parsed.data.height,
  });

  if (!region) {
    return { kind: "INVALID", reason: parsed.data.reason, durationMs };
  }

  return { kind: "FOUND", region, confidence: parsed.data.confidence, reason: parsed.data.reason, durationMs };
}
