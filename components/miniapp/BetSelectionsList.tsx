import SelectionList from "@/components/bets/SelectionList";
import type { MiniAppBetSelection } from "./types";
import { normalizeSelectionToEnglish } from "@/lib/bets/normalizeSelectionToEnglish";

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
//
// English-only selection labels (temporary product rule) — this is the
// normalization entry point for this specific data flow: `selections` here
// is the raw MiniAppBetSelection[] straight off GET /api/miniapp/me,
// which never passes through lib/bets/mapBetForDisplay.ts (that mapper
// only runs on this same bet's displayTitle/displaySubtitle, not on the
// full per-leg list rendered here), so nothing upstream normalizes it.
// One caller (ActiveBetsScreen/HistoryScreen rendering a just-confirmed bet
// optimistically merged via mergeConfirmedBet.ts) may already carry
// normalized text from the confirm response's own serializer — normalizing
// it again here is a harmless, idempotent no-op, not a bug: this component
// can't distinguish that case from the raw-fetched one, and every
// canonical output is also a recognized input.
export default function BetSelectionsList({ selections }: BetSelectionsListProps) {
  if (!selections || selections.length <= 1) return null;

  const normalized = selections.map((selection) => ({
    ...selection,
    outcome: normalizeSelectionToEnglish({
      selection: selection.outcome,
      sport: selection.sport,
      event: selection.event,
      market: selection.market ?? null,
    }),
  }));

  return (
    <div className="mt-1.5">
      <SelectionList selections={normalized} mode="list" showStatus={false} />
    </div>
  );
}
