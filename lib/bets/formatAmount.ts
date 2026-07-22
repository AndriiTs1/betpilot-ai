// Shared 2-decimal amount formatter — previously duplicated identically as
// a local `formatAmount` in both BetTicket.tsx and BetPreviewCard.tsx.
export function formatAmount(value: number): string {
  return value.toFixed(2);
}
