// Stage 3.2 — provider-independent domain model for a finished (or
// in-progress/cancelled/etc.) event's result. Deliberately NOT the shape of
// any provider's /scores response (e.g. The Odds API's `completed` +
// `scores` array) — no provider mapper exists yet; translating a real
// provider response into this type is a later, separate stage's job. This
// type is constructed by hand in tests today, and will be constructed by a
// future result-fetching layer later — nothing in this stage produces one
// from live data.
//
// Kept intentionally smaller than an early sketch of this type (no
// providerEventId/sportKey/completed/startedAt/completedAt/rawProviderStatus/
// resultSource) — evaluateSelectionOutcome() (the only consumer in Stage
// 3.2) doesn't read any of those fields, and adding them now would be
// exactly the "add fields formally, before they're needed" the Stage 3.2
// scope warns against. They can be added later, additively, once a real
// caller (a Stage 3.3+ result-fetching layer) needs them for
// correlation/logging — this interface is not exhaustive by design.

import type { CanonicalParticipant } from "@/lib/odds/domain";

export type EventResultStatus =
  | "NOT_STARTED"
  | "IN_PROGRESS"
  | "COMPLETED"
  | "CANCELLED"
  | "POSTPONED"
  | "ABANDONED"
  | "UNKNOWN";

export const EVENT_RESULT_STATUSES: readonly EventResultStatus[] = [
  "NOT_STARTED",
  "IN_PROGRESS",
  "COMPLETED",
  "CANCELLED",
  "POSTPONED",
  "ABANDONED",
  "UNKNOWN",
];

export function isEventResultStatus(value: string): value is EventResultStatus {
  return (EVENT_RESULT_STATUSES as readonly string[]).includes(value);
}

// No separate `completed: boolean` field (an early sketch of this type had
// one) — `status === "COMPLETED"` is the single source of truth for "has
// this event finished," so there is no way to construct a status/completed
// pair that disagree with each other, and evaluateSelectionOutcome() never
// has to reconcile the two.
//
// homeScore/awayScore are `number | null` (not optional `?:`), matching
// this codebase's existing convention (VerificationResult, preview-token
// provider metadata fields) of an explicit `null` for "known absence"
// rather than an ambiguous missing key. Only meaningful when
// status === "COMPLETED" — evaluateSelectionOutcome() never reads them for
// any other status.
export interface CanonicalEventResult {
  readonly status: EventResultStatus;
  readonly homeParticipant: CanonicalParticipant;
  readonly awayParticipant: CanonicalParticipant;
  readonly homeScore: number | null;
  readonly awayScore: number | null;
}
