// Shared Telegram Bot API update/message shapes. Stage 14.1 pulls the
// webhook route's previously inline, text-only TelegramUpdate interface out
// here and extends it with photo/document/caption/update_id — every field
// this stage's screenshot intake needs, nothing beyond that (no
// inline_query, callback_query, edited_message, etc. — the webhook route
// still ignores every update that has no `message`, unchanged).

export interface TelegramPhotoSize {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  // Genuinely optional in the Bot API — most clients send it, but nothing
  // guarantees it (see selectScreenshotSource's fallback-to-last-element
  // behavior for when it's missing).
  file_size?: number;
}

export interface TelegramDocument {
  file_id: string;
  file_unique_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

export interface TelegramMessage {
  message_id: number;
  date: number;
  text?: string;
  // Photo/document caption — deliberately never read anywhere in this
  // stage. Telegram keeps it in its own field (never in `text`), which is
  // what already makes "image handling takes priority over text handling"
  // hold automatically: a photo/document update has no `text` at all.
  caption?: string;
  photo?: TelegramPhotoSize[];
  document?: TelegramDocument;
  chat: { id: number };
  // username is genuinely optional in the Bot API (not every Telegram
  // account has one set).
  from: { id: number; username?: string };
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}
