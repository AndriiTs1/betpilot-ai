import PlayerCard from "./PlayerCard";

const players = [
  {
    name: "Ivan",
    balance: 850,
    totalBets: 24,
  },
  {
    name: "Alex",
    balance: 420,
    totalBets: 11,
  },
];

export default function PlayerList() {
  return (
    <section className="mt-10">
      <h2 className="mb-6 text-2xl font-semibold">Players</h2>

      <div className="grid gap-6 md:grid-cols-2">
        {players.map((player) => (
          <PlayerCard
            key={player.name}
            name={player.name}
            balance={player.balance}
            totalBets={player.totalBets}
          />
        ))}
      </div>
    </section>
  );
}
