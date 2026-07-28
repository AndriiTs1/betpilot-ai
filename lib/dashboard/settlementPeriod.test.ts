import { test } from "node:test";
import assert from "node:assert/strict";
import {
  getZurichCalendarDate,
  calendarDateToUtcMidnight,
  getNextSettlementDate,
  getCurrentSettlementPeriodStart,
  getCurrentSettlementPeriodBounds,
} from "./settlementPeriod";

test("getZurichCalendarDate: reads the calendar date in Europe/Zurich, not UTC", () => {
  // 2026-07-15T23:30:00Z is already 2026-07-16 in Zurich (CEST, UTC+2).
  const date = getZurichCalendarDate(new Date("2026-07-15T23:30:00Z"));
  assert.deepEqual(date, { year: 2026, month: 6, day: 16 });
});

test("calendarDateToUtcMidnight: builds a UTC-midnight Date from a calendar date", () => {
  const result = calendarDateToUtcMidnight({ year: 2026, month: 6, day: 15 });
  assert.equal(result.toISOString(), "2026-07-15T00:00:00.000Z");
});

test("getNextSettlementDate: day <= 15 resolves to the 15th of the same month", () => {
  const result = getNextSettlementDate(new Date("2026-07-01T10:00:00Z"));
  assert.equal(result.toISOString(), "2026-07-15T00:00:00.000Z");
});

test("getNextSettlementDate: exactly on the 15th still resolves to the 15th (due today)", () => {
  const result = getNextSettlementDate(new Date("2026-07-15T08:00:00Z"));
  assert.equal(result.toISOString(), "2026-07-15T00:00:00.000Z");
});

test("getNextSettlementDate: day > 15 resolves to the last day of the month", () => {
  const result = getNextSettlementDate(new Date("2026-07-16T08:00:00Z"));
  assert.equal(result.toISOString(), "2026-07-31T00:00:00.000Z");
});

test("getNextSettlementDate: handles a 30-day month correctly", () => {
  const result = getNextSettlementDate(new Date("2026-04-20T08:00:00Z"));
  assert.equal(result.toISOString(), "2026-04-30T00:00:00.000Z");
});

test("getNextSettlementDate: handles a leap-year February", () => {
  const result = getNextSettlementDate(new Date("2028-02-20T08:00:00Z"));
  assert.equal(result.toISOString(), "2028-02-29T00:00:00.000Z");
});

test("getNextSettlementDate: December rolls into January correctly", () => {
  const result = getNextSettlementDate(new Date("2026-12-20T08:00:00Z"));
  assert.equal(result.toISOString(), "2026-12-31T00:00:00.000Z");
});

test("getCurrentSettlementPeriodStart: day <= 15 resolves to the 1st of the month", () => {
  const result = getCurrentSettlementPeriodStart(new Date("2026-07-10T08:00:00Z"));
  assert.equal(result.toISOString(), "2026-07-01T00:00:00.000Z");
});

test("getCurrentSettlementPeriodStart: exactly on the 15th is still in the first-half period", () => {
  const result = getCurrentSettlementPeriodStart(new Date("2026-07-15T20:00:00Z"));
  assert.equal(result.toISOString(), "2026-07-01T00:00:00.000Z");
});

test("getCurrentSettlementPeriodStart: day > 15 resolves to the 16th of the month", () => {
  const result = getCurrentSettlementPeriodStart(new Date("2026-07-16T00:30:00Z"));
  assert.equal(result.toISOString(), "2026-07-16T00:00:00.000Z");
});

test("getCurrentSettlementPeriodBounds: start and nextSettlementDate always agree on which half they describe", () => {
  const bounds = getCurrentSettlementPeriodBounds(new Date("2026-07-20T00:00:00Z"));
  assert.equal(bounds.start.toISOString(), "2026-07-16T00:00:00.000Z");
  assert.equal(bounds.nextSettlementDate.toISOString(), "2026-07-31T00:00:00.000Z");
});
