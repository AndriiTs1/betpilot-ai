import type { ReactNode } from "react";

// Centralized sport -> icon system. Every icon here is a small, hand-drawn
// local SVG (no @tabler/icons-react, no lucide-react, no emoji, no images) —
// each sport gets its own distinct silhouette so cards read at a glance
// without needing the text label next to it.
//
// Used by BetScreen.tsx's "Последняя активность" list, ActiveBetsScreen.tsx
// and HistoryScreen.tsx's card lists, and BetTicket.tsx's per-selection rows
// (including multi-leg EXPRESS tickets where different legs can be different
// sports) — every one of those renders the same <SportIcon> component
// exported below.

export interface SportSvgProps {
  size?: number | string;
  className?: string;
}

// Shared <svg> shell every sport icon renders through — viewBox, stroke
// contract, and a11y attribute all live here once instead of being repeated
// nine times. This is a fixed, always-the-same component reference used
// directly in JSX (not created dynamically per render), so it doesn't trip
// react-hooks/static-components.
function IconBase({ size = 22, className, children }: SportSvgProps & { children: ReactNode }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

// Soccer ball: outer circle + a центральный pentagon + five short seams
// radiating out from each pentagon vertex toward the rim.
export function FootballIcon({ size, className }: SportSvgProps) {
  return (
    <IconBase size={size} className={className}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7.6l2.9 2.1-1.1 3.4h-3.6l-1.1-3.4z" />
      <path d="M12 7.6V4.2" />
      <path d="M14.9 9.7l2.7-1.8" />
      <path d="M13.8 13.1l1.1 3.4" />
      <path d="M10.2 13.1l-1.1 3.4" />
      <path d="M9.1 9.7L6.4 7.9" />
    </IconBase>
  );
}

// Basketball: circle + a vertical/horizontal cross + two curved side seams
// bulging inward — the classic four-panel basketball look.
export function BasketballIcon({ size, className }: SportSvgProps) {
  return (
    <IconBase size={size} className={className}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 3v18" />
      <path d="M3 12h18" />
      <path d="M5.3 5.3c2.4 2.6 2.4 11 0 13.4" />
      <path d="M18.7 5.3c-2.4 2.6-2.4 11 0 13.4" />
    </IconBase>
  );
}

// Tennis ball: circle + exactly two curved seams near the edges (no cross),
// so the silhouette stays visually distinct from the basketball.
export function TennisIcon({ size, className }: SportSvgProps) {
  return (
    <IconBase size={size} className={className}>
      <circle cx="12" cy="12" r="9" />
      <path d="M7 4.5c3 3 3 12 0 15" />
      <path d="M17 4.5c-3 3-3 12 0 15" />
    </IconBase>
  );
}

// Hockey: a real stick (angled shaft + blade) next to a flattened puck —
// deliberately not a plain circle/cylinder.
export function HockeyIcon({ size, className }: SportSvgProps) {
  return (
    <IconBase size={size} className={className}>
      <ellipse cx="7.6" cy="18.6" rx="3.3" ry="1.3" />
      <path d="M16 3l-5 12.2" />
      <path d="M11 15.2l5 1.2" />
    </IconBase>
  );
}

// Baseball: circle + two curved seams, each crossed by small stitch ticks —
// the ticks are what read as "baseball" rather than a plain tennis-style curve.
export function BaseballIcon({ size, className }: SportSvgProps) {
  return (
    <IconBase size={size} className={className}>
      <circle cx="12" cy="12" r="9" />
      <path d="M6 5c4 3 4 11 0 14" />
      <path d="M18 5c-4 3-4 11 0 14" />
      <path d="M6.6 7.6l1.3-0.7" />
      <path d="M7.9 11.3h1.5" />
      <path d="M6.6 16.4l1.3 0.7" />
      <path d="M17.4 7.6l-1.3-0.7" />
      <path d="M16.1 11.3h-1.5" />
      <path d="M17.4 16.4l-1.3 0.7" />
    </IconBase>
  );
}

// Volleyball: circle + three large curved panel dividers meeting near the
// center — the tri-panel look, distinct from basketball's straight cross.
export function VolleyballIcon({ size, className }: SportSvgProps) {
  return (
    <IconBase size={size} className={className}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 3c-3 3-3 15 0 18" />
      <path d="M4 8c4 2 12 2 16 0" />
      <path d="M4 16c4-2 12-2 16 0" />
    </IconBase>
  );
}

// American football: a pointed oval (rotated ellipse) with a center lace
// line and three short cross-ticks — an oval ball with lacing, not a
// round ball.
export function AmericanFootballIcon({ size, className }: SportSvgProps) {
  return (
    <IconBase size={size} className={className}>
      <ellipse cx="12" cy="12" rx="9" ry="5" transform="rotate(-35 12 12)" />
      <path d="M9.4 13.8L14.6 10.2" />
      <path d="M12.8 9.9l1 1.4" />
      <path d="M11.5 11.3l1 1.4" />
      <path d="M10.2 12.7l1 1.4" />
    </IconBase>
  );
}

// Golf: a dimpled ball resting on a tee — a distinct silhouette from every
// other round-ball icon above thanks to the tee stem/cup below it.
export function GolfIcon({ size, className }: SportSvgProps) {
  return (
    <IconBase size={size} className={className}>
      <circle cx="12" cy="8" r="4.2" />
      <circle cx="10.6" cy="6.8" r="0.5" fill="currentColor" stroke="none" />
      <circle cx="13.3" cy="7.1" r="0.5" fill="currentColor" stroke="none" />
      <circle cx="11.7" cy="9.5" r="0.5" fill="currentColor" stroke="none" />
      <path d="M12 12.2V19" />
      <path d="M8.5 19c1-1 2-1.5 3.5-1.5s2.5 0.5 3.5 1.5" />
    </IconBase>
  );
}

// Trophy: fallback only, for an unknown/empty sport — a classic cup with
// two handles, a stem, and a base, so an unrecognized value never silently
// looks like a real sport match.
export function TrophyIcon({ size, className }: SportSvgProps) {
  return (
    <IconBase size={size} className={className}>
      <path d="M7 4h10" />
      <path d="M7 4v3a5 5 0 0 0 10 0V4" />
      <path d="M7 5H4a1 1 0 0 0-1 1v1a4 4 0 0 0 4 4" />
      <path d="M17 5h3a1 1 0 0 1 1 1v1a4 4 0 0 1-4 4" />
      <path d="M12 12v4" />
      <path d="M9 20v-1a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v1" />
      <path d="M9 20h6" />
    </IconBase>
  );
}

type SportIconComponent = (props: SportSvgProps) => ReactNode;

// Keys are pre-normalized (see normalizeSportKey below) — no spaces,
// hyphens, or underscores, all lowercase — so "American Football",
// "american-football", "american_football", "Ice Hockey", "ice-hockey" all
// collapse to the same lookup key without needing separate entries.
const SPORT_ICON_COMPONENTS: Record<string, SportIconComponent> = {
  football: FootballIcon,
  soccer: FootballIcon,
  basketball: BasketballIcon,
  tennis: TennisIcon,
  hockey: HockeyIcon,
  icehockey: HockeyIcon,
  baseball: BaseballIcon,
  volleyball: VolleyballIcon,
  americanfootball: AmericanFootballIcon,
  nfl: AmericanFootballIcon,
  golf: GolfIcon,
};

// Neutral default for an unknown, empty, or missing sport — deliberately not
// one of the specific icons above, so an unrecognized value never silently
// looks like a real sport match.
const FALLBACK_SPORT_ICON: SportIconComponent = TrophyIcon;

// trim() + toLowerCase() plus collapsing every run of whitespace/hyphens/
// underscores — so "tennis", "Tennis", " tennis ", "american-football",
// "american_football", "American Football", and "Ice Hockey" are all
// treated as the same key.
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
  className?: string;
}

// The one place every screen renders a sport glyph through — callers never
// know or care which local icon a given sport resolves to. No wrapper
// element: renders exactly the icon's own <svg>, so the 36x36 container/
// background styling stays the caller's responsibility.
export function SportIcon({ sport, size = 22, className }: SportIconProps) {
  const Icon = getSportIconComponent(sport);
  // eslint-disable-next-line react-hooks/static-components -- Icon is picked from a fixed, module-level map of never-redefined component references, not created during render.
  return <Icon size={size} className={className} />;
}
