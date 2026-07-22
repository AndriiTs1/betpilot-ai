import { test } from "node:test";
import assert from "node:assert/strict";
import { formatBetDate } from "./formatBetDate";

test("formatBetDate: formats a plain date as DD.MM.YY", () => {
  assert.equal(formatBetDate(new Date(2026, 6, 20)), "20.07.26");
  assert.equal(formatBetDate(new Date(2026, 6, 22)), "22.07.26");
});

test("formatBetDate: pads single-digit day and month with a leading zero", () => {
  assert.equal(formatBetDate(new Date(2026, 0, 5)), "05.01.26");
  assert.equal(formatBetDate(new Date(2027, 0, 5)), "05.01.27");
});

test("formatBetDate: uses only the last two digits of the year", () => {
  assert.equal(formatBetDate(new Date(2027, 0, 5)), "05.01.27");
  assert.equal(formatBetDate(new Date(1999, 11, 31)), "31.12.99");
});

test("formatBetDate: an ISO string input is accepted the same as a Date", () => {
  // Local calendar date, not UTC — matches every other date helper in this
  // project (no timezone conversion applied).
  assert.equal(formatBetDate(new Date(2026, 6, 20).toISOString()), "20.07.26");
});

test("formatBetDate: an invalid date returns the project's existing fallback, never 'Invalid Date'", () => {
  assert.equal(formatBetDate("not-a-date"), "—");
  assert.equal(formatBetDate(new Date(NaN)), "—");
  assert.equal(formatBetDate(""), "—");
});

test("formatBetDate: crosses a year boundary correctly", () => {
  assert.equal(formatBetDate(new Date(2026, 11, 31)), "31.12.26");
  assert.equal(formatBetDate(new Date(2027, 0, 1)), "01.01.27");
});

test("formatBetDate: never uses relative labels like Today/Yesterday", () => {
  const today = new Date();
  const formatted = formatBetDate(today);
  assert.doesNotMatch(formatted, /today|yesterday/i);
  assert.match(formatted, /^\d{2}\.\d{2}\.\d{2}$/);
});
