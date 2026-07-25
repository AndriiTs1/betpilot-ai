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
}
