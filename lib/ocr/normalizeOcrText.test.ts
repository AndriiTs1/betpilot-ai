import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeOcrText } from "./normalizeOcrText";

const CRLF = String.fromCharCode(13, 10);
const CR = String.fromCharCode(13);
const NUL = String.fromCharCode(0);
const NBSP = String.fromCharCode(0xa0);

test("normalizeOcrText: CRLF is normalized to LF", () => {
  assert.equal(normalizeOcrText(`Line1${CRLF}Line2${CRLF}Line3`), "Line1\nLine2\nLine3");
});

test("normalizeOcrText: bare CR is normalized to LF", () => {
  assert.equal(normalizeOcrText(`Line1${CR}Line2`), "Line1\nLine2");
});

test("normalizeOcrText: excessive blank lines are collapsed to one", () => {
  assert.equal(normalizeOcrText("Line1\n\n\n\n\nLine2"), "Line1\n\nLine2");
  assert.equal(normalizeOcrText("Line1\n\n\nLine2"), "Line1\n\nLine2");
});

test("normalizeOcrText: a single blank line is preserved unchanged", () => {
  assert.equal(normalizeOcrText("Line1\n\nLine2"), "Line1\n\nLine2");
});

test("normalizeOcrText: meaningful single line breaks are preserved", () => {
  assert.equal(normalizeOcrText("Real Madrid\nBarcelona\nOver 2.5"), "Real Madrid\nBarcelona\nOver 2.5");
});

test("normalizeOcrText: null bytes are removed", () => {
  assert.equal(normalizeOcrText(`abc${NUL}def`), "abcdef");
});

test("normalizeOcrText: non-breaking spaces are normalized to regular spaces", () => {
  assert.equal(normalizeOcrText(`Real${NBSP}Madrid`), "Real Madrid");
});

test("normalizeOcrText: leading and trailing whitespace is trimmed", () => {
  assert.equal(normalizeOcrText("   \n  hello world  \n   "), "hello world");
});

test("normalizeOcrText: decimal-point odds are preserved exactly", () => {
  assert.equal(normalizeOcrText("Odds: 2.05"), "Odds: 2.05");
});

test("normalizeOcrText: comma-decimal odds are preserved exactly", () => {
  assert.equal(normalizeOcrText("Odds: 1,85"), "Odds: 1,85");
});

test("normalizeOcrText: Asian handicap +/- signs are preserved exactly", () => {
  assert.equal(normalizeOcrText("Handicap +1.5"), "Handicap +1.5");
  assert.equal(normalizeOcrText("Handicap -0.5"), "Handicap -0.5");
});

test("normalizeOcrText: team names, market labels, and punctuation are preserved", () => {
  const input = "Real Madrid vs Barcelona\nMarket: Over/Under 2.5 Goals\nSelection: Over 2.5";
  assert.equal(normalizeOcrText(input), input);
});

test("normalizeOcrText: a combination of all rules produces the expected result", () => {
  const input = `  Real${NBSP}Madrid vs Barcelona${CRLF}${CRLF}${CRLF}Odds: 2.05, 1,85${NUL}${CRLF}Handicap: +1.5 / -0.5  `;
  assert.equal(
    normalizeOcrText(input),
    "Real Madrid vs Barcelona\n\nOdds: 2.05, 1,85\nHandicap: +1.5 / -0.5",
  );
});

test("normalizeOcrText: an empty string stays empty", () => {
  assert.equal(normalizeOcrText(""), "");
});

test("normalizeOcrText: whitespace-only text normalizes to an empty string", () => {
  assert.equal(normalizeOcrText("   \n\n  \t  "), "");
});
