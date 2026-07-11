interface OddsCheckResult {
  originalOdds: number;

  currentOdds: number;

  isValid: boolean;

  difference: number;
}

export function verifyOdds(receivedOdds: number): OddsCheckResult {
  // В будущем здесь будет API букмекера
  // Pinnacle / Odds API / Betfair

  const currentOdds = 2.05;

  const difference = Number((currentOdds - receivedOdds).toFixed(2));

  return {
    originalOdds: receivedOdds,

    currentOdds,

    isValid: receivedOdds === currentOdds,

    difference,
  };
}
