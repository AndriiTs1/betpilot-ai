import { useLocale } from "./LocaleProvider";

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
  const { t } = useLocale();

  return (
    <div className="grid grid-cols-2 gap-3">
      <MiniStat label={t("balance.available")} value={availableCredit} />
      <MiniStat label={t("balance.limit")} value={creditLimit} />
      <MiniStat label={t("balance.exposure")} value={exposure} />
      <MiniStat label={t("balance.pending")} value={pendingExposure} />
    </div>
  );
}
