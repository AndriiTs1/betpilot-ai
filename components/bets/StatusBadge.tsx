// H4-B4 — SETTLED_HALF_WIN/SETTLED_HALF_LOSS (H4-B1 schema, H4-B3 financial
// settlement) reuse the exact same win/loss-family dot and text colors as
// SETTLED_WIN/SETTLED_LOSS — only the label text is distinct ("Half win"/
// "Half loss"), never collapsed into "Won"/"Lost". This is shared by both
// the Mini App (HistoryScreen.tsx, ActiveBetsScreen.tsx) and the operator
// dashboard (PlayerCard.tsx) — the one mapper both surfaces already read
// through, so no component-specific label strings are added anywhere else.
// Exported (not just a local const) so StatusBadge.test.ts can verify
// label/color mapping directly, without a DOM-rendering test harness —
// same "export the classification data for direct testing" convention
// ActiveBetsScreen.tsx's own ACTIVE_STATUSES already established.
export const STATUS_BADGES: Record<string, { dot: string; label: string; text: string }> = {
  PENDING: { dot: "bg-yellow-400", label: "Pending", text: "text-yellow-300" },
  CONFIRMED: { dot: "bg-blue-400", label: "Confirmed", text: "text-blue-300" },
  REJECTED: { dot: "bg-slate-500", label: "Rejected", text: "text-slate-400" },
  SETTLED_WIN: { dot: "bg-green-400", label: "Won", text: "text-green-300" },
  SETTLED_LOSS: { dot: "bg-red-400", label: "Lost", text: "text-red-300" },
  VOID: { dot: "bg-slate-500", label: "Void", text: "text-slate-400" },
  SETTLED_HALF_WIN: { dot: "bg-green-400", label: "Half win", text: "text-green-300" },
  SETTLED_HALF_LOSS: { dot: "bg-red-400", label: "Half loss", text: "text-red-300" },
};

export default function StatusBadge({ status }: { status: string }) {
  const badge = STATUS_BADGES[status] ?? { dot: "bg-slate-500", label: status, text: "text-slate-400" };

  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`h-2 w-2 rounded-full ${badge.dot}`} />
      <span className={badge.text}>{badge.label}</span>
    </span>
  );
}
