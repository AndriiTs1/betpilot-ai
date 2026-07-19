import { prisma } from "@/lib/db/client";
import { Prisma, type Bet } from "@/lib/generated/prisma/client";
import type { PreviewTokenPayload } from "@/lib/betPreview/previewToken";

export interface CreateBetFromPreviewResult {
  bet: Bet;
  idempotent: boolean;
}

// P2002 = unique constraint violation. Confirmed against the actual runtime
// error (Prisma 7.8 + the Neon driver adapter): `err.meta` here is
// `{ modelName: "Bet", driverAdapterError: ... }` — no `meta.target` array,
// unlike the classic query-engine error shape older Prisma versions (and
// most docs/training data) show. Don't rely on target: this create() call
// has exactly one unique field that can ever collide (previewId — `id` is a
// server-generated cuid, never client-supplied, so it can't), so P2002 +
// modelName "Bet" is unambiguous at this call site.
function isPreviewIdUniqueViolation(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError &&
    err.code === "P2002" &&
    err.meta?.modelName === "Bet"
  );
}

// Idempotent, race-safe: the payload's previewId (from a verified token) is
// the only thing that can ever create a duplicate Bet. The upfront
// findUnique inside the transaction handles the common "same token confirmed
// twice, sequentially" case; the P2002 catch below handles two concurrent
// requests racing each other — Postgres aborts a transaction on the first
// error, so that recovery lookup MUST run outside the failed transaction on
// a fresh connection, not inside it.
export async function createBetFromPreview(
  payload: PreviewTokenPayload,
): Promise<CreateBetFromPreviewResult> {
  try {
    return await prisma.$transaction(async (tx) => {
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
    const existing = await prisma.bet.findUnique({ where: { previewId: payload.previewId } });
    if (existing) {
      return { bet: existing, idempotent: true };
    }

    throw err;
  }
}
