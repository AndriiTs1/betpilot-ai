import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchBetConfirm, getBetConfirmErrorMessage, buildOddsChangedReconfirm } from "./betConfirmApi";

// Stubs the global fetch this module calls internally — no new dependency,
// Node's native fetch/Response are already used throughout this project.
// Restored after each test so other test files (and Node's own fetch
// elsewhere) are never left with a stale stub.
function stubFetch(responseInit: { status: number; body: unknown }) {
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(responseInit.body), {
      status: responseInit.status,
      headers: { "Content-Type": "application/json" },
    })) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

function singleBetBody() {
  return {
    id: "bet-1",
    status: "PENDING",
    type: "SINGLE",
    sport: "Football",
    event: "Real Madrid vs Barcelona",
    outcome: "Real Madrid Win",
    stake: 100,
    odds: 2.1,
    totalOdds: 2.1,
    createdAt: "2026-07-21T12:00:00.000Z",
  };
}

function expressBetBody() {
  return {
    id: "bet-2",
    status: "PENDING",
    type: "EXPRESS",
    sport: "Football",
    event: null,
    outcome: null,
    odds: null,
    stake: "40",
    totalOdds: "3.06",
    createdAt: "2026-07-21T12:00:00.000Z",
    selections: [
      {
        id: "sel-1",
        sport: "Football",
        event: "Real Madrid vs Barcelona",
        outcome: "Real Madrid Win",
        market: "Match Winner",
        odds: "1.8",
        currentOdds: "1.8",
        oddsStatus: "VERIFIED",
      },
      {
        id: "sel-2",
        sport: "Tennis",
        event: "Inter Milan vs Juventus",
        outcome: "Over 2.5 Goals",
        market: null,
        odds: "1.7",
        currentOdds: null,
        oddsStatus: "UNAVAILABLE",
      },
    ],
  };
}

test("fetchBetConfirm: SINGLE confirm response is still accepted (unchanged)", async () => {
  const restore = stubFetch({ status: 200, body: { bet: singleBetBody(), idempotent: false } });
  try {
    const result = await fetchBetConfirm("fake-init-data", "fake-token");
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.data.bet.type, "SINGLE");
    assert.equal(result.data.idempotent, false);
  } finally {
    restore();
  }
});

test("fetchBetConfirm: EXPRESS confirm response is now accepted (was invalid_response before Step 5)", async () => {
  const restore = stubFetch({ status: 200, body: { bet: expressBetBody(), idempotent: false } });
  try {
    const result = await fetchBetConfirm("fake-init-data", "fake-express-token");
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.data.bet.type, "EXPRESS");
    if (result.data.bet.type !== "EXPRESS") return;
    assert.equal(result.data.bet.selections.length, 2);
    assert.equal(result.data.bet.selections[0].sport, "Football");
    assert.equal(result.data.bet.selections[1].sport, "Tennis");
  } finally {
    restore();
  }
});

test("fetchBetConfirm: a repeated EXPRESS confirm (idempotent: true) is still accepted with the same bet id", async () => {
  const restore = stubFetch({ status: 200, body: { bet: expressBetBody(), idempotent: true } });
  try {
    const first = await fetchBetConfirm("fake-init-data", "fake-express-token");
    const second = await fetchBetConfirm("fake-init-data", "fake-express-token");

    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    if (!first.ok || !second.ok) return;
    assert.equal(second.data.idempotent, true);
    assert.equal(first.data.bet.id, second.data.bet.id);
  } finally {
    restore();
  }
});

test("fetchBetConfirm: an EXPRESS response missing selections is rejected as invalid_response", async () => {
  const malformed: Record<string, unknown> = expressBetBody();
  delete malformed.selections;
  const restore = stubFetch({ status: 200, body: { bet: malformed, idempotent: false } });
  try {
    const result = await fetchBetConfirm("fake-init-data", "fake-token");
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.failure.kind, "invalid_response");
  } finally {
    restore();
  }
});

test("fetchBetConfirm: a 422 PREVIEW_INVALID error response is still surfaced (unchanged error path)", async () => {
  const restore = stubFetch({ status: 422, body: { error: "PREVIEW_INVALID" } });
  try {
    const result = await fetchBetConfirm("fake-init-data", "fake-token");
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.deepEqual(result.failure, { kind: "http", code: "PREVIEW_INVALID" });
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------
// getBetConfirmErrorMessage — Telegram auth error unification
// ---------------------------------------------------------------------

test("getBetConfirmErrorMessage: expired gets the shared, distinct expired message", () => {
  const message = getBetConfirmErrorMessage({ kind: "http", code: "expired" });
  assert.equal(message, "Your Telegram session has expired. Close and reopen the Mini App through the bot.");
});

test("getBetConfirmErrorMessage: malformed and invalid_signature share the same message as each other", () => {
  const malformed = getBetConfirmErrorMessage({ kind: "http", code: "malformed" });
  const invalidSignature = getBetConfirmErrorMessage({ kind: "http", code: "invalid_signature" });

  assert.equal(malformed, "Unable to verify your Telegram session. Close and reopen the Mini App through the bot.");
  assert.equal(malformed, invalidSignature);
  assert.notEqual(malformed, getBetConfirmErrorMessage({ kind: "http", code: "expired" }));
});

test("getBetConfirmErrorMessage: PREVIEW_EXPIRED/PREVIEW_INVALID are unrelated to Telegram auth and keep their own unchanged message", () => {
  const previewExpired = getBetConfirmErrorMessage({ kind: "http", code: "PREVIEW_EXPIRED" });
  const previewInvalid = getBetConfirmErrorMessage({ kind: "http", code: "PREVIEW_INVALID" });

  assert.equal(previewExpired, "⏳ This preview has expired.\n\nOdds may have changed.\n\nPlease generate a new preview.");
  assert.equal(previewExpired, previewInvalid);
  assert.notEqual(previewExpired, getBetConfirmErrorMessage({ kind: "http", code: "expired" }));
});

test("getBetConfirmErrorMessage: network/timeout/aborted/invalid_response keep their existing, unrelated messages", () => {
  assert.equal(getBetConfirmErrorMessage({ kind: "network" }), "Unable to connect. Check your internet connection.");
  assert.equal(getBetConfirmErrorMessage({ kind: "timeout" }), "The request took too long. Please try again.");
  assert.equal(getBetConfirmErrorMessage({ kind: "aborted" }), "");
  assert.equal(getBetConfirmErrorMessage({ kind: "invalid_response" }), "Something went wrong. Please try again.");
});

// ---------------------------------------------------------------------
// Step 15B — 409 ODDS_CHANGED_RECONFIRM_REQUIRED
// ---------------------------------------------------------------------

function refreshedSinglePreviewBody() {
  return {
    type: "SINGLE",
    stake: 100,
    totalOdds: 1.95,
    potentialWin: 195,
    selections: [
      {
        sport: "Football",
        event: "Real Madrid vs Barcelona",
        market: null,
        selection: "Real Madrid Win",
        submittedOdds: 2.1,
        currentOdds: 1.95,
        oddsStatus: "ODDS_CHANGED",
        bookmaker: "Bet365",
        discrepancyPercent: -7.14,
        homeTeamName: null,
        awayTeamName: null,
        competitionName: null,
        eventStartTime: null,
      },
    ],
  };
}

function stalePreviewSuccess(): import("./betPreviewApi").BetPreviewSuccess {
  return {
    preview: {
      type: "SINGLE",
      stake: 100,
      totalOdds: 2.1,
      potentialWin: 210,
      selections: [
        {
          sport: "Football",
          event: "Real Madrid vs Barcelona",
          market: null,
          selection: "Real Madrid Win",
          submittedOdds: 2.1,
          currentOdds: 2.1,
          oddsStatus: "VERIFIED",
          bookmaker: "Bet365",
          discrepancyPercent: 0,
          homeTeamName: null,
          awayTeamName: null,
          competitionName: null,
          eventStartTime: null,
        },
      ],
    },
    previewToken: "stale-token-abc",
  };
}

test("fetchBetConfirm: a valid ODDS_CHANGED_RECONFIRM_REQUIRED 409 is parsed into the dedicated odds_changed failure", async () => {
  const restore = stubFetch({
    status: 409,
    body: {
      error: "ODDS_CHANGED_RECONFIRM_REQUIRED",
      refreshedPreview: refreshedSinglePreviewBody(),
      refreshedPreviewToken: "fresh-token-xyz",
    },
  });
  try {
    const result = await fetchBetConfirm("fake-init-data", "stale-token-abc");
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.failure.kind, "odds_changed");
    if (result.failure.kind !== "odds_changed") return;
    assert.equal(result.failure.refreshedPreviewToken, "fresh-token-xyz");
    assert.equal(result.failure.refreshedPreview.selections[0].currentOdds, 1.95);
  } finally {
    restore();
  }
});

test("fetchBetConfirm: refreshedPreview/refreshedPreviewToken are handed to the UI layer unmodified", async () => {
  const body = {
    error: "ODDS_CHANGED_RECONFIRM_REQUIRED",
    refreshedPreview: refreshedSinglePreviewBody(),
    refreshedPreviewToken: "fresh-token-xyz",
  };
  const restore = stubFetch({ status: 409, body });
  try {
    const result = await fetchBetConfirm("fake-init-data", "stale-token-abc");
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.failure.kind, "odds_changed");
    if (result.failure.kind !== "odds_changed") return;
    assert.deepEqual(result.failure.refreshedPreview, body.refreshedPreview);
  } finally {
    restore();
  }
});

test("fetchBetConfirm: missing refreshedPreview on a 409 falls back to the safe invalid_response failure", async () => {
  const restore = stubFetch({
    status: 409,
    body: { error: "ODDS_CHANGED_RECONFIRM_REQUIRED", refreshedPreviewToken: "fresh-token-xyz" },
  });
  try {
    const result = await fetchBetConfirm("fake-init-data", "stale-token-abc");
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.failure.kind, "invalid_response");
  } finally {
    restore();
  }
});

test("fetchBetConfirm: missing refreshedPreviewToken on a 409 falls back to the safe invalid_response failure", async () => {
  const restore = stubFetch({
    status: 409,
    body: { error: "ODDS_CHANGED_RECONFIRM_REQUIRED", refreshedPreview: refreshedSinglePreviewBody() },
  });
  try {
    const result = await fetchBetConfirm("fake-init-data", "stale-token-abc");
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.failure.kind, "invalid_response");
  } finally {
    restore();
  }
});

test("fetchBetConfirm: an empty-string refreshedPreviewToken on a 409 falls back to the safe invalid_response failure", async () => {
  const restore = stubFetch({
    status: 409,
    body: {
      error: "ODDS_CHANGED_RECONFIRM_REQUIRED",
      refreshedPreview: refreshedSinglePreviewBody(),
      refreshedPreviewToken: "",
    },
  });
  try {
    const result = await fetchBetConfirm("fake-init-data", "stale-token-abc");
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.failure.kind, "invalid_response");
  } finally {
    restore();
  }
});

test("fetchBetConfirm: a structurally invalid refreshedPreview (missing selections) on a 409 falls back to invalid_response", async () => {
  const malformedPreview: Record<string, unknown> = refreshedSinglePreviewBody();
  delete malformedPreview.selections;
  const restore = stubFetch({
    status: 409,
    body: {
      error: "ODDS_CHANGED_RECONFIRM_REQUIRED",
      refreshedPreview: malformedPreview,
      refreshedPreviewToken: "fresh-token-xyz",
    },
  });
  try {
    const result = await fetchBetConfirm("fake-init-data", "stale-token-abc");
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.failure.kind, "invalid_response");
  } finally {
    restore();
  }
});

test("fetchBetConfirm: a non-object refreshedPreview on a 409 falls back to invalid_response", async () => {
  const restore = stubFetch({
    status: 409,
    body: {
      error: "ODDS_CHANGED_RECONFIRM_REQUIRED",
      refreshedPreview: "not-an-object",
      refreshedPreviewToken: "fresh-token-xyz",
    },
  });
  try {
    const result = await fetchBetConfirm("fake-init-data", "stale-token-abc");
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.failure.kind, "invalid_response");
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------
// Step 15B — buildOddsChangedReconfirm (shared pure helper)
// ---------------------------------------------------------------------

test("buildOddsChangedReconfirm: the returned preview carries the fresh token, never the stale one", () => {
  const stale = stalePreviewSuccess();
  const failure: import("./betConfirmApi").BetConfirmOddsChangedFailure = {
    kind: "odds_changed",
    refreshedPreview: refreshedSinglePreviewBody() as import("./betPreviewApi").BetPreview,
    refreshedPreviewToken: "fresh-token-xyz",
  };

  const result = buildOddsChangedReconfirm(stale, failure);

  assert.equal(result.preview.previewToken, "fresh-token-xyz");
  assert.notEqual(result.preview.previewToken, stale.previewToken);
  assert.deepEqual(result.preview.preview, failure.refreshedPreview);
});

test("buildOddsChangedReconfirm: the message shows both the old submitted odds and the new current odds", () => {
  const stale = stalePreviewSuccess(); // submittedOdds 2.1
  const failure: import("./betConfirmApi").BetConfirmOddsChangedFailure = {
    kind: "odds_changed",
    refreshedPreview: refreshedSinglePreviewBody() as import("./betPreviewApi").BetPreview, // currentOdds 1.95
    refreshedPreviewToken: "fresh-token-xyz",
  };

  const result = buildOddsChangedReconfirm(stale, failure);

  assert.match(result.message, /2\.10/);
  assert.match(result.message, /1\.95/);
  assert.match(result.message, /Real Madrid vs Barcelona/);
});

test("buildOddsChangedReconfirm: a null stale preview (no prior preview in state) still produces a safe message, old odds shown as unknown", () => {
  const failure: import("./betConfirmApi").BetConfirmOddsChangedFailure = {
    kind: "odds_changed",
    refreshedPreview: refreshedSinglePreviewBody() as import("./betPreviewApi").BetPreview,
    refreshedPreviewToken: "fresh-token-xyz",
  };

  const result = buildOddsChangedReconfirm(null, failure);

  assert.equal(result.preview.previewToken, "fresh-token-xyz");
  assert.match(result.message, /—/); // unknown old odds rendered as em dash, not a crash
  assert.match(result.message, /1\.95/);
});

test("getBetConfirmErrorMessage: odds_changed has a defensive fallback message even though forms intercept it first", () => {
  const failure: import("./betConfirmApi").BetConfirmOddsChangedFailure = {
    kind: "odds_changed",
    refreshedPreview: refreshedSinglePreviewBody() as import("./betPreviewApi").BetPreview,
    refreshedPreviewToken: "fresh-token-xyz",
  };
  const message = getBetConfirmErrorMessage(failure);
  assert.equal(typeof message, "string");
  assert.ok(message.length > 0);
});
