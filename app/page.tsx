import DashboardOverview from "@/components/dashboard/DashboardOverview";
import BetQueue from "@/components/bets/BetQueue";
import PlayerList from "@/components/players/PlayerList";
import { requireOperatorPage } from "@/lib/auth/requireOperator";

// Stage 5.0D: redirects to /operator/login for anyone without a valid
// operator session, before any Dashboard content is rendered. This is the
// only change in this file — no UI/business logic touched.
export default async function Home() {
  await requireOperatorPage();

  return (
    <main className="dashboard-shell min-h-screen text-white">
      <div className="mx-auto max-w-7xl px-6 pt-4 pb-10 sm:pt-6">
        <header className="mb-7 text-center sm:text-left">
          <h1 className="text-3xl font-extrabold tracking-tight text-white">
            BetPilot <span className="text-blue-400">AI</span>
          </h1>

          <p className="mt-1.5 text-sm text-slate-500">
            AI Sports Betting Management Platform
          </p>
        </header>

        <DashboardOverview />

        <BetQueue />

        <PlayerList />
      </div>
    </main>
  );
}
