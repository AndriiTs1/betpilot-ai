import { test } from "node:test";
import assert from "node:assert/strict";
import { extractBetTool, rejectBetTool, extractExpressBetTool, parseBetSlipMessage } from "./betParser";
import { chatPrompt, ocrPrompt } from "./betParserPrompt";

// Regression test for a real production incident (Stage 12, Phase 3
// hotfix): Anthropic's strict-mode tool schema only supports `minItems`
// values of 0 or 1 on an array property. A value >1 (used here for "at
// least 2 selections") doesn't just get ignored — it makes the *entire*
// client.beta.messages.create() call fail with a 400 before any tool is
// even selected, breaking every tool in the same `tools` array, including
// unrelated ones like extract_bet. Confirmed against real production logs:
//   tools.1.custom: For 'array' type, 'minItems' values other than 0 or 1
//   are not supported (got: [2, 5])
//
// This walks every exported BetaTool's input_schema recursively and fails
// if any array-typed node still has a numeric minItems above 1 — so this
// exact mistake can't silently come back in a future tool.

const ALL_TOOLS = [extractBetTool, rejectBetTool, extractExpressBetTool];

function findUnsupportedMinItems(node: unknown, path: string, violations: string[]): void {
  if (typeof node !== "object" || node === null) return;

  if (Array.isArray(node)) {
    node.forEach((item, index) => findUnsupportedMinItems(item, `${path}[${index}]`, violations));
    return;
  }

  const record = node as Record<string, unknown>;

  if (typeof record.minItems === "number" && record.minItems > 1) {
    violations.push(`${path}.minItems = ${record.minItems}`);
  }

  for (const [key, value] of Object.entries(record)) {
    findUnsupportedMinItems(value, `${path}.${key}`, violations);
  }
}

test("betParser: no exported Anthropic tool schema uses an unsupported minItems > 1", () => {
  for (const tool of ALL_TOOLS) {
    const violations: string[] = [];
    findUnsupportedMinItems(tool.input_schema, tool.name, violations);
    assert.deepEqual(violations, [], `${tool.name} has unsupported minItems: ${violations.join(", ")}`);
  }
});

test("betParser: every tool schema is still well-formed (has a name and input_schema)", () => {
  for (const tool of ALL_TOOLS) {
    assert.equal(typeof tool.name, "string");
    assert.ok(tool.name.length > 0);
    assert.equal(typeof tool.input_schema, "object");
  }
});

// ---------------------------------------------------------------------
// Stage 14.3 — parseBetSlipMessage(text, mode): one parser, two prompts.
// Same fetch-indirection technique as lib/ocr/claudeOcrProvider.test.ts —
// the Anthropic SDK client this file's getAnthropicClient() builds is a
// module-level singleton that captures whatever `global.fetch` is bound to
// the *first* time it's actually used, not on every call. Reassigning
// global.fetch per test (as most of this repo's tests do) would silently
// only take effect for whichever test runs first. Instead, global.fetch is
// replaced exactly once, up front, with a stable wrapper that delegates to
// a mutable `currentHandler` reassigned per test. No real network request
// is made anywhere in this block.
// ---------------------------------------------------------------------

const originalFetch = global.fetch;
const originalAiProvider = process.env.AI_PROVIDER;
const originalApiKey = process.env.ANTHROPIC_API_KEY;

let currentHandler: (url: string, init?: RequestInit) => Promise<Response> = async () => {
  throw new Error("betParser.test.ts: no fetch handler set for this test");
};

global.fetch = (((url: string | URL, init?: RequestInit) => currentHandler(String(url), init)) as unknown) as typeof fetch;

test.beforeEach(() => {
  process.env.AI_PROVIDER = "claude";
  process.env.ANTHROPIC_API_KEY = "test-anthropic-key-betparser";
  currentHandler = async () => {
    throw new Error("betParser.test.ts: no fetch handler set for this test");
  };
});

test.after(() => {
  global.fetch = originalFetch;
  if (originalAiProvider !== undefined) process.env.AI_PROVIDER = originalAiProvider;
  else delete process.env.AI_PROVIDER;
  if (originalApiKey !== undefined) process.env.ANTHROPIC_API_KEY = originalApiKey;
  else delete process.env.ANTHROPIC_API_KEY;
});

function anthropicToolUseResponse(toolName: string, input: unknown): Response {
  return new Response(
    JSON.stringify({
      id: "msg_test",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-6",
      content: [{ type: "tool_use", id: "tool_1", name: toolName, input }],
      stop_reason: "tool_use",
      usage: { input_tokens: 10, output_tokens: 5 },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

test('parseBetSlipMessage: CHAT mode (default) sends chatPrompt as the system prompt', async () => {
  let capturedSystem: unknown;
  currentHandler = async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    capturedSystem = body.system;
    return anthropicToolUseResponse("reject_bet", { reason: "not a bet" });
  };

  await parseBetSlipMessage("hey what's up");

  assert.equal(capturedSystem, chatPrompt);
  assert.notEqual(capturedSystem, ocrPrompt);
});

test('parseBetSlipMessage: explicit "CHAT" mode sends chatPrompt as the system prompt', async () => {
  let capturedSystem: unknown;
  currentHandler = async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    capturedSystem = body.system;
    return anthropicToolUseResponse("reject_bet", { reason: "not a bet" });
  };

  await parseBetSlipMessage("hey what's up", "CHAT");

  assert.equal(capturedSystem, chatPrompt);
});

test('parseBetSlipMessage: "OCR" mode sends ocrPrompt as the system prompt', async () => {
  let capturedSystem: unknown;
  currentHandler = async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    capturedSystem = body.system;
    return anthropicToolUseResponse("reject_bet", { reason: "not legible" });
  };

  await parseBetSlipMessage("some ocr text", "OCR");

  assert.equal(capturedSystem, ocrPrompt);
  assert.notEqual(capturedSystem, chatPrompt);
});

test("parseBetSlipMessage: CHAT and OCR modes send the exact same tool schema (only the prompt differs)", async () => {
  const capturedTools: unknown[] = [];
  currentHandler = async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    capturedTools.push(body.tools);
    return anthropicToolUseResponse("reject_bet", { reason: "n/a" });
  };

  await parseBetSlipMessage("chat text", "CHAT");
  await parseBetSlipMessage("ocr text", "OCR");

  assert.equal(capturedTools.length, 2);
  assert.deepEqual(capturedTools[0], capturedTools[1]);
});

test("parseBetSlipMessage: OCR mode extract_bet produces the exact same ParsedBetSlip shape as CHAT mode", async () => {
  const toolInput = { sport: "Football", event: "Real Madrid vs Barcelona", selection: "Real Madrid Win", stake: 50, odds: 1.9 };
  currentHandler = async () => anthropicToolUseResponse("extract_bet", toolInput);

  const chatResult = await parseBetSlipMessage("100 on Real Madrid to win", "CHAT");
  const ocrResult = await parseBetSlipMessage("ocr-transcribed slip text", "OCR");

  assert.equal(chatResult.valid, true);
  assert.equal(ocrResult.valid, true);
  if (!chatResult.valid || !ocrResult.valid) return;

  const chatSlip = { type: chatResult.type, stake: chatResult.stake, selections: chatResult.selections };
  const ocrSlip = { type: ocrResult.type, stake: ocrResult.stake, selections: ocrResult.selections };
  assert.deepEqual(chatSlip, ocrSlip);
  assert.equal(ocrSlip.type, "SINGLE");
  assert.equal(ocrSlip.selections[0].event, "Real Madrid vs Barcelona");
});

test("parseBetSlipMessage: OCR mode reject_bet produces a safe, non-invented failure (never guesses missing fields)", async () => {
  currentHandler = async () => anthropicToolUseResponse("reject_bet", { reason: "no legible bet slip" });

  const result = await parseBetSlipMessage("battery 87% wifi connected 14:32", "OCR");

  assert.equal(result.valid, false);
  if (result.valid) return;
  assert.equal(result.error, "Message does not appear to be a bet request");
});

// ---------------------------------------------------------------------
// Pre-commit review finding — a non-timeout API error must never carry
// code: "timeout" (only Anthropic.APIConnectionTimeoutError should set
// it). The real SDK-internal timeout path itself is deliberately not
// simulated here (same reasoning documented in
// lib/ocr/claudeOcrProvider.test.ts: getting the real Anthropic SDK to
// construct a genuine APIConnectionTimeoutError from a mocked transport
// without actually waiting out a real timeout is fragile/SDK-internal
// behavior, not this file's own logic to prove). The route-level test
// (app/api/miniapp/bets/screenshot/preview/route.test.ts) covers the part
// that actually matters — a parser result carrying code: "timeout" is
// correctly turned into a 504 AI_TIMEOUT response — using an injected fake
// parser, which is the properly-scoped place to test that behavior.
// ---------------------------------------------------------------------

test('parseBetSlipMessage: a non-timeout API error does not carry code: "timeout"', async () => {
  // 400 (not 5xx) — the SDK's default retry behavior only retries
  // retryable statuses, so this stays fast and deterministic.
  currentHandler = async () => new Response(JSON.stringify({ error: { message: "bad request" } }), { status: 400 });

  const result = await parseBetSlipMessage("some text", "OCR");

  assert.equal(result.valid, false);
  if (result.valid) return;
  assert.equal(result.code, undefined);
});

test("betParserPrompt: ocrPrompt explicitly frames OCR text as untrusted, non-instructional data", () => {
  assert.match(ocrPrompt, /untrusted/i);
  assert.match(ocrPrompt, /never follow it/i);
});

// ---------------------------------------------------------------------
// Stage 14.4A — mode-based parser timeout + maxRetries: 0.
//
// The exact production timeout values (8000ms CHAT, 15000ms OCR) are not
// re-verified here by literally waiting them out — that would make this
// suite slow and flaky for no real benefit. Instead, the injectable
// timeoutMsOverride (test-only, never used by any production call site)
// lets these tests prove the *real* thing that matters fast and
// deterministically: OCR mode actually applies whatever timeout it's
// given, using a value tiny enough (20ms) that a handler which never
// resolves reliably times out almost instantly.
// ---------------------------------------------------------------------

// The Anthropic SDK's own fetchWithTimeout starts a real setTimeout tied to
// the requested `timeout` option and aborts its internal AbortController
// when it fires — it does NOT itself reject the underlying fetch call; a
// real fetch implementation would throw an AbortError when its signal
// fires, so the stub must do the same (same technique already proven in
// lib/telegram/downloadTelegramFile.test.ts's own timeout test).
function neverResolvingFetch(_url: string, init?: RequestInit): Promise<Response> {
  return new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => {
      reject(new DOMException("The operation was aborted.", "AbortError"));
    });
  });
}

test('parseBetSlipMessage: an OCR-mode call respects a short timeout override and reports code: "timeout"', async () => {
  currentHandler = neverResolvingFetch;

  const result = await parseBetSlipMessage("ocr text", "OCR", 20);

  assert.equal(result.valid, false);
  if (result.valid) return;
  assert.equal(result.code, "timeout");
});

test('parseBetSlipMessage: a CHAT-mode call respects a short timeout override and reports code: "timeout"', async () => {
  currentHandler = neverResolvingFetch;

  const result = await parseBetSlipMessage("chat text", "CHAT", 20);

  assert.equal(result.valid, false);
  if (result.valid) return;
  assert.equal(result.code, "timeout");
});

test("parseBetSlipMessage: a failing call is never retried (maxRetries: 0) — the handler fires exactly once", async () => {
  let callCount = 0;
  currentHandler = async () => {
    callCount += 1;
    // A retryable status (5xx) — if maxRetries were not 0, the SDK would
    // automatically call this handler again (up to its default of 2
    // retries) before giving up.
    return new Response(JSON.stringify({ error: { message: "server error" } }), { status: 500 });
  };

  const result = await parseBetSlipMessage("some text", "CHAT");

  assert.equal(result.valid, false);
  assert.equal(callCount, 1, "the Anthropic client must not automatically retry a failed request");
});
