import { test } from "node:test";
import assert from "node:assert/strict";
import { extractBetTool, rejectBetTool, extractExpressBetTool, parseBetSlipMessage, parseBetMessage, MAX_DECIMAL_ODDS } from "./betParser";
import { chatPrompt, ocrPrompt } from "./betParserPrompt";
import { SCREENSHOT_QA1_DIAGNOSTIC_MARKER } from "@/lib/logging/screenshotQa1Diagnostic";
import { extractMarketIntentEvidence } from "./marketIntentEvidence";

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

// ---------------------------------------------------------------------
// Stage AI-1 — temperature: 0.1 on the production parser's outbound
// request, identical for CHAT and OCR mode (same call site, same schema).
// Also pins every other request field this stage must leave untouched, so
// a future change to one of them fails loudly here rather than silently.
// ---------------------------------------------------------------------

test("parseBetSlipMessage: CHAT mode sends temperature: 0.1 and leaves model/max_tokens/tool_choice/messages unchanged", async () => {
  let capturedBody: Record<string, unknown> | null = null;
  currentHandler = async (_url, init) => {
    capturedBody = JSON.parse(String(init?.body));
    return anthropicToolUseResponse("reject_bet", { reason: "n/a" });
  };

  await parseBetSlipMessage("100 on Real Madrid to win", "CHAT");

  assert.ok(capturedBody);
  const body = capturedBody as Record<string, unknown>;
  assert.equal(body.temperature, 0.1);
  assert.equal(body.model, "claude-sonnet-4-6");
  assert.equal(body.max_tokens, 1024);
  assert.equal(body.system, chatPrompt);
  assert.deepEqual(body.tool_choice, { type: "any" });
  assert.deepEqual(body.messages, [{ role: "user", content: "100 on Real Madrid to win" }]);
  assert.equal("top_p" in body, false);
  assert.equal("top_k" in body, false);
});

test("parseBetSlipMessage: OCR mode also sends temperature: 0.1 (identical to CHAT mode) and leaves model/max_tokens/tool_choice/messages unchanged", async () => {
  let capturedBody: Record<string, unknown> | null = null;
  currentHandler = async (_url, init) => {
    capturedBody = JSON.parse(String(init?.body));
    return anthropicToolUseResponse("reject_bet", { reason: "n/a" });
  };

  await parseBetSlipMessage("ocr-transcribed slip text", "OCR");

  assert.ok(capturedBody);
  const body = capturedBody as Record<string, unknown>;
  assert.equal(body.temperature, 0.1);
  assert.equal(body.model, "claude-sonnet-4-6");
  assert.equal(body.max_tokens, 1024);
  assert.equal(body.system, ocrPrompt);
  assert.deepEqual(body.tool_choice, { type: "any" });
  assert.deepEqual(body.messages, [{ role: "user", content: "ocr-transcribed slip text" }]);
  assert.equal("top_p" in body, false);
  assert.equal("top_k" in body, false);
});

test("parseBetSlipMessage: CHAT and OCR modes send byte-identical temperature (parity)", async () => {
  const capturedTemperatures: unknown[] = [];
  currentHandler = async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    capturedTemperatures.push(body.temperature);
    return anthropicToolUseResponse("reject_bet", { reason: "n/a" });
  };

  await parseBetSlipMessage("chat text", "CHAT");
  await parseBetSlipMessage("ocr text", "OCR");

  assert.equal(capturedTemperatures.length, 2);
  assert.equal(capturedTemperatures[0], 0.1);
  assert.equal(capturedTemperatures[1], 0.1);
  assert.equal(capturedTemperatures[0], capturedTemperatures[1]);
});

test("parseBetSlipMessage: OCR mode extract_bet produces the exact same ParsedBetSlip shape as CHAT mode", async () => {
  const toolInput = {
    sport: "Football",
    league: null,
    event: "Real Madrid vs Barcelona",
    market: null,
    selection: "Real Madrid Win",
    period: null,
    line: null,
    stake: 50,
    odds: 1.9,
  };
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
// Step 8B — Section 14: CHAT mode previously had no explicit untrusted-
// data framing (unlike OCR). Confirms the same protection now exists.
// ---------------------------------------------------------------------

test("betParserPrompt: chatPrompt explicitly frames the player's message as untrusted, non-instructional data", () => {
  assert.match(chatPrompt, /untrusted/i);
  assert.match(chatPrompt, /never follow it/i);
});

test("betParserPrompt: chatPrompt instructs the model not to invent league, market, period, or line", () => {
  assert.match(chatPrompt, /never derive it from a team name/i);
  assert.match(chatPrompt, /pass it as null/i);
});

// Players are never required to state odds in a text bet — the odds
// provider always supplies and verifies the real price. A missing odds
// value must never be treated as a reason to reject the message.
test("betParserPrompt: chatPrompt explicitly states odds are never required from the player", () => {
  assert.match(chatPrompt, /never required to state odds/i);
  assert.match(chatPrompt, /never a reason to reject the message/i);
});

test("betParserPrompt: chatPrompt still tells the model to pass along real odds if the player did mention them", () => {
  assert.match(chatPrompt, /if odds are mentioned, pass them exactly as stated/i);
  assert.match(chatPrompt, /never invent, guess, or infer/i);
});

test("betParserPrompt: ocrPrompt retains its existing balance/payout/combined-odds safeguards", () => {
  assert.match(ocrPrompt, /account balance/i);
  assert.match(ocrPrompt, /potential payout/i);
  assert.match(ocrPrompt, /combined\/total odds/i);
});

test("betParserPrompt: ocrPrompt instructs line to be kept exactly as printed", () => {
  assert.match(ocrPrompt, /exact line as printed/i);
});

// ---------------------------------------------------------------------
// Step 8B — Section 16, Test Layer A: tool schema now carries required-
// but-nullable league/market/period/line keys, without loosening any
// existing required field.
// ---------------------------------------------------------------------

test("betParser: extract_bet requires the four new fields, alongside every pre-existing required field, as nullable", () => {
  const schema = extractBetTool.input_schema as unknown as {
    required: string[];
    properties: Record<string, { type: string | string[] }>;
    additionalProperties: boolean;
  };

  assert.deepEqual(
    [...schema.required].sort(),
    ["event", "league", "line", "market", "odds", "period", "selection", "sport", "stake"].sort(),
  );
  assert.equal(schema.additionalProperties, false);
  for (const field of ["league", "market", "period", "line"]) {
    assert.deepEqual(schema.properties[field].type, ["string", "null"]);
  }
  // Existing required fields keep their original (non-nullable) type.
  assert.equal(schema.properties.sport.type, "string");
  assert.equal(schema.properties.event.type, "string");
  assert.equal(schema.properties.selection.type, "string");
});

test("betParser: extract_express_bet's per-leg schema mirrors extract_bet's new fields, minus stake", () => {
  const schema = extractExpressBetTool.input_schema as unknown as {
    properties: { selections: { items: { required: string[]; properties: Record<string, unknown>; additionalProperties: boolean } } };
  };
  const legSchema = schema.properties.selections.items;

  assert.deepEqual(
    [...legSchema.required].sort(),
    ["event", "league", "line", "market", "odds", "period", "selection", "sport"].sort(),
  );
  assert.equal(legSchema.additionalProperties, false);
  assert.ok(!("stake" in legSchema.properties), "stake belongs at the slip level, not per-leg");
});

// ---------------------------------------------------------------------
// Step 8B — Section 16, Test Layer D: public parser parity. The existing
// SINGLE/EXPRESS fixture shapes (with the four new keys entirely absent,
// exactly as they were before this step) must keep producing identical
// output, and the richer schema must not expand what's required for a
// valid bet.
// ---------------------------------------------------------------------

test("parseBetSlipMessage: extract_bet with league/market/period/line supplied populates market, but nothing else leaks into ParsedBetSlip", async () => {
  const toolInput = {
    sport: "Football",
    league: "Premier League",
    event: "Arsenal vs Chelsea",
    market: "Match Winner",
    selection: "Arsenal",
    period: "First Half",
    line: null,
    stake: 50,
    odds: 1.95,
  };
  currentHandler = async () => anthropicToolUseResponse("extract_bet", toolInput);

  const result = await parseBetSlipMessage("Arsenal to win first half, 50 at 1.95", "CHAT");

  assert.equal(result.valid, true);
  if (!result.valid) return;
  assert.deepEqual(Object.keys(result).sort(), ["selections", "stake", "type", "valid"]);
  // Step 16A — league now also threads through; Betting Markets V1 Phase 2
  // — line now also threads through (period still does not). H3 Production
  // Fix — marketRawText (the AI's raw, unnormalized market text) now also
  // threads through, additively alongside the existing normalized `market`.
  assert.deepEqual(Object.keys(result.selections[0]).sort(), ["event", "league", "line", "market", "marketRawText", "selection", "sport", "submittedOdds"]);
  assert.equal(result.selections[0].market, "Match Winner");
  assert.equal(result.selections[0].marketRawText, "Match Winner");
  assert.equal(result.selections[0].line, null);
  assert.equal(result.selections[0].league, "Premier League");
  assert.equal(result.selections[0].sport, "Football");
  assert.equal(result.selections[0].event, "Arsenal vs Chelsea");
  assert.equal(result.selections[0].selection, "Arsenal");
  assert.equal(result.selections[0].submittedOdds, 1.95);
});

test("parseBetSlipMessage: extract_bet with the four new fields explicitly null behaves exactly like today (market: null)", async () => {
  const toolInput = {
    sport: "Football",
    league: null,
    event: "Real Madrid vs Barcelona",
    market: null,
    selection: "Real Madrid Win",
    period: null,
    line: null,
    stake: 50,
    odds: 1.9,
  };
  currentHandler = async () => anthropicToolUseResponse("extract_bet", toolInput);

  const result = await parseBetSlipMessage("100 on Real Madrid to win", "CHAT");

  assert.equal(result.valid, true);
  if (!result.valid) return;
  assert.deepEqual(result, {
    valid: true,
    type: "SINGLE",
    stake: 50,
    selections: [{ sport: "Football", league: null, event: "Real Madrid vs Barcelona", market: null, marketRawText: null, selection: "Real Madrid Win", submittedOdds: 1.9, line: null }],
  });
});

test("parseBetSlipMessage: extract_express_bet with an unresolved league/market still adapts market to the raw text or null, without rejecting the bet", async () => {
  const toolInput = {
    stake: 30,
    selections: [
      { sport: "Football", league: "EPL", event: "Real Madrid vs Barcelona", market: "match winner", selection: "Real Madrid", period: null, line: null, odds: 1.8 },
      { sport: "Football", league: null, event: "Inter vs Juventus", market: "player prop", selection: "Juventus", period: null, line: null, odds: 2.1 },
    ],
  };
  currentHandler = async () => anthropicToolUseResponse("extract_express_bet", toolInput);

  const result = await parseBetSlipMessage("express text", "CHAT");

  assert.equal(result.valid, true);
  if (!result.valid) return;
  assert.equal(result.type, "EXPRESS");
  assert.equal(result.selections.length, 2);
  // "match winner" resolves via normalizeDraftMarket -> EXTRACTED -> raw display text.
  assert.equal(result.selections[0].market, "match winner");
  // "player prop" is a recognized-but-UNSUPPORTED market -> adapts to null, never rejects the leg.
  assert.equal(result.selections[1].market, null);
});

test("parseBetSlipMessage: a null odds leg still parses successfully with the richer schema (existing behavior unchanged)", async () => {
  const toolInput = {
    sport: "Tennis",
    league: null,
    event: "Alcaraz vs Sinner",
    market: null,
    selection: "Alcaraz",
    period: null,
    line: null,
    stake: 20,
    odds: null,
  };
  currentHandler = async () => anthropicToolUseResponse("extract_bet", toolInput);

  const result = await parseBetSlipMessage("20 on Alcaraz, no odds given", "CHAT");

  assert.equal(result.valid, true);
  if (!result.valid) return;
  assert.equal(result.selections[0].submittedOdds, null);
});

test("parseBetSlipMessage: an out-of-range odds value is still rejected, even with the new fields present and null", async () => {
  const toolInput = {
    sport: "Football",
    league: null,
    event: "A vs B",
    market: null,
    selection: "A",
    period: null,
    line: null,
    stake: 10,
    odds: MAX_DECIMAL_ODDS + 1,
  };
  currentHandler = async () => anthropicToolUseResponse("extract_bet", toolInput);

  const result = await parseBetSlipMessage("bad odds", "CHAT");

  assert.equal(result.valid, false);
});

test("parseBetSlipMessage: an express slip with fewer than two legs is still rejected (min 2 unchanged)", async () => {
  const toolInput = {
    stake: 10,
    selections: [{ sport: "Football", league: null, event: "A vs B", market: null, selection: "A", period: null, line: null, odds: 1.5 }],
  };
  currentHandler = async () => anthropicToolUseResponse("extract_express_bet", toolInput);

  const result = await parseBetSlipMessage("one leg only", "CHAT");

  assert.equal(result.valid, false);
});

// ---------------------------------------------------------------------
// Post-review correction — the Claude tool boundary must be STRICT:
// league/market/period/line are required-but-nullable (z.string().nullable()
// semantics), not nullish. A real Claude tool_use.input under strict:true
// always includes every declared key, so a payload that OMITS one of these
// keys is malformed and must be rejected here, never silently accepted.
// ---------------------------------------------------------------------

const COMPLETE_SINGLE_TOOL_INPUT = {
  sport: "Football",
  league: "Premier League",
  event: "Arsenal vs Chelsea",
  market: "Match Winner",
  selection: "Arsenal",
  period: "Full Game",
  line: "2.5",
  stake: 50,
  odds: 1.95,
} as const;

const NEW_FIELD_NAMES = ["league", "market", "period", "line"] as const;

for (const field of NEW_FIELD_NAMES) {
  test(`parseBetSlipMessage: extract_bet with "${field}" omitted entirely is rejected (strict Claude contract)`, async () => {
    const toolInput: Record<string, unknown> = { ...COMPLETE_SINGLE_TOOL_INPUT };
    delete toolInput[field];
    currentHandler = async () => anthropicToolUseResponse("extract_bet", toolInput);

    const result = await parseBetSlipMessage("some bet text", "CHAT");

    assert.equal(result.valid, false);
  });
}

const COMPLETE_EXPRESS_LEG = {
  sport: "Football",
  league: "Premier League",
  event: "Arsenal vs Chelsea",
  market: "Match Winner",
  selection: "Arsenal",
  period: "Full Game",
  line: "2.5",
  odds: 1.95,
} as const;

for (const field of NEW_FIELD_NAMES) {
  test(`parseBetSlipMessage: extract_express_bet with a leg missing "${field}" is rejected (strict Claude contract)`, async () => {
    const leg: Record<string, unknown> = { ...COMPLETE_EXPRESS_LEG };
    delete leg[field];
    const toolInput = {
      stake: 30,
      selections: [leg, { ...COMPLETE_EXPRESS_LEG, event: "Inter vs Juventus", selection: "Juventus" }],
    };
    currentHandler = async () => anthropicToolUseResponse("extract_express_bet", toolInput);

    const result = await parseBetSlipMessage("express text", "CHAT");

    assert.equal(result.valid, false);
  });
}

test("parseBetSlipMessage: extract_bet with all four new fields as explicit strings is accepted", async () => {
  currentHandler = async () => anthropicToolUseResponse("extract_bet", COMPLETE_SINGLE_TOOL_INPUT);

  // Stage BA-2D, Step 5 — deliberately no "over 2.5" wording here (even
  // though the mocked AI response's own `line` field is "2.5"): this
  // originalText is otherwise unrelated to what the AI is mocked to
  // return (this test's whole point is verifying the four OPTIONAL
  // AI-schema fields thread through regardless of originalText), but
  // "over 2.5" happens to ALSO be real, independent TOTALS evidence next
  // to "to win"'s MONEYLINE evidence — two distinct strong market signals
  // in one message is genuinely AMBIGUOUS per BA-2D's own deterministic
  // reading of the text, and the new market-intent guard correctly
  // rejects that, unrelated to this test's actual purpose.
  const result = await parseBetSlipMessage("Arsenal to win, full game, 50 at 1.95", "CHAT");

  assert.equal(result.valid, true);
  if (!result.valid) return;
  assert.equal(result.selections[0].market, "Match Winner");
});

test("parseBetSlipMessage: extract_bet with all four new fields as explicit null is accepted", async () => {
  const toolInput = { ...COMPLETE_SINGLE_TOOL_INPUT, league: null, market: null, period: null, line: null };
  currentHandler = async () => anthropicToolUseResponse("extract_bet", toolInput);

  const result = await parseBetSlipMessage("Arsenal to win, 50 at 1.95", "CHAT");

  assert.equal(result.valid, true);
  if (!result.valid) return;
  assert.equal(result.selections[0].market, null);
});

// ---------------------------------------------------------------------
// Post-review correction — legacy/Ollama compatibility boundary. Ollama's
// own JSON response (per OLLAMA_SYSTEM_PROMPT) never includes league/
// market/period/line at all; parseWithOllama must enrich the parsed result
// with explicit nulls for those four keys before it satisfies the same
// strict ParsedBet contract every other producer does, WITHOUT rejecting
// an otherwise-valid Ollama bet.
// ---------------------------------------------------------------------

function ollamaChatResponse(content: unknown): Response {
  return new Response(JSON.stringify({ message: { content: JSON.stringify(content) } }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

test("parseBetMessage (Ollama path): a raw Ollama JSON payload without league/market/period/line is enriched with nulls into a valid ParsedBet", async () => {
  process.env.AI_PROVIDER = "ollama";
  currentHandler = async () =>
    ollamaChatResponse({
      valid: true,
      sport: "Football",
      event: "Real Madrid vs Barcelona",
      selection: "Real Madrid Win",
      stake: 50,
      odds: 1.9,
    });

  const result = await parseBetMessage("100 on Real Madrid to win", "player-1");

  assert.equal(result.valid, true);
  if (!result.valid) return;
  assert.equal(result.league, null);
  assert.equal(result.market, null);
  assert.equal(result.period, null);
  assert.equal(result.line, null);
  assert.equal(result.sport, "Football");
  assert.equal(result.event, "Real Madrid vs Barcelona");
  assert.equal(result.selection, "Real Madrid Win");
  assert.equal(result.stake, 50);
  assert.equal(result.odds, 1.9);
});

test("parseBetSlipMessage (Ollama fallback): the enriched Ollama payload still produces today's exact ParsedBetSlip shape (market: null)", async () => {
  process.env.AI_PROVIDER = "ollama";
  currentHandler = async () =>
    ollamaChatResponse({
      valid: true,
      sport: "Football",
      event: "Real Madrid vs Barcelona",
      selection: "Real Madrid Win",
      stake: 50,
      odds: 1.9,
    });

  const result = await parseBetSlipMessage("100 on Real Madrid to win");

  assert.equal(result.valid, true);
  if (!result.valid) return;
  assert.deepEqual(result, {
    valid: true,
    type: "SINGLE",
    stake: 50,
    selections: [{ sport: "Football", event: "Real Madrid vs Barcelona", market: null, selection: "Real Madrid Win", submittedOdds: 1.9 }],
  });
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

/* ============================================================================
 * Stage BA-2B, Step 4 — safe numeric enforcement.
 *
 * All simulate a real Claude tool_use response via the existing
 * anthropicToolUseResponse()/currentHandler fetch-interception convention
 * (see this file's own header), so `text` (the ORIGINAL player message) and
 * `toolInput` (what the AI CLAIMED) can be independently controlled — this
 * is what lets a test simulate "correct AI output" vs. "bad AI output"
 * against the exact same real message.
 * ============================================================================ */

function singleToolInput(overrides: Partial<{
  sport: string; league: string | null; event: string; market: string | null;
  selection: string; period: string | null; line: string | null; stake: number; odds: number | null;
}> = {}) {
  return {
    sport: "Football",
    league: null,
    event: "Arsenal",
    market: null,
    selection: "Win",
    period: null,
    line: null,
    stake: 10,
    odds: null,
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/* 1-4. STAKE — critical regression                                          */
/* -------------------------------------------------------------------------- */

test("BA-2B Step 4 (1): correct explicit stake — 'Арсенал ТБ 2.5, ставка 10' (stake=10, line=2.5) passes, STAKE and LINE both CORROBORATED", async () => {
  currentHandler = async () => anthropicToolUseResponse("extract_bet", singleToolInput({ market: "Totals", selection: "Over", line: "2.5", stake: 10 }));

  const result = await parseBetSlipMessage("Арсенал ТБ 2.5, ставка 10", "CHAT");

  assert.equal(result.valid, true);
  if (!result.valid) return;
  assert.equal(result.stake, 10);
  assert.equal(result.selections[0].line, "2.5");
});

test("BA-2B Step 4 (2): CRITICAL — bad AI output (stake=2.5 against explicit 'ставка 10') is rejected, never silently corrected to 10", async () => {
  currentHandler = async () => anthropicToolUseResponse("extract_bet", singleToolInput({ market: "Totals", selection: "Over", line: "2.5", stake: 2.5 }));

  const result = await parseBetSlipMessage("Арсенал ТБ 2.5, ставка 10", "CHAT");

  assert.equal(result.valid, false);
  if (result.valid) return;
  assert.equal(result.code, "numeric_mismatch");
  // The invalid branch of ParseBetSlipResult structurally has no stake/
  // line/selections field at all — there is nowhere for a "corrected"
  // value to even exist.
  assert.deepEqual(Object.keys(result).sort(), ["code", "error", "valid"]);
});

test("BA-2B Step 4 (3): AMBIGUOUS stake — 'ставка 10, ставка 20' is rejected, never guesses between the two conflicting values", async () => {
  currentHandler = async () => anthropicToolUseResponse("extract_bet", singleToolInput({ stake: 10 }));

  const result = await parseBetSlipMessage("Арсенал победа, ставка 10, ставка 20", "CHAT");

  assert.equal(result.valid, false);
  if (result.valid) return;
  assert.equal(result.code, "numeric_mismatch");
});

test("BA-2B Step 4 (4): UNVERIFIED stake — 'Арсенал победа 10' (SOLE_CANDIDATE only, no explicit marker) still passes — player convenience preserved", async () => {
  currentHandler = async () => anthropicToolUseResponse("extract_bet", singleToolInput({ stake: 10 }));

  const result = await parseBetSlipMessage("Арсенал победа 10", "CHAT");

  assert.equal(result.valid, true);
});

/* -------------------------------------------------------------------------- */
/* 5-6. LINE                                                                  */
/* -------------------------------------------------------------------------- */

test("BA-2B Step 4 (5): correct line passes (covered structurally by test 1 above — repeated here for numbering clarity)", async () => {
  currentHandler = async () => anthropicToolUseResponse("extract_bet", singleToolInput({ market: "Totals", selection: "Under", line: "3", stake: 20 }));

  const result = await parseBetSlipMessage("Арсенал ТМ 3 ставка 20", "CHAT");

  assert.equal(result.valid, true);
});

test("BA-2B Step 4 (6): contradicted line — claimed line=10 against 'ТБ 2.5, ставка 10' is rejected", async () => {
  currentHandler = async () => anthropicToolUseResponse("extract_bet", singleToolInput({ market: "Totals", selection: "Over", line: "10", stake: 10 }));

  const result = await parseBetSlipMessage("Арсенал ТБ 2.5, ставка 10", "CHAT");

  assert.equal(result.valid, false);
  if (result.valid) return;
  assert.equal(result.code, "numeric_mismatch");
});

/* -------------------------------------------------------------------------- */
/* 7-8. Equal values / decimal comma                                         */
/* -------------------------------------------------------------------------- */

test("BA-2B Step 4 (7): equal stake/line — 'Арсенал ТБ 10, ставка 10' passes, no equality heuristic rejects it", async () => {
  currentHandler = async () => anthropicToolUseResponse("extract_bet", singleToolInput({ market: "Totals", selection: "Over", line: "10", stake: 10 }));

  const result = await parseBetSlipMessage("Арсенал ТБ 10, ставка 10", "CHAT");

  assert.equal(result.valid, true);
});

test("BA-2B Step 4 (8): decimal comma — 'Арсенал ТБ 2,5 ставка 2,5' passes", async () => {
  currentHandler = async () => anthropicToolUseResponse("extract_bet", singleToolInput({ market: "Totals", selection: "Over", line: "2,5", stake: 2.5 }));

  const result = await parseBetSlipMessage("Арсенал ТБ 2,5 ставка 2,5", "CHAT");

  assert.equal(result.valid, true);
});

/* -------------------------------------------------------------------------- */
/* 9-10. Submitted ODDS (never confused with live provider odds)             */
/* -------------------------------------------------------------------------- */

test("BA-2B Step 4 (9): correct explicit submitted odds — 'коэффициент 1.90' passes", async () => {
  currentHandler = async () => anthropicToolUseResponse("extract_bet", singleToolInput({ odds: 1.9 }));

  const result = await parseBetSlipMessage("Арсенал победа коэффициент 1.90 ставка 10", "CHAT");

  assert.equal(result.valid, true);
});

test("BA-2B Step 4 (10): contradicted submitted odds — claimed 2.10 against 'коэффициент 1.90' is rejected (this is about the player's OWN stated odds, never a live provider price)", async () => {
  currentHandler = async () => anthropicToolUseResponse("extract_bet", singleToolInput({ odds: 2.1 }));

  const result = await parseBetSlipMessage("Арсенал победа коэффициент 1.90 ставка 10", "CHAT");

  assert.equal(result.valid, false);
  if (result.valid) return;
  assert.equal(result.code, "numeric_mismatch");
});

/* -------------------------------------------------------------------------- */
/* 11-12. CHAT / OCR parity                                                   */
/* -------------------------------------------------------------------------- */

test("BA-2B Step 4 (11): CHAT mode enforcement (explicit, all tests above already use CHAT)", async () => {
  currentHandler = async () => anthropicToolUseResponse("extract_bet", singleToolInput({ market: "Totals", selection: "Over", line: "2.5", stake: 2.5 }));

  const result = await parseBetSlipMessage("Арсенал ТБ 2.5, ставка 10", "CHAT");

  assert.equal(result.valid, false);
});

test("BA-2B Step 4 (12): OCR mode enforces the exact same numeric safety check as CHAT — same rejection for the same contradicted claim, no screenshot-specific logic", async () => {
  currentHandler = async () => anthropicToolUseResponse("extract_bet", singleToolInput({ market: "Totals", selection: "Over", line: "2.5", stake: 2.5 }));

  const result = await parseBetSlipMessage("Арсенал ТБ 2.5, ставка 10", "OCR");

  assert.equal(result.valid, false);
  if (result.valid) return;
  assert.equal(result.code, "numeric_mismatch");
});

/* -------------------------------------------------------------------------- */
/* 13-15. EXPRESS — global stake enforced, per-leg LINE/ODDS explicitly NOT   */
/* -------------------------------------------------------------------------- */

test("BA-2B Step 4 (13): EXPRESS global stake CONTRADICTED — claimed 10 against 'экспресс 20' is rejected", async () => {
  currentHandler = async () =>
    anthropicToolUseResponse("extract_express_bet", {
      stake: 10,
      selections: [
        { sport: "Football", league: null, event: "Arsenal", market: "Totals", selection: "Over", period: null, line: "2.5", odds: null },
        { sport: "Football", league: null, event: "Real Madrid", market: null, selection: "Win", period: null, line: null, odds: null },
      ],
    });

  const result = await parseBetSlipMessage("Арсенал ТБ 2.5 + Реал победа, экспресс 20", "CHAT");

  assert.equal(result.valid, false);
  if (result.valid) return;
  assert.equal(result.code, "numeric_mismatch");
});

test("BA-2B Step 4 (14): EXPRESS global stake CORROBORATED — claimed 20, matches 'экспресс 20', passes", async () => {
  currentHandler = async () =>
    anthropicToolUseResponse("extract_express_bet", {
      stake: 20,
      selections: [
        { sport: "Football", league: null, event: "Arsenal", market: "Totals", selection: "Over", period: null, line: "2.5", odds: null },
        { sport: "Football", league: null, event: "Real Madrid", market: null, selection: "Win", period: null, line: null, odds: null },
      ],
    });

  const result = await parseBetSlipMessage("Арсенал ТБ 2.5 + Реал победа, экспресс 20", "CHAT");

  assert.equal(result.valid, true);
});

test("BA-2B Step 4 (15): EXPRESS per-leg LINE is explicitly NOT hard-enforced yet — a wildly wrong per-leg line ('999', appearing nowhere in the message) still passes as long as the global stake corroborates", async () => {
  currentHandler = async () =>
    anthropicToolUseResponse("extract_express_bet", {
      stake: 20,
      selections: [
        { sport: "Football", league: null, event: "Arsenal", market: "Totals", selection: "Over", period: null, line: "999", odds: null },
        { sport: "Football", league: null, event: "Real Madrid", market: "Totals", selection: "Under", period: null, line: "3.5", odds: null },
      ],
    });

  const result = await parseBetSlipMessage("Арсенал ТБ 2.5 + Реал ТМ 3.5, экспресс 20", "CHAT");

  assert.equal(result.valid, true, "EXPRESS per-leg LINE enforcement is deliberately out of scope for BA-2B Step 4 — do not enable this without building real leg attribution first");
});

/* -------------------------------------------------------------------------- */
/* 16. No numeric auto-correction, structurally proven                        */
/* -------------------------------------------------------------------------- */

test("BA-2B Step 4 (16): no numeric auto-correction — a rejected result never contains a 'corrected' stake/line/odds anywhere in its shape", async () => {
  currentHandler = async () => anthropicToolUseResponse("extract_bet", singleToolInput({ market: "Totals", selection: "Over", line: "2.5", stake: 2.5 }));

  const result = await parseBetSlipMessage("Арсенал ТБ 2.5, ставка 10", "CHAT");

  assert.equal(result.valid, false);
  assert.deepEqual(Object.keys(result).sort(), ["code", "error", "valid"]);
});

/* -------------------------------------------------------------------------- */
/* 18. Existing valid flows unaffected — full regression list                 */
/* -------------------------------------------------------------------------- */

test("BA-2B Step 4 (18a): 'Победа Арсенала, ставка 10' still passes (AI's own event/selection translation is untouched; only STAKE is checked here since no line/odds were claimed)", async () => {
  currentHandler = async () => anthropicToolUseResponse("extract_bet", singleToolInput({ event: "Arsenal", selection: "Win", stake: 10 }));

  const result = await parseBetSlipMessage("Победа Арсенала, ставка 10", "CHAT");

  assert.equal(result.valid, true);
});

test("BA-2B Step 4 (18b): 'Арсенал X 10' (bare DRAW token, no explicit stake marker) still passes as UNVERIFIED, not rejected", async () => {
  currentHandler = async () => anthropicToolUseResponse("extract_bet", singleToolInput({ selection: "X", stake: 10 }));

  const result = await parseBetSlipMessage("Арсенал X 10", "CHAT");

  assert.equal(result.valid, true);
});

test("BA-2B Step 4 (18c): English winner phrasing — 'Real Madrid to win, stake 10' still passes", async () => {
  currentHandler = async () => anthropicToolUseResponse("extract_bet", singleToolInput({ event: "Real Madrid", selection: "Real Madrid to win", stake: 10 }));

  const result = await parseBetSlipMessage("Real Madrid to win, stake 10", "CHAT");

  assert.equal(result.valid, true);
});

test("BA-2B Step 4 (18d): a valid OCR-mode parse (mirroring test 1's scenario) still passes", async () => {
  currentHandler = async () => anthropicToolUseResponse("extract_bet", singleToolInput({ market: "Totals", selection: "Over", line: "2.5", stake: 10 }));

  const result = await parseBetSlipMessage("Арсенал ТБ 2.5, ставка 10", "OCR");

  assert.equal(result.valid, true);
});

/* ============================================================================
 * Stage BA-2D, Step 5 — market-intent enforcement (semantic safety).
 *
 * Same discipline as BA-2B Step 4 above: CORROBORATED/UNVERIFIED continue,
 * CONTRADICTED/AMBIGUOUS reject with code "market_mismatch", the AI's own
 * claim is NEVER read again or corrected — only whether to proceed at all
 * is decided. singleToolInput()'s defaults (event: "Arsenal", selection:
 * "Win") already resolve to MONEYLINE_2WAY/PARTICIPANT, so they double as
 * the "AI dropped the real market shape" fixture for every CONTRADICTED
 * case below, exactly mirroring how BA-2B Step 4's own fixtures reused the
 * same default shape for its bad-claim cases.
 * ============================================================================ */

/* -------------------------------------------------------------------------- */
/* 1-2. CRITICAL: 'Арсенал Ф1(-1.5) ставка 10'                               */
/* -------------------------------------------------------------------------- */

test("BA-2D Step 5 (1): CRITICAL — AI drops the spread shape (default 'Win'/'Arsenal') against 'Арсенал Ф1(-1.5) ставка 10' -> rejected, market_mismatch, never reaches odds verification", async () => {
  currentHandler = async () => anthropicToolUseResponse("extract_bet", singleToolInput({ stake: 10 }));

  const result = await parseBetSlipMessage("Арсенал Ф1(-1.5) ставка 10", "CHAT");

  assert.equal(result.valid, false);
  if (result.valid) return;
  assert.equal(result.code, "market_mismatch");
  assert.deepEqual(Object.keys(result).sort(), ["code", "error", "valid"], "no corrected market/selection value exists anywhere in the rejected shape");
});

test("BA-2D Step 5 (2): correct SPREAD AI output ('Ф1(-1.5)') against the same original text -> CORROBORATED, parsing continues", async () => {
  currentHandler = async () => anthropicToolUseResponse("extract_bet", singleToolInput({ selection: "Ф1(-1.5)", stake: 10 }));

  const result = await parseBetSlipMessage("Арсенал Ф1(-1.5) ставка 10", "CHAT");

  assert.equal(result.valid, true);
  // BA-2D never adds SPREAD provider support and never duplicates the
  // capability gate — whether TheOddsApiProvider later rejects this as
  // MARKET_NOT_SUPPORTED is a completely separate, already-existing layer
  // this parser-level result says nothing about.
});

/* -------------------------------------------------------------------------- */
/* 3. Latin production shape                                                  */
/* -------------------------------------------------------------------------- */

test("BA-2D Step 5 (3): Latin shape — 'Arsenal F1(-1.5) stake 10', AI claims MONEYLINE -> rejected, market_mismatch", async () => {
  currentHandler = async () => anthropicToolUseResponse("extract_bet", singleToolInput({ event: "Arsenal", stake: 10 }));

  const result = await parseBetSlipMessage("Arsenal F1(-1.5) stake 10", "CHAT");

  assert.equal(result.valid, false);
  if (result.valid) return;
  assert.equal(result.code, "market_mismatch");
});

test("BA-2D Step 5 (3b): Latin shape — correct AI output ('F1(-1.5)') -> CORROBORATED, parsing continues", async () => {
  currentHandler = async () => anthropicToolUseResponse("extract_bet", singleToolInput({ selection: "F1(-1.5)", stake: 10 }));

  const result = await parseBetSlipMessage("Arsenal F1(-1.5) stake 10", "CHAT");

  assert.equal(result.valid, true);
});

/* -------------------------------------------------------------------------- */
/* 4-7. TOTALS                                                                */
/* -------------------------------------------------------------------------- */

test("BA-2D Step 5 (4): AI drops the totals shape (default 'Win'/'Arsenal') against 'Арсенал ТБ 2.5 ставка 10' -> rejected, market_mismatch", async () => {
  currentHandler = async () => anthropicToolUseResponse("extract_bet", singleToolInput({ stake: 10 }));

  const result = await parseBetSlipMessage("Арсенал ТБ 2.5 ставка 10", "CHAT");

  assert.equal(result.valid, false);
  if (result.valid) return;
  assert.equal(result.code, "market_mismatch");
});

test("BA-2D Step 5 (5): correct TOTALS OVER AI output -> CORROBORATED, parsing continues", async () => {
  currentHandler = async () => anthropicToolUseResponse("extract_bet", singleToolInput({ market: "Totals", selection: "Over", line: "2.5", stake: 10 }));

  const result = await parseBetSlipMessage("Арсенал ТБ 2.5 ставка 10", "CHAT");

  assert.equal(result.valid, true);
});

test("BA-2D Step 5 (6): direction conflict — original says UNDER ('ТМ 3'), AI claims OVER -> rejected, market_mismatch (never silently flipped)", async () => {
  currentHandler = async () => anthropicToolUseResponse("extract_bet", singleToolInput({ market: "Totals", selection: "Over", line: "3", stake: 20 }));

  const result = await parseBetSlipMessage("Арсенал ТМ 3 ставка 20", "CHAT");

  assert.equal(result.valid, false);
  if (result.valid) return;
  assert.equal(result.code, "market_mismatch");
});

test("BA-2D Step 5 (7): correct UNDER AI output against 'ТМ 3' -> CORROBORATED, parsing continues", async () => {
  currentHandler = async () => anthropicToolUseResponse("extract_bet", singleToolInput({ market: "Totals", selection: "Under", line: "3", stake: 20 }));

  const result = await parseBetSlipMessage("Арсенал ТМ 3 ставка 20", "CHAT");

  assert.equal(result.valid, true);
});

/* -------------------------------------------------------------------------- */
/* 8-12. DRAW / 1X2 — RU / UA / EN, and correct winner phrasing              */
/* -------------------------------------------------------------------------- */

test("BA-2D Step 5 (8): RU — AI claims a participant winner (default 'Win'/'Arsenal') against 'ничья ставка 10' -> rejected, market_mismatch", async () => {
  currentHandler = async () => anthropicToolUseResponse("extract_bet", singleToolInput({ stake: 10 }));

  const result = await parseBetSlipMessage("ничья ставка 10", "CHAT");

  assert.equal(result.valid, false);
  if (result.valid) return;
  assert.equal(result.code, "market_mismatch");
});

test("BA-2D Step 5 (9): UA — AI claims a participant winner against 'нічия ставка 10' -> rejected, market_mismatch", async () => {
  currentHandler = async () => anthropicToolUseResponse("extract_bet", singleToolInput({ stake: 10 }));

  const result = await parseBetSlipMessage("нічия ставка 10", "CHAT");

  assert.equal(result.valid, false);
  if (result.valid) return;
  assert.equal(result.code, "market_mismatch");
});

test("BA-2D Step 5 (10): EN — AI claims a participant winner against 'draw stake 10' -> rejected, market_mismatch", async () => {
  currentHandler = async () => anthropicToolUseResponse("extract_bet", singleToolInput({ stake: 10 }));

  const result = await parseBetSlipMessage("draw stake 10", "CHAT");

  assert.equal(result.valid, false);
  if (result.valid) return;
  assert.equal(result.code, "market_mismatch");
});

test("BA-2D Step 5 (11): correct DRAW claims pass for RU/UA/EN", async () => {
  currentHandler = async () => anthropicToolUseResponse("extract_bet", singleToolInput({ selection: "ничья", stake: 10 }));
  assert.equal((await parseBetSlipMessage("ничья ставка 10", "CHAT")).valid, true);

  currentHandler = async () => anthropicToolUseResponse("extract_bet", singleToolInput({ selection: "нічия", stake: 10 }));
  assert.equal((await parseBetSlipMessage("нічия ставка 10", "CHAT")).valid, true);

  currentHandler = async () => anthropicToolUseResponse("extract_bet", singleToolInput({ selection: "draw", stake: 10 }));
  assert.equal((await parseBetSlipMessage("draw stake 10", "CHAT")).valid, true);
});

test("BA-2D Step 5 (12): correct winner phrasing (RU 'победа' / EN 'win') passes", async () => {
  currentHandler = async () => anthropicToolUseResponse("extract_bet", singleToolInput({ event: "Arsenal", selection: "Win", stake: 10 }));
  assert.equal((await parseBetSlipMessage("Арсенал победа ставка 10", "CHAT")).valid, true);
  assert.equal((await parseBetSlipMessage("Arsenal win stake 10", "CHAT")).valid, true);
});

/* -------------------------------------------------------------------------- */
/* 13. UNVERIFIED convenience                                                 */
/* -------------------------------------------------------------------------- */

test("BA-2D Step 5 (13): natural inputs with no strong deterministic market evidence are never blocked — UNVERIFIED always continues", async () => {
  currentHandler = async () => anthropicToolUseResponse("extract_bet", singleToolInput({ stake: 10 }));
  assert.equal((await parseBetSlipMessage("Арсенал 10", "CHAT")).valid, true);
  assert.equal((await parseBetSlipMessage("ставка 10 на Арсенал", "CHAT")).valid, true);
});

/* -------------------------------------------------------------------------- */
/* 14. AMBIGUOUS source                                                       */
/* -------------------------------------------------------------------------- */

test("BA-2D Step 5 (14): 'Арсенал ТБ 2.5 ТМ 3.5 ставка 10' carries two distinct strong signals -> rejected, never guesses one (code is numeric_mismatch here, since BA-2B's own LINE-role ambiguity check for 2.5 vs 3.5 fires first by enforcement order — see test 14b for a market-only isolation of the same AMBIGUOUS policy)", async () => {
  currentHandler = async () => anthropicToolUseResponse("extract_bet", singleToolInput({ market: "Totals", selection: "Over", line: "2.5", stake: 10 }));

  const result = await parseBetSlipMessage("Арсенал ТБ 2.5 ТМ 3.5 ставка 10", "CHAT");

  assert.equal(result.valid, false, "either guard alone is sufficient — this input is genuinely ambiguous for BOTH LINE value and market direction, and must never be silently resolved to one");
});

test("BA-2D Step 5 (14b): 'ничья Арсенал победа ставка 10' carries two distinct strong market signals with NO competing numeric ambiguity -> rejected, market_mismatch specifically", async () => {
  currentHandler = async () => anthropicToolUseResponse("extract_bet", singleToolInput({ event: "Arsenal", selection: "Win", stake: 10 }));

  const result = await parseBetSlipMessage("ничья Арсенал победа ставка 10", "CHAT");

  assert.equal(result.valid, false);
  if (result.valid) return;
  assert.equal(result.code, "market_mismatch", "STAKE=10 corroborates cleanly (numeric guard passes), isolating this rejection to the market guard's own AMBIGUOUS policy (DRAW vs MONEYLINE, never guessed)");
});

/* -------------------------------------------------------------------------- */
/* 15-16. Independence from BA-2B — either guard alone is sufficient to fail  */
/* -------------------------------------------------------------------------- */

test("BA-2D Step 5 (15): numeric CORROBORATED (stake=10 matches) but market CONTRADICTED (dropped spread shape) -> still rejected, code is market_mismatch specifically", async () => {
  currentHandler = async () => anthropicToolUseResponse("extract_bet", singleToolInput({ stake: 10 }));

  const result = await parseBetSlipMessage("Арсенал Ф1(-1.5) ставка 10", "CHAT");

  assert.equal(result.valid, false);
  if (result.valid) return;
  assert.equal(result.code, "market_mismatch", "numeric passed, so the rejection must be attributed to the market guard, not the numeric one");
});

test("BA-2D Step 5 (16): market CORROBORATED (correct SPREAD) but numeric CONTRADICTED (wrong stake) -> still rejected, code is numeric_mismatch specifically", async () => {
  currentHandler = async () => anthropicToolUseResponse("extract_bet", singleToolInput({ selection: "Ф1(-1.5)", stake: 999 }));

  const result = await parseBetSlipMessage("Арсенал Ф1(-1.5) ставка 10", "CHAT");

  assert.equal(result.valid, false);
  if (result.valid) return;
  assert.equal(result.code, "numeric_mismatch", "market corroborated, so the rejection must be attributed to the numeric guard, not the market one — neither guard substitutes for the other");
});

/* -------------------------------------------------------------------------- */
/* 17-18. CHAT / OCR parity                                                   */
/* -------------------------------------------------------------------------- */

test("BA-2D Step 5 (17): CHAT mode enforcement (explicit, all tests above already use CHAT)", async () => {
  currentHandler = async () => anthropicToolUseResponse("extract_bet", singleToolInput({ stake: 10 }));

  const result = await parseBetSlipMessage("Арсенал Ф1(-1.5) ставка 10", "CHAT");

  assert.equal(result.valid, false);
  if (result.valid) return;
  assert.equal(result.code, "market_mismatch");
});

test("BA-2D Step 5 (18): OCR mode enforces the exact same market safety check as CHAT — same rejection for the same contradicted claim, no screenshot-specific logic", async () => {
  currentHandler = async () => anthropicToolUseResponse("extract_bet", singleToolInput({ stake: 10 }));

  const result = await parseBetSlipMessage("Арсенал Ф1(-1.5) ставка 10", "OCR");

  assert.equal(result.valid, false);
  if (result.valid) return;
  assert.equal(result.code, "market_mismatch");
});

/* -------------------------------------------------------------------------- */
/* 19. EXPRESS unaffected                                                     */
/* -------------------------------------------------------------------------- */

test("BA-2D Step 5 (19): EXPRESS market-intent enforcement stays OFF — a leg whose text would obviously contradict its own event still passes, while BA-2B's own EXPRESS global-stake enforcement remains fully active", async () => {
  currentHandler = async () =>
    anthropicToolUseResponse("extract_express_bet", {
      stake: 20,
      selections: [
        // Deliberately a MONEYLINE-shaped claim against a message whose
        // text contains a real SPREAD signal for the same leg — BA-2D
        // Step 4's own observation computation already returns zero
        // observations for EXPRESS (no leg attribution), so this must
        // never be rejected as market_mismatch, unlike the SINGLE case.
        { sport: "Football", league: null, event: "Arsenal", market: null, selection: "Win", period: null, line: null, odds: null },
        { sport: "Football", league: null, event: "Real Madrid", market: null, selection: "Win", period: null, line: null, odds: null },
      ],
    });

  const result = await parseBetSlipMessage("Арсенал Ф1(-1.5) + Реал победа, экспресс 20", "CHAT");

  assert.equal(result.valid, true, "EXPRESS market-intent enforcement is deliberately out of scope for BA-2D Step 5 — no leg attribution exists yet");
});

test("BA-2D Step 5 (19b): EXPRESS global stake CONTRADICTED still rejects — BA-2B's own EXPRESS enforcement is completely unaffected by BA-2D", async () => {
  currentHandler = async () =>
    anthropicToolUseResponse("extract_express_bet", {
      stake: 10, // contradicts "экспресс 20"
      selections: [
        { sport: "Football", league: null, event: "Arsenal", market: null, selection: "Win", period: null, line: null, odds: null },
        { sport: "Football", league: null, event: "Real Madrid", market: null, selection: "Win", period: null, line: null, odds: null },
      ],
    });

  const result = await parseBetSlipMessage("Арсенал победа + Реал победа, экспресс 20", "CHAT");

  assert.equal(result.valid, false);
  if (result.valid) return;
  assert.equal(result.code, "numeric_mismatch");
});

/* -------------------------------------------------------------------------- */
/* 20. No auto-correction                                                     */
/* -------------------------------------------------------------------------- */

test("BA-2D Step 5 (20): no market auto-correction — a rejected result never contains a 'corrected' market/selection anywhere in its shape", async () => {
  currentHandler = async () => anthropicToolUseResponse("extract_bet", singleToolInput({ stake: 10 }));

  const result = await parseBetSlipMessage("Арсенал ТБ 2.5 ставка 10", "CHAT");

  assert.equal(result.valid, false);
  assert.deepEqual(Object.keys(result).sort(), ["code", "error", "valid"]);
});

/* -------------------------------------------------------------------------- */
/* Full existing regression list — every case from the audit's own matrix    */
/* -------------------------------------------------------------------------- */

test("BA-2D Step 5: full existing-valid-flow regression list stays green", async () => {
  const cases: Array<{ text: string; input: ReturnType<typeof singleToolInput> }> = [
    { text: "Победа Арсенала, ставка 10", input: singleToolInput({ event: "Arsenal", selection: "Win", stake: 10 }) },
    { text: "Арсенал победа ставка 25", input: singleToolInput({ event: "Arsenal", selection: "Win", stake: 25 }) },
    { text: "Арсенал ТБ 2.5 ставка 10", input: singleToolInput({ market: "Totals", selection: "Over", line: "2.5", stake: 10 }) },
    { text: "Арсенал ТМ 3 ставка 20", input: singleToolInput({ market: "Totals", selection: "Under", line: "3", stake: 20 }) },
    { text: "Арсенал X 10", input: singleToolInput({ selection: "X", stake: 10 }) },
    { text: "ничья", input: singleToolInput({ selection: "ничья", stake: 10 }) },
    { text: "нічия", input: singleToolInput({ selection: "нічия", stake: 10 }) },
    { text: "Real Madrid to win, stake 10", input: singleToolInput({ event: "Real Madrid", selection: "Real Madrid to win", stake: 10 }) },
    { text: "Arsenal over 2.5, stake 10", input: singleToolInput({ market: "Totals", selection: "Over", line: "2.5", stake: 10 }) },
    { text: "Arsenal under 3, stake 20", input: singleToolInput({ market: "Totals", selection: "Under", line: "3", stake: 20 }) },
    { text: "draw, stake 10", input: singleToolInput({ selection: "draw", stake: 10 }) },
    // BA-2C punctuation forms.
    { text: "Арсенал ТБ:2.5 ставка 10", input: singleToolInput({ market: "Totals", selection: "Over", line: "2.5", stake: 10 }) },
    { text: "Арсенал ТБ(2.5) ставка 10", input: singleToolInput({ market: "Totals", selection: "Over", line: "2.5", stake: 10 }) },
    { text: "Арсенал F1(-1.5) ставка 10", input: singleToolInput({ selection: "F1(-1.5)", stake: 10 }) },
    // Decimal-dot forms (never comma — known follow-up, not fixed here).
    { text: "Арсенал ТБ 2.5 ставка 10.5", input: singleToolInput({ market: "Totals", selection: "Over", line: "2.5", stake: 10.5 }) },
  ];

  for (const { text, input } of cases) {
    currentHandler = async () => anthropicToolUseResponse("extract_bet", input);
    const result = await parseBetSlipMessage(text, "CHAT");
    assert.equal(result.valid, true, `expected "${text}" to still pass`);
  }
});

/* -------------------------------------------------------------------------- */
/* SCREENSHOT QA-1.3 — full OCR->parser end-to-end reproduction              */
/* -------------------------------------------------------------------------- */
//
// Only the Claude tool_use call itself is mocked (currentHandler, as every
// other test in this file already does) — parseBetSlipMessage(), the real
// buildParsedBetSlipResult(), and the real numeric-role safety net
// (lib/ai/numericRoleEvidence.ts + numericRoleVerifier.ts, this stage's own
// fix) all run unmodified. This is the exact same OCR text reconstruction
// used in numericRoleVerifier.test.ts's own QA-1.3 exact-reproduction test —
// see that file's header comment on why it's a reconstruction, not the
// literal captured transcript (never logged, by design).
const BAYERN_STUTTGART_OCR_TEXT = [
  "Германия - Бундеслига",
  "Бавария - Штутгарт",
  "28.08.2026 20:30",
  "Исход (1X2)",
  "П1 - Бавария",
  "1.42",
  "",
  "Сумма ставки",
  "100",
  "USD",
  "10 25 50 100 250",
  "",
  "Возможный выигрыш",
  "142.00 USD",
  "Сделать ставку 100.00 USD",
].join("\n");

test("QA-1.3: the real Bayern/Stuttgart OCR text no longer fails BA-2B's numeric-role safety net — the deterministic layer, not just OCR/Claude, was the actual defect", async () => {
  // selection: "П1" (not "Bayern Munich") is deliberate — it's the exact
  // Home Win shorthand literally visible in the source text ("П1 -
  // Бавария"), a legitimate "Bayern/Home Win equivalent" extraction. This
  // sidesteps a SEPARATE, independent safety gate (BA-2D's market-intent
  // verifier, lib/ai/marketIntentVerifier.ts) that is NOT part of QA-1.2's
  // proven root cause (numeric_mismatch/role=STAKE) and is explicitly out
  // of this stage's scope — confirmed by testing: a translated
  // "Bayern Munich" selection claim independently trips market-intent
  // CONTRADICTED (MONEYLINE_2WAY claim vs. the text's own MONEYLINE_3WAY
  // "П1" evidence) regardless of this stage's fix, a real but different
  // defect worth flagging for a future, separate stage — see this stage's
  // final report.
  currentHandler = async () =>
    anthropicToolUseResponse(
      "extract_bet",
      singleToolInput({
        sport: "Football",
        event: "Bayern Munich vs VfB Stuttgart",
        market: "1X2",
        selection: "П1",
        stake: 100,
        odds: 1.42,
      }),
    );

  const result = await parseBetSlipMessage(BAYERN_STUTTGART_OCR_TEXT, "OCR");

  assert.equal(result.valid, true, result.valid ? "" : `expected a valid parse, got: ${result.error} (code: ${result.code})`);
  if (!result.valid) return;

  assert.equal(result.type, "SINGLE");
  assert.equal(result.selections.length, 1);
  assert.equal(result.selections[0].sport, "Football");
  assert.equal(result.selections[0].event, "Bayern Munich vs VfB Stuttgart");
  assert.equal(result.selections[0].selection, "П1");
  assert.equal(result.selections[0].submittedOdds, 1.42);
  assert.equal(result.stake, 100);
});

/* -------------------------------------------------------------------------- */
/* SCREENSHOT QA-1.6 — early-gate 1X2/participant reconciliation deferral    */
/* -------------------------------------------------------------------------- */

test("QA-1.6 positive: claim = MONEYLINE_2WAY/PARTICIPANT ('Bayern Munich') vs evidence = MONEYLINE_3WAY/HOME ('П1') is DEFERRED, not rejected — valid:true with pendingMarketReconciliation attached", async () => {
  currentHandler = async () =>
    anthropicToolUseResponse(
      "extract_bet",
      singleToolInput({
        sport: "Football",
        event: "Bayern Munich vs VfB Stuttgart",
        market: "1X2",
        selection: "Bayern Munich",
        stake: 100,
        odds: 1.42,
      }),
    );

  const result = await parseBetSlipMessage(BAYERN_STUTTGART_OCR_TEXT, "OCR");

  assert.equal(result.valid, true, result.valid ? "" : `expected deferred-valid, got: ${result.error} (code: ${result.code})`);
  if (!result.valid) return;

  assert.deepEqual(result.selections[0].pendingMarketReconciliation, {
    requiredSide: "HOME",
    claimedParticipant: "Bayern Munich",
    conflictingParticipantName: null,
  });
});

test("QA-1.6 positive: claim = PARTICIPANT ('VfB Stuttgart') vs evidence = MONEYLINE_3WAY/AWAY ('П2') is DEFERRED with requiredSide AWAY", async () => {
  const text = ["Германия - Бундеслига", "Бавария - Штутгарт", "Исход (1X2)", "П2 - Штутгарт", "1.42"].join("\n");
  currentHandler = async () =>
    anthropicToolUseResponse(
      "extract_bet",
      singleToolInput({
        sport: "Football",
        event: "Bayern Munich vs VfB Stuttgart",
        market: "1X2",
        selection: "VfB Stuttgart",
        stake: 100,
        odds: 1.42,
      }),
    );

  const result = await parseBetSlipMessage(text, "OCR");

  assert.equal(result.valid, true, result.valid ? "" : `expected deferred-valid, got: ${result.error} (code: ${result.code})`);
  if (!result.valid) return;

  assert.deepEqual(result.selections[0].pendingMarketReconciliation, {
    requiredSide: "AWAY",
    claimedParticipant: "VfB Stuttgart",
    conflictingParticipantName: null,
  });
});

test("QA-1.6 negative G: DRAW/X evidence vs a PARTICIPANT claim is still rejected immediately (never deferred) — a participant name has no DRAW equivalent", async () => {
  const text = "X\nBayern Munich vs VfB Stuttgart";
  currentHandler = async () =>
    anthropicToolUseResponse(
      "extract_bet",
      singleToolInput({ event: "Bayern Munich vs VfB Stuttgart", selection: "Bayern Munich", stake: 10 }),
    );

  const result = await parseBetSlipMessage(text, "OCR");

  assert.equal(result.valid, false);
  if (result.valid) return;
  assert.equal(result.code, "market_mismatch");
});

test("QA-1.6 negative J: a SPREAD-evidence contradiction (claim=DRAW) is still rejected immediately, unchanged", async () => {
  currentHandler = async () =>
    anthropicToolUseResponse("extract_bet", singleToolInput({ event: "Arsenal vs Chelsea", selection: "Draw", stake: 10 }));

  const result = await parseBetSlipMessage("Арсенал Ф1(-1.5) ставка 10", "CHAT");

  assert.equal(result.valid, false);
  if (result.valid) return;
  assert.equal(result.code, "market_mismatch");
});

test("QA-1.6 negative K: a TOTALS-evidence contradiction (claim=DRAW) is still rejected immediately, unchanged", async () => {
  currentHandler = async () =>
    anthropicToolUseResponse("extract_bet", singleToolInput({ event: "Arsenal vs Chelsea", selection: "Draw", stake: 10 }));

  const result = await parseBetSlipMessage("Арсенал ТБ 2.5 ставка 10", "CHAT");

  assert.equal(result.valid, false);
  if (result.valid) return;
  assert.equal(result.code, "market_mismatch");
});

test("QA-1.6 negative L: a TEAM_TOTAL-evidence contradiction (claim=DRAW) is still rejected immediately, unchanged", async () => {
  currentHandler = async () =>
    anthropicToolUseResponse("extract_bet", singleToolInput({ event: "Arsenal vs Chelsea", selection: "Draw", stake: 10 }));

  const result = await parseBetSlipMessage("Арсенал ИТБ 1.5 ставка 10", "CHAT");

  assert.equal(result.valid, false);
  if (result.valid) return;
  assert.equal(result.code, "market_mismatch");
});

test("QA-1.6 negative (updated by MASTER STAGE M3.1, Phase B): AMBIGUOUS market-intent source text with a DRAW signature is still rejected immediately, never deferred — DRAW has no HOME/AWAY equivalent to defer to, regardless of the Phase B AMBIGUOUS widening", async () => {
  currentHandler = async () =>
    anthropicToolUseResponse(
      "extract_bet",
      singleToolInput({ event: "Arsenal vs Chelsea", selection: "Arsenal", stake: 10 }),
    );

  // "ничья Арсенал победа" carries two distinct MONEYLINE-family signatures
  // in the source text itself (DRAW and PARTICIPANT-winner-suffix) — since
  // MASTER STAGE M3.1 Phase B, AMBIGUOUS itself is no longer an automatic
  // rejection for MONEYLINE_2WAY/PARTICIPANT claims (see
  // classifyReconcilable1X2Mismatch's own updated header), but a DRAW
  // conflicting signature still never qualifies: PendingMarketReconciliation
  // only ever carries requiredSide HOME|AWAY, so this correctly falls
  // through to the unchanged hard rejection below.
  const result = await parseBetSlipMessage("ничья Арсенал победа", "CHAT");

  assert.equal(result.valid, false);
  if (result.valid) return;
  assert.equal(result.code, "market_mismatch");
});

test("QA-1.6 typed-chat regression: 'Arsenal win'/'Bayern Munich win'/'Arsenal -1.5'/'Over 2.5' are all unaffected — no pendingMarketReconciliation, valid as before", async () => {
  const cases: Array<{ text: string; input: ReturnType<typeof singleToolInput> }> = [
    { text: "Arsenal win", input: singleToolInput({ event: "Arsenal", selection: "Arsenal", stake: 10 }) },
    { text: "Bayern Munich win", input: singleToolInput({ event: "Bayern Munich", selection: "Bayern Munich", stake: 10 }) },
    { text: "Arsenal -1.5", input: singleToolInput({ market: "Handicap", selection: "Arsenal -1.5", line: "-1.5", stake: 10 }) },
    { text: "Over 2.5", input: singleToolInput({ market: "Totals", selection: "Over 2.5", line: "2.5", stake: 10 }) },
  ];

  for (const { text, input } of cases) {
    currentHandler = async () => anthropicToolUseResponse("extract_bet", input);
    const result = await parseBetSlipMessage(text, "CHAT");
    assert.equal(result.valid, true, `expected "${text}" to remain valid`);
    if (!result.valid) continue;
    assert.equal(
      result.selections[0].pendingMarketReconciliation ?? null,
      null,
      `"${text}" must never carry a pendingMarketReconciliation`,
    );
  }
});

/* -------------------------------------------------------------------------- */
/* SCREENSHOT QA-CORE S1 — OCR-mode claimedParticipant normalization          */
/* -------------------------------------------------------------------------- */

test("S1: the real production claim 'Bayern Win (П1)' is deferred with a CLEAN claimedParticipant ('Bayern'), not the raw display text", async () => {
  currentHandler = async () =>
    anthropicToolUseResponse(
      "extract_bet",
      singleToolInput({
        sport: "Football",
        event: "Bayern Munich vs VfB Stuttgart",
        market: "1X2",
        selection: "Bayern Win (П1)",
        stake: 100,
        odds: 1.42,
      }),
    );

  const result = await parseBetSlipMessage(BAYERN_STUTTGART_OCR_TEXT, "OCR");

  assert.equal(result.valid, true, result.valid ? "" : `expected deferred-valid, got: ${result.error} (code: ${result.code})`);
  if (!result.valid) return;

  // The DISPLAYED selection text is completely untouched — only the
  // internal claimedParticipant used for provider matching is cleaned.
  assert.equal(result.selections[0].selection, "Bayern Win (П1)");
  assert.deepEqual(result.selections[0].pendingMarketReconciliation, {
    requiredSide: "HOME",
    claimedParticipant: "Bayern",
    conflictingParticipantName: null,
  });
});

test("S1 (task requirement C): an OCR-mode 'RB Leipzig W1' claim resolves HOME cleanly — via the PRE-EXISTING participant-prefix-aware market-intent classifier (H3 Production Fix), which strips the exact event participant name 'RB Leipzig' as a prefix and classifies the remaining 'W1' directly. No pendingMarketReconciliation is needed here at all: the claim itself already corroborates the 'W1' evidence, so this exact shape was never actually broken — confirmed as a regression, not attributed to this stage's new normalizer.", async () => {
  const text = ["Bundesliga", "RB Leipzig - Borussia Mönchengladbach", "1X2", "W1 - RB Leipzig", "1.53"].join("\n");
  currentHandler = async () =>
    anthropicToolUseResponse(
      "extract_bet",
      singleToolInput({
        sport: "Football",
        event: "RB Leipzig vs Borussia Mönchengladbach",
        market: "1X2",
        selection: "RB Leipzig W1",
        stake: 10,
        odds: 1.53,
      }),
    );

  const result = await parseBetSlipMessage(text, "OCR");

  assert.equal(result.valid, true, result.valid ? "" : `expected a valid parse, got: ${result.error} (code: ${result.code})`);
  if (!result.valid) return;

  // The raw display selection is untouched either way.
  assert.equal(result.selections[0].selection, "RB Leipzig W1");
  assert.equal(
    result.selections[0].pendingMarketReconciliation ?? null,
    null,
    "already corroborates directly — no deferral needed for an exact participant-name-prefix + shorthand shape",
  );
});

test("S1 (task requirement D): an OCR-mode 'Borussia Mönchengladbach W2' claim resolves AWAY cleanly the same way — no deferral needed", async () => {
  const text = ["Bundesliga", "RB Leipzig - Borussia Mönchengladbach", "1X2", "W2 - Borussia Mönchengladbach", "6.5"].join("\n");
  currentHandler = async () =>
    anthropicToolUseResponse(
      "extract_bet",
      singleToolInput({
        sport: "Football",
        event: "RB Leipzig vs Borussia Mönchengladbach",
        market: "1X2",
        selection: "Borussia Mönchengladbach W2",
        stake: 10,
        odds: 6.5,
      }),
    );

  const result = await parseBetSlipMessage(text, "OCR");

  assert.equal(result.valid, true, result.valid ? "" : `expected a valid parse, got: ${result.error} (code: ${result.code})`);
  if (!result.valid) return;

  assert.equal(
    result.selections[0].pendingMarketReconciliation ?? null,
    null,
    "already corroborates directly — no deferral needed",
  );
});

test("S1 (task requirement E): an OCR-mode 'RB Leipzig to win' claim IS deferred (winner-suffix breaks the exact-prefix corroboration path) with claimedParticipant cleaned to 'RB Leipzig'", async () => {
  // Deliberately only ONE market-intent signal in the source text ("П1") —
  // unlike the claim text, which independently says "to win". Two SEPARATE
  // signals in the same source text would be genuine AMBIGUOUS evidence
  // (QA-1.6's own proven negative case); this fixture avoids that by
  // construction, exactly like every existing QA-1.6 positive fixture does.
  const text = ["Bundesliga", "RB Leipzig - Borussia Mönchengladbach", "1X2", "П1 - RB Leipzig", "1.53"].join("\n");
  currentHandler = async () =>
    anthropicToolUseResponse(
      "extract_bet",
      singleToolInput({
        sport: "Football",
        event: "RB Leipzig vs Borussia Mönchengladbach",
        market: "1X2",
        selection: "RB Leipzig to win",
        stake: 10,
        odds: 1.53,
      }),
    );

  const result = await parseBetSlipMessage(text, "OCR");

  assert.equal(result.valid, true, result.valid ? "" : `expected deferred-valid, got: ${result.error} (code: ${result.code})`);
  if (!result.valid) return;

  assert.deepEqual(result.selections[0].pendingMarketReconciliation, {
    requiredSide: "HOME",
    claimedParticipant: "RB Leipzig",
    conflictingParticipantName: null,
  });
});

test("S1: CHAT mode never normalizes the claim, even for an identically-polluted string — claimedParticipant stays byte-for-byte the raw claim", async () => {
  currentHandler = async () =>
    anthropicToolUseResponse(
      "extract_bet",
      singleToolInput({ event: "Bayern Munich vs VfB Stuttgart", selection: "Bayern Win (П1)", stake: 10 }),
    );

  // A hand-typed chat message carrying the identical 1X2 evidence shape.
  const result = await parseBetSlipMessage("П1 ставка 10", "CHAT");

  assert.equal(result.valid, true, result.valid ? "" : `expected deferred-valid, got: ${result.error} (code: ${result.code})`);
  if (!result.valid) return;

  assert.deepEqual(result.selections[0].pendingMarketReconciliation, {
    requiredSide: "HOME",
    // Unchanged from the raw claim — CHAT mode must never invoke
    // normalizeOcrParticipantClaim(), proving the mode-gate is real, not
    // just coincidentally producing the same output.
    claimedParticipant: "Bayern Win (П1)",
    conflictingParticipantName: null,
  });
});

/* -------------------------------------------------------------------------- */
/* SCREENSHOT QA-CORE S2 — real Leipzig/Gladbach fixture, full-parser-level   */
/* regression. Reconstructed, representative OCR text (not the literal       */
/* captured transcript), same convention as BAYERN_STUTTGART_OCR_TEXT above. */
/* "Potential payout", not "Possible win" — see the identical fixture's own  */
/* comment in numericRoleVerifier.test.ts for the latent, unrelated          */
/* marketIntentEvidence.ts gap this sidesteps.                               */
/* -------------------------------------------------------------------------- */

const LEIPZIG_GLADBACH_OCR_TEXT = [
  "Germany - Bundesliga",
  "RB Leipzig - Borussia Mönchengladbach",
  "28.08.2026 20:30",
  "1X2",
  "W1 - RB Leipzig",
  "1.53",
  "",
  "Stake",
  "100",
  "USD",
  "10 25 50 100 200",
  "",
  "Potential payout",
  "153.00 USD",
  "Place Bet 100.00 USD",
].join("\n");

test("S2 real Leipzig/Gladbach fixture: the full OCR-mode parse succeeds — SINGLE, correct event/selection/odds/stake, no numeric_mismatch", async () => {
  currentHandler = async () =>
    anthropicToolUseResponse(
      "extract_bet",
      singleToolInput({
        sport: "Football",
        event: "RB Leipzig vs Borussia Mönchengladbach",
        market: "1X2",
        selection: "RB Leipzig Win",
        stake: 100,
        odds: 1.53,
      }),
    );

  const result = await parseBetSlipMessage(LEIPZIG_GLADBACH_OCR_TEXT, "OCR");

  assert.equal(result.valid, true, result.valid ? "" : `expected a valid parse, got: ${result.error} (code: ${result.code})`);
  if (!result.valid) return;

  assert.equal(result.type, "SINGLE");
  assert.equal(result.selections.length, 1);
  assert.equal(result.selections[0].sport, "Football");
  assert.equal(result.selections[0].event, "RB Leipzig vs Borussia Mönchengladbach");
  assert.equal(result.selections[0].selection, "RB Leipzig Win");
  assert.equal(result.selections[0].submittedOdds, 1.53);
  assert.equal(result.stake, 100);
});

/* ============================================================================
 * SCREENSHOT QA-CORE S3 Part A — EXPRESS parity.
 *
 * INVESTIGATION FIRST: computeMarketIntentObservations (betDraftMapper.ts)
 * returns [] for any EXPRESS slip — confirmed by direct inspection, not
 * assumed — so the 1X2-shorthand-vs-participant-name reconciliation
 * deferral S1 fixed for SINGLE (classifyReconcilable1X2Mismatch) NEVER
 * engages for EXPRESS legs at all, before OR after S1/S2. This is not a
 * regression S1/S2 introduced; it is a pre-existing, already-documented
 * limitation (see betDraftMapper.ts's own computeMarketIntentObservations
 * comment: "SINGLE only... an EXPRESS slip's originalText can contain
 * several legs' worth of market-shape tokens with no reliable way to say
 * which belongs to which leg").
 *
 * Extending it safely requires solving LEG ATTRIBUTION of market-intent
 * evidence: extractMarketIntentEvidence() has no per-leg awareness and
 * returns every signal found anywhere in the whole originalText. Naively
 * running each leg's claim against that same undifferentiated evidence set
 * would either (a) falsely flag genuinely correct multi-market EXPRESS
 * slips as AMBIGUOUS (2+ legs almost always produce 2+ distinct market-shape
 * signatures in the source text — one per leg), or worse (b) risk silently
 * reconciling leg A's claim against evidence that actually belongs to leg
 * B's event, a real financial-correctness risk. Per this stage's explicit
 * "do not weaken fail-closed safety" and "STOP a sub-part and report if
 * architectural assumptions are false" instructions, this specific gap is
 * NOT force-fixed here — it needs its own dedicated leg-attribution design,
 * separately reviewed.
 *
 * What IS proven below: EXPRESS parsing itself (MONEYLINE with a CLEAN
 * participant claim, SPREAD, TOTALS, mixed markets, quick-stake UI noise,
 * per-leg odds, one global stake, DRAW, cross-leg role isolation) works
 * correctly end-to-end — i.e. EXPRESS is not broken by S1 or S2 — and the
 * one known gap (a shorthand-polluted EXPRESS leg claim) is pinned down as
 * an explicit, deliberate regression test rather than left as a silent
 * unknown.
 * ============================================================================ */

test("S3 EXPRESS x2 (1X2 + TOTALS): both legs, global stake, and per-leg odds all parse correctly with quick-stake UI noise present", async () => {
  currentHandler = async () =>
    anthropicToolUseResponse("extract_express_bet", {
      stake: 50,
      selections: [
        { sport: "Football", league: null, event: "RB Leipzig vs Borussia Mönchengladbach", market: "1X2", selection: "RB Leipzig", period: null, line: null, odds: 1.53 },
        { sport: "Football", league: null, event: "Arsenal vs Chelsea", market: "Totals", selection: "Over", period: null, line: "2.5", odds: 1.9 },
      ],
    });

  const text = [
    "RB Leipzig - Borussia Mönchengladbach",
    "W1",
    "1.53",
    "Arsenal - Chelsea",
    "TB 2.5",
    "1.90",
    "Stake",
    "50",
    "10 25 50 100 200",
    "Place Bet 50.00 USD",
  ].join("\n");

  const result = await parseBetSlipMessage(text, "OCR");

  assert.equal(result.valid, true, result.valid ? "" : `expected a valid parse, got: ${result.error} (code: ${result.code})`);
  if (!result.valid) return;

  assert.equal(result.type, "EXPRESS");
  assert.equal(result.stake, 50);
  assert.equal(result.selections.length, 2);
  assert.equal(result.selections[0].event, "RB Leipzig vs Borussia Mönchengladbach");
  assert.equal(result.selections[0].selection, "RB Leipzig");
  assert.equal(result.selections[0].submittedOdds, 1.53);
  assert.equal(result.selections[1].event, "Arsenal vs Chelsea");
  assert.equal(result.selections[1].market, "Totals");
  assert.equal(result.selections[1].line, "2.5");
  assert.equal(result.selections[1].submittedOdds, 1.9);
});

test("S3 EXPRESS x3 (MONEYLINE + SPREAD + TOTALS): three legs, mixed markets, all parse correctly", async () => {
  currentHandler = async () =>
    anthropicToolUseResponse("extract_express_bet", {
      stake: 30,
      selections: [
        { sport: "Football", league: null, event: "Bayern Munich vs VfB Stuttgart", market: null, selection: "Bayern Munich", period: null, line: null, odds: 1.42 },
        { sport: "Football", league: null, event: "Arsenal vs Chelsea", market: "Handicap", selection: "Arsenal -1.5", period: null, line: "-1.5", odds: 2.1 },
        { sport: "Football", league: null, event: "Real Madrid vs Barcelona", market: "Totals", selection: "Under", period: null, line: "3.5", odds: 1.85 },
      ],
    });

  const text = [
    "Bayern Munich vs VfB Stuttgart, Bayern Munich win",
    "1.42",
    "Arsenal vs Chelsea, Ф1(-1.5)",
    "2.10",
    "Real Madrid vs Barcelona, ТМ 3.5",
    "1.85",
    "ставка 30",
  ].join("\n");

  const result = await parseBetSlipMessage(text, "OCR");

  assert.equal(result.valid, true, result.valid ? "" : `expected a valid parse, got: ${result.error} (code: ${result.code})`);
  if (!result.valid) return;

  assert.equal(result.type, "EXPRESS");
  assert.equal(result.stake, 30);
  assert.equal(result.selections.length, 3);
  assert.equal(result.selections[0].selection, "Bayern Munich");
  assert.equal(result.selections[1].line, "-1.5");
  assert.equal(result.selections[1].submittedOdds, 2.1);
  assert.equal(result.selections[2].line, "3.5");
  assert.equal(result.selections[2].submittedOdds, 1.85);
});

test("S3 EXPRESS: an explicit DRAW leg parses fine alongside other legs (display text only — canonical DRAW/participant classification is buildBetSlipPreview's concern, unaffected by S1/S2)", async () => {
  currentHandler = async () =>
    anthropicToolUseResponse("extract_express_bet", {
      stake: 15,
      selections: [
        { sport: "Football", league: null, event: "Arsenal vs Chelsea", market: null, selection: "Draw", period: null, line: null, odds: 3.4 },
        { sport: "Football", league: null, event: "Real Madrid vs Barcelona", market: "Totals", selection: "Over", period: null, line: "2.5", odds: 1.9 },
      ],
    });

  const text = "Arsenal - Chelsea\nX\n3.40\nReal Madrid - Barcelona\nТБ 2.5\n1.90\nставка 15";

  const result = await parseBetSlipMessage(text, "OCR");

  assert.equal(result.valid, true, result.valid ? "" : `expected a valid parse, got: ${result.error} (code: ${result.code})`);
  if (!result.valid) return;
  assert.equal(result.selections[0].selection, "Draw");
});

test("S3 EXPRESS + S2 regression: quick-stake UI noise never disrupts a correctly labeled global EXPRESS stake", async () => {
  currentHandler = async () =>
    anthropicToolUseResponse("extract_express_bet", {
      stake: 100,
      selections: [
        { sport: "Football", league: null, event: "Arsenal vs Chelsea", market: "Totals", selection: "Over", period: null, line: "2.5", odds: 1.9 },
        { sport: "Football", league: null, event: "Real Madrid vs Barcelona", market: "Totals", selection: "Under", period: null, line: "3.5", odds: 1.85 },
      ],
    });

  const text = [
    "Arsenal - Chelsea, ТБ 2.5",
    "1.90",
    "Real Madrid - Barcelona, ТМ 3.5",
    "1.85",
    "Stake",
    "100",
    "10 25 50 100 200",
    "Potential payout",
    "285.00 USD",
    "Place Bet 100.00 USD",
  ].join("\n");

  const result = await parseBetSlipMessage(text, "OCR");

  assert.equal(result.valid, true, result.valid ? "" : `expected a valid parse, got: ${result.error} (code: ${result.code})`);
  if (!result.valid) return;
  assert.equal(result.stake, 100);
});

test("S3 EXPRESS: cross-leg numeric role isolation — two different per-leg LINE values never contaminate the single, unambiguous global STAKE claim", async () => {
  currentHandler = async () =>
    anthropicToolUseResponse("extract_express_bet", {
      stake: 20,
      selections: [
        { sport: "Football", league: null, event: "Arsenal", market: "Totals", selection: "Over", period: null, line: "2.5", odds: null },
        { sport: "Football", league: null, event: "Real Madrid", market: null, selection: "Win", period: null, line: null, odds: null },
      ],
    });

  const result = await parseBetSlipMessage("Арсенал ТБ 2.5 + Реал победа, экспресс 20", "CHAT");

  assert.equal(result.valid, true, result.valid ? "" : `expected a valid parse, got: ${result.error} (code: ${result.code})`);
  if (!result.valid) return;
  assert.equal(result.stake, 20);
});

test("S3 EXPRESS known gap (documented, not fixed): a shorthand-polluted 1X2 claim in an EXPRESS leg passes through completely unchecked — neither rejected nor reconciled, same as before S1/S2", async () => {
  currentHandler = async () =>
    anthropicToolUseResponse("extract_express_bet", {
      stake: 20,
      selections: [
        { sport: "Football", league: null, event: "Bayern Munich vs VfB Stuttgart", market: "1X2", selection: "Bayern Win (П1)", period: null, line: null, odds: 1.42 },
        { sport: "Football", league: null, event: "Arsenal vs Chelsea", market: "Totals", selection: "Over", period: null, line: "2.5", odds: 1.9 },
      ],
    });

  const text = "Bayern Munich vs VfB Stuttgart\nП1\n1.42\nArsenal vs Chelsea\nTB 2.5\n1.90\nэкспресс 20";

  const result = await parseBetSlipMessage(text, "OCR");

  assert.equal(result.valid, true, result.valid ? "" : `expected a valid parse, got: ${result.error} (code: ${result.code})`);
  if (!result.valid) return;
  // No market-intent check runs for EXPRESS at all (computeMarketIntentObservations
  // returns [] for type !== "SINGLE") — the polluted display text survives
  // unmodified, and no pendingMarketReconciliation is ever attached. This is
  // the exact, confirmed pre-existing behavior — not a target this stage
  // changes.
  assert.equal(result.selections[0].selection, "Bayern Win (П1)");
  assert.equal(result.selections[0].pendingMarketReconciliation ?? null, null);
});

/* ============================================================================
 * SCREENSHOT QA-4 — numeric_evidence diagnostic. The QA-4 production audit
 * for Case B (rrr2.png) found a numeric_mismatch/CONTRADICTED rejection with
 * no way to see WHICH values actually competed, or whether SCREENSHOT
 * QA-CORE S2's LABEL_STRONG/LABEL_WEAK tiering had engaged. These tests
 * prove the new diagnostic surfaces exactly that, OCR-mode only.
 * ============================================================================ */

function captureConsoleLog(): { loggedCalls: unknown[][]; restore: () => void } {
  const originalConsoleLog = console.log;
  const loggedCalls: unknown[][] = [];
  console.log = (...args: unknown[]) => loggedCalls.push(args);
  return {
    loggedCalls,
    restore: () => {
      console.log = originalConsoleLog;
    },
  };
}

function numericEvidenceDiagnostics(loggedCalls: unknown[][]): Array<Record<string, unknown>> {
  const results: Array<Record<string, unknown>> = [];
  for (const call of loggedCalls) {
    if (call[0] === SCREENSHOT_QA1_DIAGNOSTIC_MARKER && typeof call[1] === "string") {
      const parsed = JSON.parse(call[1]) as Record<string, unknown>;
      if (parsed.stage === "numeric_evidence") results.push(parsed);
    }
  }
  return results;
}

test("QA-4 numeric_evidence diagnostic: OCR-mode CONTRADICTED (LABEL_STRONG present, claim disagrees) logs role/verdict/claimedValue/conflictingEvidence", async () => {
  const { loggedCalls, restore } = captureConsoleLog();
  try {
    currentHandler = async () =>
      anthropicToolUseResponse("extract_bet", singleToolInput({ event: "RB Leipzig vs Borussia Mönchengladbach", selection: "RB Leipzig", stake: 100 }));

    const result = await parseBetSlipMessage("RB Leipzig - Borussia Mönchengladbach\nStake 50\n1.53", "OCR");

    assert.equal(result.valid, false);
    if (result.valid) return;
    assert.equal(result.code, "numeric_mismatch");

    const diagnostics = numericEvidenceDiagnostics(loggedCalls);
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0].role, "STAKE");
    assert.equal(diagnostics[0].verdict, "CONTRADICTED");
    assert.equal(diagnostics[0].claimedValue, "100");
    assert.equal((diagnostics[0].conflictingEvidence as unknown[]).length, 1);
    assert.deepEqual(diagnostics[0].conflictingEvidence, [{ value: "50", confidence: "LABEL_STRONG", marker: "stake" }]);
    assert.deepEqual(diagnostics[0].supportingEvidence, []);
  } finally {
    restore();
  }
});

test("QA-4 numeric_evidence diagnostic: OCR-mode AMBIGUOUS (two conflicting LABEL_STRONG values) logs both competing entries", async () => {
  const { loggedCalls, restore } = captureConsoleLog();
  try {
    currentHandler = async () =>
      anthropicToolUseResponse("extract_bet", singleToolInput({ event: "Arsenal vs Chelsea", selection: "Arsenal", stake: 10 }));

    const result = await parseBetSlipMessage("Арсенал победа, ставка 10, ставка 20", "OCR");

    assert.equal(result.valid, false);
    if (result.valid) return;
    assert.equal(result.code, "numeric_mismatch");

    const diagnostics = numericEvidenceDiagnostics(loggedCalls);
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0].verdict, "AMBIGUOUS");
    assert.equal(diagnostics[0].claimedValue, "10");
    assert.equal((diagnostics[0].supportingEvidence as unknown[]).length, 1);
    assert.equal((diagnostics[0].conflictingEvidence as unknown[]).length, 1);
  } finally {
    restore();
  }
});

test("QA-4 numeric_evidence diagnostic: never fires for CHAT mode, even for the identical rejection", async () => {
  const { loggedCalls, restore } = captureConsoleLog();
  try {
    currentHandler = async () =>
      anthropicToolUseResponse("extract_bet", singleToolInput({ event: "RB Leipzig vs Borussia Mönchengladbach", selection: "RB Leipzig", stake: 100 }));

    const result = await parseBetSlipMessage("RB Leipzig - Borussia Mönchengladbach\nstake 50\n1.53", "CHAT");

    assert.equal(result.valid, false);
    if (result.valid) return;
    assert.equal(result.code, "numeric_mismatch");
    assert.equal(numericEvidenceDiagnostics(loggedCalls).length, 0, "CHAT mode must never log the screenshot-only diagnostic");
  } finally {
    restore();
  }
});

test("QA-4 numeric_evidence diagnostic: never fires when the numeric claim is fine (CORROBORATED/UNVERIFIED) — only an actual rejection needs explaining", async () => {
  const { loggedCalls, restore } = captureConsoleLog();
  try {
    currentHandler = async () =>
      anthropicToolUseResponse("extract_bet", singleToolInput({ event: "Arsenal vs Chelsea", selection: "Arsenal", stake: 10 }));

    const result = await parseBetSlipMessage("Арсенал победа, ставка 10", "OCR");

    assert.equal(result.valid, true);
    assert.equal(numericEvidenceDiagnostics(loggedCalls).length, 0);
  } finally {
    restore();
  }
});

test("QA-4 numeric_evidence diagnostic: never leaks raw OCR text, only closed enum/number/marker fields", async () => {
  const { loggedCalls, restore } = captureConsoleLog();
  try {
    const secretMarker = "SECRET_OCR_LINE_MARKER_9182";
    currentHandler = async () =>
      anthropicToolUseResponse("extract_bet", singleToolInput({ event: "RB Leipzig vs Borussia Mönchengladbach", selection: "RB Leipzig", stake: 100 }));

    await parseBetSlipMessage(`${secretMarker}\nStake 50\n1.53`, "OCR");

    const rawLoggedText = JSON.stringify(loggedCalls);
    assert.equal(rawLoggedText.includes(secretMarker), false);

    const diagnostics = numericEvidenceDiagnostics(loggedCalls);
    assert.equal(diagnostics.length, 1);
    for (const entry of [...(diagnostics[0].supportingEvidence as Record<string, unknown>[]), ...(diagnostics[0].conflictingEvidence as Record<string, unknown>[])]) {
      for (const [key, value] of Object.entries(entry)) {
        assert.ok(
          value === null || typeof value === "string",
          `numeric evidence field "${key}" must be a string or null, got ${typeof value}`,
        );
      }
    }
  } finally {
    restore();
  }
});

/* ============================================================================
 * MASTER STAGE M3, Phase 1 — market_intent_evidence diagnostic. The M2.1
 * production audit found a market_mismatch/AMBIGUOUS rejection with no way
 * to see WHICH (marketType, selectionType) signatures actually competed.
 * These tests prove the new diagnostic surfaces exactly that, OCR-mode only,
 * mirroring the numeric_evidence tests above.
 * ============================================================================ */

function marketIntentEvidenceDiagnostics(loggedCalls: unknown[][]): Array<Record<string, unknown>> {
  const results: Array<Record<string, unknown>> = [];
  for (const call of loggedCalls) {
    if (call[0] === SCREENSHOT_QA1_DIAGNOSTIC_MARKER && typeof call[1] === "string") {
      const parsed = JSON.parse(call[1]) as Record<string, unknown>;
      if (parsed.stage === "market_intent_evidence") results.push(parsed);
    }
  }
  return results;
}

test("M3 market_intent_evidence diagnostic: OCR-mode AMBIGUOUS (DRAW vs MONEYLINE signatures) logs claimed type and both competing entries", async () => {
  const { loggedCalls, restore } = captureConsoleLog();
  try {
    currentHandler = async () => anthropicToolUseResponse("extract_bet", singleToolInput({ event: "Arsenal", selection: "Win", stake: 10 }));

    const result = await parseBetSlipMessage("ничья Арсенал победа ставка 10", "OCR");

    assert.equal(result.valid, false);
    if (result.valid) return;
    assert.equal(result.code, "market_mismatch");

    const diagnostics = marketIntentEvidenceDiagnostics(loggedCalls);
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0].claimedMarketType, "MONEYLINE_2WAY");
    assert.equal(diagnostics[0].claimedSelectionType, "PARTICIPANT");
    assert.equal(diagnostics[0].verdict, "AMBIGUOUS");
    assert.equal((diagnostics[0].supportingEvidence as unknown[]).length, 1);
    assert.equal((diagnostics[0].conflictingEvidence as unknown[]).length, 1);
    const conflicting = (diagnostics[0].conflictingEvidence as Array<Record<string, unknown>>)[0];
    assert.equal(conflicting.marketType, "MONEYLINE_3WAY");
    assert.equal(conflicting.selectionType, "DRAW");
  } finally {
    restore();
  }
});

test("M3 market_intent_evidence diagnostic: OCR-mode CONTRADICTED (dropped SPREAD shape) logs the conflicting SPREAD entry with its line/participant", async () => {
  const { loggedCalls, restore } = captureConsoleLog();
  try {
    currentHandler = async () => anthropicToolUseResponse("extract_bet", singleToolInput({ stake: 10 }));

    const result = await parseBetSlipMessage("Арсенал Ф1(-1.5) ставка 10", "OCR");

    assert.equal(result.valid, false);
    if (result.valid) return;
    assert.equal(result.code, "market_mismatch");

    const diagnostics = marketIntentEvidenceDiagnostics(loggedCalls);
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0].claimedMarketType, "MONEYLINE_2WAY");
    assert.equal(diagnostics[0].claimedSelectionType, "PARTICIPANT");
    assert.equal(diagnostics[0].verdict, "CONTRADICTED");
    assert.deepEqual(diagnostics[0].supportingEvidence, []);
    assert.equal((diagnostics[0].conflictingEvidence as unknown[]).length, 1);
    const conflicting = (diagnostics[0].conflictingEvidence as Array<Record<string, unknown>>)[0];
    assert.equal(conflicting.marketType, "SPREAD");
    assert.equal(conflicting.embeddedLine, "-1.5");
  } finally {
    restore();
  }
});

test("M3 market_intent_evidence diagnostic: never fires for CHAT mode, even for the identical rejection", async () => {
  const { loggedCalls, restore } = captureConsoleLog();
  try {
    currentHandler = async () => anthropicToolUseResponse("extract_bet", singleToolInput({ event: "Arsenal", selection: "Win", stake: 10 }));

    const result = await parseBetSlipMessage("ничья Арсенал победа ставка 10", "CHAT");

    assert.equal(result.valid, false);
    if (result.valid) return;
    assert.equal(result.code, "market_mismatch");
    assert.equal(marketIntentEvidenceDiagnostics(loggedCalls).length, 0);
  } finally {
    restore();
  }
});

test("M3 market_intent_evidence diagnostic: never fires when the market claim is fine (no rejection) — only an actual market_mismatch rejection needs explaining", async () => {
  const { loggedCalls, restore } = captureConsoleLog();
  try {
    currentHandler = async () => anthropicToolUseResponse("extract_bet", singleToolInput({ event: "Arsenal", selection: "Win", stake: 10 }));

    const result = await parseBetSlipMessage("Арсенал победа, ставка 10", "OCR");

    assert.equal(result.valid, true);
    assert.equal(marketIntentEvidenceDiagnostics(loggedCalls).length, 0);
  } finally {
    restore();
  }
});

test("M3 market_intent_evidence diagnostic: never leaks raw OCR text, only closed enum/string fields", async () => {
  const { loggedCalls, restore } = captureConsoleLog();
  try {
    const secretMarker = "SECRET_MARKER_" + Math.random().toString(36).slice(2);
    currentHandler = async () => anthropicToolUseResponse("extract_bet", singleToolInput({ event: "Arsenal", selection: "Win", stake: 10 }));

    await parseBetSlipMessage(`ничья Арсенал победа ставка 10 ${secretMarker}`, "OCR");

    const rawLoggedText = JSON.stringify(loggedCalls);
    assert.equal(rawLoggedText.includes(secretMarker), false);

    const diagnostics = marketIntentEvidenceDiagnostics(loggedCalls);
    assert.equal(diagnostics.length, 1);
    for (const entry of [...(diagnostics[0].supportingEvidence as Record<string, unknown>[]), ...(diagnostics[0].conflictingEvidence as Record<string, unknown>[])]) {
      for (const [key, value] of Object.entries(entry)) {
        assert.ok(
          value === null || typeof value === "string",
          `market intent evidence field "${key}" must be a string or null, got ${typeof value}`,
        );
      }
    }
  } finally {
    restore();
  }
});

/* ============================================================================
 * MASTER STAGE M3 — Phase 1 PROVED the M2.1 hypothesis (before Phase 2's
 * fix, this exact real-derived text — reused from Case D/laliga4.jpg's
 * already-proven numericRoleVerifier.test.ts fixture, not invented — made
 * marketIntentEvidence.ts's unguarded window scan misclassify the "ℹ +10"
 * quick-add control as a spurious SPREAD signature, participantName "ℹ",
 * competing against the genuine MONEYLINE_2WAY/PARTICIPANT selection and
 * producing the real production AMBIGUOUS verdict). Phase 2 then applied
 * the shared control-row detector (./screenshotUiNoise, already proven for
 * numericRoleEvidence.ts by M1.1/M1.3) to this file's own token-consumption
 * boundary. This test now proves the FIX: the same real text no longer
 * produces that false signature at all.
 * ============================================================================ */

test("M3: the real Case D (laliga4) text shape no longer produces a spurious SPREAD signature from the 'ℹ +10' quick-add control", () => {
  const text = ["Barcelona - Real Madrid", "-1.5", "1.90", "ℹ +10", "Ставка", "50"].join("\n");
  const evidence = extractMarketIntentEvidence(text);
  const falseSpreadFromControl = evidence.filter(
    (e) => e.classification.marketType === "SPREAD" && e.classification.participantName !== null && !/[a-zа-яё]{2}/i.test(e.classification.participantName),
  );
  assert.deepEqual(falseSpreadFromControl, [], "the 'ℹ +10' control must never produce a SPREAD signature attributed to the icon itself");
});

test("M3 end-to-end: the real Case D (laliga4) text shape now parses successfully through the full pipeline — a SPREAD claim on 'Real Madrid -1.5' is no longer rejected as market_mismatch", async () => {
  currentHandler = async () =>
    anthropicToolUseResponse(
      "extract_bet",
      singleToolInput({ event: "Barcelona vs Real Madrid", market: "Handicap", selection: "Real Madrid", line: "-1.5", stake: 50, odds: 1.9 }),
    );

  const text = ["Barcelona - Real Madrid", "Real Madrid -1.5", "1.90", "ℹ +10", "Ставка", "50"].join("\n");
  const result = await parseBetSlipMessage(text, "OCR");

  assert.equal(result.valid, true, result.valid ? "" : `unexpected rejection: ${result.code} — ${result.error}`);
});

/* ============================================================================
 * MASTER STAGE M3.1, Phase B — generalized provider-informed deferral for
 * TOTALS/OVER, TOTALS/UNDER, and SPREAD/PARTICIPANT claims (previously only
 * MONEYLINE_2WAY/PARTICIPANT could ever defer, and only when CONTRADICTED).
 * Positive cases below use a genuine CROSS-market-type conflicting signal
 * (never invented noise — a real classifyBettingSelectionText match for a
 * DIFFERENT market entirely, the exact shape a quick-add control row used to
 * produce before MASTER STAGE M3 Phase 2 fixed the root cause). Negative
 * cases prove the SAME-market-type safety boundary isDeferrableLineMarketClaim
 * enforces, and that unsupported/incomplete claims are unaffected.
 * ============================================================================ */

test("M3.1 Phase B positive 1: TOTALS/OVER claim with a genuine cross-market MONEYLINE signal present -> deferred, valid (not rejected)", async () => {
  currentHandler = async () =>
    anthropicToolUseResponse("extract_bet", singleToolInput({ event: "Barcelona vs Real Madrid", market: "Totals", selection: "Over 2.5", line: "2.5", stake: 10 }));

  // "ничья" -> MONEYLINE_3WAY/DRAW (a genuine, different market shape, and
  // — crucially — one with NO embedded line, so this stays isolated to the
  // market-intent gate: a cross-market signal that ALSO carried its own
  // line would trip the numeric-role LINE gate first, checked before
  // market-intent, exactly as the critical safety tests below demonstrate
  // deliberately); "ТБ 2.5" -> TOTALS/OVER (matches the claim).
  const result = await parseBetSlipMessage("ничья\nТБ 2.5\nставка 10", "OCR");

  assert.equal(result.valid, true, result.valid ? "" : `unexpected rejection: ${result.code} — ${result.error}`);
  if (!result.valid) return;
  assert.equal(result.selections[0].line, "2.5");
});

test("M3.1 Phase B positive 2: TOTALS/UNDER claim with a genuine cross-market MONEYLINE signal present -> deferred, valid", async () => {
  currentHandler = async () =>
    anthropicToolUseResponse("extract_bet", singleToolInput({ event: "Arsenal vs Chelsea", market: "Totals", selection: "Under 3", line: "3", stake: 10 }));

  // "ничья" -> MONEYLINE_3WAY/DRAW (a genuine, different market shape);
  // "ТМ 3" -> TOTALS/UNDER (matches the claim).
  const result = await parseBetSlipMessage("ничья\nТМ 3\nставка 10", "OCR");

  assert.equal(result.valid, true, result.valid ? "" : `unexpected rejection: ${result.code} — ${result.error}`);
  if (!result.valid) return;
  assert.equal(result.selections[0].line, "3");
});

test("M3.1 Phase B positive 3: SPREAD/PARTICIPANT claim with a genuine cross-market MONEYLINE signal present -> deferred, valid", async () => {
  currentHandler = async () =>
    anthropicToolUseResponse("extract_bet", singleToolInput({ event: "Barcelona vs Real Madrid", market: "Handicap", selection: "Real Madrid -1.5", line: "-1.5", stake: 10 }));

  // "ничья" -> MONEYLINE_3WAY/DRAW (a genuine, different market shape, no
  // embedded line — see positive 1's own comment for why this specific
  // noise shape is what isolates the market-intent gate cleanly);
  // "Реал Мадрид Ф1(-1.5)" -> SPREAD/PARTICIPANT (matches the claim).
  const result = await parseBetSlipMessage("ничья\nРеал Мадрид Ф1(-1.5)\nставка 10", "OCR");

  assert.equal(result.valid, true, result.valid ? "" : `unexpected rejection: ${result.code} — ${result.error}`);
  if (!result.valid) return;
  assert.equal(result.selections[0].line, "-1.5");
});

test("M3.1 Phase B CRITICAL SAFETY: SPREAD claim with a genuine SAME-market conflicting line/side -> still rejected, never deferred (a real direction/line disagreement, not noise)", async () => {
  currentHandler = async () =>
    anthropicToolUseResponse("extract_bet", singleToolInput({ event: "Barcelona vs Real Madrid", market: "Handicap", selection: "Real Madrid -1.5", line: "-1.5", stake: 10 }));

  // Both "Барселона Ф1(-1.5)" and "Реал Мадрид Ф1(-2.5)" are SPREAD/PARTICIPANT
  // — the SAME marketType as the claim, but a genuinely different
  // participant/line. This must never be silently trusted to the provider.
  // Verified (not assumed): this specific fixture actually trips the
  // NUMERIC-role LINE gate first (two distinct LINE values, -1.5 and -2.5 —
  // numeric safety is checked before market-intent safety, unchanged order),
  // so the observable code here is numeric_mismatch, not market_mismatch —
  // both are acceptable, since the real property under test is "never
  // silently deferred/accepted", proven by isDeferrableLineMarketClaim's own
  // hasSameMarketTypeConflict check regardless of which gate fires first.
  const result = await parseBetSlipMessage("Барселона Ф1(-1.5)\nРеал Мадрид Ф1(-2.5)\nставка 10", "OCR");

  assert.equal(result.valid, false, "a same-market SPREAD disagreement must still hard-reject");
  if (result.valid) return;
  assert.ok(result.code === "numeric_mismatch" || result.code === "market_mismatch", `expected a hard rejection, got code=${result.code}`);
});

test("M3.1 Phase B CRITICAL SAFETY: unsupported market (TEAM_TOTAL) is never deferred, regardless of verdict", async () => {
  currentHandler = async () =>
    anthropicToolUseResponse("extract_bet", singleToolInput({ event: "Arsenal vs Chelsea", market: "Team Total", selection: "Arsenal Over 1.5", line: "1.5", stake: 10 }));

  // "ИТБ Арсенал 1.5" classifies as TEAM_TOTAL/OVER — not one of the four
  // supported deferral shapes (MONEYLINE_2WAY/PARTICIPANT, TOTALS/OVER,
  // TOTALS/UNDER, SPREAD/PARTICIPANT) — isDeferrableLineMarketClaim must
  // never defer it even if AI's own claim happens to disagree. Verified:
  // this fixture also trips the numeric LINE gate first (1.5 vs -1.5) —
  // same acceptable-either-code reasoning as the test above.
  const result = await parseBetSlipMessage("Арсенал Ф1(-1.5)\nИТБ Арсенал 1.5\nставка 10", "OCR");

  assert.equal(result.valid, false);
  if (result.valid) return;
  assert.ok(result.code === "numeric_mismatch" || result.code === "market_mismatch", `expected a hard rejection, got code=${result.code}`);
});

test("M3.1 Phase B CRITICAL SAFETY: an incomplete TOTALS claim (no line at all) is never deferred — incompleteness can never be resolved by the provider", async () => {
  currentHandler = async () =>
    anthropicToolUseResponse("extract_bet", singleToolInput({ event: "Barcelona vs Real Madrid", market: "Totals", selection: "Over", line: null, stake: 10 }));

  const result = await parseBetSlipMessage("Барселона Ф1(-1.5)\nБольше\nставка 10", "OCR");

  assert.equal(result.valid, false);
  if (result.valid) return;
  assert.ok(result.code === "numeric_mismatch" || result.code === "market_mismatch", `expected a hard rejection, got code=${result.code}`);
});

test("M3.1 Phase B CRITICAL SAFETY: an incomplete SPREAD claim (whitespace-only participant text) is never deferred", async () => {
  // A genuinely EMPTY selection string is rejected by Claude's own tool
  // schema before this code ever runs at all (zod's minLength(1) on
  // `selection` — confirmed directly: the AI extraction call itself cannot
  // return one) — proving that specific incompleteness shape is already
  // structurally impossible upstream, not merely untested. This test proves
  // the next-weakest real shape instead: a WHITESPACE-ONLY selection, which
  // clears the schema's length check but must still fail
  // isDeferrableLineMarketClaim's own `.trim()` completeness guard.
  currentHandler = async () =>
    anthropicToolUseResponse("extract_bet", singleToolInput({ event: "Barcelona vs Real Madrid", market: "Handicap", selection: "   ", line: "-1.5", stake: 10 }));

  const result = await parseBetSlipMessage("ничья\nФ1(-1.5)\nставка 10", "OCR");

  assert.equal(result.valid, false);
  if (result.valid) return;
  assert.equal(result.code, "market_mismatch");
});

test("M3.1 Phase B: the market_intent_evidence diagnostic's new `deferred` field is true for a deferred claim and false for a hard rejection", async () => {
  const { loggedCalls, restore } = captureConsoleLog();
  try {
    // Deferred case (positive 1's exact shape — cross-market DRAW noise,
    // isolated from the numeric-role gate since DRAW carries no line).
    currentHandler = async () =>
      anthropicToolUseResponse("extract_bet", singleToolInput({ event: "Barcelona vs Real Madrid", market: "Totals", selection: "Over 2.5", line: "2.5", stake: 10 }));
    await parseBetSlipMessage("ничья\nТБ 2.5\nставка 10", "OCR");

    // Hard-rejected case: DRAW conflicting with a MONEYLINE_2WAY/PARTICIPANT
    // claim — DRAW never qualifies for 1X2 deferral (no HOME/AWAY
    // equivalent), same fixture already proven as a genuine hard rejection
    // above (see the updated QA-1.6 negative test) — and, like positive 1,
    // carries no embedded line, so it reaches the market-intent gate
    // directly rather than being intercepted by numeric-role first.
    currentHandler = async () =>
      anthropicToolUseResponse("extract_bet", singleToolInput({ event: "Arsenal vs Chelsea", selection: "Arsenal", stake: 10 }));
    await parseBetSlipMessage("ничья Арсенал победа", "OCR");

    const diagnostics = marketIntentEvidenceDiagnostics(loggedCalls);
    assert.equal(diagnostics.length, 2);
    assert.equal(diagnostics[0].deferred, true);
    assert.equal(diagnostics[1].deferred, false);
  } finally {
    restore();
  }
});
