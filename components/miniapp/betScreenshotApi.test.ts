import { test } from "node:test";
import assert from "node:assert/strict";
import { getBetScreenshotErrorMessage, fetchBetScreenshotPreview } from "./betScreenshotApi";

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

/* -------------------------------------------------------------------------- */
/* SCREENSHOT QA-CORE S3 — accurate error-message mapping. Confirmed         */
/* production defect (QA-2): MARKET_INTENT_UNRECONCILED used to share        */
/* INVALID_BET_SLIP's "invalid number of selections" message even though it   */
/* has nothing to do with selection count. detail already existed on the      */
/* server response — this file never read it until now.                      */
/* -------------------------------------------------------------------------- */

test("getBetScreenshotErrorMessage: OCR_NO_TEXT gets its own distinct message, separate from IMAGE_NOT_RECOGNIZED", () => {
  const message = getBetScreenshotErrorMessage({ kind: "http", code: "OCR_NO_TEXT" });
  assert.equal(message, "We couldn't read enough text from this image. Try a clearer screenshot.");
  assert.notEqual(message, getBetScreenshotErrorMessage({ kind: "http", code: "IMAGE_NOT_RECOGNIZED" }));
});

test("getBetScreenshotErrorMessage: IMAGE_NOT_RECOGNIZED + detail 'numeric_mismatch' gets a stake/odds-ambiguity-specific message", () => {
  const message = getBetScreenshotErrorMessage({ kind: "http", code: "IMAGE_NOT_RECOGNIZED", detail: "numeric_mismatch" });
  assert.equal(
    message,
    "We spotted more than one possible stake or odds value on this screenshot. Please make sure only your actual bet is visible, or enter it manually.",
  );
});

test("getBetScreenshotErrorMessage: IMAGE_NOT_RECOGNIZED + detail 'market_mismatch' gets a selection-mismatch-specific message", () => {
  const message = getBetScreenshotErrorMessage({ kind: "http", code: "IMAGE_NOT_RECOGNIZED", detail: "market_mismatch" });
  assert.equal(message, "We couldn't confidently match the selection on this screenshot. Please try a clearer screenshot or enter the bet manually.");
});

test("getBetScreenshotErrorMessage: IMAGE_NOT_RECOGNIZED with no detail (or 'unspecified') keeps today's existing, still-accurate generic message", () => {
  const noDetail = getBetScreenshotErrorMessage({ kind: "http", code: "IMAGE_NOT_RECOGNIZED" });
  const unspecified = getBetScreenshotErrorMessage({ kind: "http", code: "IMAGE_NOT_RECOGNIZED", detail: "unspecified" });
  assert.equal(noDetail, "We couldn't recognize a bet slip in this image. Please try a clearer screenshot.");
  assert.equal(noDetail, unspecified);
});

test("getBetScreenshotErrorMessage: INVALID_BET_SLIP + detail 'MARKET_INTENT_UNRECONCILED' no longer claims an invalid selection count (confirmed production defect, QA-2)", () => {
  const message = getBetScreenshotErrorMessage({ kind: "http", code: "INVALID_BET_SLIP", detail: "MARKET_INTENT_UNRECONCILED" });
  assert.equal(message, "We couldn't confirm which team or match your selection refers to. Please try again or enter the bet manually.");
  assert.notEqual(message, "This bet doesn't have a valid number of selections. Please try again.");
});

test("getBetScreenshotErrorMessage: INVALID_BET_SLIP with no detail, or any other BetSlipValidationErrorCode, keeps the selection-count message — now accurate for every remaining case", () => {
  const noDetail = getBetScreenshotErrorMessage({ kind: "http", code: "INVALID_BET_SLIP" });
  const selectionCount = getBetScreenshotErrorMessage({ kind: "http", code: "INVALID_BET_SLIP", detail: "SINGLE_INVALID_SELECTION_COUNT" });
  const tooFew = getBetScreenshotErrorMessage({ kind: "http", code: "INVALID_BET_SLIP", detail: "EXPRESS_TOO_FEW_SELECTIONS" });
  assert.equal(noDetail, "This bet doesn't have a valid number of selections. Please try again.");
  assert.equal(selectionCount, noDetail);
  assert.equal(tooFew, noDetail);
});

/* -------------------------------------------------------------------------- */
/* SCREENSHOT QA-CORE S3 — fetchBetScreenshotPreview's own `detail`           */
/* extraction, previously entirely untested (no prior test in this file or    */
/* elsewhere actually exercised its response-parsing logic with a mocked      */
/* fetch). Same fetch-indirection technique lib/ai/betParser.test.ts already  */
/* uses: global.fetch replaced once with a stable wrapper delegating to a     */
/* mutable per-test handler.                                                  */
/* -------------------------------------------------------------------------- */

const originalFetch = global.fetch;
let currentHandler: () => Promise<Response> = async () => {
  throw new Error("betScreenshotApi.test.ts: no fetch handler set for this test");
};

global.fetch = ((() => currentHandler()) as unknown) as typeof fetch;

test.after(() => {
  global.fetch = originalFetch;
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

test("fetchBetScreenshotPreview: a 422 body with a string detail is surfaced on the returned failure", async () => {
  currentHandler = async () => jsonResponse(422, { error: "INVALID_BET_SLIP", detail: "MARKET_INTENT_UNRECONCILED" });

  const result = await fetchBetScreenshotPreview("fake-init-data", new File(["x"], "slip.jpg", { type: "image/jpeg" }));

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.failure.kind, "http");
  if (result.failure.kind !== "http") return;
  assert.equal(result.failure.code, "INVALID_BET_SLIP");
  assert.equal(result.failure.detail, "MARKET_INTENT_UNRECONCILED");
});

test("fetchBetScreenshotPreview: a body with no detail field surfaces detail: null, never fabricated", async () => {
  currentHandler = async () => jsonResponse(422, { error: "IMAGE_NOT_RECOGNIZED" });

  const result = await fetchBetScreenshotPreview("fake-init-data", new File(["x"], "slip.jpg", { type: "image/jpeg" }));

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.failure.kind, "http");
  if (result.failure.kind !== "http") return;
  assert.equal(result.failure.detail, null);
});

test("fetchBetScreenshotPreview: a non-string detail field is treated as absent, never passed through as-is", async () => {
  currentHandler = async () => jsonResponse(422, { error: "IMAGE_NOT_RECOGNIZED", detail: 12345 });

  const result = await fetchBetScreenshotPreview("fake-init-data", new File(["x"], "slip.jpg", { type: "image/jpeg" }));

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.failure.kind, "http");
  if (result.failure.kind !== "http") return;
  assert.equal(result.failure.detail, null);
});
