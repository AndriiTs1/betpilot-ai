import type { ScreenshotIntake } from "@/lib/telegram/screenshotIntake";
import { normalizeOcrText } from "./normalizeOcrText";
import type { OcrFailure, OcrImageInput, OcrMimeType, OcrProvider, OcrResult, OcrSuccess } from "./ocrTypes";

// Stage 14.2 — the single place that wires a provider-agnostic OcrProvider
// to a downloaded screenshot. Provider-specific code (lib/ocr/claudeOcrProvider.ts)
// never appears here, and Telegram-specific code never appears here either —
// this function only knows about buffers, mime types, and OcrResult.

const DEFAULT_OCR_TIMEOUT_MS = 20000;

const ALLOWED_MIME_TYPES: ReadonlySet<OcrMimeType> = new Set(["image/jpeg", "image/png", "image/webp"]);

export interface RecognizeScreenshotParams {
  intake: Pick<ScreenshotIntake, "mimeType" | "originalFilename">;
  buffer: Buffer;
  provider: OcrProvider;
  timeoutMs?: number;
}

// A sentinel distinct from anything a provider might throw — lets the
// Promise.race below tell "our own timeout fired" apart from "the provider
// itself rejected", without inspecting error messages.
class OcrTimeoutSignal {}

function isOcrSuccessShape(value: unknown): value is OcrSuccess {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Partial<OcrSuccess>;
  return (
    v.kind === "SUCCESS" &&
    typeof v.provider === "string" &&
    typeof v.rawText === "string" &&
    typeof v.normalizedText === "string" &&
    typeof v.durationMs === "number"
  );
}

function isOcrFailureShape(value: unknown): value is OcrFailure {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Partial<OcrFailure>;
  return (
    v.kind === "FAILURE" &&
    typeof v.code === "string" &&
    typeof v.provider === "string" &&
    typeof v.durationMs === "number" &&
    typeof v.safeMessage === "string"
  );
}

function failure(code: OcrFailure["code"], provider: string, durationMs: number, safeMessage: string): OcrFailure {
  return { kind: "FAILURE", code, provider, durationMs, safeMessage };
}

export async function recognizeScreenshot(params: RecognizeScreenshotParams): Promise<OcrResult> {
  const startedAt = Date.now();
  const timeoutMs = params.timeoutMs ?? DEFAULT_OCR_TIMEOUT_MS;
  const providerName = params.provider.name;

  if (params.buffer.byteLength === 0) {
    return failure("EMPTY_IMAGE", providerName, Date.now() - startedAt, "Image is empty");
  }

  if (!ALLOWED_MIME_TYPES.has(params.intake.mimeType)) {
    return failure("UNSUPPORTED_FORMAT", providerName, Date.now() - startedAt, "Unsupported image format");
  }

  const input: OcrImageInput = {
    buffer: params.buffer,
    mimeType: params.intake.mimeType,
    filename: params.intake.originalFilename,
  };

  let raw: unknown;
  // The timeout timer must be cleared as soon as the race settles either
  // way — an uncleared setTimeout keeps a Node process (or serverless
  // invocation) alive for the full timeoutMs even after the provider
  // already resolved, which otherwise leaks a dangling timer on every
  // single successful call.
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  try {
    raw = await Promise.race([
      params.provider.recognize(input),
      new Promise<never>((_resolve, reject) => {
        timeoutHandle = setTimeout(() => reject(new OcrTimeoutSignal()), timeoutMs);
      }),
    ]);
  } catch (err) {
    const durationMs = Date.now() - startedAt;

    if (err instanceof OcrTimeoutSignal) {
      return failure("PROVIDER_TIMEOUT", providerName, durationMs, "OCR provider timed out");
    }

    // Never the provider's own thrown error/stack trace — server log only,
    // and only the error's name/kind, never image bytes or secrets.
    console.error("recognizeScreenshot: provider threw:", err instanceof Error ? err.name : "unknown error");
    return failure("PROVIDER_ERROR", providerName, durationMs, "OCR provider error");
  } finally {
    clearTimeout(timeoutHandle);
  }

  const durationMs = Date.now() - startedAt;

  if (isOcrFailureShape(raw)) {
    return { ...raw, durationMs };
  }

  if (!isOcrSuccessShape(raw)) {
    return failure("INVALID_RESPONSE", providerName, durationMs, "OCR provider returned an invalid response");
  }

  // Normalization is deliberately re-applied here, authoritatively, never
  // trusted from the provider's own normalizedText field (Part 4: kept
  // separate from every provider adapter).
  const normalizedText = normalizeOcrText(raw.rawText);

  if (normalizedText.length === 0) {
    return failure("NO_TEXT_FOUND", providerName, durationMs, "No text found in image");
  }

  return { ...raw, normalizedText, durationMs };
}
