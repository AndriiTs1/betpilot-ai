// Stage 14.2 — provider-agnostic OCR abstraction. Nothing in this file (or
// anywhere else under lib/ocr/) knows about Telegram, Prisma, Bet, or bet
// parsing — it only describes "give me image bytes, get back text". Kept
// separate from lib/ai/betParser.ts on purpose: that module classifies and
// structures bet fields (sport/event/selection/odds); this one only ever
// transcribes visible text, nothing more.

export type OcrMimeType = "image/jpeg" | "image/png" | "image/webp";

export interface OcrImageInput {
  buffer: Buffer;
  mimeType: OcrMimeType;
  filename?: string;
}

export interface OcrTextBlock {
  text: string;
  confidence?: number;
  boundingBox?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

export interface OcrSuccess {
  kind: "SUCCESS";
  provider: string;
  rawText: string;
  normalizedText: string;
  blocks?: OcrTextBlock[];
  language?: string;
  durationMs: number;
}

export type OcrFailureCode =
  | "EMPTY_IMAGE"
  | "UNSUPPORTED_FORMAT"
  | "NO_TEXT_FOUND"
  | "PROVIDER_UNAVAILABLE"
  | "PROVIDER_TIMEOUT"
  | "PROVIDER_ERROR"
  | "INVALID_RESPONSE";

export interface OcrFailure {
  kind: "FAILURE";
  code: OcrFailureCode;
  provider: string;
  durationMs: number;
  // Player/log-safe by construction — never a raw provider error message,
  // stack trace, or response body. See recognizeScreenshot.ts and each
  // provider adapter for where this is set.
  safeMessage: string;
}

export type OcrResult = OcrSuccess | OcrFailure;

export interface OcrProvider {
  readonly name: string;
  recognize(input: OcrImageInput): Promise<OcrResult>;
}
