"use client";

import { useState } from "react";
import SelectionRow from "./SelectionRow";
import type { DisplaySelection } from "@/lib/bets/mapBetForDisplay";

interface SelectionListProps {
  selections: readonly DisplaySelection[];
  // "full" (default) — every selection always rendered, never truncated.
  // Decision contexts only: Bet Preview, Confirmation Ticket, Operator
  // Pending Queue. A bet the player or operator is about to act on must
  // never hide a leg behind a collapsed state.
  //
  // "list" — 1-3 selections shown directly; more than 3 shows the first 3
  // plus an expandable "+N more" control. Review/list contexts only: Mini
  // App Active Bets/History, Dashboard Active Bets/History.
  mode?: "full" | "list";
  showStatus?: boolean;
  showLegLabels?: boolean;
}

const LIST_VISIBLE_THRESHOLD = 3;

export default function SelectionList({
  selections,
  mode = "full",
  showStatus = true,
  showLegLabels = false,
}: SelectionListProps) {
  const [expanded, setExpanded] = useState(false);

  if (selections.length === 0) return null;

  const isTruncated = mode === "list" && !expanded && selections.length > LIST_VISIBLE_THRESHOLD;
  const visible = isTruncated ? selections.slice(0, LIST_VISIBLE_THRESHOLD) : selections;
  const remaining = selections.length - LIST_VISIBLE_THRESHOLD;

  return (
    <div className="space-y-2">
      {visible.map((selection, index) => (
        <SelectionRow
          key={selection.id}
          selection={selection}
          legLabel={showLegLabels ? `Leg ${index + 1}` : undefined}
          showStatus={showStatus}
        />
      ))}

      {isTruncated && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="w-full rounded-xl py-2 text-center text-xs font-medium text-slate-400 transition-colors hover:text-white"
          style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)" }}
        >
          +{remaining} more selection{remaining === 1 ? "" : "s"}
        </button>
      )}
    </div>
  );
}
