import { prisma } from "@/lib/db/client";
import { Prisma, type Bet, type BetSelection, type PrismaClient } from "@/lib/generated/prisma/client";
import type {
  PreviewTokenPayload,
  ExpressPreviewTokenPayload,
  AnyPreviewTokenPayload,
} from "@/lib/betPreview/previewToken";
import { MIN_EXPRESS_SELECTIONS, MAX_EXPRESS_SELECTIONS } from "@/lib/bets/betSlipRules";

export interface CreateBetFromPreviewResult {
  bet: Bet;
  idempotent: boolean;
}

// Stage 12, Phase 4, Step 3 — the EXPRESS counterpart of
// CreateBetFromPreviewResult. Always carries its selections: unlike SINGLE
// (which has never had BetSelection rows and isn't gaining them this step),
// an EXPRESS Bet is meaningless to a caller without its legs — the
// confirm route Step 4 will build hasn't been written yet, but whatever it
// does will need these, not just the Bet row's own scalar columns.
export interface CreateExpressBetFromPreviewResult {
  bet: Bet & { selections: BetSelection[] };
  idempotent: boolean;
}

// Injectable so tests can supply an in-memory fake instead of a real
// database connection — same DI shape as buildBetSlipPreview.ts's
// verifyOddsFn option. Typed as the exact real PrismaClient (not a
// hand-rolled structural interface): production always gets the real
// singleton with zero risk of a type mismatch; test fakes are passed in via
// an explicit `as unknown as PrismaClient` cast at the call site instead of
// this module trying to precisely re-derive Prisma's generated types.
export interface CreateBetFromPreviewOptions {
  db?: PrismaClient;
}

// P2002 = unique constraint violation. Confirmed against the actual runtime
// error (Prisma 7.8 + the Neon driver adapter): `err.meta` here is
// `{ modelName: "Bet", driverAdapterError: ... }` — no `meta.target` array,
// unlike the classic query-engine error shape older Prisma versions (and
// most docs/training data) show. Don't rely on target: this create() call
// has exactly one unique field that can ever collide (previewId — `id` is a
// server-generated cuid, never client-supplied, so it can't), so P2002 +
// modelName "Bet" is unambiguous at this call site. Shared by both the
// SINGLE and EXPRESS creation paths below — the constraint and its failure
// shape are the same regardless of which one is racing.
function isPreviewIdUniqueViolation(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError &&
    err.code === "P2002" &&
    err.meta?.modelName === "Bet"
  );
}

export type CreateBetFromPreviewValidationErrorCode =
  | "UNKNOWN_PAYLOAD_TYPE"
  | "EXPRESS_INVALID_SELECTIONS_ARRAY"
  | "EXPRESS_TOO_FEW_SELECTIONS"
  | "EXPRESS_TOO_MANY_SELECTIONS"
  | "EXPRESS_MISSING_IDENTIFIER"
  | "EXPRESS_INVALID_DECIMAL"
  | "EXPRESS_SELECTION_INVALID_SHAPE";

// Same narrow-purpose "Error subclass with an explicit code" convention
// already used by lib/bets/betSlipRules.ts's BetSlipValidationError and
// lib/betPreview/previewToken.ts's PreviewTokenSignError.
export class CreateBetFromPreviewValidationError extends Error {
  readonly code: CreateBetFromPreviewValidationErrorCode;

  constructor(code: CreateBetFromPreviewValidationErrorCode, message: string) {
    super(message);
    this.name = "CreateBetFromPreviewValidationError";
    this.code = code;
  }
}

// This function's contract has always assumed a *verified* payload — the
// confirm route only ever reaches this file after verifyPreviewToken /
// verifyExpressPreviewToken has already checked the token's signature and
// decoded shape (lib/betPreview/previewToken.ts). This is a second,
// narrower defense-in-depth guard specifically for the EXPRESS write path,
// not a replacement for that verification and not a duplicate of it: this
// step's scope forbids modifying previewToken.ts, and its shape-validating
// functions aren't exported, so there is nothing importable to reuse here.
// what's checked mirrors isExpressPreviewTokenPayloadShape /
// isExpressPreviewTokenSelectionShape's rules by necessity (the payload
// still needs to be well-formed before a DB write), but the selection
// *count* range comes directly from lib/bets/betSlipRules.ts's exported
// constants rather than being duplicated a third time.
const DECIMAL_STRING_PATTERN = /^-?\d+(\.\d+)?$/;
const VALID_ODDS_STATUSES: readonly string[] = ["PENDING", "VERIFIED", "ODDS_CHANGED", "NOT_FOUND", "UNAVAILABLE"];

function isValidDecimalString(value: unknown): value is string {
  return typeof value === "string" && DECIMAL_STRING_PATTERN.test(value);
}

function assertValidExpressPayload(payload: ExpressPreviewTokenPayload): void {
  if (payload.previewId.length === 0 || payload.playerId.length === 0) {
    throw new CreateBetFromPreviewValidationError(
      "EXPRESS_MISSING_IDENTIFIER",
      "createBetFromPreview: EXPRESS payload is missing previewId/playerId",
    );
  }

  if (!isValidDecimalString(payload.stake) || !isValidDecimalString(payload.totalOdds)) {
    throw new CreateBetFromPreviewValidationError(
      "EXPRESS_INVALID_DECIMAL",
      "createBetFromPreview: EXPRESS payload's stake/totalOdds is not a valid decimal string",
    );
  }

  if (!Array.isArray(payload.selections)) {
    throw new CreateBetFromPreviewValidationError(
      "EXPRESS_INVALID_SELECTIONS_ARRAY",
      "createBetFromPreview: EXPRESS payload.selections is not an array",
    );
  }

  if (payload.selections.length < MIN_EXPRESS_SELECTIONS) {
    throw new CreateBetFromPreviewValidationError(
      "EXPRESS_TOO_FEW_SELECTIONS",
      `createBetFromPreview: EXPRESS requires at least ${MIN_EXPRESS_SELECTIONS} selections, got ${payload.selections.length}`,
    );
  }

  if (payload.selections.length > MAX_EXPRESS_SELECTIONS) {
    throw new CreateBetFromPreviewValidationError(
      "EXPRESS_TOO_MANY_SELECTIONS",
      `createBetFromPreview: EXPRESS supports at most ${MAX_EXPRESS_SELECTIONS} selections, got ${payload.selections.length}`,
    );
  }

  for (const selection of payload.selections) {
    const validShape =
      typeof selection.sport === "string" &&
      selection.sport.length > 0 &&
      typeof selection.event === "string" &&
      selection.event.length > 0 &&
      typeof selection.outcome === "string" &&
      selection.outcome.length > 0 &&
      (selection.market === null || typeof selection.market === "string") &&
      (selection.submittedOdds === null || isValidDecimalString(selection.submittedOdds)) &&
      (selection.currentOdds === null || isValidDecimalString(selection.currentOdds)) &&
      typeof selection.oddsStatus === "string" &&
      VALID_ODDS_STATUSES.includes(selection.oddsStatus);

    if (!validShape) {
      throw new CreateBetFromPreviewValidationError(
        "EXPRESS_SELECTION_INVALID_SHAPE",
        `createBetFromPreview: EXPRESS selection for "${String(selection?.event)}" is missing a required field or has an invalid value`,
      );
    }
  }
}

// Overloads: the confirm route (unchanged, out of this step's scope) calls
// this with a payload already narrowed to PreviewTokenPayload (SINGLE) by
// its own `payload.type !== "SINGLE"` guard — that call site keeps
// resolving to the first overload and gets back the exact same
// CreateBetFromPreviewResult shape it always has, unaffected by anything
// below. The second overload (EXPRESS) is new; nothing forbidden-to-touch
// calls it yet.
export async function createBetFromPreview(
  payload: PreviewTokenPayload,
  options?: CreateBetFromPreviewOptions,
): Promise<CreateBetFromPreviewResult>;
export async function createBetFromPreview(
  payload: ExpressPreviewTokenPayload,
  options?: CreateBetFromPreviewOptions,
): Promise<CreateExpressBetFromPreviewResult>;
export async function createBetFromPreview(
  payload: AnyPreviewTokenPayload,
  options: CreateBetFromPreviewOptions = {},
): Promise<CreateBetFromPreviewResult | CreateExpressBetFromPreviewResult> {
  const db = options.db ?? prisma;

  if (payload.type === "SINGLE") {
    return createSingleBetFromPreview(payload, db);
  }

  if (payload.type === "EXPRESS") {
    return createExpressBetFromPreview(payload, db);
  }

  // Unreachable through any currently-typed caller (AnyPreviewTokenPayload
  // only ever has these two members) — a last defense-in-depth guard for
  // exactly the "don't accept an unverified arbitrary object" requirement,
  // in case something upstream ever bypasses the type system (e.g. an `as`
  // cast around a malformed decoded token).
  throw new CreateBetFromPreviewValidationError(
    "UNKNOWN_PAYLOAD_TYPE",
    `createBetFromPreview: unknown payload type "${(payload as { type: unknown }).type}"`,
  );
}

// Byte-for-byte the same logic this file has had since Phase 3 — only the
// database client is now a parameter instead of the module-level `prisma`
// import, so tests can inject a fake. No SINGLE behavior, field, or return
// shape changed: same idempotent-transaction-then-P2002-recovery model,
// same OddsSnapshot side-write, same fields written to Bet, still no
// BetSelection row created for SINGLE (unchanged — Stage 12 hasn't
// backfilled the live write path yet, only the one-time historical
// backfill script, and extending that is explicitly out of this step's
// scope).
async function createSingleBetFromPreview(
  payload: PreviewTokenPayload,
  db: PrismaClient,
): Promise<CreateBetFromPreviewResult> {
  try {
    return await db.$transaction(async (tx) => {
      const existing = await tx.bet.findUnique({ where: { previewId: payload.previewId } });
      if (existing) {
        return { bet: existing, idempotent: true as const };
      }

      const created = await tx.bet.create({
        data: {
          playerId: payload.playerId,
          previewId: payload.previewId,
          type: "SINGLE",
          sport: payload.sport,
          event: payload.event,
          outcome: payload.outcome,
          stake: new Prisma.Decimal(payload.stake),
          odds: payload.odds !== null ? new Prisma.Decimal(payload.odds) : null,
          totalOdds: payload.totalOdds !== null ? new Prisma.Decimal(payload.totalOdds) : null,
          status: "PENDING",
        },
      });

      if (payload.oddsCheck !== null && payload.odds !== null) {
        await tx.oddsSnapshot.create({
          data: {
            betId: created.id,
            sourceOdds:
              payload.oddsCheck.sourceOdds !== null
                ? new Prisma.Decimal(payload.oddsCheck.sourceOdds)
                : null,
            submittedOdds: new Prisma.Decimal(payload.odds),
            matched: payload.oddsCheck.matched,
          },
        });
      }

      return { bet: created, idempotent: false as const };
    });
  } catch (err) {
    if (!isPreviewIdUniqueViolation(err)) throw err;

    // Transaction above was already rolled back by Prisma when the create
    // threw — this runs as a fresh query, not inside the aborted one.
    const existing = await db.bet.findUnique({ where: { previewId: payload.previewId } });
    if (existing) {
      return { bet: existing, idempotent: true };
    }

    throw err;
  }
}

// New for Stage 12, Phase 4, Step 3. Same idempotent-transaction shape as
// SINGLE above (upfront findUnique inside the transaction for the common
// sequential-double-confirm case, P2002 catch + fresh-connection recovery
// lookup for the concurrent-race case) — deliberately kept as a *separate*
// function rather than merged with createSingleBetFromPreview, so SINGLE's
// already-correct, already-battle-tested logic above is never at risk of
// being disturbed by EXPRESS's additional nested-selections write.
async function createExpressBetFromPreview(
  payload: ExpressPreviewTokenPayload,
  db: PrismaClient,
): Promise<CreateExpressBetFromPreviewResult> {
  assertValidExpressPayload(payload);

  // Bet.sport is a required, non-nullable column with no per-Bet meaning
  // for a multi-sport accumulator (see the Step 1/2 correction this step
  // built on) — per explicit instruction, it's set to the first selection's
  // sport, purely to satisfy the existing schema, not a real classification
  // of the whole bet.
  const betSport = payload.selections[0].sport;

  try {
    return await db.$transaction(async (tx) => {
      const existing = await tx.bet.findUnique({
        where: { previewId: payload.previewId },
        include: { selections: true },
      });
      if (existing) {
        return { bet: existing, idempotent: true as const };
      }

      // Nested create: Bet and every BetSelection are written as one
      // atomic operation (Prisma's nested-write guarantee), inside this
      // function's own $transaction wrapper on top of that — the same
      // belt-and-suspenders atomicity SINGLE's oddsSnapshot side-write
      // already relies on. There is no code path that persists a Bet
      // without its selections, or selections without their Bet.
      const created = await tx.bet.create({
        data: {
          playerId: payload.playerId,
          previewId: payload.previewId,
          type: "EXPRESS",
          sport: betSport,
          event: null,
          outcome: null,
          odds: null,
          stake: new Prisma.Decimal(payload.stake),
          totalOdds: new Prisma.Decimal(payload.totalOdds),
          status: "PENDING",
          selections: {
            create: payload.selections.map((selection) => ({
              sport: selection.sport,
              event: selection.event,
              outcome: selection.outcome,
              market: selection.market,
              odds: selection.submittedOdds !== null ? new Prisma.Decimal(selection.submittedOdds) : null,
              currentOdds: selection.currentOdds !== null ? new Prisma.Decimal(selection.currentOdds) : null,
              oddsStatus: selection.oddsStatus,
            })),
          },
        },
        include: { selections: true },
      });

      return { bet: created, idempotent: false as const };
    });
  } catch (err) {
    if (!isPreviewIdUniqueViolation(err)) throw err;

    const existing = await db.bet.findUnique({
      where: { previewId: payload.previewId },
      include: { selections: true },
    });
    if (existing) {
      return { bet: existing, idempotent: true };
    }

    throw err;
  }
}
