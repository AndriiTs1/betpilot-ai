import { test } from "node:test";
import assert from "node:assert/strict";
import { translations, translate } from "./translations";

// Requirement 14 — translation dictionaries have matching keys. This is
// already enforced at compile time (both `en` and `ru` in translations.ts
// are typed against the same TranslationDict interface — a missing key in
// either fails `tsc --noEmit`), but this runtime walk is a second,
// independent proof that survives even for a caller who only runs `npm
// test` and never typechecks, and it fails loudly with the exact missing
// path instead of a generic TS error.
function collectKeyPaths(value: unknown, prefix = ""): string[] {
  if (typeof value === "string") return [prefix];
  if (value === null || typeof value !== "object") {
    throw new Error(`unexpected non-string, non-object value at "${prefix}"`);
  }
  return Object.entries(value as Record<string, unknown>).flatMap(([key, nested]) =>
    collectKeyPaths(nested, prefix ? `${prefix}.${key}` : key),
  );
}

test("translations: ru and en dictionaries have exactly the same set of dot-path keys", () => {
  const enKeys = collectKeyPaths(translations.en).sort();
  const ruKeys = collectKeyPaths(translations.ru).sort();
  assert.deepEqual(ruKeys, enKeys);
});

test("translations: every value in both dictionaries is a non-empty string", () => {
  for (const locale of ["ru", "en"] as const) {
    for (const path of collectKeyPaths(translations[locale])) {
      const value = translate(locale, path as never);
      assert.equal(typeof value, "string");
      assert.ok(value.length > 0, `${locale}.${path} must not be empty`);
    }
  }
});

// Requirements 1/2 — initial RU/EN rendering: spot-check the exact
// user-facing keys named in the product brief, across every namespace this
// stage translates.
test("translations: RU renders the expected copy for every named product key", () => {
  assert.equal(translate("ru", "home.aiOnline"), "AI Online");
  assert.equal(translate("ru", "home.ready"), "Готов проверить вашу ставку");
  assert.equal(translate("ru", "home.sendBet"), "Отправить ставку");
  assert.equal(translate("ru", "home.screenshotOrText"), "Скриншот или текст");
  assert.equal(translate("ru", "home.available"), "Доступно");
  assert.equal(translate("ru", "home.exposure"), "В игре");
  assert.equal(translate("ru", "home.pending"), "Ожидает");
  assert.equal(translate("ru", "nav.newBet"), "Новая ставка");
  assert.equal(translate("ru", "nav.active"), "Активные");
  assert.equal(translate("ru", "nav.history"), "История");
  assert.equal(translate("ru", "nav.balance"), "Баланс");
  assert.equal(translate("ru", "bet.placeBet"), "Разместить ставку");
  assert.equal(translate("ru", "bet.single"), "Ординар");
  assert.equal(translate("ru", "bet.express"), "Экспресс");
  assert.equal(translate("ru", "bet.placeholder"), "Команда, исход, ставка");
  assert.equal(translate("ru", "bet.preview"), "Предпросмотр ставки");
});

test("translations: EN renders the expected copy for every named product key", () => {
  assert.equal(translate("en", "home.aiOnline"), "AI Online");
  assert.equal(translate("en", "home.ready"), "Ready to check your bet");
  assert.equal(translate("en", "home.sendBet"), "Place a bet");
  assert.equal(translate("en", "home.screenshotOrText"), "Screenshot or text");
  assert.equal(translate("en", "home.available"), "Available");
  assert.equal(translate("en", "home.exposure"), "In play");
  assert.equal(translate("en", "home.pending"), "Pending");
  assert.equal(translate("en", "nav.newBet"), "New bet");
  assert.equal(translate("en", "nav.active"), "Active");
  assert.equal(translate("en", "nav.history"), "History");
  assert.equal(translate("en", "nav.balance"), "Balance");
  assert.equal(translate("en", "bet.placeBet"), "Place a bet");
  assert.equal(translate("en", "bet.single"), "Single");
  assert.equal(translate("en", "bet.express"), "Express");
  assert.equal(translate("en", "bet.placeholder"), "Team, outcome, stake");
  assert.equal(translate("en", "bet.preview"), "Preview bet");
});

// Requirements 3/4 — RU<->EN live switch. translate() is a pure function of
// (locale, key): there is no cache or memoized-per-mount value keyed only
// by key, so calling it again with a different locale for the SAME key
// immediately reflects the new language — exactly the property a live
// in-place switch (no reload, no remount) depends on.
test("translations: switching the locale argument alone changes the result for the same key, both directions", () => {
  assert.notEqual(translate("ru", "nav.active"), translate("en", "nav.active"));
  assert.equal(translate("ru", "nav.active"), "Активные");
  assert.equal(translate("en", "nav.active"), "Active");

  // RU -> EN -> RU round-trip for the same key must land back on the exact
  // original string — no accumulated state, no drift.
  const original = translate("ru", "bet.single");
  const afterSwitchToEn = translate("en", "bet.single");
  const afterSwitchBackToRu = translate("ru", "bet.single");
  assert.notEqual(original, afterSwitchToEn);
  assert.equal(afterSwitchBackToRu, original);
});

test("translations: {token} interpolation substitutes a supplied param and leaves an unsupplied one untouched", () => {
  assert.equal(translate("ru", "home.welcome", { name: "Андрей" }), "Добро пожаловать, Андрей");
  assert.equal(translate("en", "home.welcome", { name: "Andrii" }), "Welcome, Andrii");
  // No params supplied at all — returns the raw template rather than
  // throwing, so a caller that forgets params degrades visibly, not fatally.
  assert.equal(translate("ru", "home.welcome"), "Добро пожаловать, {name}");
});

// "Русский"/"English" are language endonyms — a language's own name is
// conventionally NOT translated into the currently active UI language (a
// picker always shows "Русский"/"English" regardless of which is active).
test("translations: language names in the common namespace are locale-invariant endonyms", () => {
  assert.equal(translate("ru", "common.russian"), translate("en", "common.russian"));
  assert.equal(translate("ru", "common.english"), translate("en", "common.english"));
  assert.equal(translate("ru", "common.russian"), "Русский");
  assert.equal(translate("ru", "common.english"), "English");
});
