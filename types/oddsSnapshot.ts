export interface OddsCheckResult {
  matched: boolean;

  sourceOdds: number | null;

  submittedOdds: number;

  discrepancyPercent: number | null;

  bookmaker: string | null;

  note: string | null;
}
