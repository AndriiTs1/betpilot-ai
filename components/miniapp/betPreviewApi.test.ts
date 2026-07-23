import { test } from "node:test";
import assert from "node:assert/strict";
import { getBetPreviewErrorMessage } from "./betPreviewApi";

// Focused coverage for the client-side error-message mapping — the actual
// fetchBetPreview() network/parsing logic is exercised indirectly by the
// server-side route tests; this file is specifically about the Telegram
// auth-error unification (previously malformed/invalid_signature and
// expired had two different messages here; now both routes go through the
// shared components/miniapp/telegramAuthError.ts).

test("getBetPreviewErrorMessage: expired gets the shared, distinct expired message", () => {
  const message = getBetPreviewErrorMessage({ kind: "http", code: "expired" });
  assert.equal(message, "Your Telegram session has expired. Close and reopen the Mini App through the bot.");
});

test("getBetPreviewErrorMessage: malformed and invalid_signature share the same message as each other", () => {
  const malformed = getBetPreviewErrorMessage({ kind: "http", code: "malformed" });
  const invalidSignature = getBetPreviewErrorMessage({ kind: "http", code: "invalid_signature" });

  assert.equal(malformed, "Unable to verify your Telegram session. Close and reopen the Mini App through the bot.");
  assert.equal(malformed, invalidSignature);
  assert.notEqual(malformed, getBetPreviewErrorMessage({ kind: "http", code: "expired" }));
});

test("getBetPreviewErrorMessage: unrelated error codes keep their own unchanged messages", () => {
  assert.equal(getBetPreviewErrorMessage({ kind: "http", code: "PLAYER_NOT_FOUND" }), "Your player account was not found.");
  assert.equal(getBetPreviewErrorMessage({ kind: "http", code: "PARSE_FAILED" }), "We could not understand this bet. Try adding event, selection, stake and odds.");
});

test("getBetPreviewErrorMessage: network/timeout/invalid_response keep their existing, unrelated messages", () => {
  assert.equal(getBetPreviewErrorMessage({ kind: "network" }), "Unable to connect. Check your internet connection.");
  assert.equal(getBetPreviewErrorMessage({ kind: "timeout" }), "The request took too long. Please try again.");
  assert.equal(getBetPreviewErrorMessage({ kind: "invalid_response" }), "Something went wrong. Please try again.");
});
