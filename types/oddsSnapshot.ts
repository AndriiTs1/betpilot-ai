export interface OddsCheckResult {
  matched: boolean;

  // null unless matched is true — a tolerance verdict only makes sense once
  // the event/market/selection were actually found in the bookmaker's data.
  withinTolerance: boolean | null;

  sourceOdds: number | null;

  submittedOdds: number;

  discrepancyPercent: number | null;

  bookmaker: string | null;

  note: string | null;
}
