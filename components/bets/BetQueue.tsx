const bets = [
  {
    id: "1",
    player: "Ivan",
    event: "Real Madrid vs Barcelona",
    selection: "Real Madrid Win",
    stake: 100,
    odds: 2.1,
    status: "WAITING_CONFIRMATION",
  },
  {
    id: "2",
    player: "Alex",
    event: "PSG vs Marseille",
    selection: "PSG Win",
    stake: 50,
    odds: 1.85,
    status: "WAITING_CONFIRMATION",
  },
];

export default function BetQueue() {
  return (
    <section className="mt-10">
      <h2 className="mb-6 text-2xl font-semibold">Pending Bets</h2>

      <div className="space-y-4">
        {bets.map((bet) => (
          <div
            key={bet.id}
            className="rounded-2xl border border-slate-800 bg-slate-900 p-6"
          >
            <div className="flex justify-between">
              <div>
                <h3 className="text-xl font-semibold">{bet.player}</h3>

                <p className="mt-2 text-slate-400">{bet.event}</p>

                <p className="mt-1 text-slate-400">{bet.selection}</p>
              </div>

              <div className="text-right">
                <p className="text-2xl font-bold">{bet.stake} USDC</p>

                <p className="text-slate-400">Odds {bet.odds}</p>
              </div>
            </div>

            <div className="mt-5 flex gap-3">
              <button className="rounded-xl bg-green-500 px-5 py-2 font-semibold text-black">
                Confirm
              </button>

              <button className="rounded-xl bg-red-500 px-5 py-2 font-semibold text-white">
                Reject
              </button>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
