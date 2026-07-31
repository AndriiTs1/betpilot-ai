import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { BetSelectionOddsStatus } from "@/lib/generated/prisma/client";

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

// Stage 3.1 — provider event references + canonical market/selection
// identity, carried through the signed token so createBetFromPreview.ts can
// persist them at confirm time without a second provider request or any
// fuzzy re-matching. All seven fields are `string | null` (never bare
// `string`, matching this file's existing odds/totalOdds convention) and
// ALWAYS present on a token this file itself signs — `null` means
// "verification never resolved trustworthy provider event metadata for
// this selection," never "field omitted." Backward compatibility: an OLDER
// token (signed before this change) genuinely has these keys missing
// (`undefined` at decode time, not `null`) — hasValidPreviewTokenShape
// treats `undefined` as equivalent to `null` for exactly this reason, and
// verifyPreviewToken normalizes the decoded payload so this exported type's
// own contract (`string | null`, never `undefined`) still holds for every
// caller, old token or new. See lib/bets/buildBetSlipPreview.ts for where
// these are populated (only when oddsCheck.matched === true and the odds
// verifier actually resolved provider event metadata) and
// lib/bets/createBetFromPreview.ts for where they're persisted.
export interface PreviewTokenProviderMetadata {
  providerEventId: string | null;
  providerSportKey: string | null;
  eventStartTime: string | null;
  canonicalMarketType: string | null;
  canonicalSelectionType: string | null;
  canonicalParticipant: string | null;
  canonicalPeriod: string | null;
  // Betting Markets V1, Phase 2 — the numeric line for a TOTALS/SPREAD
  // selection (e.g. "2.5", "-1.5"), signed alongside the other canonical
  // fields above. Security-relevant: this is the value confirmation must
  // trust — never re-read from raw client input at confirm time. Same
  // null-means-"no line" / undefined-means-"older token" backward-
  // compatibility rule as every other field in this interface.
  canonicalLine: string | null;
  // Full event display metadata — the provider's own team names and a
  // human-readable competition name (see lib/odds/oddsVerifier.ts's
  // extractProviderEventMetadata), carried through the token so
  // createBetFromPreview.ts can persist them without a second provider
  // request. Same "all present or all null" / undefined-means-older-token
  // rules as every other field in this interface.
  homeTeamName: string | null;
  awayTeamName: string | null;
  competitionName: string | null;
}

// Partial, not the full (required) PreviewTokenProviderMetadata — so every
// existing call site/test fixture that constructs a PreviewTokenPayload
// object literal without knowing about Stage 3.1 keeps compiling unchanged
// (this is the DECODED/verified shape; verifyPreviewToken's own
// normalizeProviderMetadata is what actually guarantees `string | null`,
// never `undefined`, for every real token this module itself produces).
// Stage 10.2 — which provider resolved this event. Optional/nullable-by-
// omission on purpose, mirroring PreviewTokenProviderMetadata's own
// backward-compatibility rule immediately above: an older token (signed
// before this field existed) simply has it absent, normalized to
// "THE_ODDS_API" below (normalizeProviderMetadata) — the same value
// createBetFromPreview.ts already hardcoded unconditionally before this
// stage, so every existing token's real-world meaning is unchanged. A
// plain `string` (not an import of lib/odds/oddsProvider.ts's ProviderName)
// deliberately keeps this module dependency-light, matching its existing
// "no domain/provider imports" shape — validated only as "is this a
// non-empty string" by hasValidPreviewTokenShape below, same rigor as
// every other metadata field here.
export interface PreviewTokenPayload extends Partial<PreviewTokenProviderMetadata> {
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
  providerName?: string;
  issuedAt: number;
  expiresAt: number;
}

export interface PreviewTokenInput extends Partial<PreviewTokenProviderMetadata> {
  playerId: string;
  sport: string;
  event: string;
  outcome: string;
  stake: number;
  odds: number | null;
  totalOdds: number | null;
  oddsCheck: PreviewTokenOddsCheck | null;
  providerName?: string;
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

// Stage 3.1 — `undefined` (key absent, an older token signed before this
// field existed) and `null` (a newer token that explicitly knows there is
// no provider event metadata) are BOTH valid — this is exactly the
// backward-compatibility rule: an old token's missing keys must decode
// successfully, not be rejected as malformed.
function isOptionalNullableString(value: unknown): value is string | null | undefined {
  return value === undefined || value === null || typeof value === "string";
}

const PROVIDER_METADATA_KEYS = [
  "providerEventId",
  "providerSportKey",
  "eventStartTime",
  "canonicalMarketType",
  "canonicalSelectionType",
  "canonicalParticipant",
  "canonicalPeriod",
  "canonicalLine",
  "homeTeamName",
  "awayTeamName",
  "competitionName",
] as const;

function hasValidProviderMetadataShape(p: Record<string, unknown>): boolean {
  return PROVIDER_METADATA_KEYS.every((key) => isOptionalNullableString(p[key]));
}

// Normalizes an already shape-validated SINGLE payload's provider-metadata
// keys: an absent (`undefined`) key from an older token becomes `null`,
// matching PreviewTokenProviderMetadata's own `string | null` contract —
// every caller of verifyPreviewToken sees exactly one shape, old token or
// new, never `| undefined` leaking through. (EXPRESS has its own
// per-selection equivalent, normalizeExpressSelection, below.)
function normalizeProviderMetadata(p: PreviewTokenPayload): PreviewTokenPayload {
  return {
    ...p,
    providerEventId: p.providerEventId ?? null,
    providerSportKey: p.providerSportKey ?? null,
    eventStartTime: p.eventStartTime ?? null,
    canonicalMarketType: p.canonicalMarketType ?? null,
    canonicalSelectionType: p.canonicalSelectionType ?? null,
    canonicalParticipant: p.canonicalParticipant ?? null,
    canonicalPeriod: p.canonicalPeriod ?? null,
    canonicalLine: p.canonicalLine ?? null,
    homeTeamName: p.homeTeamName ?? null,
    awayTeamName: p.awayTeamName ?? null,
    competitionName: p.competitionName ?? null,
    // Stage 10.2 — an absent providerName (every token signed before this
    // field existed) means exactly what createBetFromPreview.ts already
    // hardcoded unconditionally: "THE_ODDS_API". Never left undefined.
    providerName: p.providerName ?? "THE_ODDS_API",
  };
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
    (p.providerName === undefined || (typeof p.providerName === "string" && p.providerName.length > 0)) &&
    typeof p.issuedAt === "number" &&
    typeof p.expiresAt === "number" &&
    hasValidProviderMetadataShape(p)
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
    providerName: input.providerName ?? "THE_ODDS_API",
    providerEventId: input.providerEventId ?? null,
    providerSportKey: input.providerSportKey ?? null,
    eventStartTime: input.eventStartTime ?? null,
    canonicalMarketType: input.canonicalMarketType ?? null,
    canonicalSelectionType: input.canonicalSelectionType ?? null,
    canonicalParticipant: input.canonicalParticipant ?? null,
    canonicalPeriod: input.canonicalPeriod ?? null,
    canonicalLine: input.canonicalLine ?? null,
    homeTeamName: input.homeTeamName ?? null,
    awayTeamName: input.awayTeamName ?? null,
    competitionName: input.competitionName ?? null,
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

  // Stage 3.1 — normalizes an older token's absent provider-metadata keys
  // to `null`, so every caller of this function sees PreviewTokenPayload's
  // declared `string | null` contract, never `undefined`, regardless of
  // which code version originally signed the token.
  const payload = normalizeProviderMetadata(decoded as PreviewTokenPayload);

  if (payload.issuedAt > payload.expiresAt) {
    return { ok: false, reason: "invalid_payload" };
  }

  const now = Math.floor(Date.now() / 1000);
  if (payload.expiresAt <= now) {
    return { ok: false, reason: "expired" };
  }

  return { ok: true, payload };
}

// --- Stage 12, Phase 4, Step 1 — EXPRESS support -----------------------
//
// Everything below is purely additive: not one line above this comment was
// changed. `PreviewTokenPayload`/`PreviewTokenInput`/`signPreviewToken`/
// `verifyPreviewToken` keep their exact pre-existing names, shapes, and
// behavior, because `lib/bets/createBetFromPreview.ts` and
// `app/api/miniapp/bets/text/confirm/route.ts` import `PreviewTokenPayload`
// and call `verifyPreviewToken` today assuming an unconditional SINGLE
// shape — turning that exact exported name into a real discriminated union
// would force those two files (out of scope for this step) to add
// narrowing before every field access, breaking the build. So the "SINGLE
// | EXPRESS discriminated union" this step asks for is expressed as a new
// type, `AnyPreviewTokenPayload`, that treats the untouched
// `PreviewTokenPayload` as its SINGLE member — the union exists and is
// exported for future code (Phase 4 Step 2+) to use, without renaming the
// symbol every existing caller already depends on. Signing and verifying
// EXPRESS tokens go through their own new functions
// (signExpressPreviewToken / verifyExpressPreviewToken) rather than
// overloading the existing ones, for the same reason: zero risk of
// changing what SINGLE already does.
//
// Same crypto model as SINGLE: HMAC-SHA256 over the base64url payload, same
// secret, same TOKEN_VERSION, same TTL_SECONDS, same expiry/signature
// checks — only the payload shape and its runtime validation are new.

// stake/totalOdds/potentialWin/submittedOdds/currentOdds are carried as
// decimal strings, not JS numbers — mirrors lib/bets/serialize.ts's
// Decimal.toString() convention elsewhere in this codebase, so a value
// computed via Prisma.Decimal (lib/bets/expressMath.ts) round-trips through
// this token exactly, with no float re-parsing. This module has no Prisma
// runtime dependency (only the type-only BetSelectionOddsStatus import
// above), so validation below checks the string's *shape* via regex, never
// by parsing it into a number.
const DECIMAL_STRING_PATTERN = /^-?\d+(\.\d+)?$/;

// Mirrors lib/bets/betSlipRules.ts's MIN_EXPRESS_SELECTIONS /
// MAX_EXPRESS_SELECTIONS. Duplicated rather than imported: this step's
// scope only permits importing types into this module, not runtime values,
// and this module has otherwise always been dependency-free besides
// node:crypto. Keep these two literals in sync with betSlipRules.ts by
// hand if that domain rule ever changes.
const MIN_EXPRESS_SELECTIONS = 2;
const MAX_EXPRESS_SELECTIONS = 10;

const VALID_ODDS_STATUSES: readonly string[] = [
  "PENDING",
  "VERIFIED",
  "ODDS_CHANGED",
  "NOT_FOUND",
  "UNAVAILABLE",
];

// Stage 3.1 — same PreviewTokenProviderMetadata fields as SINGLE's payload,
// per leg — Partial for the same reason PreviewTokenPayload above is
// Partial (existing call sites/fixtures unaffected; verifyExpressPreviewToken's
// own normalizeExpressSelection guarantees `string | null` for every real
// token this module produces). See PreviewTokenProviderMetadata's own doc
// comment above for the full null-vs-undefined/backward-compatibility
// contract, identical here.
export interface ExpressPreviewTokenSelection extends Partial<PreviewTokenProviderMetadata> {
  sport: string;
  event: string;
  outcome: string;
  market: string | null;
  submittedOdds: string | null;
  currentOdds: string | null;
  oddsStatus: BetSelectionOddsStatus;
}

export interface ExpressPreviewTokenPayload {
  v: typeof TOKEN_VERSION;
  previewId: string;
  playerId: string;
  type: "EXPRESS";
  stake: string;
  totalOdds: string;
  potentialWin: string;
  selections: ExpressPreviewTokenSelection[];
  issuedAt: number;
  expiresAt: number;
}

export interface ExpressPreviewTokenInput {
  playerId: string;
  stake: string;
  totalOdds: string;
  potentialWin: string;
  selections: ExpressPreviewTokenSelection[];
}

// The general "either kind of decoded token payload" type this step's spec
// asks for. PreviewTokenPayload (SINGLE) is reused as-is as one of its two
// members — see the block comment above for why it isn't renamed.
export type AnyPreviewTokenPayload = PreviewTokenPayload | ExpressPreviewTokenPayload;

export type PreviewTokenSignErrorCode = "EXPRESS_TOO_FEW_SELECTIONS" | "EXPRESS_TOO_MANY_SELECTIONS";

// Same narrow-purpose "Error subclass with an explicit code" convention as
// lib/bets/betSlipRules.ts's BetSlipValidationError — this module doesn't
// import that class (types-only import constraint for this step), so it
// gets its own, structurally equivalent one.
export class PreviewTokenSignError extends Error {
  readonly code: PreviewTokenSignErrorCode;

  constructor(code: PreviewTokenSignErrorCode, message: string) {
    super(message);
    this.name = "PreviewTokenSignError";
    this.code = code;
  }
}

export type VerifyExpressPreviewTokenResult =
  | { ok: true; payload: ExpressPreviewTokenPayload }
  | { ok: false; reason: VerifyPreviewTokenFailureReason };

function isValidDecimalString(value: unknown): value is string {
  return typeof value === "string" && DECIMAL_STRING_PATTERN.test(value);
}

function isValidOddsStatus(value: unknown): value is BetSelectionOddsStatus {
  return typeof value === "string" && VALID_ODDS_STATUSES.includes(value);
}

// Only the fields createBetFromPreview.ts's EXPRESS branch actually needs
// to write a BetSelection row — deliberately not the full
// BetSlipPreviewSelection shape (no bookmaker/discrepancyPercent:
// display-only, never written to BetSelection). `sport` is required here
// (added after Step 1 originally omitted it): BetSelection.sport is a
// required, non-nullable schema column, and — unlike a SINGLE bet — an
// EXPRESS bet has no single well-defined sport of its own (its legs can
// span different sports), so it genuinely is a per-selection fact, not
// something the caller already has at the whole-slip level.
function isExpressPreviewTokenSelectionShape(value: unknown): value is ExpressPreviewTokenSelection {
  if (typeof value !== "object" || value === null) return false;

  const s = value as Record<string, unknown>;
  return (
    typeof s.sport === "string" &&
    s.sport.length > 0 &&
    typeof s.event === "string" &&
    s.event.length > 0 &&
    typeof s.outcome === "string" &&
    s.outcome.length > 0 &&
    (s.market === null || typeof s.market === "string") &&
    (s.submittedOdds === null || isValidDecimalString(s.submittedOdds)) &&
    (s.currentOdds === null || isValidDecimalString(s.currentOdds)) &&
    isValidOddsStatus(s.oddsStatus) &&
    hasValidProviderMetadataShape(s)
  );
}

// Stage 3.1 — same undefined-to-null normalization as SINGLE's
// normalizeProviderMetadata, applied per-leg. An older EXPRESS token's
// selections legitimately have none of the seven new keys at all.
function normalizeExpressSelection(selection: ExpressPreviewTokenSelection): ExpressPreviewTokenSelection {
  return {
    ...selection,
    providerEventId: selection.providerEventId ?? null,
    providerSportKey: selection.providerSportKey ?? null,
    eventStartTime: selection.eventStartTime ?? null,
    canonicalMarketType: selection.canonicalMarketType ?? null,
    canonicalSelectionType: selection.canonicalSelectionType ?? null,
    canonicalParticipant: selection.canonicalParticipant ?? null,
    canonicalPeriod: selection.canonicalPeriod ?? null,
    canonicalLine: selection.canonicalLine ?? null,
    homeTeamName: selection.homeTeamName ?? null,
    awayTeamName: selection.awayTeamName ?? null,
    competitionName: selection.competitionName ?? null,
  };
}

// Same "validate everything except v separately" pattern as
// hasValidPreviewTokenShape above, for the same reason (a wrong version
// should report "invalid_version", not the generic "invalid_payload").
function hasValidExpressPreviewTokenShape(
  value: unknown,
): value is Omit<ExpressPreviewTokenPayload, "v"> & { v: unknown } {
  if (typeof value !== "object" || value === null) return false;

  const p = value as Record<string, unknown>;
  return (
    "v" in p &&
    typeof p.previewId === "string" &&
    p.previewId.length > 0 &&
    typeof p.playerId === "string" &&
    p.playerId.length > 0 &&
    p.type === "EXPRESS" &&
    isValidDecimalString(p.stake) &&
    isValidDecimalString(p.totalOdds) &&
    isValidDecimalString(p.potentialWin) &&
    Array.isArray(p.selections) &&
    p.selections.length >= MIN_EXPRESS_SELECTIONS &&
    p.selections.length <= MAX_EXPRESS_SELECTIONS &&
    p.selections.every(isExpressPreviewTokenSelectionShape) &&
    typeof p.issuedAt === "number" &&
    typeof p.expiresAt === "number"
  );
}

// Mirrors signPreviewToken's structure exactly. Rejects an out-of-range
// selections count at sign time too, not just at verify time — this
// module's own defense-in-depth, independent of (and not a replacement
// for) validateBetSlipType, which the future buildBetSlipPreview.ts caller
// already runs before this is ever reached.
export function signExpressPreviewToken(input: ExpressPreviewTokenInput, secret: string): string {
  if (input.selections.length < MIN_EXPRESS_SELECTIONS) {
    throw new PreviewTokenSignError(
      "EXPRESS_TOO_FEW_SELECTIONS",
      `signExpressPreviewToken: EXPRESS requires at least ${MIN_EXPRESS_SELECTIONS} selections, got ${input.selections.length}`,
    );
  }

  if (input.selections.length > MAX_EXPRESS_SELECTIONS) {
    throw new PreviewTokenSignError(
      "EXPRESS_TOO_MANY_SELECTIONS",
      `signExpressPreviewToken: EXPRESS supports at most ${MAX_EXPRESS_SELECTIONS} selections, got ${input.selections.length}`,
    );
  }

  const issuedAt = Math.floor(Date.now() / 1000);

  const payload: ExpressPreviewTokenPayload = {
    v: TOKEN_VERSION,
    previewId: randomUUID(),
    type: "EXPRESS",
    issuedAt,
    expiresAt: issuedAt + TTL_SECONDS,
    playerId: input.playerId,
    stake: input.stake,
    totalOdds: input.totalOdds,
    potentialWin: input.potentialWin,
    selections: input.selections,
  };

  const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = signEncodedPayload(encodedPayload, secret);

  return `${encodedPayload}.${signature}`;
}

// Mirrors verifyPreviewToken's structure exactly (parse -> verify
// signature -> decode -> validate shape -> check version -> check expiry).
// Deliberately not refactored into a shared helper with verifyPreviewToken
// — duplicating ~15 lines here is cheaper than any risk of changing what
// the existing, already-tested SINGLE verify path does.
export function verifyExpressPreviewToken(token: string, secret: string): VerifyExpressPreviewTokenResult {
  const parts = token.split(".");
  if (parts.length !== 2) return { ok: false, reason: "malformed" };

  const [encodedPayload, signature] = parts;
  if (!encodedPayload || !signature) return { ok: false, reason: "malformed" };

  const expectedSignature = signEncodedPayload(encodedPayload, secret);
  if (!safeCompare(expectedSignature, signature)) {
    return { ok: false, reason: "invalid_signature" };
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }

  if (!hasValidExpressPreviewTokenShape(decoded)) {
    return { ok: false, reason: "invalid_payload" };
  }

  if (decoded.v !== TOKEN_VERSION) {
    return { ok: false, reason: "invalid_version" };
  }

  // Stage 3.1 — normalize each leg's provider-metadata keys the same way
  // SINGLE's verifyPreviewToken does, so an older EXPRESS token's
  // selections (missing all seven keys) still decode to
  // ExpressPreviewTokenSelection's declared `string | null` contract.
  const rawPayload = decoded as ExpressPreviewTokenPayload;
  const payload: ExpressPreviewTokenPayload = {
    ...rawPayload,
    selections: rawPayload.selections.map(normalizeExpressSelection),
  };

  if (payload.issuedAt > payload.expiresAt) {
    return { ok: false, reason: "invalid_payload" };
  }

  const now = Math.floor(Date.now() / 1000);
  if (payload.expiresAt <= now) {
    return { ok: false, reason: "expired" };
  }

  return { ok: true, payload };
}
