import StatCard from "./StatCard";

export default function DashboardOverview() {
  return (
    <section className="grid gap-6 md:grid-cols-2 xl:grid-cols-4">
      <StatCard
        title="Balance"
        value="850 USDC"
        description="Current bankroll"
      />

      <StatCard
        title="Active Players"
        value="5"
        description="Players connected"
      />

      <StatCard
        title="Pending Bets"
        value="12"
        description="Waiting confirmation"
      />

      <StatCard
        title="Profit / Loss"
        value="+350 USDC"
        description="This month"
      />
    </section>
  );
}
