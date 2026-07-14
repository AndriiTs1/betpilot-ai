interface PlayStatusCardProps {
  playedCount: string;
  playedSum: string;
  notPlayedCount: string;
  notPlayedSum: string;
}

// "Played"/"Not Played" is a temporary simplification: CONFIRMED = "played",
// PENDING = "not played". That's not actually whether the underlying match
// has finished — it will be revisited once settlement (determining
// win/loss from the real match result) is implemented.
export default function PlayStatusCard({
  playedCount,
  playedSum,
  notPlayedCount,
  notPlayedSum,
}: PlayStatusCardProps) {
  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900 p-6 text-center">
      <div className="grid grid-cols-2 divide-x divide-slate-800">
        <div>
          <p className="text-sm text-slate-400">Played</p>
          <h2 className="mt-3 text-3xl font-bold text-white">{playedCount}</h2>
          <p className="mt-2 text-sm text-slate-500">Total {playedSum}</p>
        </div>

        <div>
          <p className="text-sm text-slate-400">Not Played</p>
          <h2 className="mt-3 text-3xl font-bold text-white">{notPlayedCount}</h2>
          <p className="mt-2 text-sm text-slate-500">Total {notPlayedSum}</p>
        </div>
      </div>
    </div>
  );
}
