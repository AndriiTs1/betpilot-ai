import { test } from "node:test";
import assert from "node:assert/strict";
import { downloadTelegramFile } from "./downloadTelegramFile";

// Same global.fetch-stubbing convention as
// app/api/bets/settle.route.test.ts's Telegram notification tests — no
// mocking library, just a capturing/scripted stub restored in
// test.afterEach.

const BOT_TOKEN = "test-bot-token-12345";
const originalFetch = global.fetch;
let calledUrls: string[] = [];

test.beforeEach(() => {
  calledUrls = [];
});

test.afterEach(() => {
  global.fetch = originalFetch;
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

test("downloadTelegramFile: happy path returns the buffer, byte size, and file path", async () => {
  const fileBytes = Buffer.from("fake-image-bytes");

  global.fetch = (async (url: string | URL) => {
    calledUrls.push(String(url));
    if (String(url).includes("/getFile")) {
      return jsonResponse({ ok: true, result: { file_path: "photos/file_1.jpg", file_size: fileBytes.byteLength } });
    }
    return new Response(fileBytes, { status: 200 });
  }) as typeof fetch;

  const result = await downloadTelegramFile({ fileId: "abc", botToken: BOT_TOKEN, maxBytes: 10 * 1024 * 1024 });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.download.sizeBytes, fileBytes.byteLength);
  assert.equal(result.download.filePath, "photos/file_1.jpg");
  assert.ok(result.download.buffer.equals(fileBytes));
  assert.equal(calledUrls.length, 2);
});

test("downloadTelegramFile: getFile HTTP failure is handled", async () => {
  global.fetch = (async () => jsonResponse({ ok: false, description: "Bad Request" }, 400)) as typeof fetch;

  const result = await downloadTelegramFile({ fileId: "abc", botToken: BOT_TOKEN, maxBytes: 10 * 1024 * 1024 });

  assert.deepEqual(result, { ok: false, error: { kind: "GET_FILE_FAILED", status: 400 } });
});

test("downloadTelegramFile: missing file_path in a successful getFile response is handled", async () => {
  global.fetch = (async () => jsonResponse({ ok: true, result: {} })) as typeof fetch;

  const result = await downloadTelegramFile({ fileId: "abc", botToken: BOT_TOKEN, maxBytes: 10 * 1024 * 1024 });

  assert.deepEqual(result, { ok: false, error: { kind: "MISSING_FILE_PATH" } });
});

test("downloadTelegramFile: getFile ok:false with a 200 status is treated as missing file_path", async () => {
  global.fetch = (async () => jsonResponse({ ok: false })) as typeof fetch;

  const result = await downloadTelegramFile({ fileId: "abc", botToken: BOT_TOKEN, maxBytes: 10 * 1024 * 1024 });

  assert.deepEqual(result, { ok: false, error: { kind: "MISSING_FILE_PATH" } });
});

test("downloadTelegramFile: rejected before download when getFile reports a size over the limit", async () => {
  let downloadCalled = false;

  global.fetch = (async (url: string | URL) => {
    if (String(url).includes("/getFile")) {
      return jsonResponse({ ok: true, result: { file_path: "photos/big.jpg", file_size: 20 * 1024 * 1024 } });
    }
    downloadCalled = true;
    return new Response(Buffer.alloc(10), { status: 200 });
  }) as typeof fetch;

  const result = await downloadTelegramFile({ fileId: "abc", botToken: BOT_TOKEN, maxBytes: 10 * 1024 * 1024 });

  assert.deepEqual(result, { ok: false, error: { kind: "FILE_TOO_LARGE", sizeBytes: 20 * 1024 * 1024 } });
  assert.equal(downloadCalled, false, "must not download when getFile metadata already exceeds the limit");
});

test("downloadTelegramFile: the file download request failing (non-2xx) is handled", async () => {
  global.fetch = (async (url: string | URL) => {
    if (String(url).includes("/getFile")) {
      return jsonResponse({ ok: true, result: { file_path: "photos/file_1.jpg", file_size: 100 } });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  const result = await downloadTelegramFile({ fileId: "abc", botToken: BOT_TOKEN, maxBytes: 10 * 1024 * 1024 });

  assert.deepEqual(result, { ok: false, error: { kind: "DOWNLOAD_FAILED", status: 404 } });
});

test("downloadTelegramFile: a network error on getFile is handled", async () => {
  global.fetch = (async () => {
    throw new TypeError("fetch failed");
  }) as typeof fetch;

  const result = await downloadTelegramFile({ fileId: "abc", botToken: BOT_TOKEN, maxBytes: 10 * 1024 * 1024 });

  assert.deepEqual(result, { ok: false, error: { kind: "NETWORK_ERROR" } });
});

test("downloadTelegramFile: a network error on the file download itself is handled", async () => {
  global.fetch = (async (url: string | URL) => {
    if (String(url).includes("/getFile")) {
      return jsonResponse({ ok: true, result: { file_path: "photos/file_1.jpg", file_size: 100 } });
    }
    throw new TypeError("fetch failed");
  }) as typeof fetch;

  const result = await downloadTelegramFile({ fileId: "abc", botToken: BOT_TOKEN, maxBytes: 10 * 1024 * 1024 });

  assert.deepEqual(result, { ok: false, error: { kind: "NETWORK_ERROR" } });
});

test("downloadTelegramFile: an actual downloaded body exceeding maxBytes is rejected even though getFile reported no size", async () => {
  const oversizedBytes = Buffer.alloc(11 * 1024 * 1024, 1);

  global.fetch = (async (url: string | URL) => {
    if (String(url).includes("/getFile")) {
      // No file_size in the metadata at all — the only guard left is the
      // post-download byte-length check.
      return jsonResponse({ ok: true, result: { file_path: "photos/big.jpg" } });
    }
    return new Response(oversizedBytes, { status: 200 });
  }) as typeof fetch;

  const result = await downloadTelegramFile({ fileId: "abc", botToken: BOT_TOKEN, maxBytes: 10 * 1024 * 1024 });

  assert.deepEqual(result, { ok: false, error: { kind: "FILE_TOO_LARGE", sizeBytes: oversizedBytes.byteLength } });
});

test("downloadTelegramFile: the bot token never appears in any error result", async () => {
  global.fetch = (async () => jsonResponse({ ok: false }, 401)) as typeof fetch;

  const result = await downloadTelegramFile({ fileId: "abc", botToken: BOT_TOKEN, maxBytes: 10 * 1024 * 1024 });

  assert.equal(JSON.stringify(result).includes(BOT_TOKEN), false);
});

test("downloadTelegramFile: a slow getFile call times out and is reported as TIMEOUT", async () => {
  global.fetch = ((_url: string | URL, init?: RequestInit) => {
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        reject(new DOMException("The operation was aborted.", "AbortError"));
      });
    });
  }) as typeof fetch;

  const result = await downloadTelegramFile({
    fileId: "abc",
    botToken: BOT_TOKEN,
    maxBytes: 10 * 1024 * 1024,
    timeoutMs: 20,
  });

  assert.deepEqual(result, { ok: false, error: { kind: "TIMEOUT" } });
});
