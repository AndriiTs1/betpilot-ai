import type { TelegramMessage, TelegramPhotoSize } from "./telegramTypes";

// Stage 14.1 — pure, dependency-free selection/validation of "does this
// Telegram message contain exactly one processable image source, and which
// one" (same "pure domain module" convention as
// lib/bets/settlementRules.ts: no I/O, no Prisma, no fetch — fully
// unit-testable on plain objects).

export type ScreenshotMimeType = "image/jpeg" | "image/png" | "image/webp";

const ALLOWED_DOCUMENT_MIME_TYPES: ReadonlySet<string> = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
]);

export interface SelectedScreenshotSource {
  source: "TELEGRAM_PHOTO" | "TELEGRAM_DOCUMENT";
  fileId: string;
  fileUniqueId: string;
  mimeType: ScreenshotMimeType;
  // Telegram-reported size, best-effort — undefined when Telegram omits
  // file_size (rare but allowed by the Bot API). The real, authoritative
  // size is only known after download (see downloadTelegramFile.ts).
  sizeBytes?: number;
  originalFilename?: string;
}

export type SelectScreenshotSourceResult =
  // No message.photo and no message.document — this update isn't a
  // screenshot at all; the webhook falls through to its existing
  // text-handling flow.
  | { kind: "NONE" }
  // message.document present, but its declared MIME type isn't an allowed
  // image type (PDF, GIF, video, ZIP, executable, unknown, ...). The
  // filename extension is never consulted — only mime_type, exactly as
  // Part 2 requires ("Do not trust the filename extension alone").
  | { kind: "UNSUPPORTED_DOCUMENT_TYPE" }
  | { kind: "SELECTED"; source: SelectedScreenshotSource };

// Telegram always sends photo[] ordered smallest -> largest and (in every
// observed case) with file_size set on every element — but file_size is
// documented as optional, so this only trusts it when every element in the
// array actually has one; otherwise it falls back to "last element", per
// Part 2's explicit fallback rule.
function selectLargestPhoto(sizes: TelegramPhotoSize[]): TelegramPhotoSize {
  const everySizeKnown = sizes.every((size) => typeof size.file_size === "number");

  if (everySizeKnown) {
    return sizes.reduce((largest, candidate) =>
      (candidate.file_size as number) > (largest.file_size as number) ? candidate : largest,
    );
  }

  return sizes[sizes.length - 1];
}

function isAllowedMimeType(mimeType: string | undefined): mimeType is ScreenshotMimeType {
  return mimeType !== undefined && ALLOWED_DOCUMENT_MIME_TYPES.has(mimeType);
}

export function selectScreenshotSource(message: TelegramMessage): SelectScreenshotSourceResult {
  // Photo takes precedence when a message somehow carries both (not a real
  // Telegram shape, but this keeps the function total/defensive rather than
  // assuming the two are always mutually exclusive).
  if (message.photo && message.photo.length > 0) {
    const largest = selectLargestPhoto(message.photo);

    return {
      kind: "SELECTED",
      source: {
        source: "TELEGRAM_PHOTO",
        fileId: largest.file_id,
        fileUniqueId: largest.file_unique_id,
        // Telegram always transcodes photo uploads to JPEG server-side —
        // message.photo entries never carry their own mime_type field
        // because there is only ever one possible value.
        mimeType: "image/jpeg",
        sizeBytes: largest.file_size,
      },
    };
  }

  if (message.document) {
    if (!isAllowedMimeType(message.document.mime_type)) {
      return { kind: "UNSUPPORTED_DOCUMENT_TYPE" };
    }

    return {
      kind: "SELECTED",
      source: {
        source: "TELEGRAM_DOCUMENT",
        fileId: message.document.file_id,
        fileUniqueId: message.document.file_unique_id,
        mimeType: message.document.mime_type,
        sizeBytes: message.document.file_size,
        originalFilename: message.document.file_name,
      },
    };
  }

  return { kind: "NONE" };
}
