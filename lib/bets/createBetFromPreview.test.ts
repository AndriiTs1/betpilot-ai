import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createBetFromPreview,
  CreateBetFromPreviewValidationError,
  type CreateBetFromPreviewOptions,
} from "./createBetFromPreview";
import { Prisma, type PrismaClient } from "@/lib/generated/prisma/client";
import type { PreviewTokenPayload, ExpressPreviewTokenPayload, ExpressPreviewTokenSelection } from "@/lib/betPreview/previewToken";

// ---------------------------------------------------------------------
// In-memory fake Prisma client — this file's only test helper. Implements
// exactly the surface createBetFromPreview.ts actually calls (bet.findUnique
// / bet.create with nested selections / oddsSnapshot.create / $transaction)
// and nothing else, matching this codebase's no-mocking-library convention
// (lib/bets/buildBetSlipPreview.test.ts's fakeVerifyOddsFn is the same
// pattern, one level up). Passed to createBetFromPreview via an explicit
// `as unknown as PrismaClient` cast — real Prisma's generated types are too
// complex to hand-replicate structurally, and the production code path
// never uses this cast (it only ever runs against the real singleton).
// ---------------------------------------------------------------------

// Stage 3.1 — the eight provider/canonical reference fields, shared by both
// FakeBetRow (SINGLE) and FakeSelectionRow (EXPRESS legs), mirroring
// prisma/schema.prisma's own Variant-B field set on Bet/BetSelection.
interface FakeProviderReferenceColumns {
  providerName: string | null;
  providerEventId: string | null;
  providerSportKey: string | null;
  eventStartTime: Date | null;
  canonicalMarketType: string | null;
  canonicalSelectionType: string | null;
  canonicalParticipant: string | null;
  canonicalPeriod: string | null;
}

interface FakeBetRow extends FakeProviderReferenceColumns {
  id: string;
  playerId: string;
  previewId: string | null;
  type: "SINGLE" | "EXPRESS";
  sport: string;
  event: string | null;
  outcome: string | null;
  odds: Prisma.Decimal | null;
  totalOdds: Prisma.Decimal | null;
  stake: Prisma.Decimal;
  status: string;
  // Betting Markets V1, Phase 1 — mirrors prisma/schema.prisma's new
  // Bet.line column (Decimal(4,1), nullable). No production code sets
  // this yet (createBetFromPreview.ts is unchanged this phase — see
  // PreviewTokenPayload, which has no line field either) — modeled here
  // purely to prove the schema/fake-persistence layer itself can round-trip
  // a line value, independent of any application wiring.
  line: Prisma.Decimal | null;
  createdAt: Date;
  updatedAt: Date;
}

interface FakeSelectionRow extends FakeProviderReferenceColumns {
  id: string;
  betId: string;
  sport: string;
  event: string;
  outcome: string;
  market: string | null;
  odds: Prisma.Decimal | null;
  currentOdds: Prisma.Decimal | null;
  oddsStatus: string;
  // Same rationale as FakeBetRow.line above, mirroring BetSelection.line.
  line: Prisma.Decimal | null;
  createdAt: Date;
  updatedAt: Date;
}

function p2002(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError("Unique constraint failed on the fields: (`previewId`)", {
    code: "P2002",
    clientVersion: "test",
    meta: { modelName: "Bet" },
  });
}

interface FakeDbOptions {
  // Simulates a concurrent transaction: the transaction's own findUnique
  // sees nothing yet, but a row with the same previewId already exists by
  // the time create() runs (checked against the same shared store) — models
  // a genuine race, not just "skip the check".
  txFindUniqueSeesNothing?: boolean;
  // Throws partway through building nested selections (before anything is
  // committed to the store), to prove a failed selection insert leaves no
  // orphan Bet behind.
  failOnSelectionIndex?: number;
}

function createFakeDb(options: FakeDbOptions = {}) {
  let nextBetId = 1;
  let nextSelectionId = 1;
  const bets = new Map<string, FakeBetRow>();
  const selectionsByBetId = new Map<string, FakeSelectionRow[]>();
  const betIdByPreviewId = new Map<string, string>();
  let createCallCount = 0;

  function readBet(previewId: string): (FakeBetRow & { selections: FakeSelectionRow[] }) | null {
    const id = betIdByPreviewId.get(previewId);
    if (!id) return null;
    return { ...bets.get(id)!, selections: selectionsByBetId.get(id) ?? [] };
  }

  function insertBet(data: {
    playerId: string;
    previewId: string;
    type: "SINGLE" | "EXPRESS";
    sport: string;
    event: string | null;
    outcome: string | null;
    odds: Prisma.Decimal | null;
    stake: Prisma.Decimal;
    totalOdds: Prisma.Decimal | null;
    status: string;
    line?: Prisma.Decimal | null;
    selections?: { create: Array<Omit<FakeSelectionRow, "id" | "betId" | "createdAt" | "updatedAt">> };
  } & Partial<FakeProviderReferenceColumns>) {
    createCallCount += 1;

    if (betIdByPreviewId.has(data.previewId)) {
      throw p2002();
    }

    // Build the full set of new rows before touching any shared map, so a
    // simulated mid-build failure (failOnSelectionIndex) provably commits
    // nothing — mirrors the atomicity a real nested Prisma create() and the
    // surrounding $transaction both provide.
    const now = new Date();
    const id = `bet-${nextBetId++}`;
    const bet: FakeBetRow = {
      id,
      playerId: data.playerId,
      previewId: data.previewId,
      type: data.type,
      sport: data.sport,
      event: data.event,
      outcome: data.outcome,
      odds: data.odds,
      totalOdds: data.totalOdds,
      stake: data.stake,
      status: data.status,
      line: data.line ?? null,
      createdAt: now,
      updatedAt: now,
      providerName: data.providerName ?? null,
      providerEventId: data.providerEventId ?? null,
      providerSportKey: data.providerSportKey ?? null,
      eventStartTime: data.eventStartTime ?? null,
      canonicalMarketType: data.canonicalMarketType ?? null,
      canonicalSelectionType: data.canonicalSelectionType ?? null,
      canonicalParticipant: data.canonicalParticipant ?? null,
      canonicalPeriod: data.canonicalPeriod ?? null,
    };

    const newSelections: FakeSelectionRow[] = [];
    (data.selections?.create ?? []).forEach((s, index) => {
      if (options.failOnSelectionIndex === index) {
        throw new Error(`simulated failure inserting selection at index ${index}`);
      }
      newSelections.push({ id: `sel-${nextSelectionId++}`, betId: id, createdAt: now, updatedAt: now, ...s });
    });

    bets.set(id, bet);
    betIdByPreviewId.set(data.previewId, id);
    selectionsByBetId.set(id, newSelections);

    return { ...bet, selections: newSelections };
  }

  const tx = {
    bet: {
      findUnique: async ({ where }: { where: { previewId: string } }) => {
        if (options.txFindUniqueSeesNothing) return null;
        return readBet(where.previewId);
      },
      create: async ({ data }: { data: Parameters<typeof insertBet>[0] }) => insertBet(data),
    },
    oddsSnapshot: {
      create: async ({ data }: { data: Record<string, unknown> }) => ({ id: `snap-${Date.now()}`, checkedAt: new Date(), ...data }),
    },
  };
  type FakeTx = typeof tx;

  return {
    bet: {
      findUnique: async ({ where }: { where: { previewId: string } }) => readBet(where.previewId),
      create: tx.bet.create,
    },
    oddsSnapshot: tx.oddsSnapshot,
    $transaction: async <T>(fn: (tx: FakeTx) => Promise<T>) => fn(tx),
    _debug: {
      betCount: () => bets.size,
      createCallCount: () => createCallCount,
    },
  };
}

function fakeOptions(db: ReturnType<typeof createFakeDb>): CreateBetFromPreviewOptions {
  return { db: db as unknown as PrismaClient };
}

// ---------------------------------------------------------------------
// SINGLE regression
// ---------------------------------------------------------------------

function singlePayload(overrides: Partial<PreviewTokenPayload> = {}): PreviewTokenPayload {
  const issuedAt = Math.floor(Date.now() / 1000);
  return {
    v: 1,
    previewId: "preview-single-1",
    playerId: "player-1",
    type: "SINGLE",
    sport: "Football",
    event: "Real Madrid vs Barcelona",
    outcome: "Real Madrid Win",
    stake: 100,
    odds: 2.1,
    acceptedOdds: 2.1,
    totalOdds: 2.1,
    oddsCheck: { matched: true, withinTolerance: true, sourceOdds: 2.1, bookmaker: "Bet365" },
    issuedAt,
    expiresAt: issuedAt + 180,
    ...overrides,
  };
}

test("createBetFromPreview: SINGLE creates one Bet with the expected fields", async () => {
  const db = createFakeDb();
  const result = await createBetFromPreview(singlePayload(), fakeOptions(db));

  assert.equal(result.idempotent, false);
  assert.equal(result.bet.type, "SINGLE");
  assert.equal(result.bet.event, "Real Madrid vs Barcelona");
  assert.equal(result.bet.outcome, "Real Madrid Win");
  assert.equal(result.bet.stake.toString(), "100");
  assert.equal(result.bet.odds?.toString(), "2.1");
  assert.equal(result.bet.totalOdds?.toString(), "2.1");
  assert.equal(result.bet.status, "PENDING");
  assert.equal(db._debug.betCount(), 1);
});

test("createBetFromPreview: repeated SINGLE previewId does not create a second Bet", async () => {
  const db = createFakeDb();
  const payload = singlePayload();

  const first = await createBetFromPreview(payload, fakeOptions(db));
  const second = await createBetFromPreview(payload, fakeOptions(db));

  assert.equal(first.idempotent, false);
  assert.equal(second.idempotent, true);
  assert.equal(first.bet.id, second.bet.id);
  assert.equal(db._debug.betCount(), 1);
  assert.equal(db._debug.createCallCount(), 1);
});

test("createBetFromPreview: SINGLE P2002 race returns the already-created Bet", async () => {
  // tx.bet.findUnique is stubbed to see nothing (simulating it ran before a
  // concurrent request's commit); both calls therefore attempt create(),
  // the second one hitting the previewId collision and recovering via the
  // fresh, non-stubbed db.bet.findUnique outside the transaction.
  const raceDb = createFakeDb({ txFindUniqueSeesNothing: true });
  const payload = singlePayload();

  const first = await createBetFromPreview(payload, { db: raceDb as unknown as PrismaClient });
  const second = await createBetFromPreview(payload, { db: raceDb as unknown as PrismaClient });

  assert.equal(first.idempotent, false);
  assert.equal(second.idempotent, true);
  assert.equal(first.bet.id, second.bet.id);
  assert.equal(raceDb._debug.betCount(), 1);
});

// ---------------------------------------------------------------------
// EXPRESS
// ---------------------------------------------------------------------

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

function expressPayload(overrides: Partial<ExpressPreviewTokenPayload> = {}): ExpressPreviewTokenPayload {
  const issuedAt = Math.floor(Date.now() / 1000);
  return {
    v: 1,
    previewId: "preview-express-1",
    playerId: "player-1",
    type: "EXPRESS",
    stake: "40.00",
    totalOdds: "3.06",
    potentialWin: "122.40",
    selections: [
      expressSelection({ event: "Real Madrid vs Barcelona", outcome: "Real Madrid Win", submittedOdds: "1.80" }),
      expressSelection({
        sport: "Tennis",
        event: "Inter Milan vs Juventus",
        outcome: "Over 2.5 Goals",
        submittedOdds: "1.70",
        currentOdds: "1.70",
      }),
    ],
    issuedAt,
    expiresAt: issuedAt + 180,
    ...overrides,
  };
}

test("createBetFromPreview: EXPRESS with 2 selections creates one Bet and two BetSelection rows", async () => {
  const db = createFakeDb();
  const result = await createBetFromPreview(expressPayload(), fakeOptions(db));

  assert.equal(result.idempotent, false);
  assert.equal(result.bet.type, "EXPRESS");
  assert.equal(result.bet.selections.length, 2);
  assert.equal(db._debug.betCount(), 1);
});

test("createBetFromPreview: EXPRESS with 10 selections creates one Bet and ten BetSelection rows", async () => {
  const db = createFakeDb();
  const selections = Array.from({ length: 10 }, (_, i) =>
    expressSelection({ event: `Match ${i}`, outcome: `Outcome ${i}`, submittedOdds: "1.10", currentOdds: "1.10" }),
  );
  const result = await createBetFromPreview(expressPayload({ selections }), fakeOptions(db));

  assert.equal(result.bet.selections.length, 10);
});

test("createBetFromPreview: EXPRESS Bet.event and Bet.outcome are null", async () => {
  const db = createFakeDb();
  const result = await createBetFromPreview(expressPayload(), fakeOptions(db));

  assert.equal(result.bet.event, null);
  assert.equal(result.bet.outcome, null);
});

test("createBetFromPreview: EXPRESS Bet.sport is the first selection's sport", async () => {
  const db = createFakeDb();
  const payload = expressPayload({
    selections: [
      expressSelection({ sport: "Basketball", event: "Match A" }),
      expressSelection({ sport: "Hockey", event: "Match B" }),
    ],
  });
  const result = await createBetFromPreview(payload, fakeOptions(db));

  assert.equal(result.bet.sport, "Basketball");
});

test("createBetFromPreview: EXPRESS stores each selection's own sport, including a mixed-sport slip (Football + Tennis)", async () => {
  const db = createFakeDb();
  const payload = expressPayload({
    selections: [
      expressSelection({ sport: "Football", event: "Match A" }),
      expressSelection({ sport: "Tennis", event: "Match B" }),
    ],
  });
  const result = await createBetFromPreview(payload, fakeOptions(db));

  assert.equal(result.bet.sport, "Football"); // first selection's sport
  const [a, b] = result.bet.selections;
  assert.equal(a.sport, "Football");
  assert.equal(b.sport, "Tennis");
});

test("createBetFromPreview: EXPRESS stake and totalOdds are stored as exact Decimal values", async () => {
  const db = createFakeDb();
  const payload = expressPayload({ stake: "40.10", totalOdds: "1.10" });
  const result = await createBetFromPreview(payload, fakeOptions(db));

  assert.equal(result.bet.stake.toString(), "40.1");
  assert.equal(result.bet.totalOdds?.toString(), "1.1");
  assert.ok(result.bet.stake instanceof Prisma.Decimal);
  assert.ok(result.bet.totalOdds instanceof Prisma.Decimal);
});

test("createBetFromPreview: EXPRESS selection event/outcome/market are stored as given", async () => {
  const db = createFakeDb();
  const payload = expressPayload({
    selections: [
      expressSelection({ event: "Real Madrid vs Barcelona", outcome: "Real Madrid Win", market: "Match Winner" }),
      expressSelection({ event: "Inter vs Juventus", outcome: "Over 2.5", market: null }),
    ],
  });
  const result = await createBetFromPreview(payload, fakeOptions(db));

  const [a, b] = result.bet.selections;
  assert.equal(a.event, "Real Madrid vs Barcelona");
  assert.equal(a.outcome, "Real Madrid Win");
  assert.equal(a.market, "Match Winner");
  assert.equal(b.event, "Inter vs Juventus");
  assert.equal(b.market, null);
});

test("createBetFromPreview: EXPRESS selection submittedOdds is stored exactly (as BetSelection.odds)", async () => {
  const db = createFakeDb();
  const payload = expressPayload({
    selections: [
      expressSelection({ submittedOdds: "1.80" }),
      expressSelection({ event: "Match B", submittedOdds: "2.05" }),
    ],
  });
  const result = await createBetFromPreview(payload, fakeOptions(db));

  assert.equal(result.bet.selections[0].odds?.toString(), "1.8");
  assert.equal(result.bet.selections[1].odds?.toString(), "2.05");
});

test("createBetFromPreview: EXPRESS selection currentOdds is stored exactly, and null stays null", async () => {
  const db = createFakeDb();
  const payload = expressPayload({
    selections: [
      expressSelection({ currentOdds: "1.85" }),
      expressSelection({ event: "Match B", currentOdds: null, oddsStatus: "UNAVAILABLE" }),
    ],
  });
  const result = await createBetFromPreview(payload, fakeOptions(db));

  assert.equal(result.bet.selections[0].currentOdds?.toString(), "1.85");
  assert.equal(result.bet.selections[1].currentOdds, null);
});

test("createBetFromPreview: EXPRESS oddsStatus is stored for each selection independently", async () => {
  const db = createFakeDb();
  const payload = expressPayload({
    selections: [
      expressSelection({ event: "A", oddsStatus: "VERIFIED" }),
      expressSelection({ event: "B", oddsStatus: "ODDS_CHANGED" }),
    ],
  });
  const result = await createBetFromPreview(payload, fakeOptions(db));

  assert.equal(result.bet.selections[0].oddsStatus, "VERIFIED");
  assert.equal(result.bet.selections[1].oddsStatus, "ODDS_CHANGED");
});

test("createBetFromPreview: repeated sequential EXPRESS previewId returns the existing Bet+selections without duplicating", async () => {
  const db = createFakeDb();
  const payload = expressPayload();

  const first = await createBetFromPreview(payload, fakeOptions(db));
  const second = await createBetFromPreview(payload, fakeOptions(db));

  assert.equal(first.idempotent, false);
  assert.equal(second.idempotent, true);
  assert.equal(first.bet.id, second.bet.id);
  assert.equal(second.bet.selections.length, 2);
  assert.equal(db._debug.betCount(), 1);
  assert.equal(db._debug.createCallCount(), 1);
});

test("createBetFromPreview: simulated EXPRESS P2002 race returns the already-created Bet with its selections, no duplicate", async () => {
  const raceDb = createFakeDb({ txFindUniqueSeesNothing: true });
  const payload = expressPayload();

  const first = await createBetFromPreview(payload, { db: raceDb as unknown as PrismaClient });
  // The transaction's own findUnique is blind (simulating it ran before the
  // "other" request's commit), so this second call also attempts create()
  // and must hit the P2002 path, then recover the row `first` already made.
  const second = await createBetFromPreview(payload, { db: raceDb as unknown as PrismaClient });

  assert.equal(first.idempotent, false);
  assert.equal(second.idempotent, true);
  assert.equal(first.bet.id, second.bet.id);
  assert.equal(second.bet.selections.length, 2);
  assert.equal(raceDb._debug.betCount(), 1); // exactly one Bet in the "database"
});

test("createBetFromPreview: a failure inserting one EXPRESS selection leaves no orphan Bet", async () => {
  const db = createFakeDb({ failOnSelectionIndex: 1 });
  const payload = expressPayload();

  await assert.rejects(() => createBetFromPreview(payload, fakeOptions(db)));
  assert.equal(db._debug.betCount(), 0);
});

test("createBetFromPreview: EXPRESS with 1 selection is rejected before any write", async () => {
  const db = createFakeDb();
  const payload = expressPayload({ selections: [expressSelection()] });

  await assert.rejects(
    () => createBetFromPreview(payload, fakeOptions(db)),
    (err: unknown) => {
      assert.ok(err instanceof CreateBetFromPreviewValidationError);
      assert.equal(err.code, "EXPRESS_TOO_FEW_SELECTIONS");
      return true;
    },
  );
  assert.equal(db._debug.betCount(), 0);
});

test("createBetFromPreview: EXPRESS with 11 selections is rejected before any write", async () => {
  const db = createFakeDb();
  const selections = Array.from({ length: 11 }, (_, i) => expressSelection({ event: `Match ${i}` }));
  const payload = expressPayload({ selections });

  await assert.rejects(
    () => createBetFromPreview(payload, fakeOptions(db)),
    (err: unknown) => {
      assert.ok(err instanceof CreateBetFromPreviewValidationError);
      assert.equal(err.code, "EXPRESS_TOO_MANY_SELECTIONS");
      return true;
    },
  );
  assert.equal(db._debug.betCount(), 0);
});

test("createBetFromPreview: an unknown payload type is rejected", async () => {
  const db = createFakeDb();
  const bogus = { ...expressPayload(), type: "PARLAY" } as unknown as ExpressPreviewTokenPayload;

  await assert.rejects(
    () => createBetFromPreview(bogus, fakeOptions(db)),
    (err: unknown) => {
      assert.ok(err instanceof CreateBetFromPreviewValidationError);
      assert.equal(err.code, "UNKNOWN_PAYLOAD_TYPE");
      return true;
    },
  );
  assert.equal(db._debug.betCount(), 0);
});

// ---------------------------------------------------------------------
// Stage 3.1 — provider event references / canonical market-selection
// identity, persisted from the already-verified signed token payload only.
// ---------------------------------------------------------------------

test("Stage 3.1 SINGLE: provider/canonical fields are persisted on Bet from the token payload", async () => {
  const db = createFakeDb();
  const payload = singlePayload({
    providerEventId: "evt-single-abc",
    providerSportKey: "soccer_epl",
    eventStartTime: "2026-08-15T18:00:00.000Z",
    canonicalMarketType: "MONEYLINE_3WAY",
    canonicalSelectionType: "HOME",
    canonicalParticipant: null,
    canonicalPeriod: "FULL_GAME",
  });

  const result = await createBetFromPreview(payload, fakeOptions(db));

  assert.equal(result.bet.providerName, "THE_ODDS_API");
  assert.equal(result.bet.providerEventId, "evt-single-abc");
  assert.equal(result.bet.providerSportKey, "soccer_epl");
  assert.equal(result.bet.eventStartTime?.toISOString(), "2026-08-15T18:00:00.000Z");
  assert.equal(result.bet.canonicalMarketType, "MONEYLINE_3WAY");
  assert.equal(result.bet.canonicalSelectionType, "HOME");
  assert.equal(result.bet.canonicalParticipant, null);
  assert.equal(result.bet.canonicalPeriod, "FULL_GAME");
});

test("Stage 3.1 SINGLE: providerName stays null when providerEventId is null — never fabricated independently", async () => {
  const db = createFakeDb();
  const result = await createBetFromPreview(singlePayload(), fakeOptions(db));

  assert.equal(result.bet.providerEventId, null);
  assert.equal(result.bet.providerName, null, "providerName must never be set without a real providerEventId to attach it to");
});

test("Stage 3.1 EXPRESS: each leg persists its OWN provider event references — different legs never share or mix IDs", async () => {
  const db = createFakeDb();
  const payload = expressPayload({
    selections: [
      expressSelection({
        event: "Real Madrid vs Barcelona",
        providerEventId: "evt-leg-1",
        providerSportKey: "soccer_spain_la_liga",
        eventStartTime: "2026-08-20T19:00:00.000Z",
        canonicalMarketType: "MONEYLINE_3WAY",
        canonicalSelectionType: "HOME",
        canonicalPeriod: "FULL_GAME",
      }),
      expressSelection({
        event: "Inter Milan vs Juventus",
        providerEventId: "evt-leg-2",
        providerSportKey: "soccer_italy_serie_a",
        eventStartTime: "2026-08-21T20:00:00.000Z",
        canonicalMarketType: "MONEYLINE_3WAY",
        canonicalSelectionType: "AWAY",
        canonicalPeriod: "FULL_GAME",
      }),
    ],
  });

  const result = await createBetFromPreview(payload, fakeOptions(db));

  const [leg1, leg2] = result.bet.selections;
  assert.equal(leg1.providerEventId, "evt-leg-1");
  assert.equal(leg1.providerSportKey, "soccer_spain_la_liga");
  assert.equal(leg1.eventStartTime?.toISOString(), "2026-08-20T19:00:00.000Z");
  assert.equal(leg1.canonicalSelectionType, "HOME");
  assert.equal(leg2.providerEventId, "evt-leg-2");
  assert.equal(leg2.providerSportKey, "soccer_italy_serie_a");
  assert.equal(leg2.canonicalSelectionType, "AWAY");
  assert.notEqual(leg1.providerEventId, leg2.providerEventId, "different legs' provider event ids must never be mixed up");
});

test("Stage 3.1 EXPRESS: leg order is preserved for provider references, matching the token's own selection order", async () => {
  const db = createFakeDb();
  const payload = expressPayload({
    selections: [
      expressSelection({ event: "Match A", providerEventId: "evt-A" }),
      expressSelection({ event: "Match B", providerEventId: "evt-B" }),
    ],
  });

  const result = await createBetFromPreview(payload, fakeOptions(db));

  assert.equal(result.bet.selections[0].event, "Match A");
  assert.equal(result.bet.selections[0].providerEventId, "evt-A");
  assert.equal(result.bet.selections[1].event, "Match B");
  assert.equal(result.bet.selections[1].providerEventId, "evt-B");
});

test("Stage 3.1 legacy SINGLE token (no provider/canonical fields at all): writes null, does not crash", async () => {
  const db = createFakeDb();
  // A genuinely old-shaped payload — the seven Stage 3.1 keys are entirely
  // absent, exactly as verifyPreviewToken would decode a pre-Stage-3.1
  // token (normalized to undefined by TypeScript's Partial, matching what
  // JSON.parse of an old token produces at runtime).
  const legacyPayload = singlePayload();

  const result = await createBetFromPreview(legacyPayload, fakeOptions(db));

  assert.equal(result.idempotent, false, "sanity: bet creation itself must still succeed");
  assert.equal(result.bet.providerName, null);
  assert.equal(result.bet.providerEventId, null);
  assert.equal(result.bet.providerSportKey, null);
  assert.equal(result.bet.eventStartTime, null);
  assert.equal(result.bet.canonicalMarketType, null);
  assert.equal(result.bet.canonicalSelectionType, null);
  assert.equal(result.bet.canonicalParticipant, null);
  assert.equal(result.bet.canonicalPeriod, null);
});

test("Stage 3.1 legacy EXPRESS token (selections with no provider/canonical fields): writes null per leg, does not crash", async () => {
  const db = createFakeDb();
  const legacyPayload = expressPayload();

  const result = await createBetFromPreview(legacyPayload, fakeOptions(db));

  assert.equal(result.idempotent, false);
  for (const selection of result.bet.selections) {
    assert.equal(selection.providerName, null);
    assert.equal(selection.providerEventId, null);
    assert.equal(selection.providerSportKey, null);
    assert.equal(selection.eventStartTime, null);
  }
});

test("Stage 3.1: createBetFromPreview only ever persists what the already-verified token payload contains — no other input surface exists for provider identity", async () => {
  // There is no client body, header, or query param this function reads —
  // its only parameter is the payload already produced by
  // verifyPreviewToken/verifyExpressPreviewToken (HMAC-checked before this
  // function is ever called, by the confirm route, unchanged). This test
  // documents that structural guarantee: whatever the (simulated, already-
  // verified) payload says is exactly and only what gets persisted.
  const db = createFakeDb();
  const payload = singlePayload({ providerEventId: "evt-exactly-this-and-nothing-else" });

  const result = await createBetFromPreview(payload, fakeOptions(db));

  assert.equal(result.bet.providerEventId, "evt-exactly-this-and-nothing-else");
});

test("Stage 3.1: an invalid (unparsable) eventStartTime in the token does not crash bet creation — degrades to null", async () => {
  const db = createFakeDb();
  const payload = singlePayload({
    providerEventId: "evt-bad-time",
    providerSportKey: "soccer_epl",
    eventStartTime: "not-a-real-timestamp",
  });

  const result = await createBetFromPreview(payload, fakeOptions(db));

  assert.equal(result.idempotent, false, "bet creation must still succeed");
  assert.equal(result.bet.providerEventId, "evt-bad-time", "the id itself is unaffected — only the unparsable time degrades");
  assert.equal(result.bet.eventStartTime, null, "an invalid timestamp must never be written as Invalid Date");
});

test("Stage 3.1: a missing eventStartTime (undefined) with a real providerEventId still persists the id, with a null time", async () => {
  const db = createFakeDb();
  const payload = singlePayload({ providerEventId: "evt-no-time", providerSportKey: "soccer_epl" });

  const result = await createBetFromPreview(payload, fakeOptions(db));

  assert.equal(result.bet.providerEventId, "evt-no-time");
  assert.equal(result.bet.eventStartTime, null);
});

test("Stage 3.1: existing OddsSnapshot behavior for SINGLE is unaffected by the new provider fields", async () => {
  const db = createFakeDb();
  const payload = singlePayload({
    providerEventId: "evt-snapshot-check",
    providerSportKey: "soccer_epl",
    eventStartTime: "2026-08-15T18:00:00.000Z",
  });

  const result = await createBetFromPreview(payload, fakeOptions(db));

  // Unchanged existing fields — proves the new provider columns are purely
  // additive to the same create() call, not a replacement of anything.
  assert.equal(result.bet.stake.toString(), "100");
  assert.equal(result.bet.odds?.toString(), "2.1");
  assert.equal(result.bet.status, "PENDING");
});

// Stage M4.8 — the confirmation-baseline fix's persistence-layer proof:
// Bet.odds must be the price the bet is actually confirmed at
// (acceptedOdds — BetPilot's own current price shown in the preview being
// confirmed), never the player's own screenshot/typed reference price
// (odds), which is kept only as separate diagnostic/audit input to
// OddsSnapshot. Uses deliberately different values for the two token
// fields so a regression back to reading `odds` would fail loudly here.
test("Stage M4.8: Bet.odds is acceptedOdds, never the screenshot/reference odds field", async () => {
  const db = createFakeDb();
  const payload = singlePayload({ odds: 2.16, acceptedOdds: 2.04 });

  const result = await createBetFromPreview(payload, fakeOptions(db));

  assert.equal(result.bet.odds?.toString(), "2.04", "Bet.odds must be the accepted/current price, not the 2.16 screenshot reference");
});

// ---------------------------------------------------------------------
// Betting Markets V1, Phase 1 — additive `line` column
// (prisma/schema.prisma's Bet.line / BetSelection.line, Decimal(4,1)).
// This phase adds the schema column only — createBetFromPreview.ts itself
// is UNCHANGED (PreviewTokenPayload/ExpressPreviewTokenSelection have no
// line field yet; that's Phase 2 plumbing, explicitly out of scope here).
// These tests prove the schema/persistence layer itself can round-trip a
// line value and that existing MONEYLINE creation is unaffected by the
// new nullable column — they call the fake DB's insertBet directly (not
// through createBetFromPreview()), since the production function has
// nothing to pass yet.
// ---------------------------------------------------------------------

test("Betting Markets V1 Phase 1: existing MONEYLINE creation via the real createBetFromPreview() is unaffected — line persists as null", async () => {
  const db = createFakeDb();
  const result = await createBetFromPreview(singlePayload(), fakeOptions(db));

  assert.equal(result.idempotent, false);
  assert.equal(result.bet.line, null);
  // Every pre-existing field stays correct — the new column changed
  // nothing about the existing moneyline write path.
  assert.equal(result.bet.event, "Real Madrid vs Barcelona");
  assert.equal(result.bet.odds?.toString(), "2.1");
});

test("Betting Markets V1 Phase 1: SINGLE Bet schema can persist line = null", async () => {
  const db = createFakeDb();
  const created = await db.bet.create({
    data: {
      playerId: "player-1",
      previewId: "preview-line-null",
      type: "SINGLE",
      sport: "Football",
      event: "Arsenal vs Coventry City",
      outcome: "Arsenal Win",
      odds: new Prisma.Decimal("1.16"),
      stake: new Prisma.Decimal("10"),
      totalOdds: new Prisma.Decimal("1.16"),
      status: "PENDING",
      line: null,
    },
  });

  assert.equal(created.line, null);
});

test("Betting Markets V1 Phase 1: SINGLE Bet schema can persist line = 2.5 (a TOTALS-shaped value, round-trips exactly)", async () => {
  const db = createFakeDb();
  const created = await db.bet.create({
    data: {
      playerId: "player-1",
      previewId: "preview-line-2.5",
      type: "SINGLE",
      sport: "Football",
      event: "Arsenal vs Coventry City",
      outcome: "Over 2.5",
      odds: new Prisma.Decimal("1.9"),
      stake: new Prisma.Decimal("10"),
      totalOdds: new Prisma.Decimal("1.9"),
      status: "PENDING",
      line: new Prisma.Decimal("2.5"),
    },
  });

  assert.equal(created.line?.toString(), "2.5");
});

test("Betting Markets V1 Phase 1: EXPRESS BetSelection schema can persist line = -1.5 (a SPREAD-shaped value, round-trips exactly)", async () => {
  const db = createFakeDb();
  const created = await db.bet.create({
    data: {
      playerId: "player-1",
      previewId: "preview-express-line",
      type: "EXPRESS",
      sport: "Football",
      event: null,
      outcome: null,
      odds: null,
      stake: new Prisma.Decimal("10"),
      totalOdds: new Prisma.Decimal("3.06"),
      status: "PENDING",
      selections: {
        create: [
          {
            sport: "Football",
            event: "Arsenal vs Coventry City",
            outcome: "Arsenal -1.5",
            market: "Spread",
            odds: new Prisma.Decimal("1.8"),
            currentOdds: new Prisma.Decimal("1.8"),
            oddsStatus: "VERIFIED",
            line: new Prisma.Decimal("-1.5"),
            providerName: null,
            providerEventId: null,
            providerSportKey: null,
            eventStartTime: null,
            canonicalMarketType: null,
            canonicalSelectionType: null,
            canonicalParticipant: null,
            canonicalPeriod: null,
          },
        ],
      },
    },
  });

  assert.equal(created.selections.length, 1);
  assert.equal(created.selections[0].line?.toString(), "-1.5");
});

// ---------------------------------------------------------------------
// H4-B1 — Decimal(5,2) precision widening (was Decimal(4,1)). These are
// the schema persistence proofs Section 8/9 of the H4-B1 task ask for.
// This repo has no live-database integration test harness (every test
// here goes through the same in-memory fake DB the Phase 1 tests above
// use), so these prove the schema *type*/creation path round-trips each
// value exactly through Prisma.Decimal — not a live-database guarantee.
// The real DB column's new precision was independently verified by
// inspecting the generated migration SQL (`ALTER COLUMN "line" SET DATA
// TYPE DECIMAL(5,2)`), reported in the H4-B1 final report rather than
// asserted here as a fake DB guarantee.
// ---------------------------------------------------------------------

const QUARTER_LINE_VALUES = ["-1.25", "0.75", "-1.75", "1.25"] as const;

for (const value of QUARTER_LINE_VALUES) {
  test(`H4-B1: SINGLE Bet schema can persist line = ${value} (a quarter-line Asian handicap value, round-trips exactly, no rounding)`, async () => {
    const db = createFakeDb();
    const created = await db.bet.create({
      data: {
        playerId: "player-1",
        previewId: `preview-line-${value}`,
        type: "SINGLE",
        sport: "Football",
        event: "Arsenal vs Coventry City",
        outcome: `Arsenal ${value}`,
        odds: new Prisma.Decimal("1.9"),
        stake: new Prisma.Decimal("10"),
        totalOdds: new Prisma.Decimal("1.9"),
        status: "PENDING",
        line: new Prisma.Decimal(value),
      },
    });

    assert.equal(created.line?.toString(), value);
  });
}

test("H4-B1: EXPRESS BetSelection schema can persist line = -1.25 (a quarter-line Asian handicap value, round-trips exactly)", async () => {
  const db = createFakeDb();
  const created = await db.bet.create({
    data: {
      playerId: "player-1",
      previewId: "preview-express-quarter-line",
      type: "EXPRESS",
      sport: "Football",
      event: null,
      outcome: null,
      odds: null,
      stake: new Prisma.Decimal("10"),
      totalOdds: new Prisma.Decimal("3.06"),
      status: "PENDING",
      selections: {
        create: [
          {
            sport: "Football",
            event: "Arsenal vs Coventry City",
            outcome: "Arsenal -1.25",
            market: "Spread",
            odds: new Prisma.Decimal("1.8"),
            currentOdds: new Prisma.Decimal("1.8"),
            oddsStatus: "VERIFIED",
            line: new Prisma.Decimal("-1.25"),
            providerName: null,
            providerEventId: null,
            providerSportKey: null,
            eventStartTime: null,
            canonicalMarketType: null,
            canonicalSelectionType: null,
            canonicalParticipant: null,
            canonicalPeriod: null,
          },
        ],
      },
    },
  });

  assert.equal(created.selections.length, 1);
  assert.equal(created.selections[0].line?.toString(), "-1.25");
});

// H4-B1 Section 9 — existing whole/half-point standard SPREAD lines must
// remain exact after the Decimal(4,1) -> Decimal(5,2) widening; this is a
// strict superset of the old precision, so nothing here should round or
// truncate differently than before.
const STANDARD_LINE_VALUES = ["0", "-0.5", "0.5", "-1", "1", "-1.5", "1.5", "-2", "2"] as const;

for (const value of STANDARD_LINE_VALUES) {
  test(`H4-B1 regression: SINGLE Bet schema still persists standard line = ${value} exactly after the Decimal(5,2) widening`, async () => {
    const db = createFakeDb();
    const created = await db.bet.create({
      data: {
        playerId: "player-1",
        previewId: `preview-standard-line-${value}`,
        type: "SINGLE",
        sport: "Football",
        event: "Arsenal vs Coventry City",
        outcome: `Arsenal ${value}`,
        odds: new Prisma.Decimal("1.9"),
        stake: new Prisma.Decimal("10"),
        totalOdds: new Prisma.Decimal("1.9"),
        status: "PENDING",
        line: new Prisma.Decimal(value),
      },
    });

    assert.equal(created.line?.toString(), value);
  });
}

// ---------------------------------------------------------------------
// Betting Markets V1, Phase 2 — line plumbing through createBetFromPreview()
// itself. Unlike the Phase 1 tests above (which wrote directly to the fake
// DB because the token payload had no line field yet), these go through
// the real createBetFromPreview() with a payload carrying canonicalLine —
// the same field the signed preview token now carries end to end.
// ---------------------------------------------------------------------

test("Betting Markets V1 Phase 2 SINGLE: createBetFromPreview persists line = 2.5 from the token's canonicalLine", async () => {
  const db = createFakeDb();
  const payload = singlePayload({ canonicalLine: "2.5" });

  const result = await createBetFromPreview(payload, fakeOptions(db));

  assert.equal(result.bet.line?.toString(), "2.5");
});

test("Betting Markets V1 Phase 2 EXPRESS: createBetFromPreview persists line = -1.5 per selection from each leg's canonicalLine", async () => {
  const db = createFakeDb();
  const payload = expressPayload({
    selections: [
      expressSelection({ event: "Real Madrid vs Barcelona", canonicalLine: "-1.5" }),
      expressSelection({ event: "Inter Milan vs Juventus", canonicalLine: "3.5" }),
    ],
  });

  const result = await createBetFromPreview(payload, fakeOptions(db));

  const [leg1, leg2] = result.bet.selections;
  assert.equal(leg1.line?.toString(), "-1.5");
  assert.equal(leg2.line?.toString(), "3.5");
});

test("Betting Markets V1 Phase 2 EXPRESS: an existing MONEYLINE leg with no canonicalLine still persists line = null", async () => {
  const db = createFakeDb();
  const payload = expressPayload();

  const result = await createBetFromPreview(payload, fakeOptions(db));

  for (const selection of result.bet.selections) {
    assert.equal(selection.line, null);
  }
});

test("Betting Markets V1 Phase 2: an invalid (non-decimal-string) canonicalLine does not crash bet creation — degrades to null", async () => {
  const db = createFakeDb();
  const payload = singlePayload({ providerEventId: "evt-bad-line", canonicalLine: "not-a-number" });

  const result = await createBetFromPreview(payload, fakeOptions(db));

  assert.equal(result.idempotent, false, "bet creation must still succeed");
  assert.equal(result.bet.providerEventId, "evt-bad-line", "unrelated fields are unaffected — only the unparsable line degrades");
  assert.equal(result.bet.line, null, "an invalid decimal string must never be written to the Decimal column");
});

test("Betting Markets V1 Phase 2 review fix: a leading '+' canonicalLine (defense-in-depth — the real pipeline already canonicalizes this before signing) is accepted and canonicalized, not nulled", async () => {
  const db = createFakeDb();
  const payload = singlePayload({ canonicalLine: "+2.5" });

  const result = await createBetFromPreview(payload, fakeOptions(db));

  assert.equal(result.bet.line?.toString(), "2.5", "a leading '+' means positive, same as no sign at all — it must persist as the canonical unsigned value, never be discarded as invalid");
});

test("Betting Markets V1 Phase 2 review fix SINGLE: a positive spread persists with its sign preserved via the participant, and the line unsigned", async () => {
  const db = createFakeDb();
  // Arsenal -1.5 vs. Coventry +1.5 — participant and line are always
  // separate structured fields end to end (never one combined string), so
  // the signed meaning is preserved by construction: the negative leg keeps
  // its "-", the positive leg's canonical line is the bare unsigned value.
  const negative = await createBetFromPreview(
    singlePayload({ providerEventId: "evt-arsenal", canonicalParticipant: "Arsenal", canonicalLine: "-1.5" }),
    fakeOptions(db),
  );
  const positive = await createBetFromPreview(
    singlePayload({ providerEventId: "evt-coventry", previewId: "preview-coventry", canonicalParticipant: "Coventry", canonicalLine: "+1.5" }),
    fakeOptions(db),
  );

  assert.equal(negative.bet.canonicalParticipant, "Arsenal");
  assert.equal(negative.bet.line?.toString(), "-1.5");
  assert.equal(positive.bet.canonicalParticipant, "Coventry");
  assert.equal(positive.bet.line?.toString(), "1.5");
});

// ---------------------------------------------------------------------
// Betting Markets V1, Phase 3.3 — confirmation/persistence for a real
// TOTALS-classified, provider-verified selection. No changes were made to
// createBetFromPreview.ts itself this phase — these tests confirm the
// existing, unmodified signed-token flow (Phase 1's line column, Phase 2's
// line plumbing) already persists canonicalMarketType/canonicalSelectionType/
// line correctly for a genuine TOTALS payload, not just a synthetic one.
// ---------------------------------------------------------------------

test("Betting Markets V1 Phase 3.3 SINGLE: confirmation persists canonicalMarketType=TOTALS, canonicalSelectionType=OVER, line=requested line", async () => {
  const db = createFakeDb();
  const payload = singlePayload({
    providerEventId: "evt-totals-confirm",
    providerSportKey: "soccer_epl",
    canonicalMarketType: "TOTALS",
    canonicalSelectionType: "OVER",
    canonicalLine: "2.5",
  });

  const result = await createBetFromPreview(payload, fakeOptions(db));

  assert.equal(result.bet.canonicalMarketType, "TOTALS");
  assert.equal(result.bet.canonicalSelectionType, "OVER");
  assert.equal(result.bet.line?.toString(), "2.5");
});

test("Betting Markets V1 Phase 3.3 SINGLE: confirmation persists canonicalSelectionType=UNDER correctly", async () => {
  const db = createFakeDb();
  const payload = singlePayload({
    previewId: "preview-totals-under",
    providerEventId: "evt-totals-under-confirm",
    providerSportKey: "soccer_epl",
    canonicalMarketType: "TOTALS",
    canonicalSelectionType: "UNDER",
    canonicalLine: "3.5",
  });

  const result = await createBetFromPreview(payload, fakeOptions(db));

  assert.equal(result.bet.canonicalMarketType, "TOTALS");
  assert.equal(result.bet.canonicalSelectionType, "UNDER");
  assert.equal(result.bet.line?.toString(), "3.5");
});

test("Betting Markets V1 Phase 3.3 EXPRESS: each BetSelection stores its own market type, direction and line independently, per leg", async () => {
  const db = createFakeDb();
  const payload = expressPayload({
    selections: [
      expressSelection({
        event: "Arsenal vs Chelsea",
        providerEventId: "evt-express-totals-over",
        canonicalMarketType: "TOTALS",
        canonicalSelectionType: "OVER",
        canonicalLine: "2.5",
      }),
      expressSelection({
        event: "Real Madrid vs Barcelona",
        providerEventId: "evt-express-moneyline",
        canonicalMarketType: "MONEYLINE_2WAY",
        canonicalSelectionType: "PARTICIPANT",
        canonicalParticipant: "Real Madrid",
      }),
      expressSelection({
        event: "Inter vs Juventus",
        providerEventId: "evt-express-totals-under",
        canonicalMarketType: "TOTALS",
        canonicalSelectionType: "UNDER",
        canonicalLine: "3.5",
      }),
    ],
  });

  const result = await createBetFromPreview(payload, fakeOptions(db));

  const [leg1, leg2, leg3] = result.bet.selections;
  assert.equal(leg1.canonicalMarketType, "TOTALS");
  assert.equal(leg1.canonicalSelectionType, "OVER");
  assert.equal(leg1.line?.toString(), "2.5");

  assert.equal(leg2.canonicalMarketType, "MONEYLINE_2WAY");
  assert.equal(leg2.canonicalSelectionType, "PARTICIPANT");
  assert.equal(leg2.line, null, "a MONEYLINE leg alongside TOTALS legs must still persist line = null");

  assert.equal(leg3.canonicalMarketType, "TOTALS");
  assert.equal(leg3.canonicalSelectionType, "UNDER");
  assert.equal(leg3.line?.toString(), "3.5");

  // Different legs' market/direction/line must never bleed into each other.
  assert.notEqual(leg1.canonicalSelectionType, leg3.canonicalSelectionType);
});
