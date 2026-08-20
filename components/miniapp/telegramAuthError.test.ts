import { test } from "node:test";
import assert from "node:assert/strict";
import { isTelegramAuthErrorReason, getTelegramAuthErrorMessage } from "./telegramAuthError";

test("isTelegramAuthErrorReason: recognizes exactly the three verifyInitData reasons", () => {
  assert.equal(isTelegramAuthErrorReason("expired"), true);
  assert.equal(isTelegramAuthErrorReason("malformed"), true);
  assert.equal(isTelegramAuthErrorReason("invalid_signature"), true);
});

test("isTelegramAuthErrorReason: rejects unrelated error codes", () => {
  assert.equal(isTelegramAuthErrorReason("PLAYER_NOT_FOUND"), false);
  assert.equal(isTelegramAuthErrorReason("PREVIEW_EXPIRED"), false);
  assert.equal(isTelegramAuthErrorReason("INTERNAL_ERROR"), false);
  assert.equal(isTelegramAuthErrorReason("UNKNOWN"), false);
  assert.equal(isTelegramAuthErrorReason(""), false);
});

test("getTelegramAuthErrorMessage: expired gets its own distinct message", () => {
  const message = getTelegramAuthErrorMessage("expired");
  assert.equal(message, "Your Telegram session has expired. Close and reopen the Mini App through the bot.");
});

test("getTelegramAuthErrorMessage: malformed and invalid_signature share the same message", () => {
  const malformed = getTelegramAuthErrorMessage("malformed");
  const invalidSignature = getTelegramAuthErrorMessage("invalid_signature");

  assert.equal(malformed, "Unable to verify your Telegram session. Close and reopen the Mini App through the bot.");
  assert.equal(malformed, invalidSignature);
});

test("getTelegramAuthErrorMessage: the expired message and the malformed/invalid_signature message are distinct from each other", () => {
  assert.notEqual(getTelegramAuthErrorMessage("expired"), getTelegramAuthErrorMessage("malformed"));
});

// Localization completion pass — `locale` defaults to "en" (proven by every
// test above, none of which pass one) so every pre-existing call site is
// completely unaffected; passing "ru" explicitly now returns real Russian
// text instead of the English default.
test("getTelegramAuthErrorMessage: locale='ru' returns Russian text, distinct from the default English", () => {
  const enExpired = getTelegramAuthErrorMessage("expired");
  const ruExpired = getTelegramAuthErrorMessage("expired", "ru");
  assert.notEqual(ruExpired, enExpired);
  assert.equal(ruExpired, "Сессия Telegram истекла. Закройте и снова откройте Mini App через бота.");

  const ruMalformed = getTelegramAuthErrorMessage("malformed", "ru");
  assert.equal(ruMalformed, getTelegramAuthErrorMessage("invalid_signature", "ru"));
  assert.notEqual(ruMalformed, ruExpired);
});
