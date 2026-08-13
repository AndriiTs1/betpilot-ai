import type { ParsedBet } from "@/lib/ai/betParser";

// Stage 12, Phase 3 — the unified SINGLE/EXPRESS shape every parser output
// converges on before Preview. Doesn't touch betParser.ts's own public
// types (ParsedBet stays exactly as it is) — this file only adds a
// normalization layer on top of it, so every existing caller of that type
// is completely unaffected.
//
// Stage 14.3 — normalizeParsedImageBet() (the equivalent normalizer for the
// old image-parser's ParseImageBetResult) was removed here: the new OCR ->
// parseBetSlipMessage() pipeline already returns this exact ParsedBetSlip
// shape directly (see lib/ai/betParser.ts's ParseBetSlipResult), so no
// normalization step is needed for screenshots anymore.

export interface BetSlipSelectionInput {
  sport: string;
  // Step 16A — optional (not required-nullable like submittedOdds below)
  // specifically so every existing caller/fixture that builds this shape
  // without a league keeps compiling and behaving exactly as before,
  // unchanged — this field is purely additive. Absent (undefined) and
  // explicitly-null both mean "no league stated"; callers may use either.
  // A human-readable league name as stated (e.g. "Serie A"), never a
  // provider sport_key — see lib/odds/footballLeagues.ts for where that
  // name is actually resolved/validated.
  league?: string | null;
  event: string;
  market: string | null;
  // H3 Production Fix — the AI's own market text, verbatim/unnormalized,
  // additive alongside `market` above (never replacing its existing
  // normalized-display-label-or-null semantics). Optional (matching
  // `league`/`line` below): every existing caller/fixture that builds this
  // shape without it keeps compiling and behaving exactly as before. Reused
  // downstream by legacySelectionToCanonicalRequest (lib/odds/
  // legacyOddsBridge.ts) to recover market intent (e.g. "Фора"/"Handicap"/
  // "Spread") that a bare `selection` alone can't express on its own.
  marketRawText?: string | null;
  selection: string;
  // Decimal-compatible: a plain number here (what every parser produces
  // today) — callers construct a Prisma.Decimal from it at the point they
  // actually need Decimal math (see lib/bets/buildBetSlipPreview.ts).
  // Nullable because a player can omit odds for a leg — the same case
  // that's always been representable for a SINGLE bet.
  submittedOdds: number | null;
  // Betting Markets V1, Phase 2 — the numeric line for a TOTALS/SPREAD
  // selection (e.g. "2.5", "-1.5"), when the player's text stated one.
  // Optional (matching `league` above), not required-nullable: every
  // existing caller/fixture that builds this shape without a line keeps
  // compiling and behaving exactly as before. A decimal string (never a
  // JS number — see lib/odds/domain.ts's isDecimalString/Decimal-safety
  // convention), or null/undefined when no line was stated. Purely
  // additive data — nothing in this phase classifies a selection as
  // TOTALS/SPREAD or matches on this value; it only survives the pipeline
  // so a later phase can.
  line?: string | null;
  // SCREENSHOT QA-1.6 — set ONLY for the one narrow, explicitly-classified
  // case betParser.ts's classifyReconcilable1X2Mismatch recognizes: the
  // player/OCR text contains explicit 1X2 shorthand evidence (e.g. "П1") for
  // HOME or AWAY, but Claude's own claim normalized the selection to a bare
  // participant name (marketType MONEYLINE_2WAY, selectionType PARTICIPANT)
  // — a real, provable production case (SCREENSHOT QA-1.2 through QA-1.5),
  // not a general-purpose escape hatch. Every OTHER market/selection
  // contradiction is still rejected immediately in betParser.ts, exactly as
  // before; this field only exists to carry the ONE piece of information a
  // LATER stage needs to finish that specific, narrow decision once real
  // data becomes available.
  //
  // Deliberately NOT resolved here: betParser.ts is a pure, offline text
  // parser with no provider/event access at all, so it cannot know which
  // side ("HOME" or "AWAY") the claimed participant name actually
  // corresponds to — only that the raw text evidence said HOME or AWAY,
  // and what text Claude claimed as the participant. buildBetSlipPreview.ts
  // is the nearest point that has the odds provider's own resolved
  // homeTeamName/awayTeamName for this exact event (see its own
  // reconcile1X2ParticipantClaim) — never guessed from OCR/event-string
  // word order, which lib/odds/oddsVerifier.ts's own comments document as
  // unreliable (the provider's home/away order doesn't have to match the
  // order text lists them in).
  pendingMarketReconciliation?: PendingMarketReconciliation | null;
}

// SCREENSHOT QA-1.6 — see BetSlipSelectionInput.pendingMarketReconciliation
// above for the full rationale. requiredSide is the side the ORIGINAL TEXT
// evidence asserted (from a real MONEYLINE_3WAY/HOME or MONEYLINE_3WAY/AWAY
// evidence token, e.g. "П1"/"П2"/"Home win") — never DRAW, which has no
// participant-name equivalent and is never reconcilable this way.
// claimedParticipant is Claude's own raw, unmodified selection text (e.g.
// "Bayern Munich") — compared later against the real provider event's own
// team names via lib/odds/teamNameMatcher.ts's resolveParticipantSide,
// never against the OCR event string.
// MASTER STAGE M3.2 — the participant name (if any) the CONFLICTING
// evidence itself named, distinct from claimedParticipant (the AI's own
// claim). A proven real production case (claim "Alavés", provider HOME
// "Alavés"/AWAY "Getafe", decisive exact match) was still rejected because
// a BARE, unattributed OCR shorthand marker (e.g. a raw "2"/"П2" token with
// no team name attached — plausibly an unselected sibling outcome button's
// own UI text, not a deliberate statement) disagreed with the decisive
// match. This field lets buildBetSlipPreview.ts's reconcile1X2ParticipantClaim
// distinguish that case from a genuine NAMED disagreement (the conflicting
// evidence explicitly stated a different team) — see that function's own
// header for the full trust rule. Explicitly `null` when the conflicting
// evidence carried no participant name at all; a non-null string when it
// did. Optional (not required-nullable) specifically so existing
// callers/fixtures built before this field existed keep compiling and
// behaving exactly as before: an absent (undefined) value is treated as
// "not known to be unattributed" — i.e. the conservative, pre-M3.2 reject-
// on-mismatch behavior — never silently reinterpreted as safe to override.
export interface PendingMarketReconciliation {
  readonly requiredSide: "HOME" | "AWAY";
  readonly claimedParticipant: string;
  readonly conflictingParticipantName?: string | null;
}

export interface ParsedBetSlip {
  type: "SINGLE" | "EXPRESS";
  stake: number;
  selections: BetSlipSelectionInput[];
}

// MASTER STAGE M3, Phase 3 — formalizing, not renaming: this IS the
// project's canonical BetIntent/BetLegIntent boundary the target
// architecture calls for (screenshot/typed extraction -> canonical intent ->
// deterministic validation -> provider verification -> current odds). The
// underlying shape was already correct and stable; what was missing was an
// explicit name for the boundary itself, so provider-facing code can state
// "this consumes canonical intent, not raw OCR/AI wording" precisely.
//
// Deliberately NOT split further (no separate homeTeam/awayTeam fields):
// betParser.ts is a pure, offline text parser with no provider/event
// access — it genuinely does not know which side is home/away, only a
// free-text `event` string. homeTeam/awayTeam only exist once the odds
// provider resolves the real event (see buildBetSlipPreview.ts's oddsCheck)
// — inventing placeholder fields for data that doesn't exist yet at this
// boundary would be exactly the "renaming for aesthetics" this stage's own
// brief warns against, not real staging.
export type BetIntent = ParsedBetSlip;
export type BetLegIntent = BetSlipSelectionInput;

// Normalizes the existing, unchanged single-selection parser shape
// (ParsedBet — what parseBetMessage()/the image parser's SINGLE branch
// already return) into the new unified ParsedBetSlip. This *is* the
// backward-compatibility layer requirement: old SINGLE output still flows
// through unchanged, just wrapped.
export function normalizeParsedBet(bet: ParsedBet): ParsedBetSlip {
  return {
    type: "SINGLE",
    stake: bet.stake,
    selections: [
      {
        sport: bet.sport,
        event: bet.event,
        market: null,
        selection: bet.selection,
        submittedOdds: bet.odds,
      },
    ],
  };
}
