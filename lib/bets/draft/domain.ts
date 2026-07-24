// Step 8A — Universal BetDraft: a provider-neutral, extraction-source-
// neutral representation of a parsed bet slip, richer than
// lib/bets/betSlip.ts's ParsedBetSlip but adapted down to it
// (lib/bets/draft/legacyAdapter.ts) so every existing consumer stays
// unchanged. See docs/ODDS_PROVIDER_DESIGN.md / docs/ODDS_SUPPORT_MATRIX.md
// for the approved product/architecture context this design implements,
// and the Step 8 audit for the full design rationale.
//
// This file is deliberately parser-neutral: nothing here calls an LLM,
// reads an environment variable, performs HTTP, or knows about
// lib/ai/betParser.ts. It only defines the shape a future, separately
// approved parser integration would populate.
//
// Reuses lib/odds/domain.ts's Sport/MarketType/SelectionType/Period
// verbatim — never redefines them.

import type { MarketType, Period, SelectionType, Sport } from "@/lib/odds/domain";

/* -------------------------------------------------------------------------- */
/* Field state — the core answer to "do not collapse missing/unknown/         */
/* ambiguous/unsupported into null"                                           */
/* -------------------------------------------------------------------------- */

export type FieldState = "EXTRACTED" | "MISSING" | "UNKNOWN" | "AMBIGUOUS" | "UNSUPPORTED";

// Discriminated union, not a loose object — state and value can never
// disagree with each other by construction. EXTRACTED always carries a
// real value; every other state always carries value:null; only AMBIGUOUS
// carries candidates, and only ever with 2+ distinct entries (enforced by
// ambiguousField() below, since TypeScript's type system can't statically
// require "array length >= 2" or "entries are distinct").
export type BetDraftField<T> =
  | {
      readonly state: "EXTRACTED";
      readonly value: T;
      readonly rawText?: string;
    }
  | {
      readonly state: "MISSING" | "UNKNOWN" | "UNSUPPORTED";
      readonly value: null;
      readonly rawText?: string;
    }
  | {
      readonly state: "AMBIGUOUS";
      readonly value: null;
      readonly rawText?: string;
      readonly candidates: readonly T[];
    };

export type BetDraftDomainErrorCode = "AMBIGUOUS_REQUIRES_MULTIPLE_CANDIDATES" | "AMBIGUOUS_REQUIRES_DISTINCT_CANDIDATES";

// Same narrow-purpose "Error subclass with an explicit code" convention
// already used throughout this codebase (BetSlipValidationError,
// PreviewTokenSignError, OddsVerificationServiceError, ...).
export class BetDraftDomainError extends Error {
  readonly code: BetDraftDomainErrorCode;

  constructor(code: BetDraftDomainErrorCode, message: string) {
    super(message);
    this.name = "BetDraftDomainError";
    this.code = code;
  }
}

/* -------------------------------------------------------------------------- */
/* Safe constructors — the only sanctioned way to build a BetDraftField       */
/* -------------------------------------------------------------------------- */

export function extractedField<T>(value: T, rawText?: string): BetDraftField<T> {
  return { state: "EXTRACTED", value, rawText };
}

export function missingField<T>(rawText?: string): BetDraftField<T> {
  return { state: "MISSING", value: null, rawText };
}

export function unknownField<T>(rawText?: string): BetDraftField<T> {
  return { state: "UNKNOWN", value: null, rawText };
}

export function unsupportedField<T>(rawText?: string): BetDraftField<T> {
  return { state: "UNSUPPORTED", value: null, rawText };
}

// Throws rather than silently truncating/deduplicating — a caller passing
// fewer than two, or fewer than two DISTINCT, candidates has a bug, and
// papering over it would let a genuinely non-ambiguous field masquerade as
// ambiguous.
export function ambiguousField<T>(candidates: readonly T[], rawText?: string): BetDraftField<T> {
  if (candidates.length < 2) {
    throw new BetDraftDomainError(
      "AMBIGUOUS_REQUIRES_MULTIPLE_CANDIDATES",
      `AMBIGUOUS field state requires at least two candidates, got ${candidates.length}`,
    );
  }
  const distinctCount = new Set(candidates.map((candidate) => JSON.stringify(candidate))).size;
  if (distinctCount < 2) {
    throw new BetDraftDomainError(
      "AMBIGUOUS_REQUIRES_DISTINCT_CANDIDATES",
      "AMBIGUOUS field state requires at least two DISTINCT candidates",
    );
  }
  return { state: "AMBIGUOUS", value: null, rawText, candidates };
}

/* -------------------------------------------------------------------------- */
/* Raw extraction metadata                                                    */
/* -------------------------------------------------------------------------- */

export interface ExtractionWarning {
  readonly field: string; // dotted path, e.g. "selections[0].league"
  readonly reason: Exclude<FieldState, "EXTRACTED">;
  readonly rawText?: string;
}

export interface RawBetExtraction {
  readonly originalText: string;
  readonly sourceType: "CHAT" | "OCR";
  readonly language: BetDraftField<string>;
  readonly confidence: "HIGH" | "MEDIUM" | "LOW";
  readonly warnings: readonly ExtractionWarning[];
}

/* -------------------------------------------------------------------------- */
/* League                                                                      */
/* -------------------------------------------------------------------------- */

// Wrapped in BetDraftField<BetDraftLeague> at the selection level (not an
// optional object) — an absent league is structurally MISSING, an
// unresolved one is structurally UNKNOWN (with rawText preserved on the
// wrapper), never a single "undefined means something" optional slot.
export interface BetDraftLeague {
  readonly rawText: string;
  readonly resolvedName?: string;
}

/* -------------------------------------------------------------------------- */
/* Event and participants                                                     */
/* -------------------------------------------------------------------------- */

export interface BetDraftParticipant {
  readonly index: number;
  readonly rawName: string;
}

// event.rawText is always preserved (a selection cannot exist without some
// event text) — only scheduledStartTime is field-state-tracked, since it is
// the one part of "event" that's usually genuinely absent or ambiguous.
export interface BetDraftEvent {
  readonly rawText: string;
  readonly participants: readonly BetDraftParticipant[]; // 0, 1 (never — always 0 or 2), or 2 — never fabricated
  readonly scheduledStartTime: BetDraftField<string>; // ISO-8601, EXTRACTED only when unambiguous — see normalizeScheduledStartTime
}

export type BetDraftParticipantRef =
  | { readonly kind: "INDEX"; readonly participantIndex: number }
  | { readonly kind: "RAW_TEXT"; readonly rawName: string }
  | { readonly kind: "ROLE"; readonly role: "HOME" | "AWAY" }; // ONLY when source text itself says "home"/"away" — never inferred from participant order

/* -------------------------------------------------------------------------- */
/* Line                                                                        */
/* -------------------------------------------------------------------------- */

// magnitude is always an unsigned, normalized decimal string; direction
// carries the entire semantic sign/side — the same sign is never encoded
// in both places at once (see normalizeDraftLine's tests).
export interface BetDraftLine {
  readonly rawText: string;
  readonly magnitude: string;
  readonly direction: "OVER" | "UNDER" | "PLUS" | "MINUS" | "NONE";
}

/* -------------------------------------------------------------------------- */
/* Selection                                                                   */
/* -------------------------------------------------------------------------- */

export interface UniversalBetDraftSelection {
  readonly sport: BetDraftField<Sport>;
  readonly league: BetDraftField<BetDraftLeague>;
  readonly event: BetDraftEvent;
  readonly marketType: BetDraftField<MarketType>;
  readonly selectionType: BetDraftField<SelectionType>;
  readonly selectionRawText: string; // always preserved verbatim — the ground truth the legacy adapter reads
  readonly participant: BetDraftParticipantRef | null; // null when no reference could be determined at all
  readonly period: BetDraftField<Period>;
  readonly line: BetDraftField<BetDraftLine>;
  readonly submittedOdds: string | null; // decimal string or null — same nullable-at-parse-time semantics as today's ParsedBetSlip
}

/* -------------------------------------------------------------------------- */
/* Top-level draft                                                            */
/* -------------------------------------------------------------------------- */

export interface UniversalBetDraft {
  readonly raw: RawBetExtraction;
  readonly slipType: "SINGLE" | "EXPRESS";
  readonly stake: string; // required decimal string — stake has always been mandatory (Zod .positive(), never nullable)
  readonly selections: readonly UniversalBetDraftSelection[];
}
