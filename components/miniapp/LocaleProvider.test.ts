import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// This project has no DOM-rendering test infrastructure (same precedent as
// every other components/miniapp/*.test.ts file — see e.g. BetTextForm.test.ts's
// own header) — structural facts are proven by reading the component's own
// source instead of mounting it.

const source = readFileSync(fileURLToPath(new URL("./LocaleProvider.tsx", import.meta.url)), "utf8");

test("LocaleProvider: bootstraps locale state from the fixed DEFAULT_LOCALE, never from localStorage/Telegram during the render itself — no hydration mismatch", () => {
  assert.match(source, /useState<Locale>\(DEFAULT_LOCALE\)/);
});

test("LocaleProvider: localStorage is only ever read inside a useEffect (client-only, post-mount), never during render", () => {
  const effectMatch = source.match(/useEffect\(\(\) => \{([\s\S]*?)\}, \[\]\);/);
  assert.ok(effectMatch, "expected a mount-only useEffect ([] deps)");
  assert.match(effectMatch![1], /window\.localStorage\.getItem\(LOCALE_STORAGE_KEY\)/);
  // Wrapped defensively — storage can throw in some Telegram WebViews /
  // privacy modes, and that must never break the Mini App.
  assert.match(effectMatch![1], /try \{[\s\S]*window\.localStorage\.getItem[\s\S]*\} catch/);
});

test("LocaleProvider: setLocale (explicit player choice) persists to localStorage and marks the choice explicit", () => {
  const setLocaleMatch = source.match(/const setLocale = useCallback\(\(next: Locale\) => \{([\s\S]*?)\}, \[\]\);/);
  assert.ok(setLocaleMatch, "expected setLocale to be defined");
  const body = setLocaleMatch![1];
  assert.match(body, /setLocaleState\(next\)/);
  assert.match(body, /hasExplicitLocaleRef\.current = true/);
  assert.match(body, /window\.localStorage\.setItem\(LOCALE_STORAGE_KEY, next\)/);
});

// Requirement 8 — persisted/explicit locale must always win over a
// Telegram-derived default. Proven structurally: applyTelegramLanguageCode
// must bail out immediately whenever hasExplicitLocaleRef is already true.
test("LocaleProvider: applyTelegramLanguageCode never overrides an already-explicit locale", () => {
  const applyMatch = source.match(
    /const applyTelegramLanguageCode = useCallback\(\(languageCode: string \| null \| undefined\) => \{([\s\S]*?)\}, \[\]\);/,
  );
  assert.ok(applyMatch, "expected applyTelegramLanguageCode to be defined");
  const body = applyMatch![1];
  assert.match(body, /if \(hasExplicitLocaleRef\.current\) return;/);
  assert.match(body, /resolveInitialLocale\(undefined, languageCode\)/);
});

test("LocaleProvider: applying a Telegram language code never itself marks the locale as explicit or persists it", () => {
  const applyMatch = source.match(
    /const applyTelegramLanguageCode = useCallback\(\(languageCode: string \| null \| undefined\) => \{([\s\S]*?)\}, \[\]\);/,
  );
  const body = applyMatch![1];
  assert.equal(/hasExplicitLocaleRef\.current = true/.test(body), false);
  assert.equal(/localStorage\.setItem/.test(body), false);
});

test("LocaleProvider: t() is derived from the current locale state, so it always reflects the latest switch (no stale per-mount cache)", () => {
  assert.match(source, /useCallback\(\s*\(key: TranslationKey, params\?: Record<string, string>\) => translate\(locale, key, params\),\s*\[locale\],?\s*\)/);
});

test("LocaleProvider: exports both the provider and a useLocale hook that throws outside it", () => {
  assert.match(source, /export function LocaleProvider/);
  assert.match(source, /export function useLocale\(\): LocaleContextValue/);
  assert.match(source, /throw new Error\("useLocale must be used within a LocaleProvider"\)/);
});
