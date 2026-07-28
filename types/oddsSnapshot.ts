export interface OddsCheckResult {
  matched: boolean;

  // null unless matched is true — a tolerance verdict only makes sense once
  // the event/market/selection were actually found in the bookmaker's data.
  withinTolerance: boolean | null;

  sourceOdds: number | null;

  // Step 15G — widened from `number` to accommodate lib/odds/oddsVerifier.ts's
  // new odds:null lookup path: null exactly when no odds were submitted AND
  // no provider price was found to promote in its place (a failed lookup
  // never fabricates a value). Every existing production caller still
  // always supplies a real number here — this widening has no effect on
  // any live code path today (see oddsVerifier.ts's own comment).
  submittedOdds: number | null;

  discrepancyPercent: number | null;

  bookmaker: string | null;

  note: string | null;

  // Stage 3.1 — present ONLY when findMatchingEvent() unambiguously resolved
  // a single provider event AND its commence_time parsed as a valid date
  // (see lib/odds/oddsVerifier.ts's extractProviderEventMetadata). Optional
  // (never `| null`) because "absent" and "known to be null" are genuinely
  // different states here: every return branch before an event is resolved
  // (sport not mapped, provider fetch failed, NOT_FOUND, AMBIGUOUS) simply
  // never sets these keys at all, rather than setting them to null — an
  // absent key can never be mistaken for "we checked and there is no
  // provider event," which a `| null` field could invite. All three fields
  // are set together or not at all — never partially populated (an event id
  // without a trustworthy start time) — so a consumer can treat "these
  // exist" as one atomic fact.
  providerEventId?: string;
  providerSportKey?: string;
  eventStartTime?: string; // ISO 8601, the provider's own commence_time
}
