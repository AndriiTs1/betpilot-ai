import SelectionList from "@/components/bets/SelectionList";
import type { MiniAppBetSelection } from "./types";

interface BetSelectionsListProps {
  selections: readonly MiniAppBetSelection[] | undefined;
}

// Review/list context (Active Bets, History) — 1-3 selections are shown
// directly; more than 3 shows the first 3 plus an expandable "+N more"
// control (components/bets/SelectionList's "list" mode). Previously
// collapsed by default at any count via a bare <details>, which hid a
// short EXPRESS bet's own contents behind an extra tap for no reason — the
// corrected rule only ever truncates once there's actually more than 3
// selections to hide. Renders nothing for a single/missing/empty
// selections array, including a stale cached response predating this
// field — same as before.
export default function BetSelectionsList({ selections }: BetSelectionsListProps) {
  if (!selections || selections.length <= 1) return null;

  return (
    <div className="mt-1.5">
      <SelectionList selections={selections} mode="list" showStatus={false} />
    </div>
  );
}
