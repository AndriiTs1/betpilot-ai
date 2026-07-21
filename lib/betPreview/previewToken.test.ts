import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  signPreviewToken,
  verifyPreviewToken,
  signExpressPreviewToken,
  verifyExpressPreviewToken,
  PreviewTokenSignError,
  type PreviewTokenInput,
  type ExpressPreviewTokenInput,
  type ExpressPreviewTokenSelection,
} from "./previewToken";

const SECRET = "test-secret-do-not-use-in-production";

function singleInput(overrides: Partial<PreviewTokenInput> = {}): PreviewTokenInput {
  return {
    playerId: "player-1",
    sport: "football",
    event: "Real Madrid vs Barcelona",
    outcome: "Real Madrid Win",
    stake: 100,
    odds: 2.1,
    totalOdds: 2.1,
    oddsCheck: { matched: true, withinTolerance: true, sourceOdds: 2.1, bookmaker: "Bet365" },
    ...overrides,
  };
}

function expressSelection(overrides: Partial<ExpressPreviewTokenSelection> = {}): ExpressPreviewTokenSelection {
  return {
    sport: "Football",
    event: "Real Madrid vs Barcelona",
    outcome: "Real Madrid Win",
    market: "Match Winner",
    submittedOdds: "1.80",
    currentOdds: "1.80",
    oddsStatus: "VERIFIED",
    ...overrides,
  };
}

function expressInput(overrides: Partial<ExpressPreviewTokenInput> = {}): ExpressPreviewTokenInput {
  return {
    playerId: "player-1",
    stake: "40.00",
    totalOdds: "3.06",
    potentialWin: "122.40",
    selections: [
      expressSelection({
        sport: "Football",
        event: "Real Madrid vs Barcelona",
        outcome: "Real Madrid Win",
        submittedOdds: "1.80",
      }),
      expressSelection({
        sport: "Tennis",
        event: "Inter Milan vs Juventus",
        outcome: "Over 2.5 Goals",
        submittedOdds: "1.70",
      }),
    ],
    ...overrides,
  };
}

// ---------------------------------------------------------------------
// SINGLE — must remain byte-for-byte unbroken by the EXPRESS additions.
// ---------------------------------------------------------------------

test("SINGLE: sign -> verify roundtrip returns the exact payload", () => {
  const token = signPreviewToken(singleInput(), SECRET);
  const result = verifyPreviewToken(token, SECRET);

  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(result.payload.type, "SINGLE");
  assert.equal(result.payload.playerId, "player-1");
  assert.equal(result.payload.sport, "football");
  assert.equal(result.payload.event, "Real Madrid vs Barcelona");
  assert.equal(result.payload.outcome, "Real Madrid Win");
  assert.equal(result.payload.stake, 100);
  assert.equal(result.payload.odds, 2.1);
  assert.equal(result.payload.totalOdds, 2.1);
  assert.deepEqual(result.payload.oddsCheck, {
    matched: true,
    withinTolerance: true,
    sourceOdds: 2.1,
    bookmaker: "Bet365",
  });
  assert.equal(typeof result.payload.previewId, "string");
  assert.ok(result.payload.previewId.length > 0);
});

test("SINGLE: null odds/totalOdds/oddsCheck round-trip as null", () => {
  const token = signPreviewToken(singleInput({ odds: null, totalOdds: null, oddsCheck: null }), SECRET);
  const result = verifyPreviewToken(token, SECRET);

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.payload.odds, null);
  assert.equal(result.payload.totalOdds, null);
  assert.equal(result.payload.oddsCheck, null);
});

test("SINGLE: a corrupted signature is rejected", () => {
  const token = signPreviewToken(singleInput(), SECRET);
  const [encodedPayload] = token.split(".");
  const tampered = `${encodedPayload}.not-the-real-signature`;

  const result = verifyPreviewToken(tampered, SECRET);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "invalid_signature");
});

test("SINGLE: a tampered payload (re-encoded, unsigned) is rejected", () => {
  const token = signPreviewToken(singleInput(), SECRET);
  const [, signature] = token.split(".");
  const forgedPayload = Buffer.from(JSON.stringify({ ...singleInput(), stake: 999999 }), "utf8").toString(
    "base64url",
  );

  const result = verifyPreviewToken(`${forgedPayload}.${signature}`, SECRET);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "invalid_signature");
});

test("SINGLE: an expired token is rejected", () => {
  const originalNow = Date.now;
  try {
    Date.now = () => new Date("2020-01-01T00:00:00Z").getTime();
    const token = signPreviewToken(singleInput(), SECRET);

    Date.now = () => new Date("2020-01-01T01:00:00Z").getTime(); // +1h, well past the 180s TTL
    const result = verifyPreviewToken(token, SECRET);

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, "expired");
  } finally {
    Date.now = originalNow;
  }
});

test("SINGLE: verifying with the wrong secret is rejected", () => {
  const token = signPreviewToken(singleInput(), SECRET);
  const result = verifyPreviewToken(token, "a-different-secret");
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "invalid_signature");
});

test("SINGLE: a malformed token string is rejected", () => {
  assert.equal(verifyPreviewToken("not-a-real-token", SECRET).ok, false);
  assert.equal(verifyPreviewToken("", SECRET).ok, false);
  assert.equal(verifyPreviewToken("only.one.dot.too.many", SECRET).ok, false);
});

// ---------------------------------------------------------------------
// EXPRESS
// ---------------------------------------------------------------------

test("EXPRESS: sign -> verify roundtrip with two selections returns the exact payload", () => {
  const token = signExpressPreviewToken(expressInput(), SECRET);
  const result = verifyExpressPreviewToken(token, SECRET);

  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(result.payload.type, "EXPRESS");
  assert.equal(result.payload.playerId, "player-1");
  assert.equal(result.payload.stake, "40.00");
  assert.equal(result.payload.totalOdds, "3.06");
  assert.equal(result.payload.potentialWin, "122.40");
  assert.equal(result.payload.selections.length, 2);
  assert.equal(result.payload.selections[0].sport, "Football");
  assert.equal(result.payload.selections[0].event, "Real Madrid vs Barcelona");
  assert.equal(result.payload.selections[0].submittedOdds, "1.80");
  assert.equal(result.payload.selections[1].sport, "Tennis");
  assert.equal(result.payload.selections[1].event, "Inter Milan vs Juventus");
  assert.equal(result.payload.selections[1].submittedOdds, "1.70");
  assert.equal(typeof result.payload.previewId, "string");
  assert.ok(result.payload.previewId.length > 0);
});

test("EXPRESS: each selection's sport is preserved independently, including a mixed-sport slip", () => {
  const token = signExpressPreviewToken(
    expressInput({
      selections: [
        expressSelection({ sport: "Football", event: "Match A" }),
        expressSelection({ sport: "Basketball", event: "Match B" }),
      ],
    }),
    SECRET,
  );
  const result = verifyExpressPreviewToken(token, SECRET);

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.payload.selections[0].sport, "Football");
  assert.equal(result.payload.selections[1].sport, "Basketball");
});

test("EXPRESS: decimal fields survive the roundtrip as the exact original strings (no float re-parsing)", () => {
  // A value that would lose precision if it were ever coerced through a
  // plain JS number round-trip.
  const token = signExpressPreviewToken(
    expressInput({ stake: "40.10", totalOdds: "1.10", potentialWin: "44.11" }),
    SECRET,
  );
  const result = verifyExpressPreviewToken(token, SECRET);

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.payload.stake, "40.10");
  assert.equal(result.payload.totalOdds, "1.10");
  assert.equal(result.payload.potentialWin, "44.11");
});

test("EXPRESS: a selection's null market/submittedOdds/currentOdds round-trip as null", () => {
  const token = signExpressPreviewToken(
    expressInput({
      selections: [
        expressSelection({ market: null, submittedOdds: null, currentOdds: null, oddsStatus: "UNAVAILABLE" }),
        expressSelection(),
      ],
    }),
    SECRET,
  );
  const result = verifyExpressPreviewToken(token, SECRET);

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.payload.selections[0].market, null);
  assert.equal(result.payload.selections[0].submittedOdds, null);
  assert.equal(result.payload.selections[0].currentOdds, null);
  assert.equal(result.payload.selections[0].oddsStatus, "UNAVAILABLE");
});

test("EXPRESS: sign -> verify roundtrip with exactly 10 selections succeeds", () => {
  const selections = Array.from({ length: 10 }, (_, i) =>
    expressSelection({ event: `Match ${i}`, outcome: `Outcome ${i}`, submittedOdds: "1.10" }),
  );
  const token = signExpressPreviewToken(expressInput({ selections }), SECRET);
  const result = verifyExpressPreviewToken(token, SECRET);

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.payload.selections.length, 10);
});

test("EXPRESS: signing with 0 selections throws PreviewTokenSignError(EXPRESS_TOO_FEW_SELECTIONS)", () => {
  assert.throws(
    () => signExpressPreviewToken(expressInput({ selections: [] }), SECRET),
    (err: unknown) => err instanceof PreviewTokenSignError && err.code === "EXPRESS_TOO_FEW_SELECTIONS",
  );
});

test("EXPRESS: signing with 1 selection throws PreviewTokenSignError(EXPRESS_TOO_FEW_SELECTIONS)", () => {
  assert.throws(
    () => signExpressPreviewToken(expressInput({ selections: [expressSelection()] }), SECRET),
    (err: unknown) => err instanceof PreviewTokenSignError && err.code === "EXPRESS_TOO_FEW_SELECTIONS",
  );
});

test("EXPRESS: signing with 11 selections throws PreviewTokenSignError(EXPRESS_TOO_MANY_SELECTIONS)", () => {
  const selections = Array.from({ length: 11 }, (_, i) => expressSelection({ event: `Match ${i}` }));
  assert.throws(
    () => signExpressPreviewToken(expressInput({ selections }), SECRET),
    (err: unknown) => err instanceof PreviewTokenSignError && err.code === "EXPRESS_TOO_MANY_SELECTIONS",
  );
});

// A 1- or 11-selection EXPRESS token can only reach verify by being forged
// (signing already rejects those counts) — exercised directly against
// verifyExpressPreviewToken by hand-crafting + signing a payload the normal
// sign function would refuse to produce, to prove verify-side validation is
// independent of the sign-side guard, not the only thing enforcing it.
function forgeExpressToken(payload: Record<string, unknown>, secret: string): string {
  const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = createHmac("sha256", secret).update(encodedPayload).digest("base64url");
  return `${encodedPayload}.${signature}`;
}

function baseForgedPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const issuedAt = Math.floor(Date.now() / 1000);
  return {
    v: 1,
    previewId: "forged-preview-id",
    playerId: "player-1",
    type: "EXPRESS",
    stake: "40.00",
    totalOdds: "3.06",
    potentialWin: "122.40",
    selections: [expressSelection(), expressSelection()],
    issuedAt,
    expiresAt: issuedAt + 180,
    ...overrides,
  };
}

test("EXPRESS: verifying a forged token with 1 selection is rejected", () => {
  const token = forgeExpressToken(baseForgedPayload({ selections: [expressSelection()] }), SECRET);
  const result = verifyExpressPreviewToken(token, SECRET);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "invalid_payload");
});

test("EXPRESS: verifying a forged token with 11 selections is rejected", () => {
  const selections = Array.from({ length: 11 }, (_, i) => expressSelection({ event: `Match ${i}` }));
  const token = forgeExpressToken(baseForgedPayload({ selections }), SECRET);
  const result = verifyExpressPreviewToken(token, SECRET);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "invalid_payload");
});

test("EXPRESS: verifying a forged token with 0 selections is rejected", () => {
  const token = forgeExpressToken(baseForgedPayload({ selections: [] }), SECRET);
  const result = verifyExpressPreviewToken(token, SECRET);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "invalid_payload");
});

test("EXPRESS: a selection missing a required field (event) is rejected", () => {
  const token = forgeExpressToken(
    baseForgedPayload({
      selections: [{ ...expressSelection(), event: undefined }, expressSelection()],
    }),
    SECRET,
  );
  const result = verifyExpressPreviewToken(token, SECRET);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "invalid_payload");
});

test("EXPRESS: a selection missing sport is rejected", () => {
  const token = forgeExpressToken(
    baseForgedPayload({
      selections: [{ ...expressSelection(), sport: undefined }, expressSelection()],
    }),
    SECRET,
  );
  const result = verifyExpressPreviewToken(token, SECRET);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "invalid_payload");
});

test("EXPRESS: a selection with an empty-string sport is rejected", () => {
  const token = forgeExpressToken(
    baseForgedPayload({
      selections: [{ ...expressSelection(), sport: "" }, expressSelection()],
    }),
    SECRET,
  );
  const result = verifyExpressPreviewToken(token, SECRET);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "invalid_payload");
});

test("EXPRESS: a selection with an unknown oddsStatus value is rejected", () => {
  const token = forgeExpressToken(
    baseForgedPayload({
      selections: [{ ...expressSelection(), oddsStatus: "NOT_A_REAL_STATUS" }, expressSelection()],
    }),
    SECRET,
  );
  const result = verifyExpressPreviewToken(token, SECRET);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "invalid_payload");
});

test("EXPRESS: a selection with a non-decimal-looking submittedOdds string is rejected", () => {
  const token = forgeExpressToken(
    baseForgedPayload({
      selections: [{ ...expressSelection(), submittedOdds: "not-a-number" }, expressSelection()],
    }),
    SECRET,
  );
  const result = verifyExpressPreviewToken(token, SECRET);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "invalid_payload");
});

test("EXPRESS: a corrupted signature is rejected", () => {
  const token = signExpressPreviewToken(expressInput(), SECRET);
  const [encodedPayload] = token.split(".");
  const result = verifyExpressPreviewToken(`${encodedPayload}.not-the-real-signature`, SECRET);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "invalid_signature");
});

test("EXPRESS: an expired token is rejected", () => {
  const originalNow = Date.now;
  try {
    Date.now = () => new Date("2020-01-01T00:00:00Z").getTime();
    const token = signExpressPreviewToken(expressInput(), SECRET);

    Date.now = () => new Date("2020-01-01T01:00:00Z").getTime(); // +1h, well past the 180s TTL
    const result = verifyExpressPreviewToken(token, SECRET);

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, "expired");
  } finally {
    Date.now = originalNow;
  }
});

// ---------------------------------------------------------------------
// Cross-type ("unknown type") rejection — each verify function only
// accepts its own token type, in both directions.
// ---------------------------------------------------------------------

test("cross-type: an EXPRESS token fed into verifyPreviewToken (SINGLE) is rejected", () => {
  const token = signExpressPreviewToken(expressInput(), SECRET);
  const result = verifyPreviewToken(token, SECRET);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "invalid_payload");
});

test("cross-type: a SINGLE token fed into verifyExpressPreviewToken is rejected", () => {
  const token = signPreviewToken(singleInput(), SECRET);
  const result = verifyExpressPreviewToken(token, SECRET);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "invalid_payload");
});

test("cross-type: a completely unknown type value is rejected by both verify functions", () => {
  const forged = baseForgedPayload({ type: "PARLAY" });
  const token = forgeExpressToken(forged, SECRET);

  const expressResult = verifyExpressPreviewToken(token, SECRET);
  assert.equal(expressResult.ok, false);
  if (!expressResult.ok) assert.equal(expressResult.reason, "invalid_payload");

  const singleResult = verifyPreviewToken(token, SECRET);
  assert.equal(singleResult.ok, false);
  if (!singleResult.ok) assert.equal(singleResult.reason, "invalid_payload");
});
