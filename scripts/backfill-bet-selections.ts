import "dotenv/config";
import { PrismaClient, Prisma } from "../lib/generated/prisma/client";
import { PrismaNeon } from "@prisma/adapter-neon";

// Stage 2B backfill: creates exactly one BetSelection per existing SINGLE
// Bet that doesn't have one yet, copying sport/event/outcome/odds, and sets
// Bet.totalOdds = Bet.odds. Does not touch OddsSnapshot, status, stake,
// playerId, rawMessage, or timestamps. Does not touch EXPRESS bets (formerly
// PARLAY — there are none today, but the selection criterion below excludes
// them regardless).
//
// Idempotent by construction: the selection criterion is "type: SINGLE AND
// selections: none", so once a Bet has its one BetSelection, it no longer
// matches on a re-run — re-running after a successful backfill always
// processes 0 bets.
//
// Usage:
//   npx tsx scripts/backfill-bet-selections.ts --dry-run   (no writes)
//   npx tsx scripts/backfill-bet-selections.ts             (real run)

const adapter = new PrismaNeon({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

const isDryRun = process.argv.includes("--dry-run");

// Masks a cuid for safe logging — same convention as the Stage 2A/2B audit
// scripts, never print full IDs or any secret/connection info.
function maskId(id: string): string {
  return `${id.slice(0, 8)}...`;
}

interface CandidateBet {
  id: string;
  sport: string;
  // Stage 12 — Bet.event/outcome became nullable (an EXPRESS bet has
  // neither), but this script only ever selects type: SINGLE, and every
  // real SINGLE row still has both set. The runtime guard in runBackfill()
  // below asserts that, matching this file's existing defense-in-depth style.
  event: string | null;
  outcome: string | null;
  odds: Prisma.Decimal | null;
  type: string;
}

async function findCandidates(): Promise<CandidateBet[]> {
  return prisma.bet.findMany({
    where: { type: "SINGLE", selections: { none: {} } },
    select: { id: true, sport: true, event: true, outcome: true, odds: true, type: true },
    orderBy: { createdAt: "asc" },
  });
}

async function runDryRun(): Promise<void> {
  const candidates = await findCandidates();
  const expressCount = await prisma.bet.count({ where: { type: "EXPRESS" } });
  const oddsSnapshotCountBefore = await prisma.oddsSnapshot.count();

  console.log("=== DRY RUN — no data will be written ===");
  console.log("Candidate bets (type=SINGLE, selections: none):", candidates.length);
  console.log("EXPRESS bets in database (never touched by this script):", expressCount);
  console.log("OddsSnapshot count (will remain unchanged):", oddsSnapshotCountBefore);
  console.log("");
  console.log("Planned changes:");
  for (const bet of candidates) {
    console.log(
      `  ${maskId(bet.id)} -> create 1 BetSelection(sport=${bet.sport}, event=${bet.event}, outcome=${bet.outcome}, odds=${bet.odds ?? "null"}); set totalOdds=${bet.odds ?? "null"}`,
    );
  }
  console.log("");
  console.log(`Would create ${candidates.length} BetSelection row(s).`);
  console.log(`Would update ${candidates.length} Bet row(s) (totalOdds only).`);
}

async function runBackfill(): Promise<void> {
  const startedAt = Date.now();
  const candidates = await findCandidates();

  let created = 0;
  let updated = 0;
  const skipped = 0; // candidates query already excludes non-matching bets; nothing is skipped mid-run

  await prisma.$transaction(async (tx) => {
    for (const bet of candidates) {
      // Defense-in-depth: re-assert the invariants the selection query
      // already guarantees, so a logic change elsewhere can't silently
      // corrupt data — any violation aborts the whole transaction.
      if (bet.type !== "SINGLE") {
        throw new Error(`Refusing to backfill non-SINGLE bet ${maskId(bet.id)} (type=${bet.type})`);
      }

      if (bet.event === null || bet.outcome === null) {
        throw new Error(`Refusing to backfill bet ${maskId(bet.id)} — event/outcome unexpectedly null`);
      }

      const existingSelections = await tx.betSelection.count({ where: { betId: bet.id } });
      if (existingSelections > 0) {
        throw new Error(`Refusing to backfill bet ${maskId(bet.id)} — it already has a selection`);
      }

      await tx.betSelection.create({
        data: {
          betId: bet.id,
          sport: bet.sport,
          event: bet.event,
          outcome: bet.outcome,
          odds: bet.odds,
        },
      });
      created += 1;

      await tx.bet.update({
        where: { id: bet.id },
        data: { totalOdds: bet.odds },
      });
      updated += 1;
    }
  });

  const durationMs = Date.now() - startedAt;

  console.log("=== BACKFILL COMPLETE ===");
  console.log("Processed:", candidates.length);
  console.log("Created selections:", created);
  console.log("Updated bets:", updated);
  console.log("Skipped:", skipped);
  console.log("Duration (ms):", durationMs);
  console.log("Errors: 0");
}

async function main(): Promise<void> {
  if (isDryRun) {
    await runDryRun();
  } else {
    await runBackfill();
  }
}

main()
  .catch((err) => {
    console.error("Backfill failed — transaction rolled back, no partial writes committed.");
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
