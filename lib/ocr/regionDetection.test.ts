import { test } from "node:test";
import assert from "node:assert/strict";
import { detectBettingRegion } from "./regionDetection";

// Same fetch-indirection technique as lib/ocr/claudeOcrProvider.test.ts and
// lib/ai/betParser.test.ts — the Anthropic SDK client this file's
// module-level singleton builds captures whatever `global.fetch` is bound
// to the *first* time it's actually used, not on every call. Reassigning
// global.fetch per test would silently only take effect for whichever test
// runs first. Instead, global.fetch is replaced exactly once, up front,
// with a stable wrapper delegating to a mutable `currentHandler`. No real
// network request is made anywhere in this file.

const API_KEY = "test-anthropic-key-region-detection";
const originalFetch = global.fetch;
const originalApiKey = process.env.ANTHROPIC_API_KEY;

let currentHandler: (url: string, init?: RequestInit) => Promise<Response> = async () => {
  throw new Error("regionDetection.test.ts: no fetch handler set for this test");
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
    throw new Error("regionDetection.test.ts: no fetch handler set for this test");
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

function anthropicToolUseResponse(input: unknown): Response {
  return new Response(
    JSON.stringify({
      id: "msg_test",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-6",
      content: [{ type: "tool_use", id: "tool_1", name: "locate_betting_region", input }],
      stop_reason: "tool_use",
      usage: { input_tokens: 200, output_tokens: 20 },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function anthropicTextOnlyResponse(): Response {
  return new Response(
    JSON.stringify({
      id: "msg_test",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-6",
      content: [{ type: "text", text: "no tool call" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 5, output_tokens: 5 },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

// Same technique as lib/ai/betParser.test.ts's neverResolvingFetch — the
// SDK's own fetchWithTimeout starts a real setTimeout and aborts its
// internal AbortController when it fires; it doesn't itself reject the
// fetch call, so the stub must throw an AbortError when the signal fires,
// same as a real fetch implementation would.
function neverResolvingFetch(_url: string, init?: RequestInit): Promise<Response> {
  return new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => {
      reject(new DOMException("The operation was aborted.", "AbortError"));
    });
  });
}

function validParams() {
  return { buffer: Buffer.from("fake-detection-copy-bytes"), mimeType: "image/jpeg" as const };
}

// ---------------------------------------------------------------------
// FOUND
// ---------------------------------------------------------------------

test("detectBettingRegion: a well-formed found:true response resolves FOUND with a padded, clamped region", async () => {
  currentHandler = async () =>
    anthropicToolUseResponse({
      found: true,
      confidence: 0.92,
      x: 0.12,
      y: 0.18,
      width: 0.56,
      height: 0.64,
      reason: "Browser window containing Flashscore match and odds",
    });

  const result = await detectBettingRegion(validParams());

  assert.equal(result.kind, "FOUND");
  if (result.kind !== "FOUND") return;
  assert.equal(result.confidence, 0.92);
  // Padding widens the box outward from the raw values.
  assert.ok(result.region.x < 0.12);
  assert.ok(result.region.width > 0.56);
});

// ---------------------------------------------------------------------
// NOT_FOUND
// ---------------------------------------------------------------------

test("detectBettingRegion: found:false resolves NOT_FOUND with the model's reason", async () => {
  currentHandler = async () =>
    anthropicToolUseResponse({
      found: false,
      confidence: 0.1,
      x: 0,
      y: 0,
      width: 0,
      height: 0,
      reason: "No betting content visible",
    });

  const result = await detectBettingRegion(validParams());
  assert.equal(result.kind, "NOT_FOUND");
  if (result.kind !== "NOT_FOUND") return;
  assert.equal(result.reason, "No betting content visible");
});

// ---------------------------------------------------------------------
// INVALID — malformed shape or geometrically degenerate
// ---------------------------------------------------------------------

test("detectBettingRegion: found:true with negative coordinates resolves INVALID, not FOUND", async () => {
  currentHandler = async () =>
    anthropicToolUseResponse({
      found: true,
      confidence: 0.8,
      x: -0.2,
      y: 0.1,
      width: 0.3,
      height: 0.3,
      reason: "bad region",
    });

  const result = await detectBettingRegion(validParams());
  assert.equal(result.kind, "INVALID", "a negative coordinate is rejected outright, not clamped");
});

test("detectBettingRegion: found:true with a box that only slightly overshoots the far edge is still FOUND (clamped, not rejected)", async () => {
  currentHandler = async () =>
    anthropicToolUseResponse({
      found: true,
      confidence: 0.85,
      x: 0.8,
      y: 0.8,
      width: 0.5,
      height: 0.5,
      reason: "overshoots the right/bottom edge",
    });

  const result = await detectBettingRegion(validParams());
  assert.equal(result.kind, "FOUND");
  if (result.kind !== "FOUND") return;
  assert.ok(result.region.x + result.region.width <= 1 + 1e-9);
  assert.ok(result.region.y + result.region.height <= 1 + 1e-9);
});

test("detectBettingRegion: found:true with a degenerate box (extremely small) resolves INVALID", async () => {
  currentHandler = async () =>
    anthropicToolUseResponse({
      found: true,
      confidence: 0.8,
      x: 0.5,
      y: 0.5,
      width: 0.001,
      height: 0.001,
      reason: "tiny region",
    });

  const result = await detectBettingRegion(validParams());
  assert.equal(result.kind, "INVALID");
});

test("detectBettingRegion: a tool response missing required fields resolves INVALID, never throws", async () => {
  currentHandler = async () => anthropicToolUseResponse({ found: true, confidence: 0.9 });

  const result = await detectBettingRegion(validParams());
  assert.equal(result.kind, "INVALID");
});

test("detectBettingRegion: non-finite coordinates (NaN via extra whitespace-parsed JSON) resolve INVALID", async () => {
  // JSON itself can't encode NaN/Infinity, but a model could still return an
  // out-of-schema type Zod must reject — a string where a number is
  // required is the realistic equivalent of "the model didn't return what
  // we asked for".
  currentHandler = async () =>
    anthropicToolUseResponse({
      found: true,
      confidence: 0.9,
      x: "not-a-number",
      y: 0.1,
      width: 0.2,
      height: 0.2,
      reason: "malformed",
    });

  const result = await detectBettingRegion(validParams());
  assert.equal(result.kind, "INVALID");
});

test("detectBettingRegion: no tool_use block in the response resolves ERROR, never throws", async () => {
  currentHandler = async () => anthropicTextOnlyResponse();

  const result = await detectBettingRegion(validParams());
  assert.equal(result.kind, "ERROR");
});

// ---------------------------------------------------------------------
// TIMEOUT
// ---------------------------------------------------------------------

test("detectBettingRegion: a short timeout override against a hanging request resolves TIMEOUT, never hangs the caller", async () => {
  currentHandler = neverResolvingFetch;

  const result = await detectBettingRegion({ ...validParams(), timeoutMs: 20 });
  assert.equal(result.kind, "TIMEOUT");
});

// ---------------------------------------------------------------------
// ERROR — missing API key, transport failure
// ---------------------------------------------------------------------

test("detectBettingRegion: a missing ANTHROPIC_API_KEY resolves ERROR without ever calling fetch", async () => {
  delete process.env.ANTHROPIC_API_KEY;
  let fetchCalled = false;
  currentHandler = async () => {
    fetchCalled = true;
    throw new Error("must not be called");
  };

  const result = await detectBettingRegion(validParams());
  assert.equal(result.kind, "ERROR");
  assert.equal(fetchCalled, false);
});

test("detectBettingRegion: a transport failure resolves ERROR and never leaks the raw error to logs", async () => {
  currentHandler = async () => {
    throw new Error("ECONNRESET: internal transport detail that must never leak");
  };

  const result = await detectBettingRegion(validParams());
  assert.equal(result.kind, "ERROR");

  const loggedText = JSON.stringify(consoleErrorCalls);
  assert.equal(loggedText.includes("internal transport detail"), false);
});

// ---------------------------------------------------------------------
// Never exposes the model's reasoning as anything other than a plain string
// on the result — callers decide whether to log it; this module itself
// never puts it anywhere else (no console.log of `reason` on the success
// path).
// ---------------------------------------------------------------------

test("detectBettingRegion: does not log anything on a successful FOUND result", async () => {
  currentHandler = async () =>
    anthropicToolUseResponse({
      found: true,
      confidence: 0.92,
      x: 0.12,
      y: 0.18,
      width: 0.56,
      height: 0.64,
      reason: "Browser window containing Flashscore match and odds",
    });

  await detectBettingRegion(validParams());
  assert.deepEqual(consoleErrorCalls, []);
});
