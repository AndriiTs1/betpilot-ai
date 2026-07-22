// Canonical odds-verification badge vocabulary (per-selection oddsStatus —
// distinct from the parent Bet's own lifecycle status, see
// components/bets/StatusBadge.tsx). Previously duplicated, with
// byte-for-byte identical labels and colors, as BetPreviewCard.tsx's local
// STATUS_BADGE and BetTicket.tsx's local ODDS_STATUS_LABELS. One
// definition now, used by both plus the shared SelectionRow.

export type OddsVerificationStatus = "PENDING" | "VERIFIED" | "ODDS_CHANGED" | "NOT_FOUND" | "UNAVAILABLE";

export interface OddsStatusBadgeInfo {
  label: string;
  color: string;
}

export const ODDS_STATUS_BADGES: Record<OddsVerificationStatus, OddsStatusBadgeInfo> = {
  VERIFIED: { label: "Verified", color: "#60E84A" },
  ODDS_CHANGED: { label: "Odds changed", color: "#E8B84A" },
  NOT_FOUND: { label: "Not found", color: "#94a3b8" },
  UNAVAILABLE: { label: "Unavailable", color: "#94a3b8" },
  // Reserved default, not actually reachable in practice today — see
  // lib/generated/prisma/enums.ts's BetSelectionOddsStatus.
  PENDING: { label: "Pending", color: "#94a3b8" },
};

const EMPTY_BADGE: OddsStatusBadgeInfo = { label: "", color: "#94a3b8" };

// null/undefined (status not applicable in this context) returns an empty
// label so callers can render nothing rather than a stray badge. An
// unrecognized string (oddsStatus is loosely typed as `string` on some
// wire shapes) falls back to echoing the raw value, matching BetTicket.tsx's
// pre-existing forgiving behavior.
export function getOddsStatusBadge(status: string | null | undefined): OddsStatusBadgeInfo {
  if (!status) return EMPTY_BADGE;
  return ODDS_STATUS_BADGES[status as OddsVerificationStatus] ?? { label: status, color: "#94a3b8" };
}
