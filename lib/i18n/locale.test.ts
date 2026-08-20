import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_LOCALE, LOCALE_STORAGE_KEY, isLocale, resolveInitialLocale } from "./locale";

test("DEFAULT_LOCALE is a fixed, deterministic bootstrap value (ru) — same on server and first client render, so there is nothing to mismatch during hydration", () => {
  assert.equal(DEFAULT_LOCALE, "ru");
});

test("LOCALE_STORAGE_KEY is a stable, namespaced key", () => {
  assert.equal(LOCALE_STORAGE_KEY, "betpilot:locale");
});

test("isLocale accepts exactly 'ru'/'en' and rejects everything else", () => {
  assert.equal(isLocale("ru"), true);
  assert.equal(isLocale("en"), true);
  assert.equal(isLocale("fr"), false);
  assert.equal(isLocale(""), false);
  assert.equal(isLocale(null), false);
  assert.equal(isLocale(undefined), false);
  assert.equal(isLocale(42), false);
});

// Requirement 8 — persisted locale wins over Telegram languageCode, on
// every subsequent visit, regardless of what Telegram reports.
test("resolveInitialLocale: an explicit stored locale always wins over a conflicting Telegram languageCode", () => {
  assert.equal(resolveInitialLocale("en", "ru"), "en");
  assert.equal(resolveInitialLocale("ru", "en"), "ru");
});

// Requirement 10 — Telegram RU-like language selects RU on first visit
// (no stored value yet).
test("resolveInitialLocale: a Russian-like Telegram languageCode selects ru on first visit", () => {
  assert.equal(resolveInitialLocale(null, "ru"), "ru");
  assert.equal(resolveInitialLocale(undefined, "ru-RU"), "ru");
  assert.equal(resolveInitialLocale(null, "RU"), "ru");
  assert.equal(resolveInitialLocale(null, "  ru  "), "ru");
});

// Requirement 11 — Telegram non-RU language (or no language at all) selects
// EN on first visit.
test("resolveInitialLocale: a non-Russian or missing Telegram languageCode selects en on first visit", () => {
  assert.equal(resolveInitialLocale(null, "en"), "en");
  assert.equal(resolveInitialLocale(null, "de"), "en");
  assert.equal(resolveInitialLocale(null, "it"), "en");
  assert.equal(resolveInitialLocale(null, undefined), "en");
  assert.equal(resolveInitialLocale(null, null), "en");
  // "ro" (Romanian) starts with "r" but must never be treated as Russian.
  assert.equal(resolveInitialLocale(null, "ro"), "en");
});

// Requirement 9 — a missing/invalid/corrupted stored value never throws and
// always falls back safely (to the Telegram-derived default, same as a
// genuinely first visit).
test("resolveInitialLocale: a garbage/invalid stored value is ignored, never thrown, and falls back to the Telegram-derived default", () => {
  assert.doesNotThrow(() => resolveInitialLocale("garbage", "ru"));
  assert.equal(resolveInitialLocale("garbage", "ru"), "ru");
  assert.equal(resolveInitialLocale("", "en"), "en");
  assert.equal(resolveInitialLocale("RU", "ru"), "ru");
});
