interface PlayerCardProps {
  name: string;
  balance: number;
  totalBets: number;
}

export default function PlayerCard({
  name,
  balance,
  totalBets,
}: PlayerCardProps) {
  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900 p-6">
      <h3 className="text-xl font-semibold">{name}</h3>

      <div className="mt-4 space-y-2 text-slate-400">
        <p>
          Balance:
          <span className="ml-2 text-white font-semibold">{balance} USDC</span>
        </p>

        <p>
          Total Bets:
          <span className="ml-2 text-white font-semibold">{totalBets}</span>
        </p>
      </div>
    </div>
  );
}
