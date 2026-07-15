const STATUS_BADGES: Record<string, { dot: string; label: string; text: string }> = {
  PENDING: { dot: "bg-yellow-400", label: "Pending", text: "text-yellow-300" },
  CONFIRMED: { dot: "bg-blue-400", label: "Confirmed", text: "text-blue-300" },
  REJECTED: { dot: "bg-slate-500", label: "Rejected", text: "text-slate-400" },
  SETTLED_WIN: { dot: "bg-green-400", label: "Won", text: "text-green-300" },
  SETTLED_LOSS: { dot: "bg-red-400", label: "Lost", text: "text-red-300" },
  VOID: { dot: "bg-slate-500", label: "Void", text: "text-slate-400" },
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
