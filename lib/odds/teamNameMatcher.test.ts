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

test("resolveParticipantSide: a name matching BOTH sides is AMBIGUOUS, never a guessed side", () => {
  // "Real Madrid" vs a hypothetical reserve/B-team fixture sharing most of
  // the same words — a genuine real-world ambiguity, not a contrived edge
  // case: both "Real Madrid" (exact) and "Real Madrid Castilla" (2/3 word
  // overlap) clear PARTICIPANT_MATCH_THRESHOLD.
  assert.deepEqual(resolveParticipantSide("Real Madrid", "Real Madrid", "Real Madrid Castilla"), { kind: "AMBIGUOUS" });
});
