import type { RecentBet, MiniAppBetSelection, MeResponse } from "./types";
import type { AnyConfirmedBet } from "./betConfirmApi";

// Stage — Mini App data freshness fix. Root cause: GET /api/miniapp/me was
// only ever fetched once per Mini App session (on script-ready); nothing
// re-fetched it after a bet confirmation, so a freshly confirmed bet (of
// either type) stayed invisible in Active Bets / Recent Activity / History
// until the player fully closed and reopened the app. Fixed with optimistic
// local updating (this file) followed by a silent background reconciliation
// fetch (wired in app/miniapp/page.tsx) — never a full-screen loading state,
// never an error page on a failed background refresh.
//
// Everything here is a pure function of its inputs — no React, no fetch, no
// timers — so it's fully unit-testable without this project's deliberately
// absent DOM-rendering test infra (see ActiveBetsScreen.test.ts's own
// comment on why jsdom/@testing-library were never added). The thin,
// untested part is only the actual `fetch()` call and useState wiring in
// app/miniapp/page.tsx.

// Converts the confirm API's own response shape (AnyConfirmedBet — number
// stake/odds for SINGLE, decimal strings for EXPRESS, per
// betConfirmApi.ts's existing, unchanged types) into the RecentBet shape
// GET /api/miniapp/me already returns, so the optimistically merged bet
// renders through the *exact same* ActiveBetsScreen/HistoryScreen/
// BetScreen recent-activity code paths as a real server-fetched bet — no
// separate "is this optimistic" branch exists anywhere in the UI layer.
function toRecentBet(bet: AnyConfirmedBet): RecentBet {
  if (bet.type === "SINGLE") {
    // SINGLE bets never have BetSelection rows (unchanged since Stage 12 —
    // see lib/bets/createBetFromPreview.ts's createSingleBetFromPreview) —
    // a real server-fetched SINGLE bet's `selections` array is always
    // empty too. mapBetForDisplay.ts's existing legacy-fallback branch
    // already synthesizes a display selection from event/outcome/odds in
    // that case, so `[]` here matches real server data exactly, not a
    // simplification.
    return {
      id: bet.id,
      type: bet.type,
      sport: bet.sport,
      event: bet.event,
      outcome: bet.outcome,
      stake: String(bet.stake),
      odds: bet.odds !== null ? String(bet.odds) : null,
      status: bet.status,
      createdAt: bet.createdAt,
      totalOdds: bet.totalOdds !== null ? String(bet.totalOdds) : null,
      selections: [],
    };
  }

  // EXPRESS — ConfirmedExpressSelection has no betId/createdAt/updatedAt of
  // its own (unlike the real BetSelection row GET /api/miniapp/me returns);
  // synthesized from the parent bet here since nothing in the actual render
  // path (mapBetForDisplay.ts's DisplaySelection) ever reads those three
  // fields — they exist only to satisfy MiniAppBetSelection's shape, and
  // are overwritten with the real values on the next background
  // reconciliation regardless.
  const selections: MiniAppBetSelection[] = bet.selections.map((selection) => ({
    id: selection.id,
    betId: bet.id,
    sport: selection.sport,
    event: selection.event,
    outcome: selection.outcome,
    odds: selection.odds,
    createdAt: bet.createdAt,
    updatedAt: bet.createdAt,
  }));

  return {
    id: bet.id,
    type: bet.type,
    sport: bet.sport,
    event: bet.event,
    outcome: bet.outcome,
    stake: bet.stake,
    odds: bet.odds,
    status: bet.status,
    createdAt: bet.createdAt,
    totalOdds: bet.totalOdds,
    selections,
  };
}

// Prepends the confirmed bet, de-duplicating by id first — safe to call
// more than once for the same bet (e.g. a duplicate callback invocation):
// any existing entry with that id is dropped and the fresh one takes its
// place at the front, never producing two rows for the same id. Every
// other existing bet is left completely untouched (same array elements,
// not copied/re-derived). The confirmed bet is, by definition, the most
// recently created one, so prepending preserves the newest-first ordering
// GET /api/miniapp/me's own `orderBy: { createdAt: "desc" }` already
// establishes, without needing to re-sort the whole array.
export function mergeConfirmedBetIntoRecentBets(recentBets: RecentBet[], bet: AnyConfirmedBet): RecentBet[] {
  return [toRecentBet(bet), ...recentBets.filter((existing) => existing.id !== bet.id)];
}

export type MiniAppDataAction =
  | { type: "BET_CONFIRMED"; bet: AnyConfirmedBet }
  | { type: "BACKGROUND_REFRESH_SUCCESS"; data: MeResponse }
  | { type: "BACKGROUND_REFRESH_FAILURE" };

// The one place that decides what happens to the Mini App's already-loaded
// data in response to a confirm or a background refresh attempt. Never
// touches creditLimit/currentCredit/remainingCredit/exposure/
// pendingExposure/availableCredit on BET_CONFIRMED — no wallet/balance
// figure is ever optimistically invented or adjusted client-side; those
// only ever change when BACKGROUND_REFRESH_SUCCESS replaces the whole
// object with a fresh, real server response.
export function applyMiniAppDataAction(current: MeResponse, action: MiniAppDataAction): MeResponse {
  switch (action.type) {
    case "BET_CONFIRMED":
      return { ...current, recentBets: mergeConfirmedBetIntoRecentBets(current.recentBets, action.bet) };
    case "BACKGROUND_REFRESH_SUCCESS":
      // Server-authoritative data fully replaces the optimistic guess —
      // the optimistic bet (and everything else) is superseded, not
      // merged field-by-field.
      return action.data;
    case "BACKGROUND_REFRESH_FAILURE":
      // No-op by design: whatever was already showing (including an
      // optimistically merged bet) stays exactly as it was. Never an error
      // state, never a cleared list.
      return current;
  }
}
