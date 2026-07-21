import { test } from "node:test";
import assert from "node:assert/strict";
import { formatCompactDate } from "./formatCompactDate";

const NOW = new Date(2026, 6, 21, 15, 30); // Jul 21, 2026, 15:30 local

test("formatCompactDate: same calendar day as now -> Today", () => {
  assert.equal(formatCompactDate(new Date(2026, 6, 21, 0, 5), NOW), "Today");
  assert.equal(formatCompactDate(new Date(2026, 6, 21, 23, 59), NOW), "Today");
});

test("formatCompactDate: the previous calendar day -> Yesterday", () => {
  assert.equal(formatCompactDate(new Date(2026, 6, 20, 23, 59), NOW), "Yesterday");
  assert.equal(formatCompactDate(new Date(2026, 6, 20, 0, 0), NOW), "Yesterday");
});

test("formatCompactDate: a date earlier in the current year -> 'D Mon' with no year", () => {
  assert.equal(formatCompactDate(new Date(2026, 0, 5), NOW), "5 Jan");
  assert.equal(formatCompactDate(new Date(2026, 6, 19), NOW), "19 Jul");
});

test("formatCompactDate: a date in a different year -> 'D Mon YYYY'", () => {
  assert.equal(formatCompactDate(new Date(2025, 6, 21), NOW), "21 Jul 2025");
  assert.equal(formatCompactDate(new Date(2027, 0, 1), NOW), "1 Jan 2027");
});

test("formatCompactDate: an ISO string input is accepted the same as a Date", () => {
  assert.equal(formatCompactDate("2026-07-21T08:00:00.000Z", new Date(2026, 6, 21, 15, 0)), "Today");
  assert.equal(formatCompactDate("2025-01-01T00:00:00.000Z", NOW), "1 Jan 2025");
});

test("formatCompactDate: an invalid date returns the project's existing fallback, never 'Invalid Date'", () => {
  assert.equal(formatCompactDate("not-a-date", NOW), "—");
  assert.equal(formatCompactDate(new Date(NaN), NOW), "—");
  assert.equal(formatCompactDate("", NOW), "—");
});

test("formatCompactDate: crosses a year boundary correctly (Jan 1 -> yesterday is Dec 31 of the previous year)", () => {
  const newYearsDay = new Date(2027, 0, 1, 10, 0);
  assert.equal(formatCompactDate(new Date(2026, 11, 31, 23, 0), newYearsDay), "Yesterday");
  assert.equal(formatCompactDate(new Date(2026, 11, 30), newYearsDay), "30 Dec 2026");
});

test("formatCompactDate: a date exactly one calendar day before 'now', regardless of time-of-day gap, is Yesterday", () => {
  // Just after midnight vs. late the previous evening — under 2 hours
  // apart in wall-clock terms, but genuinely different calendar days.
  const justAfterMidnight = new Date(2026, 6, 21, 0, 30);
  assert.equal(formatCompactDate(new Date(2026, 6, 20, 23, 0), justAfterMidnight), "Yesterday");
});
