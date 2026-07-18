import type { MiniAppBetSelection } from "./types";

interface BetSelectionsListProps {
  selections: readonly MiniAppBetSelection[] | undefined;
}

// Purely presentational, collapsed by default (native <details>, no
// library, no JS state) so a long bet list doesn't visually explode.
// Renders nothing for a single/missing/empty selections array — including
// a stale cached response predating this field — leaving the surrounding
// card exactly as it looked before selections existed.
export default function BetSelectionsList({ selections }: BetSelectionsListProps) {
  if (!selections || selections.length <= 1) return null;

  return (
    <details className="mt-1 text-sm">
      <summary className="cursor-pointer text-slate-400">Экспресс ×{selections.length}</summary>

      <div className="mt-1.5 space-y-1 text-slate-400">
        {selections.map((selection) => (
          <p key={selection.id}>
            {selection.sport} · {selection.event} — {selection.outcome} @ {selection.odds ?? "—"}
          </p>
        ))}
      </div>
    </details>
  );
}
