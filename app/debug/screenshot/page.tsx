import { requireOperatorPage } from "@/lib/auth/requireOperator";
import ScreenshotDebugForm from "@/components/debug/ScreenshotDebugForm";

// Stage 14.4A, Part F — operator-only diagnostic page. Same auth pattern as
// app/page.tsx (the Operator Dashboard root): requireOperatorPage()
// redirects to /operator/login for anyone without a valid operator
// session, before any page content renders. No new auth mechanism.
export default async function ScreenshotDebugPage() {
  await requireOperatorPage();

  return (
    <main className="min-h-screen bg-[#0b1220] px-6 py-10 text-white">
      <div className="mx-auto max-w-3xl">
        <div className="mb-6 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-300">
          ⚠️ Internal diagnostic tool. This page runs a real screenshot through
          the production OCR and bet-parsing pipeline for inspection only — it
          never creates a Bet, never changes a balance, and never confirms
          anything. Nothing you upload here is stored.
        </div>

        <h1 className="text-2xl font-bold text-white">Screenshot Pipeline Debug</h1>
        <p className="mt-1 text-sm text-slate-400">
          Upload a bet-slip screenshot to see exactly what OCR, the bet parser,
          and odds verification produce at each stage, with timing for each.
        </p>

        <div className="mt-8">
          <ScreenshotDebugForm />
        </div>
      </div>
    </main>
  );
}
