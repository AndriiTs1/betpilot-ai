interface RecentBet {
  id: string;
  sport: string;
  event: string;
  outcome: string;
  stake: string;
  odds: string | null;
  status: string;
  createdAt: string;
}

interface PlayerCardProps {
  name: string;
  whatsappId: string;
  creditLimit: string;
  currentCredit: string;
  exposure: string;
  totalBets: number;
  nextSettlementDate: string;
  recentBets: RecentBet[];
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "Europe/Zurich",
  });
}

const STATUS_BADGES: Record<string, { dot: string; label: string; text: string }> = {
  PENDING: { dot: "bg-yellow-400", label: "Pending", text: "text-yellow-300" },
  CONFIRMED: { dot: "bg-blue-400", label: "Confirmed", text: "text-blue-300" },
  REJECTED: { dot: "bg-slate-500", label: "Rejected", text: "text-slate-400" },
  SETTLED_WIN: { dot: "bg-green-400", label: "Won", text: "text-green-300" },
  SETTLED_LOSS: { dot: "bg-red-400", label: "Lost", text: "text-red-300" },
  VOID: { dot: "bg-slate-500", label: "Void", text: "text-slate-400" },
};

function StatusBadge({ status }: { status: string }) {
  const badge = STATUS_BADGES[status] ?? { dot: "bg-slate-500", label: status, text: "text-slate-400" };

  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`h-2 w-2 rounded-full ${badge.dot}`} />
      <span className={badge.text}>{badge.label}</span>
    </span>
  );
}

function MiniStat({
  label,
  value,
  valueClassName = "text-white",
}: {
  label: string;
  value: string;
  valueClassName?: string;
}) {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-950/50 p-4 text-center">
      <p className="text-xs text-slate-400">{label}</p>
      <p className={`mt-2 text-xl font-bold ${valueClassName}`}>{value}</p>
    </div>
  );
}

export default function PlayerCard({
  name,
  whatsappId,
  creditLimit,
  currentCredit,
  exposure,
  totalBets,
  nextSettlementDate,
  recentBets,
}: PlayerCardProps) {
  const isNegative = currentCredit.startsWith("-");
  const isZero = Number(currentCredit) === 0;

  const currentCreditDisplay = isNegative || isZero ? currentCredit : `+${currentCredit}`;
  const currentCreditColor = isNegative
    ? "text-red-400"
    : isZero
      ? "text-white"
      : "text-green-400";

  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900 p-6">
      <h3 className="text-xl font-semibold">{name}</h3>
      <p className="mt-1 text-sm text-slate-400">{whatsappId}</p>

      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <MiniStat label="Limit" value={creditLimit} />
        <MiniStat label="Balance" value={currentCreditDisplay} valueClassName={currentCreditColor} />
        <MiniStat label="Exposure" value={exposure} />
        <MiniStat label="Bets" value={String(totalBets)} />
        <MiniStat label="Settlement" value={formatDate(nextSettlementDate)} />
      </div>

      <div className="mt-6">
        <p className="mb-3 text-sm text-slate-400">Recent Bets</p>

        {recentBets.length === 0 ? (
          <p className="text-sm text-slate-500">No bets in the current period.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="text-slate-500">
                  <th className="pb-2 pr-4 font-normal">Event</th>
                  <th className="pb-2 pr-4 font-normal">Selection</th>
                  <th className="pb-2 pr-4 font-normal">Stake</th>
                  <th className="pb-2 pr-4 font-normal">Odds</th>
                  <th className="pb-2 pr-4 font-normal">Status</th>
                  <th className="pb-2 font-normal">Date</th>
                </tr>
              </thead>
              <tbody>
                {recentBets.map((bet) => (
                  <tr key={bet.id} className="border-t border-slate-800">
                    <td className="py-2 pr-4 text-white">{bet.event}</td>
                    <td className="py-2 pr-4 text-slate-200">{bet.outcome}</td>
                    <td className="py-2 pr-4 text-white">{bet.stake}</td>
                    <td className="py-2 pr-4 text-slate-200">{bet.odds ?? "—"}</td>
                    <td className="py-2 pr-4">
                      <StatusBadge status={bet.status} />
                    </td>
                    <td className="py-2 text-slate-200">{formatDate(bet.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
