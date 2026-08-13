import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeOcrParticipantClaim, normalizeSelectionTextForCanonicalization } from "./ocrParticipantClaimNormalizer";

/* -------------------------------------------------------------------------- */
/* SCREENSHOT QA-CORE S1 — required positive cases (task's own A/C/D/E)       */
/* -------------------------------------------------------------------------- */

test("A: the real production claim 'Bayern Win (П1)' cleans to 'Bayern'", () => {
  assert.equal(normalizeOcrParticipantClaim("Bayern Win (П1)"), "Bayern");
});

test("B: 'VfB Stuttgart (П2)' cleans to 'VfB Stuttgart'", () => {
  assert.equal(normalizeOcrParticipantClaim("VfB Stuttgart (П2)"), "VfB Stuttgart");
});

test("C: 'RB Leipzig W1' cleans to 'RB Leipzig' (trailing bare W1 shorthand)", () => {
  assert.equal(normalizeOcrParticipantClaim("RB Leipzig W1"), "RB Leipzig");
});

test("D: 'Borussia Mönchengladbach W2' cleans to 'Borussia Mönchengladbach'", () => {
  assert.equal(normalizeOcrParticipantClaim("Borussia Mönchengladbach W2"), "Borussia Mönchengladbach");
});

test("E: 'RB Leipzig to win' cleans to 'RB Leipzig' (winner-suffix only, no shorthand token present)", () => {
  assert.equal(normalizeOcrParticipantClaim("RB Leipzig to win"), "RB Leipzig");
});

test("leading shorthand + separator: 'П1 - Бавария' cleans to 'Бавария'", () => {
  assert.equal(normalizeOcrParticipantClaim("П1 - Бавария"), "Бавария");
});

test("leading shorthand, no separator: 'П1 Бавария' cleans to 'Бавария'", () => {
  assert.equal(normalizeOcrParticipantClaim("П1 Бавария"), "Бавария");
});

/* -------------------------------------------------------------------------- */
/* Safety — must never over-strip a genuine participant name                  */
/* -------------------------------------------------------------------------- */

test("a clean participant name with no noise is returned unchanged", () => {
  assert.equal(normalizeOcrParticipantClaim("Bayern Munich"), "Bayern Munich");
  assert.equal(normalizeOcrParticipantClaim("Real Madrid"), "Real Madrid");
  assert.equal(normalizeOcrParticipantClaim("RB Leipzig"), "RB Leipzig");
});

test("a genuinely descriptive parenthetical (not a shorthand token) is left untouched", () => {
  assert.equal(normalizeOcrParticipantClaim("Bayern Munich (Germany)"), "Bayern Munich (Germany)");
});

test("a first/last word that merely LOOKS short is never stripped unless it's an exact closed-vocabulary token", () => {
  // "1899" is not "1" — must not be treated as the HOME shorthand token.
  assert.equal(normalizeOcrParticipantClaim("Hoffenheim 1899"), "Hoffenheim 1899");
});

test("a single-word claim that is itself a shorthand token is not emptied out — falls back to the original text", () => {
  assert.equal(normalizeOcrParticipantClaim("(П1)"), "(П1)");
});

test("whitespace is trimmed and normalized even when no shorthand noise is present", () => {
  assert.equal(normalizeOcrParticipantClaim("  Arsenal  "), "Arsenal");
});

test("an empty string is returned as-is, never throws", () => {
  assert.equal(normalizeOcrParticipantClaim(""), "");
  assert.equal(normalizeOcrParticipantClaim("   "), "");
});

/* -------------------------------------------------------------------------- */
/* SCREENSHOT ODDS QA-2 — normalizeSelectionTextForCanonicalization, the      */
/* deliberately NARROWER sibling used for provider-request canonicalization  */
/* (buildBetSlipPreview.ts), not reconciliation.                             */
/* -------------------------------------------------------------------------- */

test("normalizeSelectionTextForCanonicalization: strips a trailing parenthetical shorthand, same as the full normalizer", () => {
  assert.equal(normalizeSelectionTextForCanonicalization("Bayern Win (П1)"), "Bayern Win");
  assert.equal(normalizeSelectionTextForCanonicalization("VfB Stuttgart (П2)"), "VfB Stuttgart");
});

test("normalizeSelectionTextForCanonicalization: strips a leading shorthand token + separator, same as the full normalizer", () => {
  assert.equal(normalizeSelectionTextForCanonicalization("П1 - Бавария"), "Бавария");
  assert.equal(normalizeSelectionTextForCanonicalization("П1 Бавария"), "Бавария");
});

test("normalizeSelectionTextForCanonicalization: does NOT strip a trailing winner suffix — classifyOnce (shorthandClassifier.ts) already handles that on its own, and pre-stripping it would remove the exact signal that keeps a market hint from overriding a real selection-derived claim (a real regression found while building this fix)", () => {
  assert.equal(normalizeSelectionTextForCanonicalization("Arsenal Win"), "Arsenal Win");
  assert.equal(normalizeSelectionTextForCanonicalization("RB Leipzig to win"), "RB Leipzig to win");
});

test("normalizeSelectionTextForCanonicalization: does NOT strip a trailing bare shorthand token — legacySelectionToCanonicalRequest's own knownParticipantNames prefix loop already handles that case when it follows an exact participant-name prefix", () => {
  assert.equal(normalizeSelectionTextForCanonicalization("Bayern Munich W1"), "Bayern Munich W1");
  assert.equal(normalizeSelectionTextForCanonicalization("RB Leipzig W1"), "RB Leipzig W1");
});

test("normalizeSelectionTextForCanonicalization: 'Bayern Win (П1)' -> 'Bayern Win' still lets classifyOnce's own winner-suffix stripping finish the job, unlike the untouched raw text", () => {
  // This is the exact real production defect (QA-4/rrrr.png): the trailing
  // parenthetical alone is what breaks classifyOnce's own `$`-anchored
  // WINNER_SUFFIX_REGEX (it requires the string to literally END in "win").
  // Stripping only the parenthetical exposes "Bayern Win", which classifyOnce
  // can now correctly self-classify as MONEYLINE_2WAY/PARTICIPANT "Bayern".
  const cleaned = normalizeSelectionTextForCanonicalization("Bayern Win (П1)");
  assert.equal(cleaned, "Bayern Win");
});

test("normalizeSelectionTextForCanonicalization: a clean participant name or market phrase is returned unchanged", () => {
  assert.equal(normalizeSelectionTextForCanonicalization("Bayern Munich"), "Bayern Munich");
  assert.equal(normalizeSelectionTextForCanonicalization("Over 2.5"), "Over 2.5");
  assert.equal(normalizeSelectionTextForCanonicalization("Arsenal -1.5"), "Arsenal -1.5");
});

test("normalizeSelectionTextForCanonicalization: an empty string is returned as-is, never throws", () => {
  assert.equal(normalizeSelectionTextForCanonicalization(""), "");
  assert.equal(normalizeSelectionTextForCanonicalization("   "), "");
});
