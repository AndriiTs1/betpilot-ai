import type { ScreenshotMimeType } from "./selectScreenshotSource";

// Stage 14.1 — the normalized result of a successfully accepted screenshot.
// Deliberately carries nothing OCR/AI-related yet (no extracted text, no
// parsed bet fields) and is never persisted to Postgres (see Part 6 of the
// stage brief — kept in memory for the lifetime of the request only). A
// later stage that adds OCR/AI parsing extends this, it doesn't replace it.
export interface ScreenshotIntake {
  source: "TELEGRAM_PHOTO" | "TELEGRAM_DOCUMENT";
  playerId: string;
  telegramId: string;
  telegramMessageId: number;
  fileId: string;
  fileUniqueId?: string;
  mimeType: ScreenshotMimeType;
  sizeBytes: number;
  originalFilename?: string;
  receivedAt: Date;
}
