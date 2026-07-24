import { test } from "node:test";
import assert from "node:assert/strict";
import { extractCommandPayload, MIN_ODDS_PAYLOAD_LENGTH, MAX_ODDS_PAYLOAD_LENGTH } from "./extractCommandPayload";

test("extractCommandPayload: /odds payload is accepted", () => {
  const result = extractCommandPayload("/odds Real Madrid to win vs Barcelona, odds 2.05");
  assert.deepEqual(result, { ok: true, payload: "Real Madrid to win vs Barcelona, odds 2.05" });
});

test("extractCommandPayload: /odds@BotName payload is accepted", () => {
  const result = extractCommandPayload("/odds@BetPilotAI_bot Real Madrid to win vs Barcelona, odds 2.05");
  assert.deepEqual(result, { ok: true, payload: "Real Madrid to win vs Barcelona, odds 2.05" });
});

test("extractCommandPayload: uppercase /ODDS payload extraction is unaffected by command casing", () => {
  const result = extractCommandPayload("/ODDS Real Madrid to win vs Barcelona, odds 2.05");
  assert.deepEqual(result, { ok: true, payload: "Real Madrid to win vs Barcelona, odds 2.05" });
});

test("extractCommandPayload: /odds with no payload returns MISSING", () => {
  assert.deepEqual(extractCommandPayload("/odds"), { ok: false, reason: "MISSING" });
});

test("extractCommandPayload: /odds@BotName with no payload returns MISSING", () => {
  assert.deepEqual(extractCommandPayload("/odds@BetPilotAI_bot"), { ok: false, reason: "MISSING" });
});

test("extractCommandPayload: whitespace-only payload returns MISSING", () => {
  assert.deepEqual(extractCommandPayload("/odds     "), { ok: false, reason: "MISSING" });
});

test("extractCommandPayload: a payload shorter than the minimum is rejected as TOO_SHORT", () => {
  const shortPayload = "a".repeat(MIN_ODDS_PAYLOAD_LENGTH - 1);
  assert.deepEqual(extractCommandPayload(`/odds ${shortPayload}`), { ok: false, reason: "TOO_SHORT" });
});

test("extractCommandPayload: a payload at exactly the minimum length is accepted", () => {
  const minPayload = "a".repeat(MIN_ODDS_PAYLOAD_LENGTH);
  assert.deepEqual(extractCommandPayload(`/odds ${minPayload}`), { ok: true, payload: minPayload });
});

test("extractCommandPayload: a payload longer than the maximum is rejected as TOO_LONG", () => {
  const longPayload = "a".repeat(MAX_ODDS_PAYLOAD_LENGTH + 1);
  assert.deepEqual(extractCommandPayload(`/odds ${longPayload}`), { ok: false, reason: "TOO_LONG" });
});

test("extractCommandPayload: a payload at exactly the maximum length is accepted, never truncated", () => {
  const maxPayload = "a".repeat(MAX_ODDS_PAYLOAD_LENGTH);
  const result = extractCommandPayload(`/odds ${maxPayload}`);
  assert.deepEqual(result, { ok: true, payload: maxPayload });
  if (result.ok) assert.equal(result.payload.length, MAX_ODDS_PAYLOAD_LENGTH);
});

test("extractCommandPayload: Unicode team names are preserved byte-for-byte", () => {
  const result = extractCommandPayload("/odds Спартак vs Динамо, ставка 50, кэф 2.1");
  assert.deepEqual(result, { ok: true, payload: "Спартак vs Динамо, ставка 50, кэф 2.1" });
});

test("extractCommandPayload: internal whitespace within the payload is preserved exactly", () => {
  const result = extractCommandPayload("/odds Real   Madrid    vs Barcelona");
  assert.deepEqual(result, { ok: true, payload: "Real   Madrid    vs Barcelona" });
});

test("extractCommandPayload: leading/trailing whitespace around the payload is trimmed", () => {
  const result = extractCommandPayload("/odds   Real Madrid vs Barcelona   ");
  assert.deepEqual(result, { ok: true, payload: "Real Madrid vs Barcelona" });
});
