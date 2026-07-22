import { test } from "node:test";
import assert from "node:assert/strict";
import { createClaudeOcrProvider } from "./claudeOcrProvider";

// The Anthropic SDK captures whatever `global.fetch` is bound to *once*, the
// first time its internal client actually needs it (Shims.getDefaultFetch(),
// called lazily on first request) — not on every call. Reassigning
// `global.fetch` per test (the pattern used everywhere else in this repo,
// e.g. lib/telegram/downloadTelegramFile.test.ts) would silently only ever
// take effect for whichever test happens to run first, since this
// provider's own Anthropic client is also a lazily-created module-level
// singleton (mirrors lib/ai/betParser.ts's getAnthropicClient()). Instead,
// `global.fetch` is replaced exactly once, up front, with a stable wrapper
// that delegates to a mutable `currentHandler` — each test only ever
// reassigns `currentHandler`, never `global.fetch` itself, which sidesteps
// the SDK's one-time capture without touching production code. No real
// network request is made in this file.

const API_KEY = "test-anthropic-key-abc123";
const originalFetch = global.fetch;
const originalApiKey = process.env.ANTHROPIC_API_KEY;

let currentHandler: (url: string, init?: RequestInit) => Promise<Response> = async () => {
  throw new Error("claudeOcrProvider.test.ts: no fetch handler set for this test");
};

global.fetch = (((url: string | URL, init?: RequestInit) => currentHandler(String(url), init)) as unknown) as typeof fetch;

let consoleErrorCalls: unknown[][] = [];
const originalConsoleError = console.error;

test.beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = API_KEY;
  consoleErrorCalls = [];
  console.error = (...args: unknown[]) => {
    consoleErrorCalls.push(args);
  };
  currentHandler = async () => {
    throw new Error("claudeOcrProvider.test.ts: no fetch handler set for this test");
  };
});

test.afterEach(() => {
  console.error = originalConsoleError;
});

test.after(() => {
  global.fetch = originalFetch;
  if (originalApiKey !== undefined) {
    process.env.ANTHROPIC_API_KEY = originalApiKey;
  } else {
    delete process.env.ANTHROPIC_API_KEY;
  }
});

function anthropicTextResponse(text: string): Response {
  return new Response(
    JSON.stringify({
      id: "msg_test",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-6",
      content: [{ type: "text", text }],
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 5 },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function validInput() {
  return { buffer: Buffer.from("fake-image-bytes"), mimeType: "image/jpeg" as const };
}

test("claudeOcrProvider: a successful Claude response is returned as raw OCR text", async () => {
  currentHandler = async () => anthropicTextResponse("Real Madrid vs Barcelona\nOver 2.5");

  const provider = createClaudeOcrProvider();
  const result = await provider.recognize(validInput());

  assert.equal(result.kind, "SUCCESS");
  if (result.kind !== "SUCCESS") return;
  assert.equal(result.rawText, "Real Madrid vs Barcelona\nOver 2.5");
  assert.equal(result.provider, "claude");
  assert.equal(typeof result.durationMs, "number");
});

test("claudeOcrProvider: the request sent to Claude carries the base64 image and declared mime type", async () => {
  let capturedBody: Record<string, unknown> | null = null;

  currentHandler = async (_url, init) => {
    capturedBody = JSON.parse(String(init?.body));
    return anthropicTextResponse("ok");
  };

  const provider = createClaudeOcrProvider();
  const input = { buffer: Buffer.from("hello-image"), mimeType: "image/png" as const };
  await provider.recognize(input);

  assert.ok(capturedBody);
  const messages = (capturedBody as { messages: Array<{ content: Array<Record<string, unknown>> }> }).messages;
  const imageBlock = messages[0].content.find((block) => block.type === "image") as
    | { source: { media_type: string; data: string } }
    | undefined;

  assert.ok(imageBlock);
  assert.equal(imageBlock.source.media_type, "image/png");
  assert.equal(imageBlock.source.data, Buffer.from("hello-image").toString("base64"));
});

test("claudeOcrProvider: missing ANTHROPIC_API_KEY returns PROVIDER_UNAVAILABLE without any network call", async () => {
  delete process.env.ANTHROPIC_API_KEY;
  let fetchCalled = false;
  currentHandler = async () => {
    fetchCalled = true;
    return anthropicTextResponse("should never be reached");
  };

  const provider = createClaudeOcrProvider();
  const result = await provider.recognize(validInput());

  assert.equal(result.kind, "FAILURE");
  if (result.kind !== "FAILURE") return;
  assert.equal(result.code, "PROVIDER_UNAVAILABLE");
  assert.equal(fetchCalled, false);
});

test("claudeOcrProvider: an API error response is mapped to PROVIDER_ERROR with a safe message", async () => {
  currentHandler = async () =>
    new Response(JSON.stringify({ type: "error", error: { type: "internal_server_error", message: "boom detail" } }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });

  const provider = createClaudeOcrProvider();
  const result = await provider.recognize(validInput());

  assert.equal(result.kind, "FAILURE");
  if (result.kind !== "FAILURE") return;
  assert.equal(result.code, "PROVIDER_ERROR");
  assert.equal(result.safeMessage.includes("boom detail"), false);
});

test("claudeOcrProvider: the API key never appears in console.error output on failure", async () => {
  currentHandler = async () => new Response("server error", { status: 500 });

  const provider = createClaudeOcrProvider();
  await provider.recognize(validInput());

  for (const call of consoleErrorCalls) {
    assert.equal(JSON.stringify(call).includes(API_KEY), false);
  }
});

test("claudeOcrProvider: image bytes never appear in console.error output on failure", async () => {
  currentHandler = async () => new Response("server error", { status: 500 });

  const provider = createClaudeOcrProvider();
  const input = { buffer: Buffer.from("super-secret-pixel-data"), mimeType: "image/jpeg" as const };
  await provider.recognize(input);

  const base64OfImage = input.buffer.toString("base64");
  for (const call of consoleErrorCalls) {
    assert.equal(JSON.stringify(call).includes(base64OfImage), false);
  }
});

test("claudeOcrProvider: a response with no text block still returns SUCCESS with empty rawText (not a thrown error)", async () => {
  currentHandler = async () =>
    new Response(
      JSON.stringify({
        id: "msg_test",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-6",
        content: [],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 0 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );

  const provider = createClaudeOcrProvider();
  const result = await provider.recognize(validInput());

  assert.equal(result.kind, "SUCCESS");
  if (result.kind !== "SUCCESS") return;
  assert.equal(result.rawText, "");
});
