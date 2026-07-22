import { test } from "node:test";
import assert from "node:assert/strict";
import { selectScreenshotSource } from "./selectScreenshotSource";
import type { TelegramMessage } from "./telegramTypes";

function baseMessage(overrides: Partial<TelegramMessage> = {}): TelegramMessage {
  return {
    message_id: 1,
    date: 1700000000,
    chat: { id: 555 },
    from: { id: 42 },
    ...overrides,
  };
}

test("selectScreenshotSource: a text-only message has no image source", () => {
  const result = selectScreenshotSource(baseMessage({ text: "hello" }));
  assert.deepEqual(result, { kind: "NONE" });
});

test("selectScreenshotSource: an empty message has no image source", () => {
  const result = selectScreenshotSource(baseMessage());
  assert.deepEqual(result, { kind: "NONE" });
});

test("selectScreenshotSource: a photo message is selected as TELEGRAM_PHOTO, always image/jpeg", () => {
  const message = baseMessage({
    photo: [{ file_id: "small", file_unique_id: "u-small", width: 90, height: 90, file_size: 1000 }],
  });

  const result = selectScreenshotSource(message);
  assert.deepEqual(result, {
    kind: "SELECTED",
    source: {
      source: "TELEGRAM_PHOTO",
      fileId: "small",
      fileUniqueId: "u-small",
      mimeType: "image/jpeg",
      sizeBytes: 1000,
    },
  });
});

test("selectScreenshotSource: the largest photo by file_size is selected, regardless of array order", () => {
  const message = baseMessage({
    photo: [
      { file_id: "medium", file_unique_id: "u-medium", width: 320, height: 320, file_size: 20000 },
      { file_id: "largest", file_unique_id: "u-largest", width: 1280, height: 1280, file_size: 250000 },
      { file_id: "smallest", file_unique_id: "u-smallest", width: 90, height: 90, file_size: 1000 },
    ],
  });

  const result = selectScreenshotSource(message);
  assert.equal(result.kind, "SELECTED");
  assert.equal(result.kind === "SELECTED" && result.source.fileId, "largest");
});

test("selectScreenshotSource: falls back to the last photo element when file_size is missing", () => {
  const message = baseMessage({
    photo: [
      { file_id: "first", file_unique_id: "u-first", width: 90, height: 90 },
      { file_id: "last", file_unique_id: "u-last", width: 1280, height: 1280 },
    ],
  });

  const result = selectScreenshotSource(message);
  assert.equal(result.kind, "SELECTED");
  assert.equal(result.kind === "SELECTED" && result.source.fileId, "last");
});

test("selectScreenshotSource: falls back to the last element when file_size is present on only some photos", () => {
  const message = baseMessage({
    photo: [
      { file_id: "first", file_unique_id: "u-first", width: 90, height: 90, file_size: 999999 },
      { file_id: "last", file_unique_id: "u-last", width: 1280, height: 1280 },
    ],
  });

  const result = selectScreenshotSource(message);
  assert.equal(result.kind, "SELECTED");
  assert.equal(result.kind === "SELECTED" && result.source.fileId, "last");
});

for (const mimeType of ["image/jpeg", "image/png", "image/webp"] as const) {
  test(`selectScreenshotSource: a ${mimeType} document is selected as TELEGRAM_DOCUMENT`, () => {
    const message = baseMessage({
      document: {
        file_id: "doc-1",
        file_unique_id: "u-doc-1",
        mime_type: mimeType,
        file_size: 12345,
        file_name: `slip.${mimeType.split("/")[1]}`,
      },
    });

    const result = selectScreenshotSource(message);
    assert.deepEqual(result, {
      kind: "SELECTED",
      source: {
        source: "TELEGRAM_DOCUMENT",
        fileId: "doc-1",
        fileUniqueId: "u-doc-1",
        mimeType,
        sizeBytes: 12345,
        originalFilename: `slip.${mimeType.split("/")[1]}`,
      },
    });
  });
}

for (const mimeType of ["application/pdf", "image/gif", "video/mp4", "application/zip", "application/x-msdownload"]) {
  test(`selectScreenshotSource: a document with mime type ${mimeType} is rejected`, () => {
    const message = baseMessage({
      document: { file_id: "doc-1", file_unique_id: "u-doc-1", mime_type: mimeType, file_name: "file.bin" },
    });

    assert.deepEqual(selectScreenshotSource(message), { kind: "UNSUPPORTED_DOCUMENT_TYPE" });
  });
}

test("selectScreenshotSource: a document with no mime_type at all is rejected", () => {
  const message = baseMessage({
    document: { file_id: "doc-1", file_unique_id: "u-doc-1", file_name: "file" },
  });

  assert.deepEqual(selectScreenshotSource(message), { kind: "UNSUPPORTED_DOCUMENT_TYPE" });
});

test("selectScreenshotSource: does not trust a spoofed image-looking filename over the real mime_type", () => {
  const message = baseMessage({
    document: {
      file_id: "doc-1",
      file_unique_id: "u-doc-1",
      mime_type: "application/pdf",
      file_name: "definitely-a-photo.jpg",
    },
  });

  assert.deepEqual(selectScreenshotSource(message), { kind: "UNSUPPORTED_DOCUMENT_TYPE" });
});
