import DashboardOverview from "@/components/dashboard/DashboardOverview";
import BetQueue from "@/components/bets/BetQueue";
import BetHistory from "@/components/bets/BetHistory";
import PlayerList from "@/components/players/PlayerList";
import { requireOperatorPage } from "@/lib/auth/requireOperator";

// Stage 5.0D: redirects to /operator/login for anyone without a valid
// operator session, before any Dashboard content is rendered. This is the
// only change in this file — no UI/business logic touched.
export default async function Home() {
  await requireOperatorPage();

  return (
    <main className="min-h-screen bg-slate-950 text-white">
      <div className="mx-auto max-w-7xl px-6 pt-4 pb-10 sm:pt-6">
        <header className="mb-10 text-center sm:text-left">
          <h1 className="text-3xl font-extrabold tracking-tight text-white">BetPilot AI</h1>

          <p className="mt-2 text-sm text-slate-300">
            AI Sports Betting Management Platform
          </p>
        </header>

        <DashboardOverview />

        <BetQueue />

        <BetHistory />

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
