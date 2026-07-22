import type { SVGProps } from "react";
import type { Icon } from "@tabler/icons-react";
import {
  IconBallFootball,
  IconBallBasketball,
  IconBallTennis,
  IconBallBaseball,
  IconBallVolleyball,
  IconBallAmericanFootball,
  IconGolf,
  IconTrophy,
} from "@tabler/icons-react";

// Centralized sport -> icon system. Migrated from lucide-react to
// @tabler/icons-react: Tabler has real, purpose-built ball icons for every
// sport this app needs except hockey (no puck icon exists in the set —
// verified directly against the installed package), so HockeyPuckIcon
// below is a small local component matching Tabler's own visual
// conventions (see its own comment for the exact reference used).
//
// Used by BetScreen.tsx's "Последняя активность" list, ActiveBetsScreen.tsx
// and HistoryScreen.tsx's card lists, and BetTicket.tsx's per-selection
// rows (including multi-leg EXPRESS tickets where different legs can be
// different sports) — every one of those now renders the same <SportIcon>
// component exported below, not a screen-specific lookup.

// HockeyPuckIcon — Tabler has no hockey puck icon (confirmed: no match
// anywhere in @tabler/icons' icon set or its Sport category). Drawn in
// Tabler's own established style for a flattened disc/cylinder — the same
// "ellipse rim + short side walls" construction Tabler's own IconDatabase
// uses for a squat cylinder, just proportioned much flatter (a puck is a
// short disc, not a tall canister). Same prop shape as a real Tabler icon
// (size/stroke/color/className plus any other svg attribute) so it's a
// drop-in substitute inside SPORT_ICON_COMPONENTS below.
export function HockeyPuckIcon({
  size = 24,
  stroke = 2,
  ...rest
}: Omit<SVGProps<SVGSVGElement>, "stroke"> & { size?: string | number; stroke?: string | number }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={stroke}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...rest}
    >
      <path d="M3 12a9 3 0 1 0 18 0a9 3 0 1 0 -18 0" />
      <path d="M3 12v2a9 3 0 0 0 18 0v-2" />
    </svg>
  );
}

type SportIconComponent = Icon | typeof HockeyPuckIcon;

// Keys are pre-normalized (see normalizeSportKey below) — no spaces,
// hyphens, or underscores, all lowercase — so "American Football",
// "american-football", and "american_football" all collapse to the same
// lookup key ("americanfootball") without needing separate entries.
const SPORT_ICON_COMPONENTS: Record<string, SportIconComponent> = {
  football: IconBallFootball,
  soccer: IconBallFootball,
  basketball: IconBallBasketball,
  tennis: IconBallTennis,
  hockey: HockeyPuckIcon,
  baseball: IconBallBaseball,
  volleyball: IconBallVolleyball,
  americanfootball: IconBallAmericanFootball,
  nfl: IconBallAmericanFootball,
  golf: IconGolf,
};

// Neutral default for an unknown, empty, or missing sport — deliberately
// not one of the specific icons above, so an unrecognized value never
// silently looks like a real sport match.
const FALLBACK_SPORT_ICON: SportIconComponent = IconTrophy;

// trim() + toLowerCase() (unchanged from the original lucide-based
// version) plus collapsing every run of whitespace/hyphens/underscores —
// so "tennis", "Tennis", " tennis ", "american-football",
// "american_football", and "American Football" are all treated as the
// same key.
function normalizeSportKey(sport: string): string {
  return sport.trim().toLowerCase().replace(/[\s_-]+/g, "");
}

// Exported for tests only (no DOM-rendering test infra in this project —
// this is the pure lookup logic SportIcon itself renders through).
export function getSportIconComponent(sport: string | null | undefined): SportIconComponent {
  if (!sport) return FALLBACK_SPORT_ICON;
  return SPORT_ICON_COMPONENTS[normalizeSportKey(sport)] ?? FALLBACK_SPORT_ICON;
}

export interface SportIconProps {
  sport: string | null | undefined;
  size?: number;
  stroke?: number;
  className?: string;
}

// The one place every screen renders a sport glyph through — callers never
// know or care whether a given sport resolves to a Tabler icon or the
// local HockeyPuckIcon. No wrapper element: renders exactly the icon's own
// <svg>, so the 32x32 container/background styling stays the caller's
// responsibility (ActiveBetsScreen.tsx/HistoryScreen.tsx/BetScreen.tsx/
// BetTicket.tsx all apply the same container around this).
export function SportIcon({ sport, size = 18, stroke = 2, className }: SportIconProps) {
  // Icon is selected from SPORT_ICON_COMPONENTS, a fixed set of
  // module-level, never-redefined component references (Tabler's own
  // IconX exports plus HockeyPuckIcon) — not a new component definition
  // created on each render, which is what this rule actually guards
  // against. This is the same dynamic-icon-dispatch pattern every previous
  // consumer (BetScreen.tsx/BetTicket.tsx/ActiveBetsScreen.tsx) had to
  // route around by avoiding a named wrapper component entirely;
  // SportIcon's whole job is to be that named wrapper, so the pattern has
  // to live somewhere.
  const Icon = getSportIconComponent(sport);
  // eslint-disable-next-line react-hooks/static-components -- see comment above
  return <Icon size={size} stroke={stroke} className={className} aria-hidden="true" />;
}
