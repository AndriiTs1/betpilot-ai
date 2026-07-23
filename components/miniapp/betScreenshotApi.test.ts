import { test } from "node:test";
import assert from "node:assert/strict";
import { getBetScreenshotErrorMessage } from "./betScreenshotApi";

// Focused coverage for the client-side error-message mapping — the actual
// fetchBetScreenshotPreview() upload/network logic is exercised by
// app/api/miniapp/bets/screenshot/preview/route.test.ts; this file is
// specifically about the Telegram auth-error unification (previously all
// three reasons here shared one generic message, "Unable to verify
// Telegram session. Reopen the Mini App.", which did not distinguish an
// expired session from one that couldn't be verified at all; now this
// route goes through the same shared
// components/miniapp/telegramAuthError.ts as the other two API clients).

test("getBetScreenshotErrorMessage: expired gets the shared, distinct expired message", () => {
  const message = getBetScreenshotErrorMessage({ kind: "http", code: "expired" });
  assert.equal(message, "Your Telegram session has expired. Close and reopen the Mini App through the bot.");
});

test("getBetScreenshotErrorMessage: malformed and invalid_signature share the same message as each other", () => {
  const malformed = getBetScreenshotErrorMessage({ kind: "http", code: "malformed" });
  const invalidSignature = getBetScreenshotErrorMessage({ kind: "http", code: "invalid_signature" });

  assert.equal(malformed, "Unable to verify your Telegram session. Close and reopen the Mini App through the bot.");
  assert.equal(malformed, invalidSignature);
  assert.notEqual(malformed, getBetScreenshotErrorMessage({ kind: "http", code: "expired" }));
});

test("getBetScreenshotErrorMessage: unrelated error codes (including the newer IMAGE_TOO_LARGE) keep their own unchanged messages", () => {
  assert.equal(
    getBetScreenshotErrorMessage({ kind: "http", code: "FILE_TOO_LARGE" }),
    "That image is too large (max 10 MB). Please choose a smaller file.",
  );
  assert.equal(
    getBetScreenshotErrorMessage({ kind: "http", code: "IMAGE_TOO_LARGE" }),
    "That image's resolution is too large. Please crop it to the bet slip and try again.",
  );
});

test("getBetScreenshotErrorMessage: network/timeout/invalid_response keep their existing, unrelated messages", () => {
  assert.equal(getBetScreenshotErrorMessage({ kind: "network" }), "Unable to connect. Check your internet connection.");
  assert.equal(getBetScreenshotErrorMessage({ kind: "timeout" }), "The request took too long. Please try again.");
  assert.equal(getBetScreenshotErrorMessage({ kind: "invalid_response" }), "Something went wrong. Please try again.");
});
