import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

// Short-lived signed token: the only trusted carrier of a text-bet preview's
// content between POST .../preview and the not-yet-built confirm endpoint.
// No DB row backs this — everything the future confirm step needs travels
// inside the token itself.

const TOKEN_VERSION = 1 as const;
const TTL_SECONDS = 180;

export interface PreviewTokenOddsCheck {
  matched: boolean;
  withinTolerance: boolean | null;
  sourceOdds: number | null;
  bookmaker: string | null;
}

export interface PreviewTokenPayload {
  v: typeof TOKEN_VERSION;
  previewId: string;
  playerId: string;
  type: "SINGLE";
  sport: string;
  event: string;
  outcome: string;
  stake: number;
  odds: number | null;
  totalOdds: number | null;
  oddsCheck: PreviewTokenOddsCheck | null;
  issuedAt: number;
  expiresAt: number;
}

export interface PreviewTokenInput {
  playerId: string;
  sport: string;
  event: string;
  outcome: string;
  stake: number;
  odds: number | null;
  totalOdds: number | null;
  oddsCheck: PreviewTokenOddsCheck | null;
}

export type VerifyPreviewTokenFailureReason =
  | "malformed"
  | "invalid_signature"
  | "invalid_version"
  | "invalid_payload"
  | "expired";

export type VerifyPreviewTokenResult =
  | { ok: true; payload: PreviewTokenPayload }
  | { ok: false; reason: VerifyPreviewTokenFailureReason };

function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);

  if (bufA.length !== bufB.length) return false;

  return timingSafeEqual(bufA, bufB);
}

function signEncodedPayload(encodedPayload: string, secret: string): string {
  return createHmac("sha256", secret).update(encodedPayload).digest("base64url");
}

function isPreviewTokenOddsCheckShape(value: unknown): value is PreviewTokenOddsCheck | null {
  if (value === null) return true;
  if (typeof value !== "object") return false;

  const o = value as Record<string, unknown>;
  return (
    typeof o.matched === "boolean" &&
    (o.withinTolerance === null || typeof o.withinTolerance === "boolean") &&
    (o.sourceOdds === null || typeof o.sourceOdds === "number") &&
    (o.bookmaker === null || typeof o.bookmaker === "string")
  );
}

// Validates every field's shape except `v`, which is checked separately by
// the caller so a wrong version can be reported as "invalid_version" rather
// than the generic "invalid_payload".
function hasValidPreviewTokenShape(
  value: unknown,
): value is Omit<PreviewTokenPayload, "v"> & { v: unknown } {
  if (typeof value !== "object" || value === null) return false;

  const p = value as Record<string, unknown>;
  return (
    "v" in p &&
    typeof p.previewId === "string" &&
    typeof p.playerId === "string" &&
    p.type === "SINGLE" &&
    typeof p.sport === "string" &&
    typeof p.event === "string" &&
    typeof p.outcome === "string" &&
    typeof p.stake === "number" &&
    (p.odds === null || typeof p.odds === "number") &&
    (p.totalOdds === null || typeof p.totalOdds === "number") &&
    isPreviewTokenOddsCheckShape(p.oddsCheck) &&
    typeof p.issuedAt === "number" &&
    typeof p.expiresAt === "number"
  );
}

// Caller must guarantee a non-empty secret (mirrors verifyInitData(initData,
// botToken) — the missing-config check lives at the route, not here).
export function signPreviewToken(input: PreviewTokenInput, secret: string): string {
  const issuedAt = Math.floor(Date.now() / 1000);

  const payload: PreviewTokenPayload = {
    v: TOKEN_VERSION,
    previewId: randomUUID(),
    type: "SINGLE",
    issuedAt,
    expiresAt: issuedAt + TTL_SECONDS,
    playerId: input.playerId,
    sport: input.sport,
    event: input.event,
    outcome: input.outcome,
    stake: input.stake,
    odds: input.odds,
    totalOdds: input.totalOdds,
    oddsCheck: input.oddsCheck,
  };

  const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = signEncodedPayload(encodedPayload, secret);

  return `${encodedPayload}.${signature}`;
}

export function verifyPreviewToken(token: string, secret: string): VerifyPreviewTokenResult {
  const parts = token.split(".");
  if (parts.length !== 2) return { ok: false, reason: "malformed" };

  const [encodedPayload, signature] = parts;
  if (!encodedPayload || !signature) return { ok: false, reason: "malformed" };

  const expectedSignature = signEncodedPayload(encodedPayload, secret);
  if (!safeCompare(expectedSignature, signature)) {
    return { ok: false, reason: "invalid_signature" };
  }

  // Signature verified — safe to decode. No re-serialization: the decoded
  // object is used as-is, never re-stringified for comparison.
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }

  if (!hasValidPreviewTokenShape(decoded)) {
    return { ok: false, reason: "invalid_payload" };
  }

  if (decoded.v !== TOKEN_VERSION) {
    return { ok: false, reason: "invalid_version" };
  }

  const payload = decoded as PreviewTokenPayload;

  if (payload.issuedAt > payload.expiresAt) {
    return { ok: false, reason: "invalid_payload" };
  }

  const now = Math.floor(Date.now() / 1000);
  if (payload.expiresAt <= now) {
    return { ok: false, reason: "expired" };
  }

  return { ok: true, payload };
}
