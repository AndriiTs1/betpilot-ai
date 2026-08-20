// Canonical odds-verification badge vocabulary (per-selection oddsStatus —
// distinct from the parent Bet's own lifecycle status, see
// components/bets/StatusBadge.tsx). Previously duplicated, with
// byte-for-byte identical labels and colors, as BetPreviewCard.tsx's local
// STATUS_BADGE and BetTicket.tsx's local ODDS_STATUS_LABELS. One
// definition now, used by both plus the shared SelectionRow.

import { translate, type TranslationKey } from "@/lib/i18n/translations";
import type { Locale } from "@/lib/i18n/locale";

export type OddsVerificationStatus = "PENDING" | "VERIFIED" | "ODDS_CHANGED" | "NOT_FOUND" | "UNAVAILABLE";

export interface OddsStatusBadgeInfo {
  label: string;
  color: string;
}

// Canonical English labels — kept as the single source of truth for color
// AND for the exact pre-localization English text (still returned by
// getOddsStatusBadge's default `locale = "en"`, so this table's own
// `.label` values stay byte-identical to translations.ts's
// oddsStatus.* "en" entries and every pre-existing call site/test is
// unaffected). See ODDS_STATUS_TRANSLATION_KEYS below for the actual
// locale-aware lookup getOddsStatusBadge uses.
export const ODDS_STATUS_BADGES: Record<OddsVerificationStatus, OddsStatusBadgeInfo> = {
  VERIFIED: { label: "Verified", color: "#60E84A" },
  ODDS_CHANGED: { label: "Odds changed", color: "#E8B84A" },
  NOT_FOUND: { label: "Not found", color: "#94a3b8" },
  UNAVAILABLE: { label: "Unavailable", color: "#94a3b8" },
  // Reserved default, not actually reachable in practice today — see
  // lib/generated/prisma/enums.ts's BetSelectionOddsStatus.
  PENDING: { label: "Pending", color: "#94a3b8" },
};

const ODDS_STATUS_TRANSLATION_KEYS: Record<OddsVerificationStatus, TranslationKey> = {
  VERIFIED: "oddsStatus.verified",
  ODDS_CHANGED: "oddsStatus.oddsChanged",
  NOT_FOUND: "oddsStatus.notFound",
  UNAVAILABLE: "oddsStatus.unavailable",
  PENDING: "oddsStatus.pending",
};

const EMPTY_BADGE: OddsStatusBadgeInfo = { label: "", color: "#94a3b8" };

// null/undefined (status not applicable in this context) returns an empty
// label so callers can render nothing rather than a stray badge. An
// unrecognized string (oddsStatus is loosely typed as `string` on some
// wire shapes) falls back to echoing the raw value, matching BetTicket.tsx's
// pre-existing forgiving behavior — never translated, since it isn't a
// known canonical status to begin with.
//
// Localization completion pass — `locale` defaults to "en" so every
// pre-existing call site/test that doesn't pass one keeps getting the exact
// same English label as before this pass; BetPreviewCard.tsx/BetTicket.tsx
// now explicitly pass the player's real current locale. The canonical
// OddsVerificationStatus value itself (what's actually stored/compared) is
// never touched — only the returned display label.
export function getOddsStatusBadge(status: string | null | undefined, locale: Locale = "en"): OddsStatusBadgeInfo {
  if (!status) return EMPTY_BADGE;
  const known = ODDS_STATUS_BADGES[status as OddsVerificationStatus];
  if (!known) return { label: status, color: "#94a3b8" };
  return { label: translate(locale, ODDS_STATUS_TRANSLATION_KEYS[status as OddsVerificationStatus]), color: known.color };
}
