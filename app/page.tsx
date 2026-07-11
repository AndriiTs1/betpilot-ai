import DashboardOverview from "@/components/dashboard/DashboardOverview";
import BetQueue from "@/components/bets/BetQueue";
import PlayerList from "@/components/players/PlayerList";

export default function Home() {
  return (
    <main className="min-h-screen bg-slate-950 text-white">
      <div className="mx-auto max-w-7xl px-6 py-10">
        <header className="mb-10">
          <h1 className="text-4xl font-bold">BetPilot AI</h1>

          <p className="mt-2 text-slate-400">
            AI Sports Betting Management Platform
          </p>
        </header>

        <DashboardOverview />

        <BetQueue />

        <PlayerList />

        <section className="mt-10 rounded-2xl border border-slate-800 bg-slate-900 p-8">
          <h2 className="text-2xl font-semibold">Betting Operations</h2>

          <p className="mt-4 text-slate-400">
            WhatsApp AI betting assistant is being built.
          </p>
        </section>
      </div>
    </main>
  );
}
