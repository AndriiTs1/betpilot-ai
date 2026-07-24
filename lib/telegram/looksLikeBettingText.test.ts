import { test } from "node:test";
import assert from "node:assert/strict";
import { looksLikeBettingText } from "./looksLikeBettingText";
import { MAX_ODDS_PAYLOAD_LENGTH } from "./extractCommandPayload";

/* -------------------------------------------------------------------------- */
/* Required acceptances                                                       */
/* -------------------------------------------------------------------------- */

test("looksLikeBettingText: accepts event + market + odds marker", () => {
  assert.equal(looksLikeBettingText("Real Madrid to win vs Barcelona, odds 2.05"), true);
});

test("looksLikeBettingText: accepts hyphen separator + market + @odds", () => {
  assert.equal(looksLikeBettingText("Liverpool - Arsenal over 2.5 @1.90"), true);
});

test("looksLikeBettingText: accepts event + market with no odds at all", () => {
  assert.equal(looksLikeBettingText("Real Madrid to win vs Barcelona"), true);
});

test("looksLikeBettingText: accepts Italian event + market + quota", () => {
  assert.equal(looksLikeBettingText("Juventus vincente vs Milan, quota 1.85"), true);
});

test("looksLikeBettingText: accepts Russian event + slip marker + odds marker", () => {
  assert.equal(looksLikeBettingText("Реал Мадрид – Барселона, ставка 50, кф 2.1"), true);
});

test("looksLikeBettingText: accepts Russian event + market language", () => {
  assert.equal(looksLikeBettingText("Реал Мадрид – Барселона, победа Реала"), true);
});

test("looksLikeBettingText: accepts Russian event + totals market language", () => {
  assert.equal(looksLikeBettingText("Милан – Интер, тотал больше 2.5"), true);
});

test("looksLikeBettingText: accepts Italian hyphen event + market language", () => {
  assert.equal(looksLikeBettingText("Juventus - Milan, vittoria Juventus"), true);
});

test("looksLikeBettingText: accepts a multiline EXPRESS message with market + odds + slip markers", () => {
  const text = "Real Madrid to win @1.70\nArsenal to win @1.65\nInter to win @1.80\nStake 20";
  assert.equal(looksLikeBettingText(text), true);
});

test("looksLikeBettingText: accepts valid betting text surrounded by harmless emoji", () => {
  assert.equal(looksLikeBettingText("🔥 Real Madrid to win vs Barcelona, odds 2.05 🔥"), true);
});

/* -------------------------------------------------------------------------- */
/* Required rejections                                                        */
/* -------------------------------------------------------------------------- */

const REQUIRED_REJECTIONS = [
  "Hello",
  "Hi",
  "Thanks",
  "Help",
  "Open my account",
  "What can you do?",
  "How are you?",
  "Real Madrid",
  "football",
  "bet",
  "2.05",
  "@2.05",
  "I want to win",
  "This is over",
  "Draw me a picture",
  "What is the total?",
  "My stake in the company",
  "https://example.com/promo",
  "😀😀😀😀😀😀",
  "/help",
  "/settings",
  "/random",
  "/oddswrong Real Madrid win",
  "   ",
  "ab",
];

for (const rejected of REQUIRED_REJECTIONS) {
  test(`looksLikeBettingText: rejects ${JSON.stringify(rejected)}`, () => {
    assert.equal(looksLikeBettingText(rejected), false);
  });
}

test("looksLikeBettingText: rejects text longer than MAX_ODDS_PAYLOAD_LENGTH", () => {
  const tooLong = `Real Madrid to win vs Barcelona ${"a".repeat(MAX_ODDS_PAYLOAD_LENGTH)}`;
  assert.equal(looksLikeBettingText(tooLong), false);
});

/* -------------------------------------------------------------------------- */
/* Category-count edge cases                                                  */
/* -------------------------------------------------------------------------- */

test("looksLikeBettingText: exactly one category (market language only) is rejected", () => {
  assert.equal(looksLikeBettingText("I really want to win this argument"), false);
});

test("looksLikeBettingText: exactly one category (odds marker only) is rejected", () => {
  assert.equal(looksLikeBettingText("The price is odds 2.05 apparently"), false);
});

test("looksLikeBettingText: exactly one category (event structure only) is rejected", () => {
  assert.equal(looksLikeBettingText("New York - Los Angeles flight schedule"), false);
});

test("looksLikeBettingText: exactly two categories is accepted", () => {
  assert.equal(looksLikeBettingText("Barcelona vs Real Madrid, over the total"), true);
});

test("looksLikeBettingText: repeated matches from a single category do not accumulate into acceptance", () => {
  assert.equal(looksLikeBettingText("win win win win win"), false);
});

test("looksLikeBettingText: a separator without surrounding whitespace does not count as event structure", () => {
  // "RealMadrid-Barcelona" has no spaces around the hyphen, so event
  // structure is never credited; "over" alone is exactly one category, so
  // the overall result must still be false.
  assert.equal(looksLikeBettingText("RealMadrid-Barcelona over"), false);
});

test("looksLikeBettingText: a URL embedded in otherwise valid betting text does not automatically reject it", () => {
  const text = "Check https://example.com/slip Real Madrid to win vs Barcelona, odds 2.05";
  assert.equal(looksLikeBettingText(text), true);
});

/* -------------------------------------------------------------------------- */
/* Normalization details                                                      */
/* -------------------------------------------------------------------------- */

test("looksLikeBettingText: multiline text is scanned as one unit, not line by line", () => {
  // No single line here has two category signals on its own, but the whole
  // message (market language across lines + a slip marker on the last
  // line) does.
  const text = "Real Madrid to win\nArsenal to win\nStake 20";
  assert.equal(looksLikeBettingText(text), true);
});

test("looksLikeBettingText: en dash and em dash both count as event separators", () => {
  assert.equal(looksLikeBettingText("Real Madrid – Barcelona, over the total"), true);
  assert.equal(looksLikeBettingText("Real Madrid — Barcelona, over the total"), true);
});

test("looksLikeBettingText: does not mutate or alter its input", () => {
  const original = "Real Madrid to win vs Barcelona, odds 2.05";
  const snapshot = original;
  looksLikeBettingText(original);
  assert.equal(original, snapshot);
});

test("looksLikeBettingText: whitespace-only text is rejected", () => {
  assert.equal(looksLikeBettingText("     "), false);
});

test("looksLikeBettingText: a non-string value is rejected defensively", () => {
  assert.equal(looksLikeBettingText(12345 as unknown as string), false);
  assert.equal(looksLikeBettingText(null as unknown as string), false);
  assert.equal(looksLikeBettingText(undefined as unknown as string), false);
});

test("looksLikeBettingText: a bare slash command is rejected even if it looks bet-like", () => {
  assert.equal(looksLikeBettingText("/odds Real Madrid to win vs Barcelona, odds 2.05"), false);
});
