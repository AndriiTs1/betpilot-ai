import type { LucideIcon } from "lucide-react";
import { CircleDot, Disc, Goal, Target, Trophy } from "lucide-react";

// Centralized sport -> icon mapping — used by the "recent activity" rows
// on the Mini App home screen (BetScreen.tsx) and, since Stage 12 Phase 4
// Step 5, by each selection row on a confirmed bet ticket (BetTicket.tsx),
// including multi-leg EXPRESS tickets where different legs can be
// different sports. lucide-react (verified against the installed icon set)
// has no dedicated Basketball/Tennis/Hockey ball icons — CircleDot/Target/
// Disc stand in as distinct, neutral shapes for those three; Goal is a
// genuine semantic match for Football/Soccer. Keys are lowercase; lookups
// are case-insensitive via getSportIcon below, never compared directly.
const SPORT_ICONS: Record<string, LucideIcon> = {
  football: Goal,
  soccer: Goal,
  basketball: CircleDot,
  tennis: Target,
  hockey: Disc,
};

// Neutral default for an unknown, empty, or missing sport — deliberately
// not one of the five specific icons above, so an unrecognized value never
// silently looks like a real sport match.
const FALLBACK_SPORT_ICON: LucideIcon = Trophy;

export function getSportIcon(sport: string | null | undefined): LucideIcon {
  if (!sport) return FALLBACK_SPORT_ICON;
  return SPORT_ICONS[sport.trim().toLowerCase()] ?? FALLBACK_SPORT_ICON;
}
