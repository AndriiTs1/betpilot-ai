// Step 8A — reusable UniversalBetDraft builder helpers, used only by this
// directory's own tests (legacyAdapter.test.ts in particular, whose parity
// scenarios each need a full hand-built draft). Not a production module —
// exists purely to cut duplication across test files, matching this
// repo's existing convention of colocating test-support code next to the
// tests that use it (no top-level tests/ directory exists anywhere in this
// codebase — see this step's final report for why the task's suggested
// tests/fixtures/ path was not used).

import {
  extractedField,
  missingField,
  type BetDraftEvent,
  type BetDraftField,
  type RawBetExtraction,
  type UniversalBetDraft,
  type UniversalBetDraftSelection,
} from "./domain";

export function draftEvent(overrides: Partial<BetDraftEvent> = {}): BetDraftEvent {
  return {
    rawText: "Arsenal vs Chelsea",
    participants: [
      { index: 0, rawName: "Arsenal" },
      { index: 1, rawName: "Chelsea" },
    ],
    scheduledStartTime: missingField(),
    ...overrides,
  };
}

export function draftRaw(overrides: Partial<RawBetExtraction> = {}): RawBetExtraction {
  return {
    originalText: "Arsenal to beat Chelsea, $50 at 1.95",
    sourceType: "CHAT",
    language: missingField<string>(),
    confidence: "HIGH",
    warnings: [],
    ...overrides,
  };
}

export function draftSelection(overrides: Partial<UniversalBetDraftSelection> = {}): UniversalBetDraftSelection {
  return {
    sport: extractedField("FOOTBALL", "Football"),
    league: missingField(),
    event: draftEvent(),
    marketType: missingField(),
    selectionType: extractedField("PARTICIPANT", "Arsenal"),
    selectionRawText: "Arsenal",
    participant: { kind: "INDEX", participantIndex: 0 },
    period: missingField(),
    line: missingField(),
    submittedOdds: "1.95",
    ...overrides,
  };
}

export function draft(overrides: Partial<UniversalBetDraft> = {}): UniversalBetDraft {
  return {
    raw: draftRaw(),
    slipType: "SINGLE",
    stake: "50",
    selections: [draftSelection()],
    ...overrides,
  };
}

// Small helper so tests reading a BetDraftField's value don't need a type
// guard at every call site — only ever used in test code.
export function fieldValue<T>(field: BetDraftField<T>): T | null {
  return field.value;
}
