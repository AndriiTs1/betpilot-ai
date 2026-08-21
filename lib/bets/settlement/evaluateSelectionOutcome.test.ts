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

// H5-A2 — TOTALS is no longer categorically UNSUPPORTED_MARKET (see the
// dedicated "H5-A2" section below for the full TOTALS matrix); a market
// that genuinely remains out of scope (both-teams-to-score, per H4-B5's own
// scope note) replaces it here so this test still proves what it always
// proved: a real, unmodeled market returns UNSUPPORTED_MARKET.
test("selection: unsupported market (BOTH_TEAMS_TO_SCORE)", () => {
  const r = evaluateSelectionOutcome(eventResult(), selection({ marketType: "BOTH_TEAMS_TO_SCORE" as MarketType, selectionType: "YES" as SelectionType }));
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

test("selection: PARTICIPANT on a genuinely unsupported market (BOTH_TEAMS_TO_SCORE) is still UNSUPPORTED_MARKET, not attempted", () => {
  const r = evaluateSelectionOutcome(
    eventResult(),
    selection({ marketType: "BOTH_TEAMS_TO_SCORE" as MarketType, selectionType: "PARTICIPANT", participant: { name: "Arsenal" } }),
  );
  assertOutcome(r, "UNSUPPORTED", "UNSUPPORTED_MARKET");
});

// H5-A2 — TOTALS IS supported now, but only as OVER/UNDER; PARTICIPANT
// (the SPREAD/MONEYLINE shape) is not a valid TOTALS selectionType, and
// must be UNSUPPORTED_SELECTION, not UNSUPPORTED_MARKET.
test("selection: PARTICIPANT on TOTALS (a supported market, wrong selectionType) is UNSUPPORTED_SELECTION", () => {
  const r = evaluateSelectionOutcome(
    eventResult(),
    selection({ marketType: "TOTALS" as MarketType, selectionType: "PARTICIPANT", participant: { name: "Arsenal" } }),
  );
  assertOutcome(r, "UNSUPPORTED", "UNSUPPORTED_SELECTION");
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

/* -------------------------------------------------------------------------- */
/* H4-B2 — SPREAD / Asian handicap                                            */
/* -------------------------------------------------------------------------- */

function spreadSelection(participantName: string, line: string | undefined, overrides: Partial<CanonicalSelection> = {}): CanonicalSelection {
  return selection({
    marketType: "SPREAD",
    selectionType: "PARTICIPANT",
    participant: { name: participantName },
    line,
    ...overrides,
  });
}

test("SPREAD: market/period/selectionType gates — SPREAD is no longer UNSUPPORTED_MARKET", () => {
  const r = evaluateSelectionOutcome(
    eventResult({ homeParticipant: { name: "Arsenal" }, awayParticipant: { name: "Coventry City" }, homeScore: 2, awayScore: 1 }),
    spreadSelection("Arsenal", "-1"),
  );
  assert.notEqual(r.kind, "UNSUPPORTED");
});

test("SPREAD: non-PARTICIPANT selectionType is still UNSUPPORTED_SELECTION", () => {
  const r = evaluateSelectionOutcome(
    eventResult({ homeScore: 2, awayScore: 1 }),
    spreadSelection("Arsenal", "-1", { selectionType: "HOME" }),
  );
  assertOutcome(r, "UNSUPPORTED", "UNSUPPORTED_SELECTION");
});

test("SPREAD: wrong period is still UNSUPPORTED_PERIOD", () => {
  const r = evaluateSelectionOutcome(
    eventResult({ homeScore: 2, awayScore: 1 }),
    spreadSelection("Arsenal", "-1", { period: "FIRST_HALF" }),
  );
  assertOutcome(r, "UNSUPPORTED", "UNSUPPORTED_PERIOD");
});

/* ---- Section 4 worked examples, exactly as specified ---- */

test("SPREAD Section 4: Arsenal 2 - Coventry 1, Arsenal -1 -> adjusted 0 -> VOID (push)", () => {
  const r = evaluateSelectionOutcome(
    eventResult({ homeParticipant: { name: "Arsenal" }, awayParticipant: { name: "Coventry City" }, homeScore: 2, awayScore: 1 }),
    spreadSelection("Arsenal", "-1"),
  );
  assertOutcome(r, "VOID", "VOID_PUSH_SPREAD");
});

test("SPREAD Section 4: Arsenal 2 - Coventry 1, Arsenal -1.5 -> adjusted -0.5 -> LOSS", () => {
  const r = evaluateSelectionOutcome(
    eventResult({ homeParticipant: { name: "Arsenal" }, awayParticipant: { name: "Coventry City" }, homeScore: 2, awayScore: 1 }),
    spreadSelection("Arsenal", "-1.5"),
  );
  assertOutcome(r, "LOSS", "LOSS_SPREAD_HOME_PARTICIPANT");
});

test("SPREAD Section 4: Arsenal 2 - Coventry 1, Coventry +1.5 -> adjusted +0.5 -> WIN (participant is never assumed home)", () => {
  const r = evaluateSelectionOutcome(
    eventResult({ homeParticipant: { name: "Arsenal" }, awayParticipant: { name: "Coventry City" }, homeScore: 2, awayScore: 1 }),
    spreadSelection("Coventry City", "1.5"),
  );
  assertOutcome(r, "WIN", "WIN_SPREAD_AWAY_PARTICIPANT");
});

/* ---- Section 5: whole/half line results map to WIN/LOSS/VOID kinds ---- */

test("SPREAD Section 5: whole/half-line WIN maps to kind WIN (not a new status)", () => {
  const r = evaluateSelectionOutcome(
    eventResult({ homeParticipant: { name: "Arsenal" }, awayParticipant: { name: "Coventry City" }, homeScore: 3, awayScore: 0 }),
    spreadSelection("Arsenal", "-1"),
  );
  assertOutcome(r, "WIN", "WIN_SPREAD_HOME_PARTICIPANT");
});

test("SPREAD Section 5: whole/half-line LOSS maps to kind LOSS", () => {
  const r = evaluateSelectionOutcome(
    eventResult({ homeParticipant: { name: "Arsenal" }, awayParticipant: { name: "Coventry City" }, homeScore: 0, awayScore: 0 }),
    spreadSelection("Arsenal", "-1"),
  );
  assertOutcome(r, "LOSS", "LOSS_SPREAD_HOME_PARTICIPANT");
});

test("SPREAD Section 5: whole/half-line PUSH maps to kind VOID, no new PUSH status introduced", () => {
  const r = evaluateSelectionOutcome(
    eventResult({ homeParticipant: { name: "Arsenal" }, awayParticipant: { name: "Coventry City" }, homeScore: 1, awayScore: 1 }),
    spreadSelection("Arsenal", "0"),
  );
  assertOutcome(r, "VOID", "VOID_PUSH_SPREAD");
});

/* ---- Section 7: Arsenal -1.25 full matrix ---- */

test("SPREAD Section 7: Arsenal -1.25, wins by 2 -> full WIN", () => {
  const r = evaluateSelectionOutcome(
    eventResult({ homeParticipant: { name: "Arsenal" }, awayParticipant: { name: "Coventry City" }, homeScore: 3, awayScore: 1 }),
    spreadSelection("Arsenal", "-1.25"),
  );
  assertOutcome(r, "WIN", "WIN_SPREAD_HOME_PARTICIPANT");
});

test("SPREAD Section 7: Arsenal -1.25, wins by 1 -> HALF_LOSS (-1 component PUSH, -1.5 component LOSS)", () => {
  const r = evaluateSelectionOutcome(
    eventResult({ homeParticipant: { name: "Arsenal" }, awayParticipant: { name: "Coventry City" }, homeScore: 2, awayScore: 1 }),
    spreadSelection("Arsenal", "-1.25"),
  );
  assertOutcome(r, "HALF_LOSS", "HALF_LOSS_HOME_PARTICIPANT");
});

test("SPREAD Section 7: Arsenal -1.25, draws -> full LOSS", () => {
  const r = evaluateSelectionOutcome(
    eventResult({ homeParticipant: { name: "Arsenal" }, awayParticipant: { name: "Coventry City" }, homeScore: 1, awayScore: 1 }),
    spreadSelection("Arsenal", "-1.25"),
  );
  assertOutcome(r, "LOSS", "LOSS_SPREAD_HOME_PARTICIPANT");
});

test("SPREAD Section 7: Arsenal -1.25, loses -> full LOSS", () => {
  const r = evaluateSelectionOutcome(
    eventResult({ homeParticipant: { name: "Arsenal" }, awayParticipant: { name: "Coventry City" }, homeScore: 0, awayScore: 1 }),
    spreadSelection("Arsenal", "-1.25"),
  );
  assertOutcome(r, "LOSS", "LOSS_SPREAD_HOME_PARTICIPANT");
});

/* ---- Section 7: Arsenal -0.75 matrix ---- */

test("SPREAD Section 7: Arsenal -0.75, wins by 1 -> HALF_WIN (-0.5 component WIN, -1 component PUSH)", () => {
  const r = evaluateSelectionOutcome(
    eventResult({ homeParticipant: { name: "Arsenal" }, awayParticipant: { name: "Coventry City" }, homeScore: 2, awayScore: 1 }),
    spreadSelection("Arsenal", "-0.75"),
  );
  assertOutcome(r, "HALF_WIN", "HALF_WIN_HOME_PARTICIPANT");
});

test("SPREAD Section 7: Arsenal -0.75, wins by 2 -> full WIN", () => {
  const r = evaluateSelectionOutcome(
    eventResult({ homeParticipant: { name: "Arsenal" }, awayParticipant: { name: "Coventry City" }, homeScore: 3, awayScore: 1 }),
    spreadSelection("Arsenal", "-0.75"),
  );
  assertOutcome(r, "WIN", "WIN_SPREAD_HOME_PARTICIPANT");
});

test("SPREAD Section 7: Arsenal -0.75, draws -> full LOSS", () => {
  const r = evaluateSelectionOutcome(
    eventResult({ homeParticipant: { name: "Arsenal" }, awayParticipant: { name: "Coventry City" }, homeScore: 1, awayScore: 1 }),
    spreadSelection("Arsenal", "-0.75"),
  );
  assertOutcome(r, "LOSS", "LOSS_SPREAD_HOME_PARTICIPANT");
});

/* ---- Section 8: Coventry +1.25 matrix (positive line, away participant) ---- */

test("SPREAD Section 8: Coventry +1.25, loses by 1 -> HALF_WIN (+1 component PUSH, +1.5 component WIN)", () => {
  const r = evaluateSelectionOutcome(
    eventResult({ homeParticipant: { name: "Arsenal" }, awayParticipant: { name: "Coventry City" }, homeScore: 2, awayScore: 1 }),
    spreadSelection("Coventry City", "1.25"),
  );
  assertOutcome(r, "HALF_WIN", "HALF_WIN_AWAY_PARTICIPANT");
});

test("SPREAD Section 8: Coventry +1.25, loses by 2 -> full LOSS", () => {
  const r = evaluateSelectionOutcome(
    eventResult({ homeParticipant: { name: "Arsenal" }, awayParticipant: { name: "Coventry City" }, homeScore: 3, awayScore: 1 }),
    spreadSelection("Coventry City", "1.25"),
  );
  assertOutcome(r, "LOSS", "LOSS_SPREAD_AWAY_PARTICIPANT");
});

test("SPREAD Section 8: Coventry +1.25, draws -> full WIN", () => {
  const r = evaluateSelectionOutcome(
    eventResult({ homeParticipant: { name: "Arsenal" }, awayParticipant: { name: "Coventry City" }, homeScore: 1, awayScore: 1 }),
    spreadSelection("Coventry City", "1.25"),
  );
  assertOutcome(r, "WIN", "WIN_SPREAD_AWAY_PARTICIPANT");
});

test("SPREAD Section 8: Coventry +1.25, wins -> full WIN", () => {
  const r = evaluateSelectionOutcome(
    eventResult({ homeParticipant: { name: "Arsenal" }, awayParticipant: { name: "Coventry City" }, homeScore: 1, awayScore: 2 }),
    spreadSelection("Coventry City", "1.25"),
  );
  assertOutcome(r, "WIN", "WIN_SPREAD_AWAY_PARTICIPANT");
});

/* ---- Section 8: Coventry +0.75 matrix ---- */

test("SPREAD Section 8: Coventry +0.75, loses by 1 -> HALF_LOSS (+0.5 component LOSS, +1 component PUSH)", () => {
  const r = evaluateSelectionOutcome(
    eventResult({ homeParticipant: { name: "Arsenal" }, awayParticipant: { name: "Coventry City" }, homeScore: 2, awayScore: 1 }),
    spreadSelection("Coventry City", "0.75"),
  );
  assertOutcome(r, "HALF_LOSS", "HALF_LOSS_AWAY_PARTICIPANT");
});

test("SPREAD Section 8: Coventry +0.75, draws -> full WIN", () => {
  const r = evaluateSelectionOutcome(
    eventResult({ homeParticipant: { name: "Arsenal" }, awayParticipant: { name: "Coventry City" }, homeScore: 1, awayScore: 1 }),
    spreadSelection("Coventry City", "0.75"),
  );
  assertOutcome(r, "WIN", "WIN_SPREAD_AWAY_PARTICIPANT");
});

/* ---- Section 9: full 8-line quarter matrix ---- */

test("SPREAD Section 9: Arsenal -0.25, wins by 1 -> full WIN", () => {
  const r = evaluateSelectionOutcome(
    eventResult({ homeParticipant: { name: "Arsenal" }, awayParticipant: { name: "Coventry City" }, homeScore: 2, awayScore: 1 }),
    spreadSelection("Arsenal", "-0.25"),
  );
  assertOutcome(r, "WIN", "WIN_SPREAD_HOME_PARTICIPANT");
});

test("SPREAD Section 9: Arsenal -0.25, draws -> HALF_LOSS", () => {
  const r = evaluateSelectionOutcome(
    eventResult({ homeParticipant: { name: "Arsenal" }, awayParticipant: { name: "Coventry City" }, homeScore: 1, awayScore: 1 }),
    spreadSelection("Arsenal", "-0.25"),
  );
  assertOutcome(r, "HALF_LOSS", "HALF_LOSS_HOME_PARTICIPANT");
});

test("SPREAD Section 9: Arsenal -0.25, loses by 1 -> full LOSS", () => {
  const r = evaluateSelectionOutcome(
    eventResult({ homeParticipant: { name: "Arsenal" }, awayParticipant: { name: "Coventry City" }, homeScore: 0, awayScore: 1 }),
    spreadSelection("Arsenal", "-0.25"),
  );
  assertOutcome(r, "LOSS", "LOSS_SPREAD_HOME_PARTICIPANT");
});

test("SPREAD Section 9: Arsenal -1.75, wins by 2 -> HALF_WIN", () => {
  const r = evaluateSelectionOutcome(
    eventResult({ homeParticipant: { name: "Arsenal" }, awayParticipant: { name: "Coventry City" }, homeScore: 3, awayScore: 1 }),
    spreadSelection("Arsenal", "-1.75"),
  );
  assertOutcome(r, "HALF_WIN", "HALF_WIN_HOME_PARTICIPANT");
});

test("SPREAD Section 9: Arsenal -1.75, wins by 3 -> full WIN", () => {
  const r = evaluateSelectionOutcome(
    eventResult({ homeParticipant: { name: "Arsenal" }, awayParticipant: { name: "Coventry City" }, homeScore: 4, awayScore: 1 }),
    spreadSelection("Arsenal", "-1.75"),
  );
  assertOutcome(r, "WIN", "WIN_SPREAD_HOME_PARTICIPANT");
});

test("SPREAD Section 9: Arsenal -1.75, wins by 1 -> full LOSS", () => {
  const r = evaluateSelectionOutcome(
    eventResult({ homeParticipant: { name: "Arsenal" }, awayParticipant: { name: "Coventry City" }, homeScore: 2, awayScore: 1 }),
    spreadSelection("Arsenal", "-1.75"),
  );
  assertOutcome(r, "LOSS", "LOSS_SPREAD_HOME_PARTICIPANT");
});

test("SPREAD Section 9: Coventry +0.25, loses by 1 -> full LOSS", () => {
  const r = evaluateSelectionOutcome(
    eventResult({ homeParticipant: { name: "Arsenal" }, awayParticipant: { name: "Coventry City" }, homeScore: 2, awayScore: 1 }),
    spreadSelection("Coventry City", "0.25"),
  );
  assertOutcome(r, "LOSS", "LOSS_SPREAD_AWAY_PARTICIPANT");
});

test("SPREAD Section 9: Coventry +0.25, draws -> HALF_WIN", () => {
  const r = evaluateSelectionOutcome(
    eventResult({ homeParticipant: { name: "Arsenal" }, awayParticipant: { name: "Coventry City" }, homeScore: 1, awayScore: 1 }),
    spreadSelection("Coventry City", "0.25"),
  );
  assertOutcome(r, "HALF_WIN", "HALF_WIN_AWAY_PARTICIPANT");
});

test("SPREAD Section 9: Coventry +0.25, wins by 1 -> full WIN", () => {
  const r = evaluateSelectionOutcome(
    eventResult({ homeParticipant: { name: "Arsenal" }, awayParticipant: { name: "Coventry City" }, homeScore: 1, awayScore: 2 }),
    spreadSelection("Coventry City", "0.25"),
  );
  assertOutcome(r, "WIN", "WIN_SPREAD_AWAY_PARTICIPANT");
});

test("SPREAD Section 9: Coventry +1.75, loses by 2 -> HALF_LOSS", () => {
  const r = evaluateSelectionOutcome(
    eventResult({ homeParticipant: { name: "Arsenal" }, awayParticipant: { name: "Coventry City" }, homeScore: 3, awayScore: 1 }),
    spreadSelection("Coventry City", "1.75"),
  );
  assertOutcome(r, "HALF_LOSS", "HALF_LOSS_AWAY_PARTICIPANT");
});

test("SPREAD Section 9: Coventry +1.75, loses by 1 -> full WIN", () => {
  const r = evaluateSelectionOutcome(
    eventResult({ homeParticipant: { name: "Arsenal" }, awayParticipant: { name: "Coventry City" }, homeScore: 2, awayScore: 1 }),
    spreadSelection("Coventry City", "1.75"),
  );
  assertOutcome(r, "WIN", "WIN_SPREAD_AWAY_PARTICIPANT");
});

test("SPREAD Section 9: Coventry +1.75, loses by 3 -> full LOSS", () => {
  const r = evaluateSelectionOutcome(
    eventResult({ homeParticipant: { name: "Arsenal" }, awayParticipant: { name: "Coventry City" }, homeScore: 4, awayScore: 1 }),
    spreadSelection("Coventry City", "1.75"),
  );
  assertOutcome(r, "LOSS", "LOSS_SPREAD_AWAY_PARTICIPANT");
});

/* ---- Section 10: home/away safety, multi-word teams ---- */

test("SPREAD Section 10: Real Madrid (home) -0.5, wins by 1 -> WIN", () => {
  const r = evaluateSelectionOutcome(
    eventResult({ homeParticipant: { name: "Real Madrid" }, awayParticipant: { name: "Barcelona" }, homeScore: 2, awayScore: 1 }),
    spreadSelection("Real Madrid", "-0.5"),
  );
  assertOutcome(r, "WIN", "WIN_SPREAD_HOME_PARTICIPANT");
});

test("SPREAD Section 10: Barcelona (away) +0.5, home wins by 1 -> LOSS (side never flipped)", () => {
  const r = evaluateSelectionOutcome(
    eventResult({ homeParticipant: { name: "Real Madrid" }, awayParticipant: { name: "Barcelona" }, homeScore: 2, awayScore: 1 }),
    spreadSelection("Barcelona", "0.5"),
  );
  assertOutcome(r, "LOSS", "LOSS_SPREAD_AWAY_PARTICIPANT");
});

test("SPREAD Section 10: Manchester United (away) +1.25, loses by 1 -> HALF_WIN", () => {
  const r = evaluateSelectionOutcome(
    eventResult({ homeParticipant: { name: "Chelsea" }, awayParticipant: { name: "Manchester United" }, homeScore: 2, awayScore: 1 }),
    spreadSelection("Manchester United", "1.25"),
  );
  assertOutcome(r, "HALF_WIN", "HALF_WIN_AWAY_PARTICIPANT");
});

test("SPREAD Section 10: Manchester United (home) -1.25, wins by 1 -> HALF_LOSS (same math, opposite side)", () => {
  const r = evaluateSelectionOutcome(
    eventResult({ homeParticipant: { name: "Manchester United" }, awayParticipant: { name: "Chelsea" }, homeScore: 2, awayScore: 1 }),
    spreadSelection("Manchester United", "-1.25"),
  );
  assertOutcome(r, "HALF_LOSS", "HALF_LOSS_HOME_PARTICIPANT");
});

/* ---- Section 11: participant matching (reused, not reimplemented) ---- */

test("SPREAD Section 11: participant matches neither side -> INVALID_DATA(PARTICIPANT_MISMATCH), never guessed", () => {
  const r = evaluateSelectionOutcome(
    eventResult({ homeParticipant: { name: "Arsenal" }, awayParticipant: { name: "Chelsea" } }),
    spreadSelection("Liverpool", "-1"),
  );
  assertOutcome(r, "INVALID_DATA", "PARTICIPANT_MISMATCH");
});

test("SPREAD Section 11: participant matches BOTH sides -> INVALID_DATA(AMBIGUOUS_PARTICIPANT_MATCH), never guessed", () => {
  const r = evaluateSelectionOutcome(
    eventResult({ homeParticipant: { name: "Real Madrid" }, awayParticipant: { name: "Real Madrid Castilla" } }),
    spreadSelection("Real Madrid", "-1"),
  );
  assertOutcome(r, "INVALID_DATA", "AMBIGUOUS_PARTICIPANT_MATCH");
});

test("SPREAD Section 11: missing participant name -> INVALID_DATA(MISSING_PARTICIPANT_NAME)", () => {
  const r = evaluateSelectionOutcome(eventResult(), spreadSelection("", "-1"));
  assertOutcome(r, "INVALID_DATA", "MISSING_PARTICIPANT_NAME");
});

/* ---- Section 12: safety gates preserved for SPREAD ---- */

test("SPREAD Section 12: missing score -> INVALID_DATA(MISSING_SCORE), same gate as MONEYLINE", () => {
  const r = evaluateSelectionOutcome(
    eventResult({ homeParticipant: { name: "Arsenal" }, awayParticipant: { name: "Coventry City" }, homeScore: null }),
    spreadSelection("Arsenal", "-1"),
  );
  assertOutcome(r, "INVALID_DATA", "MISSING_SCORE");
});

test("SPREAD Section 12: invalid (non-integer) score -> INVALID_DATA(INVALID_SCORE)", () => {
  const r = evaluateSelectionOutcome(
    eventResult({ homeParticipant: { name: "Arsenal" }, awayParticipant: { name: "Coventry City" }, homeScore: 1.5, awayScore: 1 }),
    spreadSelection("Arsenal", "-1"),
  );
  assertOutcome(r, "INVALID_DATA", "INVALID_SCORE");
});

test("SPREAD Section 12: event not completed -> WAITING, same gate as MONEYLINE", () => {
  const r = evaluateSelectionOutcome(
    eventResult({ homeParticipant: { name: "Arsenal" }, awayParticipant: { name: "Coventry City" }, status: "IN_PROGRESS", homeScore: null, awayScore: null }),
    spreadSelection("Arsenal", "-1"),
  );
  assertOutcome(r, "WAITING", "EVENT_NOT_COMPLETED");
});

test("SPREAD Section 12: cancelled event -> VOID(VOID_CANCELLED), same gate as MONEYLINE, not conflated with a spread push", () => {
  const r = evaluateSelectionOutcome(
    eventResult({ homeParticipant: { name: "Arsenal" }, awayParticipant: { name: "Coventry City" }, status: "CANCELLED", homeScore: null, awayScore: null }),
    spreadSelection("Arsenal", "-1"),
  );
  assertOutcome(r, "VOID", "VOID_CANCELLED");
});

/* ---- Section 3: valid line grid — invalid fractions fail safely ---- */

test("SPREAD Section 3: off-grid line -1.33 -> INVALID_DATA(INVALID_LINE), never silently rounded", () => {
  const r = evaluateSelectionOutcome(
    eventResult({ homeParticipant: { name: "Arsenal" }, awayParticipant: { name: "Coventry City" }, homeScore: 2, awayScore: 1 }),
    spreadSelection("Arsenal", "-1.33"),
  );
  assertOutcome(r, "INVALID_DATA", "INVALID_LINE");
});

test("SPREAD Section 3: off-grid line +0.10 -> INVALID_DATA(INVALID_LINE), never silently rounded", () => {
  const r = evaluateSelectionOutcome(
    eventResult({ homeParticipant: { name: "Arsenal" }, awayParticipant: { name: "Coventry City" }, homeScore: 2, awayScore: 1 }),
    spreadSelection("Arsenal", "0.10"),
  );
  assertOutcome(r, "INVALID_DATA", "INVALID_LINE");
});

test("SPREAD: missing line entirely -> INVALID_DATA(MISSING_LINE)", () => {
  const r = evaluateSelectionOutcome(
    eventResult({ homeParticipant: { name: "Arsenal" }, awayParticipant: { name: "Coventry City" }, homeScore: 2, awayScore: 1 }),
    spreadSelection("Arsenal", undefined),
  );
  assertOutcome(r, "INVALID_DATA", "MISSING_LINE");
});

/* ---- Critical invariants ---- */

test("Invariant A: -1.25 is never rounded to -1 or -1.5 before evaluation — HALF_LOSS (wins by 1) and full LOSS (wins by 0) are genuinely distinguished", () => {
  const winBy1 = evaluateSelectionOutcome(
    eventResult({ homeParticipant: { name: "Arsenal" }, awayParticipant: { name: "Coventry City" }, homeScore: 2, awayScore: 1 }),
    spreadSelection("Arsenal", "-1.25"),
  );
  const draw = evaluateSelectionOutcome(
    eventResult({ homeParticipant: { name: "Arsenal" }, awayParticipant: { name: "Coventry City" }, homeScore: 1, awayScore: 1 }),
    spreadSelection("Arsenal", "-1.25"),
  );
  assert.equal(winBy1.kind, "HALF_LOSS");
  assert.equal(draw.kind, "LOSS");
  assert.notDeepEqual(winBy1, draw);
});

test("Invariant C/D: HALF_WIN is never emitted as full WIN, HALF_LOSS is never emitted as full LOSS", () => {
  const halfWin = evaluateSelectionOutcome(
    eventResult({ homeParticipant: { name: "Arsenal" }, awayParticipant: { name: "Coventry City" }, homeScore: 2, awayScore: 1 }),
    spreadSelection("Arsenal", "-0.75"),
  );
  const halfLoss = evaluateSelectionOutcome(
    eventResult({ homeParticipant: { name: "Arsenal" }, awayParticipant: { name: "Coventry City" }, homeScore: 2, awayScore: 1 }),
    spreadSelection("Arsenal", "-1.25"),
  );
  assert.equal(halfWin.kind, "HALF_WIN");
  assert.notEqual(halfWin.kind, "WIN");
  assert.equal(halfLoss.kind, "HALF_LOSS");
  assert.notEqual(halfLoss.kind, "LOSS");
});

test("Invariant E: HALF_WIN/HALF_LOSS carry no financial amount — the result shape has only kind and reasonCode", () => {
  const r = evaluateSelectionOutcome(
    eventResult({ homeParticipant: { name: "Arsenal" }, awayParticipant: { name: "Coventry City" }, homeScore: 2, awayScore: 1 }),
    spreadSelection("Arsenal", "-0.75"),
  );
  assert.deepEqual(Object.keys(r).sort(), ["kind", "reasonCode"]);
});

test("Invariant B: participant side is never flipped — same fixture, opposite participant name, opposite result", () => {
  const forArsenal = evaluateSelectionOutcome(
    eventResult({ homeParticipant: { name: "Arsenal" }, awayParticipant: { name: "Coventry City" }, homeScore: 2, awayScore: 1 }),
    spreadSelection("Arsenal", "-1.5"),
  );
  const forCoventry = evaluateSelectionOutcome(
    eventResult({ homeParticipant: { name: "Arsenal" }, awayParticipant: { name: "Coventry City" }, homeScore: 2, awayScore: 1 }),
    spreadSelection("Coventry City", "1.5"),
  );
  assert.equal(forArsenal.kind, "LOSS");
  assert.equal(forCoventry.kind, "WIN");
});

/* -------------------------------------------------------------------------- */
/* H5-A2 — TOTALS / Asian totals                                             */
/* -------------------------------------------------------------------------- */

function totalsSelection(direction: "OVER" | "UNDER", line: string | undefined, overrides: Partial<CanonicalSelection> = {}): CanonicalSelection {
  return selection({
    marketType: "TOTALS",
    selectionType: direction,
    line,
    ...overrides,
  });
}

function totalsResult(homeScore: number, awayScore: number, overrides: Partial<CanonicalEventResult> = {}): CanonicalEventResult {
  return eventResult({ homeParticipant: { name: "Arsenal" }, awayParticipant: { name: "Coventry City" }, homeScore, awayScore, ...overrides });
}

test("TOTALS: market/period/selectionType gates — TOTALS is no longer UNSUPPORTED_MARKET", () => {
  const r = evaluateSelectionOutcome(totalsResult(2, 1), totalsSelection("OVER", "2.5"));
  assert.notEqual(r.kind, "UNSUPPORTED");
});

test("TOTALS: wrong period is still UNSUPPORTED_PERIOD", () => {
  const r = evaluateSelectionOutcome(totalsResult(2, 1), totalsSelection("OVER", "2.5", { period: "FIRST_HALF" }));
  assertOutcome(r, "UNSUPPORTED", "UNSUPPORTED_PERIOD");
});

/* ---- Standard (whole/half) lines ---- */

test("TOTALS standard: Over 2.5, 3 goals total -> WIN", () => {
  const r = evaluateSelectionOutcome(totalsResult(2, 1), totalsSelection("OVER", "2.5"));
  assertOutcome(r, "WIN", "WIN_TOTALS_OVER");
});

test("TOTALS standard: Under 2.5, 3 goals total -> LOSS", () => {
  const r = evaluateSelectionOutcome(totalsResult(2, 1), totalsSelection("UNDER", "2.5"));
  assertOutcome(r, "LOSS", "LOSS_TOTALS_UNDER");
});

test("TOTALS standard: Over 3.0, exactly 3 goals total -> VOID (push), no new PUSH status introduced", () => {
  const r = evaluateSelectionOutcome(totalsResult(2, 1), totalsSelection("OVER", "3"));
  assertOutcome(r, "VOID", "VOID_PUSH_TOTALS");
});

test("TOTALS standard: Under 3.0, exactly 3 goals total -> VOID (push)", () => {
  const r = evaluateSelectionOutcome(totalsResult(2, 1), totalsSelection("UNDER", "3"));
  assertOutcome(r, "VOID", "VOID_PUSH_TOTALS");
});

test("TOTALS standard: Over 3.0, 2 goals total -> LOSS", () => {
  const r = evaluateSelectionOutcome(totalsResult(1, 1), totalsSelection("OVER", "3"));
  assertOutcome(r, "LOSS", "LOSS_TOTALS_OVER");
});

test("TOTALS standard: Under 3.0, 2 goals total -> WIN", () => {
  const r = evaluateSelectionOutcome(totalsResult(1, 1), totalsSelection("UNDER", "3"));
  assertOutcome(r, "WIN", "WIN_TOTALS_UNDER");
});

/* ---- Required Asian total matrix, exactly as specified ---- */

test("TOTALS Over 2.25: 3 goals -> WIN", () => {
  const r = evaluateSelectionOutcome(totalsResult(2, 1), totalsSelection("OVER", "2.25"));
  assertOutcome(r, "WIN", "WIN_TOTALS_OVER");
});

test("TOTALS Over 2.25: 2 goals -> HALF_LOSS", () => {
  const r = evaluateSelectionOutcome(totalsResult(1, 1), totalsSelection("OVER", "2.25"));
  assertOutcome(r, "HALF_LOSS", "HALF_LOSS_TOTALS_OVER");
});

test("TOTALS Over 2.25: 1 goal -> LOSS", () => {
  const r = evaluateSelectionOutcome(totalsResult(1, 0), totalsSelection("OVER", "2.25"));
  assertOutcome(r, "LOSS", "LOSS_TOTALS_OVER");
});

test("TOTALS Under 2.25: 1 goal -> WIN", () => {
  const r = evaluateSelectionOutcome(totalsResult(1, 0), totalsSelection("UNDER", "2.25"));
  assertOutcome(r, "WIN", "WIN_TOTALS_UNDER");
});

test("TOTALS Under 2.25: 2 goals -> HALF_WIN", () => {
  const r = evaluateSelectionOutcome(totalsResult(1, 1), totalsSelection("UNDER", "2.25"));
  assertOutcome(r, "HALF_WIN", "HALF_WIN_TOTALS_UNDER");
});

test("TOTALS Under 2.25: 3 goals -> LOSS", () => {
  const r = evaluateSelectionOutcome(totalsResult(2, 1), totalsSelection("UNDER", "2.25"));
  assertOutcome(r, "LOSS", "LOSS_TOTALS_UNDER");
});

test("TOTALS Over 2.75: 4 goals -> WIN", () => {
  const r = evaluateSelectionOutcome(totalsResult(2, 2), totalsSelection("OVER", "2.75"));
  assertOutcome(r, "WIN", "WIN_TOTALS_OVER");
});

test("TOTALS Over 2.75: 3 goals -> HALF_WIN", () => {
  const r = evaluateSelectionOutcome(totalsResult(2, 1), totalsSelection("OVER", "2.75"));
  assertOutcome(r, "HALF_WIN", "HALF_WIN_TOTALS_OVER");
});

test("TOTALS Over 2.75: 2 goals -> LOSS", () => {
  const r = evaluateSelectionOutcome(totalsResult(1, 1), totalsSelection("OVER", "2.75"));
  assertOutcome(r, "LOSS", "LOSS_TOTALS_OVER");
});

test("TOTALS Under 2.75: 2 goals -> WIN", () => {
  const r = evaluateSelectionOutcome(totalsResult(1, 1), totalsSelection("UNDER", "2.75"));
  assertOutcome(r, "WIN", "WIN_TOTALS_UNDER");
});

test("TOTALS Under 2.75: 3 goals -> HALF_LOSS", () => {
  const r = evaluateSelectionOutcome(totalsResult(2, 1), totalsSelection("UNDER", "2.75"));
  assertOutcome(r, "HALF_LOSS", "HALF_LOSS_TOTALS_UNDER");
});

test("TOTALS Under 2.75: 4 goals -> LOSS", () => {
  const r = evaluateSelectionOutcome(totalsResult(2, 2), totalsSelection("UNDER", "2.75"));
  assertOutcome(r, "LOSS", "LOSS_TOTALS_UNDER");
});

/* ---- 3.25 / 3.75 quarter-grid regression ---- */

test("TOTALS Over 3.25: 4 goals -> WIN (component split [3, 3.5], both WIN)", () => {
  const r = evaluateSelectionOutcome(totalsResult(2, 2), totalsSelection("OVER", "3.25"));
  assertOutcome(r, "WIN", "WIN_TOTALS_OVER");
});

test("TOTALS Over 3.25: 3 goals -> HALF_LOSS (component split [3, 3.5]: PUSH + LOSS)", () => {
  const r = evaluateSelectionOutcome(totalsResult(2, 1), totalsSelection("OVER", "3.25"));
  assertOutcome(r, "HALF_LOSS", "HALF_LOSS_TOTALS_OVER");
});

test("TOTALS Under 3.25: 3 goals -> HALF_WIN (component split [3, 3.5]: PUSH + WIN)", () => {
  const r = evaluateSelectionOutcome(totalsResult(2, 1), totalsSelection("UNDER", "3.25"));
  assertOutcome(r, "HALF_WIN", "HALF_WIN_TOTALS_UNDER");
});

test("TOTALS Over 3.75: 4 goals -> HALF_WIN (component split [3.5, 4]: WIN + PUSH)", () => {
  const r = evaluateSelectionOutcome(totalsResult(2, 2), totalsSelection("OVER", "3.75"));
  assertOutcome(r, "HALF_WIN", "HALF_WIN_TOTALS_OVER");
});

test("TOTALS Under 3.75: 4 goals -> HALF_LOSS (component split [3.5, 4]: LOSS + PUSH)", () => {
  const r = evaluateSelectionOutcome(totalsResult(2, 2), totalsSelection("UNDER", "3.75"));
  assertOutcome(r, "HALF_LOSS", "HALF_LOSS_TOTALS_UNDER");
});

/* ---- Grid safety: valid vs invalid/off-grid lines, never rounded ---- */

test("TOTALS grid: every valid whole/half/quarter form is accepted (2, 2.0, 2.25, 2.5, 2.50, 2.75, 3, 3.25, 3.5, 3.75)", () => {
  for (const line of ["2", "2.0", "2.25", "2.5", "2.50", "2.75", "3", "3.25", "3.5", "3.75"]) {
    const r = evaluateSelectionOutcome(totalsResult(2, 1), totalsSelection("OVER", line));
    assert.notEqual(r.kind, "INVALID_DATA", `line "${line}" must be accepted, got ${JSON.stringify(r)}`);
  }
});

test("TOTALS grid: off-grid lines (2.1, 2.33, 2.6) fail closed as INVALID_LINE, never rounded to the nearest supported grid point", () => {
  for (const line of ["2.1", "2.33", "2.6"]) {
    const r = evaluateSelectionOutcome(totalsResult(2, 1), totalsSelection("OVER", line));
    assertOutcome(r, "INVALID_DATA", "INVALID_LINE");
  }
});

/* ---- Fail-closed ---- */

test("TOTALS fail-closed: missing line -> INVALID_DATA MISSING_LINE", () => {
  const r = evaluateSelectionOutcome(totalsResult(2, 1), totalsSelection("OVER", undefined));
  assertOutcome(r, "INVALID_DATA", "MISSING_LINE");
});

test("TOTALS fail-closed: missing score -> INVALID_DATA MISSING_SCORE", () => {
  const r = evaluateSelectionOutcome(totalsResult(2, 1, { homeScore: null }), totalsSelection("OVER", "2.5"));
  assertOutcome(r, "INVALID_DATA", "MISSING_SCORE");
});

test("TOTALS fail-closed: invalid event result (blank participant name) -> INVALID_DATA INVALID_EVENT_RESULT", () => {
  const r = evaluateSelectionOutcome(totalsResult(2, 1, { homeParticipant: { name: "" } }), totalsSelection("OVER", "2.5"));
  assertOutcome(r, "INVALID_DATA", "INVALID_EVENT_RESULT");
});

test("TOTALS fail-closed: not-yet-completed event -> WAITING, never a guessed result", () => {
  const r = evaluateSelectionOutcome(totalsResult(2, 1, { status: "IN_PROGRESS" }), totalsSelection("OVER", "2.5"));
  assertOutcome(r, "WAITING", "EVENT_NOT_COMPLETED");
});

/* ---- Purity / semantic invariants, mirroring the SPREAD section above ---- */

test("TOTALS invariant: HALF_WIN/HALF_LOSS carry no financial amount — the result shape has only kind and reasonCode", () => {
  const r = evaluateSelectionOutcome(totalsResult(1, 1), totalsSelection("OVER", "2.25"));
  assert.deepEqual(Object.keys(r).sort(), ["kind", "reasonCode"]);
});

test("TOTALS invariant: OVER and UNDER on the identical fixture/line never agree — one must WIN, PUSH, or LOSS oppositely", () => {
  const over = evaluateSelectionOutcome(totalsResult(2, 1), totalsSelection("OVER", "2.5"));
  const under = evaluateSelectionOutcome(totalsResult(2, 1), totalsSelection("UNDER", "2.5"));
  assert.equal(over.kind, "WIN");
  assert.equal(under.kind, "LOSS");
});

/* -------------------------------------------------------------------------- */
/* Individual Team Totals, Stage 4                                            */
/* -------------------------------------------------------------------------- */

function teamTotalSelection(
  participantName: string,
  direction: "OVER" | "UNDER",
  line: string | undefined,
  overrides: Partial<CanonicalSelection> = {},
): CanonicalSelection {
  return selection({
    marketType: "TEAM_TOTAL",
    selectionType: direction,
    participant: { name: participantName },
    line,
    ...overrides,
  });
}

// Marseille (home) 2–1 Strasbourg (away) — the task's own worked example.
function marseilleStrasbourgResult(homeScore: number, awayScore: number): CanonicalEventResult {
  return eventResult({ homeParticipant: { name: "Marseille" }, awayParticipant: { name: "Strasbourg" }, homeScore, awayScore });
}

test("TEAM_TOTAL: market/period gates — TEAM_TOTAL is no longer UNSUPPORTED_MARKET", () => {
  const r = evaluateSelectionOutcome(marseilleStrasbourgResult(2, 1), teamTotalSelection("Marseille", "OVER", "1.5"));
  assert.notEqual(r.kind, "UNSUPPORTED");
});

test("TEAM_TOTAL: a non-OVER/UNDER selectionType is UNSUPPORTED_SELECTION, mirroring TOTALS' own rule", () => {
  const r = evaluateSelectionOutcome(
    marseilleStrasbourgResult(2, 1),
    teamTotalSelection("Marseille", "OVER", "1.5", { selectionType: "PARTICIPANT" }),
  );
  assertOutcome(r, "UNSUPPORTED", "UNSUPPORTED_SELECTION");
});

test("TEAM_TOTAL: wrong period is still UNSUPPORTED_PERIOD", () => {
  const r = evaluateSelectionOutcome(marseilleStrasbourgResult(2, 1), teamTotalSelection("Marseille", "OVER", "1.5", { period: "FIRST_HALF" }));
  assertOutcome(r, "UNSUPPORTED", "UNSUPPORTED_PERIOD");
});

/* --- HOME team (Marseille) — required cases 1-6 -------------------------- */

test("TEAM_TOTAL (1) HOME: 'Marseille OVER 1.5', Marseille scores 2 -> WIN", () => {
  const r = evaluateSelectionOutcome(marseilleStrasbourgResult(2, 1), teamTotalSelection("Marseille", "OVER", "1.5"));
  assertOutcome(r, "WIN", "WIN_TEAM_TOTAL_HOME_OVER");
});

test("TEAM_TOTAL (2) HOME: 'Marseille OVER 1.5', Marseille scores 1 -> LOSS", () => {
  const r = evaluateSelectionOutcome(marseilleStrasbourgResult(1, 3), teamTotalSelection("Marseille", "OVER", "1.5"));
  assertOutcome(r, "LOSS", "LOSS_TEAM_TOTAL_HOME_OVER");
});

test("TEAM_TOTAL (2b) HOME: 'Marseille OVER 1.5', Marseille scores 0 -> LOSS", () => {
  const r = evaluateSelectionOutcome(marseilleStrasbourgResult(0, 0), teamTotalSelection("Marseille", "OVER", "1.5"));
  assertOutcome(r, "LOSS", "LOSS_TEAM_TOTAL_HOME_OVER");
});

test("TEAM_TOTAL (3) HOME: 'Marseille UNDER 1.5', Marseille scores 1 -> WIN", () => {
  const r = evaluateSelectionOutcome(marseilleStrasbourgResult(1, 0), teamTotalSelection("Marseille", "UNDER", "1.5"));
  assertOutcome(r, "WIN", "WIN_TEAM_TOTAL_HOME_UNDER");
});

test("TEAM_TOTAL (3b) HOME: 'Marseille UNDER 1.5', Marseille scores 0 -> WIN", () => {
  const r = evaluateSelectionOutcome(marseilleStrasbourgResult(0, 2), teamTotalSelection("Marseille", "UNDER", "1.5"));
  assertOutcome(r, "WIN", "WIN_TEAM_TOTAL_HOME_UNDER");
});

test("TEAM_TOTAL (4) HOME: 'Marseille UNDER 1.5', Marseille scores 2 -> LOSS", () => {
  const r = evaluateSelectionOutcome(marseilleStrasbourgResult(2, 1), teamTotalSelection("Marseille", "UNDER", "1.5"));
  assertOutcome(r, "LOSS", "LOSS_TEAM_TOTAL_HOME_UNDER");
});

test("TEAM_TOTAL (5) HOME: whole-number line — 'Marseille OVER 2', Marseille scores exactly 2 -> PUSH/VOID", () => {
  const r = evaluateSelectionOutcome(marseilleStrasbourgResult(2, 0), teamTotalSelection("Marseille", "OVER", "2"));
  assertOutcome(r, "VOID", "VOID_PUSH_TEAM_TOTAL");
});

test("TEAM_TOTAL (5b) HOME: 'Marseille OVER 2', Marseille scores 1 -> LOSS; scores 3 -> WIN", () => {
  const loss = evaluateSelectionOutcome(marseilleStrasbourgResult(1, 0), teamTotalSelection("Marseille", "OVER", "2"));
  const win = evaluateSelectionOutcome(marseilleStrasbourgResult(3, 0), teamTotalSelection("Marseille", "OVER", "2"));
  assert.equal(loss.kind, "LOSS");
  assert.equal(win.kind, "WIN");
});

test("TEAM_TOTAL (6) HOME: whole-number line — 'Marseille UNDER 2', Marseille scores exactly 2 -> PUSH/VOID", () => {
  const r = evaluateSelectionOutcome(marseilleStrasbourgResult(2, 0), teamTotalSelection("Marseille", "UNDER", "2"));
  assertOutcome(r, "VOID", "VOID_PUSH_TEAM_TOTAL");
});

test("TEAM_TOTAL (6b) HOME: 'Marseille UNDER 2', Marseille scores 0/1 -> WIN; scores 3+ -> LOSS", () => {
  const win0 = evaluateSelectionOutcome(marseilleStrasbourgResult(0, 0), teamTotalSelection("Marseille", "UNDER", "2"));
  const win1 = evaluateSelectionOutcome(marseilleStrasbourgResult(1, 0), teamTotalSelection("Marseille", "UNDER", "2"));
  const loss = evaluateSelectionOutcome(marseilleStrasbourgResult(3, 0), teamTotalSelection("Marseille", "UNDER", "2"));
  assert.equal(win0.kind, "WIN");
  assert.equal(win1.kind, "WIN");
  assert.equal(loss.kind, "LOSS");
});

/* --- AWAY team (Strasbourg) — required cases 7-11, proven independently -- */

test("TEAM_TOTAL (7) AWAY: 'Strasbourg OVER 1.5', Strasbourg scores 2 -> WIN", () => {
  const r = evaluateSelectionOutcome(marseilleStrasbourgResult(0, 2), teamTotalSelection("Strasbourg", "OVER", "1.5"));
  assertOutcome(r, "WIN", "WIN_TEAM_TOTAL_AWAY_OVER");
});

test("TEAM_TOTAL (8) AWAY: 'Strasbourg OVER 1.5', Strasbourg scores 1 -> LOSS", () => {
  const r = evaluateSelectionOutcome(marseilleStrasbourgResult(2, 1), teamTotalSelection("Strasbourg", "OVER", "1.5"));
  assertOutcome(r, "LOSS", "LOSS_TEAM_TOTAL_AWAY_OVER");
});

test("TEAM_TOTAL (9) AWAY: 'Strasbourg UNDER 1.5', Strasbourg scores 1 -> WIN", () => {
  const r = evaluateSelectionOutcome(marseilleStrasbourgResult(2, 1), teamTotalSelection("Strasbourg", "UNDER", "1.5"));
  assertOutcome(r, "WIN", "WIN_TEAM_TOTAL_AWAY_UNDER");
});

test("TEAM_TOTAL (10) AWAY: 'Strasbourg UNDER 1.5', Strasbourg scores 2 -> LOSS", () => {
  const r = evaluateSelectionOutcome(marseilleStrasbourgResult(0, 2), teamTotalSelection("Strasbourg", "UNDER", "1.5"));
  assertOutcome(r, "LOSS", "LOSS_TEAM_TOTAL_AWAY_UNDER");
});

test("TEAM_TOTAL (11) AWAY: integer-line push — 'Strasbourg OVER 2', Strasbourg scores exactly 2 -> PUSH/VOID", () => {
  const r = evaluateSelectionOutcome(marseilleStrasbourgResult(0, 2), teamTotalSelection("Strasbourg", "OVER", "2"));
  assertOutcome(r, "VOID", "VOID_PUSH_TEAM_TOTAL");
});

/* --- Task's own worked example: Marseille 2-1 Strasbourg ----------------- */

test("TEAM_TOTAL worked example: Marseille 2-1 Strasbourg — 'Marseille OVER 1.5' -> WIN, 'Strasbourg OVER 1.5' -> LOSS, 'Marseille UNDER 2.5' -> WIN, 'Strasbourg UNDER 1.5' -> WIN", () => {
  const result = marseilleStrasbourgResult(2, 1);
  assert.equal(evaluateSelectionOutcome(result, teamTotalSelection("Marseille", "OVER", "1.5")).kind, "WIN");
  assert.equal(evaluateSelectionOutcome(result, teamTotalSelection("Strasbourg", "OVER", "1.5")).kind, "LOSS");
  assert.equal(evaluateSelectionOutcome(result, teamTotalSelection("Marseille", "UNDER", "2.5")).kind, "WIN");
  assert.equal(evaluateSelectionOutcome(result, teamTotalSelection("Strasbourg", "UNDER", "1.5")).kind, "WIN");
});

/* --- SAFETY: cases 12-14 -------------------------------------------------- */

test("TEAM_TOTAL (12) SAFETY: participant cannot cross-match home/away — Marseille's own OVER 1.5 never reads Strasbourg's score, and vice versa, against the SAME final score", () => {
  const result = marseilleStrasbourgResult(2, 1); // Marseille 2, Strasbourg 1
  const marseille = evaluateSelectionOutcome(result, teamTotalSelection("Marseille", "OVER", "1.5"));
  const strasbourg = evaluateSelectionOutcome(result, teamTotalSelection("Strasbourg", "OVER", "1.5"));
  // Marseille (2) clears 1.5 -> WIN; Strasbourg (1) does not -> LOSS. If the
  // evaluator ever cross-matched, these would incorrectly come out equal.
  assert.equal(marseille.kind, "WIN");
  assert.equal(strasbourg.kind, "LOSS");
  assert.notEqual(marseille.kind, strasbourg.kind);
});

test("TEAM_TOTAL (13) SAFETY: an unknown participant does not settle using the wrong score — PARTICIPANT_MISMATCH, never a guess", () => {
  const r = evaluateSelectionOutcome(marseilleStrasbourgResult(2, 1), teamTotalSelection("Real Madrid", "OVER", "1.5"));
  assertOutcome(r, "INVALID_DATA", "PARTICIPANT_MISMATCH");
});

test("TEAM_TOTAL (13b) SAFETY: an ambiguous participant name (matches both sides) never guesses a side", () => {
  const result = eventResult({ homeParticipant: { name: "Real Madrid" }, awayParticipant: { name: "Real Madrid Castilla" }, homeScore: 2, awayScore: 1 });
  const r = evaluateSelectionOutcome(result, teamTotalSelection("Real Madrid Castilla B", "OVER", "1.5"));
  // "Real Madrid Castilla B" fuzzily overlaps both "Real Madrid" (shared
  // "Real"+"Madrid") and "Real Madrid Castilla" (shared majority) without a
  // decisive exact match on either — must never guess.
  assert.ok(r.kind === "INVALID_DATA");
});

test("TEAM_TOTAL (13c) SAFETY: missing participant name -> MISSING_PARTICIPANT_NAME, never guessed as home", () => {
  const r = evaluateSelectionOutcome(marseilleStrasbourgResult(2, 1), teamTotalSelection("", "OVER", "1.5", { participant: undefined }));
  assertOutcome(r, "INVALID_DATA", "MISSING_PARTICIPANT_NAME");
});

test("TEAM_TOTAL (14) SAFETY: malformed line fails safely — INVALID_LINE, never coerced/rounded", () => {
  const r = evaluateSelectionOutcome(marseilleStrasbourgResult(2, 1), teamTotalSelection("Marseille", "OVER", "not-a-number"));
  assertOutcome(r, "INVALID_DATA", "INVALID_LINE");
});

test("TEAM_TOTAL (14b) SAFETY: missing line -> MISSING_LINE", () => {
  const r = evaluateSelectionOutcome(marseilleStrasbourgResult(2, 1), teamTotalSelection("Marseille", "OVER", undefined));
  assertOutcome(r, "INVALID_DATA", "MISSING_LINE");
});

test("TEAM_TOTAL (14c) SAFETY: a line outside the supported .00/.25/.50/.75 grid -> INVALID_LINE, never rounded to the nearest supported line", () => {
  const r = evaluateSelectionOutcome(marseilleStrasbourgResult(2, 1), teamTotalSelection("Marseille", "OVER", "1.33"));
  assertOutcome(r, "INVALID_DATA", "INVALID_LINE");
});

/* --- Quarter-line TEAM_TOTAL (reuses splitAsianHandicapLine unmodified) --- */

test("TEAM_TOTAL quarter-line: 'Marseille OVER 1.25', Marseille scores exactly 1 -> HALF_LOSS", () => {
  const r = evaluateSelectionOutcome(marseilleStrasbourgResult(1, 0), teamTotalSelection("Marseille", "OVER", "1.25"));
  assertOutcome(r, "HALF_LOSS", "HALF_LOSS_TEAM_TOTAL_HOME_OVER");
});

test("TEAM_TOTAL quarter-line: 'Marseille OVER 0.75', Marseille scores exactly 1 -> HALF_WIN", () => {
  const r = evaluateSelectionOutcome(marseilleStrasbourgResult(1, 0), teamTotalSelection("Marseille", "OVER", "0.75"));
  assertOutcome(r, "HALF_WIN", "HALF_WIN_TEAM_TOTAL_HOME_OVER");
});

/* --- Existing markets unchanged: cases 15-17 ------------------------------ */

test("TEAM_TOTAL Stage 4 regression (15): existing TOTALS (match total) behavior is completely unaffected by the TEAM_TOTAL addition", () => {
  const r = evaluateSelectionOutcome(totalsResult(2, 1), totalsSelection("OVER", "2.5"));
  assertOutcome(r, "WIN", "WIN_TOTALS_OVER");
});

test("TEAM_TOTAL Stage 4 regression (16): existing SPREAD behavior is completely unaffected by the TEAM_TOTAL addition", () => {
  const r = evaluateSelectionOutcome(
    eventResult({ homeParticipant: { name: "Arsenal" }, awayParticipant: { name: "Coventry City" }, homeScore: 2, awayScore: 0 }),
    spreadSelection("Arsenal", "-1.5"),
  );
  assertOutcome(r, "WIN", "WIN_SPREAD_HOME_PARTICIPANT");
});

test("TEAM_TOTAL Stage 4 regression (17): existing MONEYLINE behavior is completely unaffected by the TEAM_TOTAL addition", () => {
  const r = evaluateSelectionOutcome(eventResult({ homeScore: 2, awayScore: 1 }), selection({ marketType: "MONEYLINE_3WAY", selectionType: "HOME" }));
  assertOutcome(r, "WIN", "WIN_HOME_PARTICIPANT");
});
