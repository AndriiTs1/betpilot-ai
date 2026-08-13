import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeTeamName, compareTeamNames, resolveParticipantSide } from "./teamNameMatcher";

// ---------------------------------------------------------------------
// normalizeTeamName — extracted verbatim from commit 7430506's
// oddsVerifier.ts fix; oddsVerifier.test.ts already covers this pipeline
// exhaustively (Cyrillic examples, aliases, empty/punctuation-only input),
// so this file focuses on the NEW public surface (compareTeamNames,
// resolveParticipantSide) this stage adds, plus a light smoke check that
// the extraction didn't change normalizeTeamName's own behavior.
// ---------------------------------------------------------------------

test("normalizeTeamName: smoke check — extraction preserved behavior", () => {
  assert.equal(normalizeTeamName("Arsenal"), "arsenal");
  assert.equal(normalizeTeamName("Гурник Забже"), "gurnik zabzhe");
  assert.equal(normalizeTeamName(""), "");
});

// ---------------------------------------------------------------------
// compareTeamNames
// ---------------------------------------------------------------------

test("compareTeamNames: exact Latin match scores 1", () => {
  assert.equal(compareTeamNames("Arsenal", "Arsenal"), 1);
});

test("compareTeamNames: case-insensitive match scores 1", () => {
  assert.equal(compareTeamNames("ARSENAL", "arsenal"), 1);
});

test("compareTeamNames: diacritics — Fenerbahçe matches Fenerbahce", () => {
  assert.equal(compareTeamNames("Fenerbahçe", "Fenerbahce"), 1);
});

test("compareTeamNames: Cyrillic transliteration — required examples", () => {
  assert.equal(compareTeamNames("Фенербахче", "Fenerbahce"), 1);
  assert.equal(compareTeamNames("Гурник Забже", "Górnik Zabrze"), 1);
  assert.equal(compareTeamNames("Кайрат Алматы", "Kairat Almaty"), 1);
  assert.equal(compareTeamNames("Омония", "Omonia"), 1);
  assert.equal(compareTeamNames("Кауно Жальгирис", "Kauno Zalgiris"), 1);
  assert.equal(compareTeamNames("КИ Клаксвик", "KI Klaksvík"), 1);
});

test("compareTeamNames: bounded typo tolerance — one missing letter in a long word still matches", () => {
  assert.equal(compareTeamNames("Liverpool", "Liverpol"), 1);
});

test("compareTeamNames: unrelated teams score 0", () => {
  assert.equal(compareTeamNames("Arsenal", "Chelsea"), 0);
});

test("compareTeamNames: empty values never match", () => {
  assert.equal(compareTeamNames("", "Arsenal"), 0);
  assert.equal(compareTeamNames("", ""), 0);
});

// ---------------------------------------------------------------------
// resolveParticipantSide
// ---------------------------------------------------------------------

test("resolveParticipantSide: exact home match resolves HOME", () => {
  assert.deepEqual(resolveParticipantSide("Arsenal", "Arsenal", "Chelsea"), { kind: "HOME" });
});

test("resolveParticipantSide: exact away match resolves AWAY", () => {
  assert.deepEqual(resolveParticipantSide("Chelsea", "Arsenal", "Chelsea"), { kind: "AWAY" });
});

test("resolveParticipantSide: Cyrillic participant name resolves against Latin provider names — home", () => {
  assert.deepEqual(resolveParticipantSide("Гурник Забже", "Górnik Zabrze", "Fenerbahce"), { kind: "HOME" });
});

test("resolveParticipantSide: Cyrillic participant name resolves against Latin provider names — away", () => {
  assert.deepEqual(resolveParticipantSide("Фенербахче", "Górnik Zabrze", "Fenerbahce"), { kind: "AWAY" });
});

test("resolveParticipantSide: a name matching neither side is NO_MATCH, never a guessed side", () => {
  assert.deepEqual(resolveParticipantSide("Liverpool", "Arsenal", "Chelsea"), { kind: "NO_MATCH" });
});

test("resolveParticipantSide: empty participant name is NO_MATCH, never a guessed side", () => {
  assert.deepEqual(resolveParticipantSide("", "Arsenal", "Chelsea"), { kind: "NO_MATCH" });
});

test("resolveParticipantSide: a name matching BOTH sides is AMBIGUOUS, never a guessed side, UNLESS one side is a decisive exact match (see the M2 tests below) — this case stays AMBIGUOUS because the losing side's overlap is a genuine majority, not just a shared prefix word", () => {
  // "Real Madrid" vs a hypothetical reserve/B-team fixture sharing most of
  // the same words — a genuine real-world ambiguity, not a contrived edge
  // case: both "Real Madrid" (exact) and "Real Madrid Castilla" (2/3 word
  // overlap) clear PARTICIPANT_MATCH_THRESHOLD, and 2/3 exceeds the M2
  // decisive-margin ceiling (0.5) — this is the exact boundary case that
  // proves the M2 fix did not simply lower the threshold.
  assert.deepEqual(resolveParticipantSide("Real Madrid", "Real Madrid", "Real Madrid Castilla"), { kind: "AMBIGUOUS" });
});

/* ============================================================================
 * SCREENSHOT QA-CORE M2 — decisive-margin resolution. A proven production
 * false AMBIGUOUS: claim "Real Madrid" against a real event whose HOME team
 * is literally "Real Madrid" and AWAY team is "Real Sociedad" — both used to
 * cross PARTICIPANT_MATCH_THRESHOLD (home=1.0 exact, away=0.5 sharing only
 * the generic "Real" prefix), so the resolver reported AMBIGUOUS even though
 * one side is a perfect match. Fixed generically (no team/league-specific
 * code) via DECISIVE_LOSING_SCORE_CEILING — see teamNameMatcher.ts's own
 * header for the full calibration rationale against both this case and the
 * pre-existing "Real Madrid Castilla" protected-ambiguity case above.
 * ============================================================================ */

test("M2 case 1: Real Madrid vs Real Sociedad, claim 'Real Madrid' -> HOME (the proven production case)", () => {
  assert.deepEqual(resolveParticipantSide("Real Madrid", "Real Madrid", "Real Sociedad"), { kind: "HOME" });
});

test("M2 case 2: Real Madrid vs Real Sociedad, claim 'Real Sociedad' -> AWAY (symmetric)", () => {
  assert.deepEqual(resolveParticipantSide("Real Sociedad", "Real Madrid", "Real Sociedad"), { kind: "AWAY" });
});

test("M2 case 3: Manchester United vs Manchester City, claim 'Manchester United' -> HOME", () => {
  assert.deepEqual(resolveParticipantSide("Manchester United", "Manchester United", "Manchester City"), { kind: "HOME" });
});

test("M2 case 4: Manchester United vs Manchester City, claim 'Manchester City' -> AWAY", () => {
  assert.deepEqual(resolveParticipantSide("Manchester City", "Manchester United", "Manchester City"), { kind: "AWAY" });
});

test("M2 case 5: Real Madrid vs Real Betis, claim 'Real Betis' -> AWAY", () => {
  assert.deepEqual(resolveParticipantSide("Real Betis", "Real Madrid", "Real Betis"), { kind: "AWAY" });
});

test("M2 case 6: genuinely ambiguous participant claim (neither side an exact match) remains AMBIGUOUS — fail-closed preserved", () => {
  // Neither side is score===1: home "Real Madrid" vs claim "Real" alone
  // scores lower than 1 (partial word), so even though both sides may cross
  // the base threshold, the decisive-margin rule never fires without an
  // exact winner.
  const result = resolveParticipantSide("Real", "Real Madrid", "Real Sociedad");
  assert.deepEqual(result, { kind: "AMBIGUOUS" });
});

test("M2 case 7: an unrelated participant produces the existing NO_MATCH result, unaffected by the decisive-margin change", () => {
  assert.deepEqual(resolveParticipantSide("Liverpool", "Real Madrid", "Real Sociedad"), { kind: "NO_MATCH" });
});

test("M2 case 8: accents/case normalization behavior is unaffected — decisive resolution still works through normalizeTeamName", () => {
  assert.deepEqual(resolveParticipantSide("real madrid", "REAL MADRID", "Real Sociedad"), { kind: "HOME" });
  assert.deepEqual(resolveParticipantSide("Реал Мадрид", "Real Madrid", "Real Sociedad"), { kind: "HOME" });
});

test("M2 case 9: existing Cyrillic transliteration decisive cases still resolve correctly (exact match, no genuine second candidate)", () => {
  assert.deepEqual(resolveParticipantSide("Гурник Забже", "Górnik Zabrze", "Fenerbahce"), { kind: "HOME" });
  assert.deepEqual(resolveParticipantSide("Фенербахче", "Górnik Zabrze", "Fenerbahce"), { kind: "AWAY" });
});

test("M2: two teams sharing a common non-Spanish prefix word also resolve decisively (Sporting CP vs Sporting Braga) — proves the fix is generic, not Real-Madrid-specific", () => {
  assert.deepEqual(resolveParticipantSide("Sporting CP", "Sporting CP", "Sporting Braga"), { kind: "HOME" });
});

test("M2: Manchester derby and Milan derby style pairs both resolve decisively — further proof the fix generalizes across different shared-prefix club names", () => {
  assert.deepEqual(resolveParticipantSide("Inter Milan", "Inter Milan", "AC Milan"), { kind: "HOME" });
  assert.deepEqual(resolveParticipantSide("AC Milan", "AC Milan", "Inter Milan"), { kind: "HOME" });
});

test("M2: if BOTH sides happen to be an exact score-1 match (a degenerate data scenario), the result is still honestly AMBIGUOUS, never an arbitrary pick", () => {
  const result = resolveParticipantSide("Real Madrid", "Real Madrid", "Real Madrid");
  assert.deepEqual(result, { kind: "AMBIGUOUS" });
});
