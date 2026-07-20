interface EmptyStateProps {
  icon: string;
  title: string;
  description?: string;
}

// Shared visual container for "nothing here yet" states (Pending Bets,
// Active Bets, History) — Stage 6.2 styling only, no new behavior.
export default function EmptyState({ icon, title, description }: EmptyStateProps) {
  return (
    <div className="rounded-2xl border border-slate-800/70 bg-[#0b1220] px-6 py-8 text-center shadow-[inset_0_1px_0_0_rgba(255,255,255,0.04)]">
      <span className="mx-auto flex h-9 w-9 items-center justify-center rounded-lg border border-white/10 bg-white/5 text-slate-500">
        <i className={`ti ti-${icon} text-base`} aria-hidden="true" />
      </span>

      <p className="mt-3 text-sm text-slate-300">{title}</p>

      {description && <p className="mt-1 text-xs text-slate-500">{description}</p>}
    </div>
  );
}
