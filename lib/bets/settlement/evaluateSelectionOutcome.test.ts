import { test } from "node:test";
import assert from "node:assert/strict";
import type { CanonicalSelection, MarketType, SelectionType } from "@/lib/odds/domain";
import type { CanonicalEventResult, EventResultStatus } from "./eventResultDomain";
import { evaluateSelectionOutcome, type SelectionOutcomeEvaluation } from "./evaluateSelectionOutcome";

/* -------------------------------------------------------------------------- */
/* Fixture builders                                                           */
/* -------------------------------------------------------------------------- */

function eventResult(overrides: Partial<CanonicalEventResult> = {}): CanonicalEventResult {
  return {
    status: "COMPLETED",
    homeParticipant: { name: "Arsenal" },
    awayParticipant: { name: "Chelsea" },
    homeScore: 2,
    awayScore: 1,
    ...overrides,
  };
}

function selection(overrides: Partial<CanonicalSelection> = {}): CanonicalSelection {
  return {
    sport: "FOOTBALL",
    event: { sport: "FOOTBALL", name: "Arsenal vs Chelsea", participants: [{ name: "Arsenal" }, { name: "Chelsea" }], period: "FULL_GAME" },
    marketType: "MONEYLINE_3WAY",
    period: "FULL_GAME",
    selectionType: "HOME",
    ...overrides,
  };
}

function assertOutcome(result: SelectionOutcomeEvaluation, kind: SelectionOutcomeEvaluation["kind"], reasonCode: string) {
  assert.equal(result.kind, kind);
  assert.equal(result.reasonCode, reasonCode);
}

/* -------------------------------------------------------------------------- */
/* A. MONEYLINE_3WAY                                                          */
/* -------------------------------------------------------------------------- */

test("3WAY: HOME win", () => {
  const r = evaluateSelectionOutcome(eventResult({ homeScore: 2, awayScore: 1 }), selection({ selectionType: "HOME" }));
  assertOutcome(r, "WIN", "WIN_HOME_PARTICIPANT");
});

test("3WAY: HOME loss", () => {
  const r = evaluateSelectionOutcome(eventResult({ homeScore: 0, awayScore: 1 }), selection({ selectionType: "HOME" }));
  assertOutcome(r, "LOSS", "LOSS_HOME_PARTICIPANT");
});

test("3WAY: HOME loses on draw", () => {
  const r = evaluateSelectionOutcome(eventResult({ homeScore: 1, awayScore: 1 }), selection({ selectionType: "HOME" }));
  assertOutcome(r, "LOSS", "LOSS_HOME_PARTICIPANT");
});

test("3WAY: AWAY win", () => {
  const r = evaluateSelectionOutcome(eventResult({ homeScore: 0, awayScore: 2 }), selection({ selectionType: "AWAY" }));
  assertOutcome(r, "WIN", "WIN_AWAY_PARTICIPANT");
});

test("3WAY: AWAY loss", () => {
  const r = evaluateSelectionOutcome(eventResult({ homeScore: 2, awayScore: 0 }), selection({ selectionType: "AWAY" }));
  assertOutcome(r, "LOSS", "LOSS_AWAY_PARTICIPANT");
});

test("3WAY: AWAY loses on draw", () => {
  const r = evaluateSelectionOutcome(eventResult({ homeScore: 1, awayScore: 1 }), selection({ selectionType: "AWAY" }));
  assertOutcome(r, "LOSS", "LOSS_AWAY_PARTICIPANT");
});

test("3WAY: DRAW win", () => {
  const r = evaluateSelectionOutcome(eventResult({ homeScore: 1, awayScore: 1 }), selection({ selectionType: "DRAW" }));
  assertOutcome(r, "WIN", "WIN_DRAW");
});

test("3WAY: DRAW loss", () => {
  const r = evaluateSelectionOutcome(eventResult({ homeScore: 2, awayScore: 1 }), selection({ selectionType: "DRAW" }));
  assertOutcome(r, "LOSS", "LOSS_DRAW");
});

/* -------------------------------------------------------------------------- */
/* B. MONEYLINE_2WAY                                                          */
/* -------------------------------------------------------------------------- */

test("2WAY: HOME win", () => {
  const r = evaluateSelectionOutcome(
    eventResult({ homeScore: 3, awayScore: 1 }),
    selection({ marketType: "MONEYLINE_2WAY", selectionType: "HOME" }),
  );
  assertOutcome(r, "WIN", "WIN_HOME_PARTICIPANT");
});

test("2WAY: HOME loss", () => {
  const r = evaluateSelectionOutcome(
    eventResult({ homeScore: 0, awayScore: 1 }),
    selection({ marketType: "MONEYLINE_2WAY", selectionType: "HOME" }),
  );
  assertOutcome(r, "LOSS", "LOSS_HOME_PARTICIPANT");
});

test("2WAY: AWAY win", () => {
  const r = evaluateSelectionOutcome(
    eventResult({ homeScore: 1, awayScore: 4 }),
    selection({ marketType: "MONEYLINE_2WAY", selectionType: "AWAY" }),
  );
  assertOutcome(r, "WIN", "WIN_AWAY_PARTICIPANT");
});

test("2WAY: AWAY loss", () => {
  const r = evaluateSelectionOutcome(
    eventResult({ homeScore: 2, awayScore: 0 }),
    selection({ marketType: "MONEYLINE_2WAY", selectionType: "AWAY" }),
  );
  assertOutcome(r, "LOSS", "LOSS_AWAY_PARTICIPANT");
});

test("2WAY: draw is VOID (no draw option in this market) — HOME selection", () => {
  const r = evaluateSelectionOutcome(
    eventResult({ homeScore: 1, awayScore: 1 }),
    selection({ marketType: "MONEYLINE_2WAY", selectionType: "HOME" }),
  );
  assertOutcome(r, "VOID", "VOID_DRAW_TWO_WAY_MARKET");
});

test("2WAY: draw is VOID — AWAY selection", () => {
  const r = evaluateSelectionOutcome(
    eventResult({ homeScore: 2, awayScore: 2 }),
    selection({ marketType: "MONEYLINE_2WAY", selectionType: "AWAY" }),
  );
  assertOutcome(r, "VOID", "VOID_DRAW_TWO_WAY_MARKET");
});

/* -------------------------------------------------------------------------- */
/* C. Status handling                                                         */
/* -------------------------------------------------------------------------- */

test("status: NOT_STARTED -> WAITING", () => {
  const r = evaluateSelectionOutcome(eventResult({ status: "NOT_STARTED", homeScore: null, awayScore: null }), selection());
  assertOutcome(r, "WAITING", "EVENT_NOT_COMPLETED");
});

test("status: IN_PROGRESS -> WAITING", () => {
  const r = evaluateSelectionOutcome(eventResult({ status: "IN_PROGRESS", homeScore: 1, awayScore: 0 }), selection());
  assertOutcome(r, "WAITING", "EVENT_NOT_COMPLETED");
});

test("status: POSTPONED -> WAITING with its own reason code", () => {
  const r = evaluateSelectionOutcome(eventResult({ status: "POSTPONED", homeScore: null, awayScore: null }), selection());
  assertOutcome(r, "WAITING", "EVENT_POSTPONED");
});

test("status: CANCELLED -> VOID (domain outcome only, not a financial op)", () => {
  const r = evaluateSelectionOutcome(eventResult({ status: "CANCELLED", homeScore: null, awayScore: null }), selection());
  assertOutcome(r, "VOID", "VOID_CANCELLED");
});

test("status: ABANDONED -> WAITING (deferred to manual review, not VOID)", () => {
  const r = evaluateSelectionOutcome(eventResult({ status: "ABANDONED", homeScore: 1, awayScore: 0 }), selection());
  assertOutcome(r, "WAITING", "EVENT_ABANDONED");
});

test("status: UNKNOWN -> INVALID_DATA (not WAITING — we don't know it will ever resolve)", () => {
  const r = evaluateSelectionOutcome(eventResult({ status: "UNKNOWN", homeScore: null, awayScore: null }), selection());
  assertOutcome(r, "INVALID_DATA", "INVALID_EVENT_RESULT");
});

test("status: COMPLETED + valid score -> real evaluation", () => {
  const r = evaluateSelectionOutcome(eventResult({ status: "COMPLETED", homeScore: 2, awayScore: 0 }), selection({ selectionType: "HOME" }));
  assertOutcome(r, "WIN", "WIN_HOME_PARTICIPANT");
});

test("status: completed=false with a score present is still WAITING — score is never read", () => {
  const r = evaluateSelectionOutcome(eventResult({ status: "IN_PROGRESS", homeScore: 5, awayScore: 5 }), selection({ selectionType: "DRAW" }));
  assertOutcome(r, "WAITING", "EVENT_NOT_COMPLETED");
});

/* -------------------------------------------------------------------------- */
/* D. Invalid result data                                                     */
/* -------------------------------------------------------------------------- */

test("invalid data: missing homeScore", () => {
  const r = evaluateSelectionOutcome(eventResult({ homeScore: null, awayScore: 1 }), selection());
  assertOutcome(r, "INVALID_DATA", "MISSING_SCORE");
});

test("invalid data: missing awayScore", () => {
  const r = evaluateSelectionOutcome(eventResult({ homeScore: 1, awayScore: null }), selection());
  assertOutcome(r, "INVALID_DATA", "MISSING_SCORE");
});

test("invalid data: NaN score", () => {
  const r = evaluateSelectionOutcome(eventResult({ homeScore: Number.NaN, awayScore: 1 }), selection());
  assertOutcome(r, "INVALID_DATA", "INVALID_SCORE");
});

test("invalid data: Infinity score", () => {
  const r = evaluateSelectionOutcome(eventResult({ homeScore: Number.POSITIVE_INFINITY, awayScore: 1 }), selection());
  assertOutcome(r, "INVALID_DATA", "INVALID_SCORE");
});

test("invalid data: negative score", () => {
  const r = evaluateSelectionOutcome(eventResult({ homeScore: -1, awayScore: 1 }), selection());
  assertOutcome(r, "INVALID_DATA", "INVALID_SCORE");
});

test("invalid data: decimal score is rejected", () => {
  const r = evaluateSelectionOutcome(eventResult({ homeScore: 1.5, awayScore: 1 }), selection());
  assertOutcome(r, "INVALID_DATA", "INVALID_SCORE");
});

test("invalid data: missing participants (empty name)", () => {
  const r = evaluateSelectionOutcome(eventResult({ homeParticipant: { name: "" } }), selection());
  assertOutcome(r, "INVALID_DATA", "INVALID_EVENT_RESULT");
});

test("invalid data: identical home/away participants", () => {
  const r = evaluateSelectionOutcome(
    eventResult({ homeParticipant: { name: "Arsenal" }, awayParticipant: { name: "arsenal " } }),
    selection(),
  );
  assertOutcome(r, "INVALID_DATA", "INVALID_EVENT_RESULT");
});

test("invalid data: malformed event result (whitespace-only participant name)", () => {
  const r = evaluateSelectionOutcome(eventResult({ awayParticipant: { name: "   " } }), selection());
  assertOutcome(r, "INVALID_DATA", "INVALID_EVENT_RESULT");
});

/* -------------------------------------------------------------------------- */
/* E. Selection validation                                                    */
/* -------------------------------------------------------------------------- */

test("selection: unsupported market (TOTALS)", () => {
  const r = evaluateSelectionOutcome(eventResult(), selection({ marketType: "TOTALS" as MarketType, selectionType: "OVER" as SelectionType }));
  assertOutcome(r, "UNSUPPORTED", "UNSUPPORTED_MARKET");
});

// Stage 3.5C-FIX — PARTICIPANT is no longer categorically UNSUPPORTED_SELECTION
// (production audit: 100% of real bets with any canonical fields at all
// were PARTICIPANT, zero were HOME/AWAY/DRAW — rejecting it outright meant
// automatic settlement could never succeed for a real bet). It is now
// resolved structurally to an effective HOME/AWAY side — see section G below
// for the full resolution test matrix. Double-chance selection types
// (HOME_OR_DRAW/DRAW_OR_AWAY/HOME_OR_AWAY) remain genuinely out of scope.
test("selection: double-chance selection types remain unsupported (HOME_OR_DRAW)", () => {
  const r = evaluateSelectionOutcome(eventResult(), selection({ marketType: "MONEYLINE_3WAY", selectionType: "HOME_OR_DRAW" }));
  assertOutcome(r, "UNSUPPORTED", "UNSUPPORTED_SELECTION");
});

test("selection: PARTICIPANT on a genuinely unsupported market (TOTALS) is still UNSUPPORTED_MARKET, not attempted", () => {
  const r = evaluateSelectionOutcome(
    eventResult(),
    selection({ marketType: "TOTALS" as MarketType, selectionType: "PARTICIPANT", participant: { name: "Arsenal" } }),
  );
  assertOutcome(r, "UNSUPPORTED", "UNSUPPORTED_MARKET");
});

test("selection: unsupported period", () => {
  const r = evaluateSelectionOutcome(eventResult(), selection({ period: "FIRST_HALF" }));
  assertOutcome(r, "UNSUPPORTED", "UNSUPPORTED_PERIOD");
});

test("selection: participant mismatch (HOME selection names a team that isn't the event's home team)", () => {
  const r = evaluateSelectionOutcome(
    eventResult({ homeParticipant: { name: "Arsenal" }, awayParticipant: { name: "Chelsea" } }),
    selection({ marketType: "MONEYLINE_2WAY", selectionType: "HOME", participant: { name: "Chelsea" } }),
  );
  assertOutcome(r, "INVALID_DATA", "PARTICIPANT_MISMATCH");
});

test("selection: DRAW in a 2-way market is UNSUPPORTED_SELECTION, not evaluated as a result", () => {
  const r = evaluateSelectionOutcome(eventResult({ homeScore: 1, awayScore: 1 }), selection({ marketType: "MONEYLINE_2WAY", selectionType: "DRAW" }));
  assertOutcome(r, "UNSUPPORTED", "UNSUPPORTED_SELECTION");
});

test("selection: missing canonical selection fields (marketType UNKNOWN)", () => {
  const r = evaluateSelectionOutcome(eventResult(), selection({ marketType: "UNKNOWN" }));
  assertOutcome(r, "UNSUPPORTED", "UNSUPPORTED_MARKET");
});

test("selection: canonicalLine does not influence the moneyline evaluator", () => {
  const withLine = evaluateSelectionOutcome(eventResult({ homeScore: 2, awayScore: 0 }), selection({ selectionType: "HOME", line: "1.5" }));
  const withoutLine = evaluateSelectionOutcome(eventResult({ homeScore: 2, awayScore: 0 }), selection({ selectionType: "HOME" }));
  assert.deepEqual(withLine, withoutLine);
});

test("selection: participant matching does not use fuzzy/free-text market data as a source of truth", () => {
  // HOME selection with a participant name that only loosely resembles the
  // real home team ("Arsenal FC" vs "Arsenal") must NOT be silently
  // accepted via fuzzy matching — only exact (normalized) matches pass.
  const r = evaluateSelectionOutcome(
    eventResult({ homeParticipant: { name: "Arsenal" } }),
    selection({ marketType: "MONEYLINE_2WAY", selectionType: "HOME", participant: { name: "Arsenal FC" } }),
  );
  assertOutcome(r, "INVALID_DATA", "PARTICIPANT_MISMATCH");
});

/* -------------------------------------------------------------------------- */
/* F. Purity                                                                  */
/* -------------------------------------------------------------------------- */

test("purity: input objects are not mutated", () => {
  const event = eventResult();
  const sel = selection();
  const eventCopy = JSON.parse(JSON.stringify(event));
  const selCopy = JSON.parse(JSON.stringify(sel));

  evaluateSelectionOutcome(event, sel);

  assert.deepEqual(event, eventCopy);
  assert.deepEqual(sel, selCopy);
});

test("purity: identical input always returns an equal (deep-equal) result", () => {
  const event = eventResult({ homeScore: 3, awayScore: 3 });
  const sel = selection({ marketType: "MONEYLINE_3WAY", selectionType: "DRAW" });

  const r1 = evaluateSelectionOutcome(event, sel);
  const r2 = evaluateSelectionOutcome(event, sel);

  assert.deepEqual(r1, r2);
});

/* -------------------------------------------------------------------------- */
/* G. PARTICIPANT resolution (Stage 3.5C-FIX)                                 */
/* -------------------------------------------------------------------------- */

test("PARTICIPANT: matches home, home wins -> WIN", () => {
  const r = evaluateSelectionOutcome(
    eventResult({ homeScore: 2, awayScore: 1 }),
    selection({ marketType: "MONEYLINE_3WAY", selectionType: "PARTICIPANT", participant: { name: "Arsenal" } }),
  );
  assertOutcome(r, "WIN", "WIN_HOME_PARTICIPANT");
});

test("PARTICIPANT: matches home, home loses -> LOSS", () => {
  const r = evaluateSelectionOutcome(
    eventResult({ homeScore: 0, awayScore: 1 }),
    selection({ marketType: "MONEYLINE_3WAY", selectionType: "PARTICIPANT", participant: { name: "Arsenal" } }),
  );
  assertOutcome(r, "LOSS", "LOSS_HOME_PARTICIPANT");
});

test("PARTICIPANT: matches away, away wins -> WIN", () => {
  const r = evaluateSelectionOutcome(
    eventResult({ homeScore: 0, awayScore: 2 }),
    selection({ marketType: "MONEYLINE_3WAY", selectionType: "PARTICIPANT", participant: { name: "Chelsea" } }),
  );
  assertOutcome(r, "WIN", "WIN_AWAY_PARTICIPANT");
});

test("PARTICIPANT: matches away, away loses -> LOSS", () => {
  const r = evaluateSelectionOutcome(
    eventResult({ homeScore: 2, awayScore: 0 }),
    selection({ marketType: "MONEYLINE_3WAY", selectionType: "PARTICIPANT", participant: { name: "Chelsea" } }),
  );
  assertOutcome(r, "LOSS", "LOSS_AWAY_PARTICIPANT");
});

test("PARTICIPANT: Cyrillic participant name matches the Latin provider home name", () => {
  const r = evaluateSelectionOutcome(
    eventResult({
      homeParticipant: { name: "Górnik Zabrze" },
      awayParticipant: { name: "Fenerbahce" },
      homeScore: 2,
      awayScore: 0,
    }),
    selection({ marketType: "MONEYLINE_3WAY", selectionType: "PARTICIPANT", participant: { name: "Гурник Забже" } }),
  );
  assertOutcome(r, "WIN", "WIN_HOME_PARTICIPANT");
});

test("PARTICIPANT: Cyrillic participant name matches the Latin provider away name", () => {
  const r = evaluateSelectionOutcome(
    eventResult({
      homeParticipant: { name: "Górnik Zabrze" },
      awayParticipant: { name: "Fenerbahce" },
      homeScore: 0,
      awayScore: 1,
    }),
    selection({ marketType: "MONEYLINE_3WAY", selectionType: "PARTICIPANT", participant: { name: "Фенербахче" } }),
  );
  assertOutcome(r, "WIN", "WIN_AWAY_PARTICIPANT");
});

test("PARTICIPANT: matches neither side -> INVALID_DATA(PARTICIPANT_MISMATCH), never guessed", () => {
  const r = evaluateSelectionOutcome(
    eventResult({ homeParticipant: { name: "Arsenal" }, awayParticipant: { name: "Chelsea" } }),
    selection({ marketType: "MONEYLINE_3WAY", selectionType: "PARTICIPANT", participant: { name: "Liverpool" } }),
  );
  assertOutcome(r, "INVALID_DATA", "PARTICIPANT_MISMATCH");
});

test("PARTICIPANT: matches BOTH sides -> INVALID_DATA(AMBIGUOUS_PARTICIPANT_MATCH), never guessed", () => {
  const r = evaluateSelectionOutcome(
    eventResult({ homeParticipant: { name: "Real Madrid" }, awayParticipant: { name: "Real Madrid Castilla" } }),
    selection({ marketType: "MONEYLINE_3WAY", selectionType: "PARTICIPANT", participant: { name: "Real Madrid" } }),
  );
  assertOutcome(r, "INVALID_DATA", "AMBIGUOUS_PARTICIPANT_MATCH");
});

test("PARTICIPANT: missing participant field entirely -> INVALID_DATA(MISSING_PARTICIPANT_NAME)", () => {
  const r = evaluateSelectionOutcome(eventResult(), selection({ marketType: "MONEYLINE_3WAY", selectionType: "PARTICIPANT" }));
  assertOutcome(r, "INVALID_DATA", "MISSING_PARTICIPANT_NAME");
});

test("PARTICIPANT: whitespace-only participant name -> INVALID_DATA(MISSING_PARTICIPANT_NAME)", () => {
  const r = evaluateSelectionOutcome(
    eventResult(),
    selection({ marketType: "MONEYLINE_3WAY", selectionType: "PARTICIPANT", participant: { name: "   " } }),
  );
  assertOutcome(r, "INVALID_DATA", "MISSING_PARTICIPANT_NAME");
});

test("PARTICIPANT: draw result in MONEYLINE_3WAY gives LOSS, same rule a real HOME selection already gets", () => {
  const r = evaluateSelectionOutcome(
    eventResult({ homeScore: 1, awayScore: 1 }),
    selection({ marketType: "MONEYLINE_3WAY", selectionType: "PARTICIPANT", participant: { name: "Arsenal" } }),
  );
  assertOutcome(r, "LOSS", "LOSS_HOME_PARTICIPANT");
});

test("PARTICIPANT: draw result in MONEYLINE_2WAY is VOID, same rule a real HOME selection already gets", () => {
  const r = evaluateSelectionOutcome(
    eventResult({ homeScore: 1, awayScore: 1 }),
    selection({ marketType: "MONEYLINE_2WAY", selectionType: "PARTICIPANT", participant: { name: "Arsenal" } }),
  );
  assertOutcome(r, "VOID", "VOID_DRAW_TWO_WAY_MARKET");
});

test("purity: repeated calls across every event status produce stable results (no hidden clock/state dependency)", () => {
  const statuses: EventResultStatus[] = ["NOT_STARTED", "IN_PROGRESS", "COMPLETED", "CANCELLED", "POSTPONED", "ABANDONED", "UNKNOWN"];
  for (const status of statuses) {
    const event = eventResult({ status, homeScore: status === "COMPLETED" ? 1 : null, awayScore: status === "COMPLETED" ? 0 : null });
    const sel = selection({ selectionType: "HOME" });
    const first = evaluateSelectionOutcome(event, sel);
    const second = evaluateSelectionOutcome(event, sel);
    assert.deepEqual(first, second, `status ${status} produced non-deterministic results`);
  }
});
