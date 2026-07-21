-- Stage 12, Phase 1 — schema-only groundwork for EXPRESS bets.
-- No TypeScript/runtime code reads any of this yet; existing SINGLE bets
-- are unaffected by every statement below.

-- Rename BetType.PARLAY -> EXPRESS. Verified directly against the database
-- immediately before this migration was written: 0 rows have type = 'PARLAY'
-- (9 total Bet rows, all SINGLE), so this is a pure metadata rename with no
-- data to remap. Using RENAME VALUE (not Prisma's default recreate-the-type
-- diff) because it's the simpler, purpose-built operation for this exact
-- same-shape rename and doesn't require rewriting the enum type or the
-- column that uses it.
ALTER TYPE "BetType" RENAME VALUE 'PARLAY' TO 'EXPRESS';

-- New per-selection odds-verification status. PENDING is the default but,
-- as of this stage, unreachable in practice — see BetSelectionOddsStatus's
-- doc comment in schema.prisma.
CREATE TYPE "BetSelectionOddsStatus" AS ENUM ('PENDING', 'VERIFIED', 'ODDS_CHANGED', 'NOT_FOUND', 'UNAVAILABLE');

-- An EXPRESS bet has no single event/outcome of its own (that detail now
-- lives per-leg on BetSelection) — widening only, existing SINGLE rows keep
-- their values unchanged.
ALTER TABLE "Bet" ALTER COLUMN "event" DROP NOT NULL,
ALTER COLUMN "outcome" DROP NOT NULL;

-- New, additive, nullable/defaulted BetSelection columns for EXPRESS
-- support. Existing outcome/odds columns are intentionally left as-is (not
-- renamed) — see BetSelection's doc comment in schema.prisma.
ALTER TABLE "BetSelection" ADD COLUMN "currentOdds" DECIMAL(6,2),
ADD COLUMN "market" TEXT,
ADD COLUMN "oddsStatus" "BetSelectionOddsStatus" NOT NULL DEFAULT 'PENDING';
