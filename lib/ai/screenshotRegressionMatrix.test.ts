import { test } from "node:test";
import assert from "node:assert/strict";
import { parseBetSlipMessage } from "./betParser";

// SCREENSHOT QA-CORE S4 — the permanent, deterministic screenshot regression
// matrix. Operates at the OCR-TEXT level (already-transcribed text feeding
// parseBetSlipMessage(text, "OCR")) — the exact layer S1/S2/S3 actually
// changed. Deliberately does NOT attempt to unit-test dark/light theme,
// embedded browser chrome pixels, or multiple visual card layouts: by the
// time text reaches this layer, OCR has already erased all of that — those
// are OCR/vision-level concerns (lib/ocr/claudeOcrProvider.ts's prompt,
// unmodified by this stage) that a text-level fixture cannot represent, and
// this stage's own brief explicitly warns against relying only on
// AI-generated pixels in unit tests instead of deterministic text fixtures.
// RU/UA/EN language variety and UI-noise presence (quick-stake buttons,
// potential-payout figures, CTA amounts) ARE representable in text and are
// deliberately spread across the fixtures below as the "layout variant"
// dimension this suite can actually prove.
//
// Every fixture asserts the full set of fields the task requires: type,
// sport, event, market, selection, line, submittedOdds, stake — no
// partial-credit success; every assertion must pass exactly.
//
// Same fetch-indirection technique betParser.test.ts already uses — its own
// header comment explains why (the Anthropic SDK client's module-level
// singleton captures whatever global.fetch is bound to on first use).

const originalFetch = global.fetch;
const originalAiProvider = process.env.AI_PROVIDER;
const originalApiKey = process.env.ANTHROPIC_API_KEY;

let currentHandler: (url: string, init?: RequestInit) => Promise<Response> = async () => {
  throw new Error("screenshotRegressionMatrix.test.ts: no fetch handler set for this test");
};

global.fetch = (((url: string | URL, init?: RequestInit) => currentHandler(String(url), init)) as unknown) as typeof fetch;

test.beforeEach(() => {
  process.env.AI_PROVIDER = "claude";
  process.env.ANTHROPIC_API_KEY = "test-anthropic-key-regression-matrix";
  currentHandler = async () => {
    throw new Error("screenshotRegressionMatrix.test.ts: no fetch handler set for this test");
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
      id: "msg_regression_matrix",
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

function singleToolInput(overrides: Partial<{
  sport: string; league: string | null; event: string; market: string | null;
  selection: string; period: string | null; line: string | null; stake: number; odds: number | null;
}> = {}) {
  return {
    sport: "Football",
    league: null,
    event: "Arsenal vs Chelsea",
    market: null,
    selection: "Arsenal",
    period: null,
    line: null,
    stake: 10,
    odds: null,
    ...overrides,
  };
}

interface ExpressLegInput {
  sport: string; league: string | null; event: string; market: string | null;
  selection: string; period: string | null; line: string | null; odds: number | null;
}

function expressToolInput(stake: number, selections: ExpressLegInput[]) {
  return { stake, selections };
}

/* ============================================================================
 * SINGLE matrix — 9 fixtures
 * ============================================================================ */

test("Matrix 1 — SINGLE MONEYLINE 1X2 HOME (RU, П1)", async () => {
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

  const text = "Германия - Бундеслига\nБавария - Штутгарт\nИсход (1X2)\nП1 - Бавария\n1.42\nСтавка 100";
  const result = await parseBetSlipMessage(text, "OCR");

  assert.equal(result.valid, true, result.valid ? "" : `${result.error} (${result.code})`);
  if (!result.valid) return;
  assert.equal(result.type, "SINGLE");
  assert.equal(result.selections[0].sport, "Football");
  assert.equal(result.selections[0].event, "Bayern Munich vs VfB Stuttgart");
  assert.equal(result.selections[0].market, "1X2");
  assert.equal(result.selections[0].selection, "Bayern Munich");
  assert.equal(result.selections[0].line, null);
  assert.equal(result.selections[0].submittedOdds, 1.42);
  assert.equal(result.stake, 100);
});

test("Matrix 2 — SINGLE MONEYLINE 1X2 AWAY (EN, W2)", async () => {
  currentHandler = async () =>
    anthropicToolUseResponse(
      "extract_bet",
      singleToolInput({
        sport: "Football",
        event: "RB Leipzig vs Borussia Mönchengladbach",
        market: "1X2",
        selection: "Borussia Mönchengladbach",
        stake: 50,
        odds: 6.5,
      }),
    );

  const text = "Bundesliga\nRB Leipzig - Borussia Mönchengladbach\n1X2\nW2 - Borussia Mönchengladbach\n6.50\nStake 50";
  const result = await parseBetSlipMessage(text, "OCR");

  assert.equal(result.valid, true, result.valid ? "" : `${result.error} (${result.code})`);
  if (!result.valid) return;
  assert.equal(result.type, "SINGLE");
  assert.equal(result.selections[0].event, "RB Leipzig vs Borussia Mönchengladbach");
  assert.equal(result.selections[0].selection, "Borussia Mönchengladbach");
  assert.equal(result.selections[0].submittedOdds, 6.5);
  assert.equal(result.stake, 50);
});

test("Matrix 3 — SINGLE DRAW (UA, Нічия)", async () => {
  currentHandler = async () =>
    anthropicToolUseResponse(
      "extract_bet",
      singleToolInput({
        sport: "Football",
        event: "Arsenal vs Chelsea",
        market: "1X2",
        selection: "Draw",
        stake: 20,
        odds: 3.4,
      }),
    );

  const text = "Arsenal - Chelsea\n1X2\nНічия\n3.40\nСума ставки 20";
  const result = await parseBetSlipMessage(text, "OCR");

  assert.equal(result.valid, true, result.valid ? "" : `${result.error} (${result.code})`);
  if (!result.valid) return;
  assert.equal(result.selections[0].selection, "Draw");
  assert.equal(result.selections[0].submittedOdds, 3.4);
  assert.equal(result.stake, 20);
});

test("Matrix 4 — SINGLE SPREAD -1.5 (RU, Ф1(-1.5))", async () => {
  currentHandler = async () =>
    anthropicToolUseResponse(
      "extract_bet",
      singleToolInput({
        sport: "Football",
        event: "Arsenal vs Chelsea",
        market: "Handicap",
        selection: "Arsenal -1.5",
        line: "-1.5",
        stake: 25,
        odds: 2.1,
      }),
    );

  const text = "Арсенал - Челси\nФора\nАрсенал Ф1(-1.5)\n2.10\nставка 25";
  const result = await parseBetSlipMessage(text, "OCR");

  assert.equal(result.valid, true, result.valid ? "" : `${result.error} (${result.code})`);
  if (!result.valid) return;
  assert.equal(result.selections[0].market, "Handicap");
  assert.equal(result.selections[0].selection, "Arsenal -1.5");
  assert.equal(result.selections[0].line, "-1.5");
  assert.equal(result.selections[0].submittedOdds, 2.1);
  assert.equal(result.stake, 25);
});

test("Matrix 5 — SINGLE SPREAD -1.25 (quarter line, EN)", async () => {
  currentHandler = async () =>
    anthropicToolUseResponse(
      "extract_bet",
      singleToolInput({
        sport: "Football",
        event: "Real Madrid vs Barcelona",
        market: "Handicap",
        selection: "Real Madrid -1.25",
        line: "-1.25",
        stake: 40,
        odds: 1.95,
      }),
    );

  const text = "Real Madrid vs Barcelona\nHandicap\nReal Madrid F1(-1.25)\n1.95\nStake 40";
  const result = await parseBetSlipMessage(text, "OCR");

  assert.equal(result.valid, true, result.valid ? "" : `${result.error} (${result.code})`);
  if (!result.valid) return;
  assert.equal(result.selections[0].line, "-1.25");
  assert.equal(result.selections[0].submittedOdds, 1.95);
  assert.equal(result.stake, 40);
});

test("Matrix 6 — SINGLE TOTALS Over 2.5 (EN)", async () => {
  currentHandler = async () =>
    anthropicToolUseResponse(
      "extract_bet",
      singleToolInput({
        sport: "Football",
        event: "Bayern Munich vs VfB Stuttgart",
        market: "Totals",
        selection: "Over 2.5",
        line: "2.5",
        stake: 30,
        odds: 1.85,
      }),
    );

  const text = "Bayern Munich vs VfB Stuttgart\nTotals\nOver 2.5\n1.85\nStake 30";
  const result = await parseBetSlipMessage(text, "OCR");

  assert.equal(result.valid, true, result.valid ? "" : `${result.error} (${result.code})`);
  if (!result.valid) return;
  assert.equal(result.selections[0].market, "Totals");
  assert.equal(result.selections[0].selection, "Over 2.5");
  assert.equal(result.selections[0].line, "2.5");
  assert.equal(result.selections[0].submittedOdds, 1.85);
  assert.equal(result.stake, 30);
});

test("Matrix 7 — SINGLE TOTALS Under 3 (RU, ТМ 3)", async () => {
  currentHandler = async () =>
    anthropicToolUseResponse(
      "extract_bet",
      singleToolInput({
        sport: "Football",
        event: "Arsenal vs Chelsea",
        market: "Тотал",
        selection: "Under 3",
        line: "3",
        stake: 35,
        odds: 1.75,
      }),
    );

  const text = "Арсенал - Челси\nТотал\nТМ 3\n1.75\nразмер ставки 35";
  const result = await parseBetSlipMessage(text, "OCR");

  assert.equal(result.valid, true, result.valid ? "" : `${result.error} (${result.code})`);
  if (!result.valid) return;
  assert.equal(result.selections[0].line, "3");
  assert.equal(result.selections[0].submittedOdds, 1.75);
  assert.equal(result.stake, 35);
});

test("Matrix 8 — SINGLE TOTALS Over 2.25 (quarter line, RU, ТБ 2.25)", async () => {
  currentHandler = async () =>
    anthropicToolUseResponse(
      "extract_bet",
      singleToolInput({
        sport: "Football",
        event: "Real Madrid vs Barcelona",
        market: "Тотал",
        selection: "Over 2.25",
        line: "2.25",
        stake: 45,
        odds: 2.0,
      }),
    );

  const text = "Реал Мадрид - Барселона\nТотал\nТБ 2.25\n2.00\nСумма пари 45";
  const result = await parseBetSlipMessage(text, "OCR");

  assert.equal(result.valid, true, result.valid ? "" : `${result.error} (${result.code})`);
  if (!result.valid) return;
  assert.equal(result.selections[0].line, "2.25");
  assert.equal(result.selections[0].submittedOdds, 2.0);
  assert.equal(result.stake, 45);
});

test("Matrix 9 — SINGLE TOTALS Under 2.75 (quarter line, EN) with quick-stake UI noise and potential payout", async () => {
  currentHandler = async () =>
    anthropicToolUseResponse(
      "extract_bet",
      singleToolInput({
        sport: "Football",
        event: "RB Leipzig vs Borussia Mönchengladbach",
        market: "Totals",
        selection: "Under 2.75",
        line: "2.75",
        stake: 55,
        odds: 1.9,
      }),
    );

  const text = [
    "RB Leipzig vs Borussia Mönchengladbach",
    "Totals",
    "Under 2.75",
    "1.90",
    "Stake",
    "55",
    "10 25 50 100 200",
    "Potential payout",
    "104.50 USD",
    "Place Bet 55.00 USD",
  ].join("\n");

  const result = await parseBetSlipMessage(text, "OCR");

  assert.equal(result.valid, true, result.valid ? "" : `${result.error} (${result.code})`);
  if (!result.valid) return;
  assert.equal(result.selections[0].line, "2.75");
  assert.equal(result.selections[0].submittedOdds, 1.9);
  assert.equal(result.stake, 55, "quick-stake noise + a same-value CTA amount must not disturb the labeled stake");
});

/* ============================================================================
 * EXPRESS matrix — 5 fixtures
 * ============================================================================ */

test("Matrix 10 — EXPRESS x2: MONEYLINE + TOTALS", async () => {
  currentHandler = async () =>
    anthropicToolUseResponse(
      "extract_express_bet",
      expressToolInput(20, [
        { sport: "Football", league: null, event: "Bayern Munich vs VfB Stuttgart", market: "1X2", selection: "Bayern Munich", period: null, line: null, odds: 1.42 },
        { sport: "Football", league: null, event: "Arsenal vs Chelsea", market: "Totals", selection: "Over 2.5", period: null, line: "2.5", odds: 1.85 },
      ]),
    );

  const text = "Bayern Munich vs VfB Stuttgart\nП1\n1.42\nArsenal vs Chelsea\nOver 2.5\n1.85\nэкспресс 20";
  const result = await parseBetSlipMessage(text, "OCR");

  assert.equal(result.valid, true, result.valid ? "" : `${result.error} (${result.code})`);
  if (!result.valid) return;
  assert.equal(result.type, "EXPRESS");
  assert.equal(result.stake, 20);
  assert.equal(result.selections.length, 2);
  assert.equal(result.selections[0].selection, "Bayern Munich");
  assert.equal(result.selections[0].submittedOdds, 1.42);
  assert.equal(result.selections[1].line, "2.5");
  assert.equal(result.selections[1].submittedOdds, 1.85);
});

test("Matrix 11 — EXPRESS x2: SPREAD + TOTALS", async () => {
  currentHandler = async () =>
    anthropicToolUseResponse(
      "extract_express_bet",
      expressToolInput(25, [
        { sport: "Football", league: null, event: "Arsenal vs Chelsea", market: "Handicap", selection: "Arsenal -1.5", period: null, line: "-1.5", odds: 2.1 },
        { sport: "Football", league: null, event: "Real Madrid vs Barcelona", market: "Totals", selection: "Under 3.5", period: null, line: "3.5", odds: 1.7 },
      ]),
    );

  const text = "Арсенал - Челси, Ф1(-1.5)\n2.10\nReal Madrid - Barcelona, Under 3.5\n1.70\nставка 25";
  const result = await parseBetSlipMessage(text, "OCR");

  assert.equal(result.valid, true, result.valid ? "" : `${result.error} (${result.code})`);
  if (!result.valid) return;
  assert.equal(result.selections.length, 2);
  assert.equal(result.selections[0].line, "-1.5");
  assert.equal(result.selections[0].submittedOdds, 2.1);
  assert.equal(result.selections[1].line, "3.5");
  assert.equal(result.selections[1].submittedOdds, 1.7);
  assert.equal(result.stake, 25);
});

test("Matrix 12 — EXPRESS x3: MONEYLINE + SPREAD + TOTALS", async () => {
  currentHandler = async () =>
    anthropicToolUseResponse(
      "extract_express_bet",
      expressToolInput(30, [
        { sport: "Football", league: null, event: "Bayern Munich vs VfB Stuttgart", market: null, selection: "Bayern Munich", period: null, line: null, odds: 1.42 },
        { sport: "Football", league: null, event: "Arsenal vs Chelsea", market: "Handicap", selection: "Arsenal -1.5", period: null, line: "-1.5", odds: 2.1 },
        { sport: "Football", league: null, event: "Real Madrid vs Barcelona", market: "Totals", selection: "Under 3.5", period: null, line: "3.5", odds: 1.85 },
      ]),
    );

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

  assert.equal(result.valid, true, result.valid ? "" : `${result.error} (${result.code})`);
  if (!result.valid) return;
  assert.equal(result.selections.length, 3);
  assert.equal(result.selections[0].selection, "Bayern Munich");
  assert.equal(result.selections[1].line, "-1.5");
  assert.equal(result.selections[2].line, "3.5");
  assert.equal(result.stake, 30);
});

test("Matrix 13 — EXPRESS with a quarter-line SPREAD leg (-1.25)", async () => {
  currentHandler = async () =>
    anthropicToolUseResponse(
      "extract_express_bet",
      expressToolInput(40, [
        { sport: "Football", league: null, event: "Real Madrid vs Barcelona", market: "Handicap", selection: "Real Madrid -1.25", period: null, line: "-1.25", odds: 1.95 },
        { sport: "Football", league: null, event: "Arsenal vs Chelsea", market: "Totals", selection: "Over 2.5", period: null, line: "2.5", odds: 1.85 },
      ]),
    );

  const text = "Real Madrid vs Barcelona, F1(-1.25)\n1.95\nArsenal vs Chelsea, Over 2.5\n1.85\nStake 40";
  const result = await parseBetSlipMessage(text, "OCR");

  assert.equal(result.valid, true, result.valid ? "" : `${result.error} (${result.code})`);
  if (!result.valid) return;
  assert.equal(result.selections[0].line, "-1.25");
  assert.equal(result.selections[0].submittedOdds, 1.95);
  assert.equal(result.stake, 40);
});

test("Matrix 14 — EXPRESS with a quarter-line TOTALS leg (2.25)", async () => {
  currentHandler = async () =>
    anthropicToolUseResponse(
      "extract_express_bet",
      expressToolInput(45, [
        { sport: "Football", league: null, event: "Bayern Munich vs VfB Stuttgart", market: null, selection: "Bayern Munich", period: null, line: null, odds: 1.42 },
        { sport: "Football", league: null, event: "Real Madrid vs Barcelona", market: "Totals", selection: "Over 2.25", period: null, line: "2.25", odds: 2.0 },
      ]),
    );

  const text = "Бавария - Штутгарт\nП1\n1.42\nРеал Мадрид - Барселона\nТБ 2.25\n2.00\nСумма ставки 45";
  const result = await parseBetSlipMessage(text, "OCR");

  assert.equal(result.valid, true, result.valid ? "" : `${result.error} (${result.code})`);
  if (!result.valid) return;
  assert.equal(result.selections[0].selection, "Bayern Munich");
  assert.equal(result.selections[1].line, "2.25");
  assert.equal(result.selections[1].submittedOdds, 2.0);
  assert.equal(result.stake, 45);
});
