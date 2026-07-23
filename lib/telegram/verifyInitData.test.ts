import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { verifyInitData } from "./verifyInitData";

const BOT_TOKEN = "test-bot-token-verify-init-data";
const USER_ID = 700000001;

// Same construction Telegram itself uses to sign initData, and the same
// helper shape already used by app/api/miniapp/bets/screenshot/preview/
// route.test.ts and app/api/bets/confirm.route.test.ts — reused here so a
// forged/mismatched signature test is a real HMAC mismatch, not a stubbed
// one.
function buildInitData(
  botToken: string,
  userId: number,
  authDate: number,
  overrides: Record<string, string> = {},
): string {
  const params = new URLSearchParams();
  params.set("auth_date", String(authDate));
  params.set("user", JSON.stringify({ id: userId, first_name: "Test" }));

  for (const [key, value] of Object.entries(overrides)) {
    params.set(key, value);
  }

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

  const secretKey = createHmac("sha256", "WebAppData").update(botToken).digest();
  const hash = createHmac("sha256", secretKey).update(dataCheckString).digest("hex");

  params.set("hash", hash);
  return params.toString();
}

const FIXED_NOW = new Date("2026-01-01T12:00:00Z").getTime();
const FIXED_NOW_SECONDS = Math.floor(FIXED_NOW / 1000);

function withFixedNow<T>(run: () => T): T {
  const originalNow = Date.now;
  try {
    Date.now = () => FIXED_NOW;
    return run();
  } finally {
    Date.now = originalNow;
  }
}

// ---------------------------------------------------------------------
// Valid initData
// ---------------------------------------------------------------------

test("verifyInitData: a correctly signed initData younger than the TTL is accepted", () => {
  withFixedNow(() => {
    const initData = buildInitData(BOT_TOKEN, USER_ID, FIXED_NOW_SECONDS - 30 * 60); // 30 min old
    const result = verifyInitData(initData, BOT_TOKEN);

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.user.id, USER_ID);
  });
});

test("verifyInitData: initData signed at the exact current moment is accepted", () => {
  withFixedNow(() => {
    const initData = buildInitData(BOT_TOKEN, USER_ID, FIXED_NOW_SECONDS);
    const result = verifyInitData(initData, BOT_TOKEN);
    assert.equal(result.ok, true);
  });
});

// ---------------------------------------------------------------------
// The TTL boundary — current behavior: strictly greater than the limit is
// what triggers "expired" (ageSeconds > INIT_DATA_MAX_AGE_SECONDS), so an
// age of exactly 3600s is NOT expired. Documented here as the current,
// intentional contract.
// ---------------------------------------------------------------------

test("verifyInitData: an age of exactly 1 hour (3600s) is still accepted — the boundary is inclusive", () => {
  withFixedNow(() => {
    const initData = buildInitData(BOT_TOKEN, USER_ID, FIXED_NOW_SECONDS - 60 * 60);
    const result = verifyInitData(initData, BOT_TOKEN);
    assert.equal(result.ok, true);
  });
});

test("verifyInitData: an age of 1 hour and 1 second is rejected as expired", () => {
  withFixedNow(() => {
    const initData = buildInitData(BOT_TOKEN, USER_ID, FIXED_NOW_SECONDS - (60 * 60 + 1));
    const result = verifyInitData(initData, BOT_TOKEN);

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, "expired");
  });
});

test("verifyInitData: an initData well past 1 hour old is rejected as expired", () => {
  withFixedNow(() => {
    const initData = buildInitData(BOT_TOKEN, USER_ID, FIXED_NOW_SECONDS - 2 * 60 * 60); // 2h old
    const result = verifyInitData(initData, BOT_TOKEN);

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, "expired");
  });
});

// ---------------------------------------------------------------------
// invalid_signature
// ---------------------------------------------------------------------

test("verifyInitData: an initData signed with a different bot token is rejected as invalid_signature", () => {
  withFixedNow(() => {
    const initData = buildInitData("a-completely-different-bot-token", USER_ID, FIXED_NOW_SECONDS);
    const result = verifyInitData(initData, BOT_TOKEN);

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, "invalid_signature");
  });
});

test("verifyInitData: a tampered field (user id changed after signing) is rejected as invalid_signature", () => {
  withFixedNow(() => {
    const initData = buildInitData(BOT_TOKEN, USER_ID, FIXED_NOW_SECONDS);
    const tampered = initData.replace(String(USER_ID), String(USER_ID + 1));

    const result = verifyInitData(tampered, BOT_TOKEN);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, "invalid_signature");
  });
});

// ---------------------------------------------------------------------
// malformed
// ---------------------------------------------------------------------

test("verifyInitData: a missing hash is rejected as malformed", () => {
  const params = new URLSearchParams();
  params.set("auth_date", String(FIXED_NOW_SECONDS));
  params.set("user", JSON.stringify({ id: USER_ID }));
  // No hash set at all.

  const result = verifyInitData(params.toString(), BOT_TOKEN);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "malformed");
});

test("verifyInitData: an empty string is rejected as malformed", () => {
  const result = verifyInitData("", BOT_TOKEN);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "malformed");
});

test("verifyInitData: a missing auth_date is rejected as malformed", () => {
  withFixedNow(() => {
    // Built by hand (not via buildInitData, which always sets auth_date) —
    // signs whatever fields are present, omitting auth_date entirely.
    const params = new URLSearchParams();
    params.set("user", JSON.stringify({ id: USER_ID }));
    const dataCheckString = [...params.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, value]) => `${key}=${value}`)
      .join("\n");
    const secretKey = createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
    const hash = createHmac("sha256", secretKey).update(dataCheckString).digest("hex");
    params.set("hash", hash);

    const result = verifyInitData(params.toString(), BOT_TOKEN);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, "malformed");
  });
});

test("verifyInitData: a non-numeric auth_date is rejected as malformed", () => {
  withFixedNow(() => {
    const initData = buildInitData(BOT_TOKEN, USER_ID, FIXED_NOW_SECONDS, { auth_date: "not-a-number" });
    const result = verifyInitData(initData, BOT_TOKEN);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, "malformed");
  });
});

test("verifyInitData: a missing user field is rejected as malformed", () => {
  withFixedNow(() => {
    const params = new URLSearchParams();
    params.set("auth_date", String(FIXED_NOW_SECONDS));
    const dataCheckString = [...params.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, value]) => `${key}=${value}`)
      .join("\n");
    const secretKey = createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
    const hash = createHmac("sha256", secretKey).update(dataCheckString).digest("hex");
    params.set("hash", hash);

    const result = verifyInitData(params.toString(), BOT_TOKEN);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, "malformed");
  });
});

test("verifyInitData: an unparsable user field (not JSON) is rejected as malformed", () => {
  withFixedNow(() => {
    const initData = buildInitData(BOT_TOKEN, USER_ID, FIXED_NOW_SECONDS, { user: "{not valid json" });
    const result = verifyInitData(initData, BOT_TOKEN);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, "malformed");
  });
});

test("verifyInitData: a user field whose id is not a number is rejected as malformed", () => {
  withFixedNow(() => {
    const initData = buildInitData(BOT_TOKEN, USER_ID, FIXED_NOW_SECONDS, {
      user: JSON.stringify({ id: "not-a-number" }),
    });
    const result = verifyInitData(initData, BOT_TOKEN);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, "malformed");
  });
});
