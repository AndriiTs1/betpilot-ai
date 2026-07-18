interface BalanceScreenProps {
  creditLimit: string;
  availableCredit: string;
  exposure: string;
  pendingExposure: string;
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-950/50 p-4 text-center">
      <p className="text-xs text-slate-400">{label}</p>
      <p className="mt-2 text-xl font-bold">{value}</p>
    </div>
  );
}

// Carried over from the previous single-screen DataScreen as-is — same
// fields, same formulas (computed server-side in /api/miniapp/me), same
// formatting. Recent bets moved out to ActiveBetsScreen/HistoryScreen.
export default function BalanceScreen({
  creditLimit,
  availableCredit,
  exposure,
  pendingExposure,
}: BalanceScreenProps) {
  return (
    <div className="grid grid-cols-2 gap-3">
      <MiniStat label="Доступно" value={availableCredit} />
      <MiniStat label="Лимит" value={creditLimit} />
      <MiniStat label="В игре" value={exposure} />
      <MiniStat label="В ожидании" value={pendingExposure} />
    </div>
  );
}
