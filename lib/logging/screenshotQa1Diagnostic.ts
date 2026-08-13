// SCREENSHOT QA-1.1 — TEMPORARY diagnostic for one specific incident (the
// Bayern Munich vs. VfB Stuttgart screenshot returning IMAGE_NOT_RECOGNIZED
// in production, credentials unavailable locally to reproduce directly).
// Deliberately kept separate from lib/logging/structuredLog.ts's permanent,
// content-free ScreenshotPipelineEvent log (whose own header comment
// explicitly says metadata can never carry OCR text or parsed bet content)
// — this module exists ONLY to answer "which stage first diverges from the
// expected bet slip" for this investigation, is meant to be removed once
// that's answered, and is intentionally the only place in the codebase that
// logs parsed bet content (event/selection/market/line/odds/stake) at all.
//
// Every field below is either a boolean/enum/number, or — for the parser
// stage only — the bet's own already-extracted structured fields (which the
// player who reported this issue already disclosed in plaintext). This
// module MUST NEVER be given: Telegram initData, a Telegram/player id, an
// auth header, a cookie, a bot token, an Anthropic key, a DB URL, a preview
// token, raw image bytes/base64, or a full raw OCR transcript — none of
// those types are constructible from this file's exported types at all.
//
// Side-effect-only: every function here returns void and only calls
// console.log. Nothing it does can change a response's status/body — see
// app/api/miniapp/bets/screenshot/preview/route.test.ts's QA-1.1 tests for
// the proof (identical HTTP result with console.log mocked to a no-op).

export const SCREENSHOT_QA1_DIAGNOSTIC_MARKER = "[SCREENSHOT_QA1_DIAGNOSTIC]";

export interface Qa1PreprocessingDiagnostic {
  stage: "preprocessing";
  mimeType: string;
  imageWidth: number | null;
  imageHeight: number | null;
  looksLikeFullScreenScreenshot: boolean;
}

export interface Qa1RegionDetectionDiagnostic {
  stage: "region_detection";
  attempted: boolean;
  outcome: "skipped_small_image" | "region_found" | "region_not_found" | "region_invalid" | "region_timeout" | "region_error";
  // Normalized (0-1) coordinates exactly as the model returned them —
  // never pixel values, and null whenever outcome !== "region_found".
  region: { x: number; y: number; width: number; height: number } | null;
  cropWidthPx: number | null;
  cropHeightPx: number | null;
  // true whenever OCR ends up running on the original, uncropped buffer —
  // i.e. every outcome except "region_found" (skipped, not-found, invalid,
  // timeout, or error all fall back to full-image OCR, matching
  // recognizeBetSlipScreenshot.ts's own existing fallback behavior,
  // unchanged by this diagnostic).
  fallbackToFullImage: boolean;
}

// Booleans only, per this stage's explicit "prefer boolean markers"
// instruction — deliberately no raw/redacted OCR text field at all, to keep
// this module's own attack surface as small as possible; text LENGTH is a
// safe count, never content.
export interface Qa1OcrDiagnostic {
  stage: "ocr";
  normalizedTextLength: number;
  containsBayern: boolean;
  containsStuttgart: boolean;
  containsOdds142: boolean;
  containsStake100: boolean;
  containsP1: boolean;
}

export interface Qa1ParserSelectionDiagnostic {
  sport: string;
  event: string;
  market: string | null;
  selection: string;
  line: string | null;
  odds: number | null;
}

export interface Qa1ParserDiagnostic {
  stage: "parser";
  valid: boolean;
  // ParseBetSlipResult's own optional discriminator
  // (lib/ai/betParser.ts) — "unspecified" only when the parser rejected
  // without one of the three named codes (e.g. reject_bet, malformed
  // extraction), never a fabricated value.
  errorCode: "timeout" | "numeric_mismatch" | "market_mismatch" | "unspecified" | null;
  type: "SINGLE" | "EXPRESS" | null;
  stake: number | null;
  selections: Qa1ParserSelectionDiagnostic[] | null;
}

// SCREENSHOT QA-4 — the boundary the QA-4 production audit found genuinely
// invisible: a numeric_mismatch rejection's own `errorCode` (above) says
// role and verdict via the console.error text line only, and neither that
// nor the QA1 parser stage ever expose WHICH numbers actually competed, or
// whether SCREENSHOT QA-CORE S2's LABEL_STRONG/LABEL_WEAK tiering
// (lib/ai/numericRoleVerifier.ts) actually engaged for a given rejection.
// Fires only for the exact role/observation that caused a numeric_mismatch
// rejection (lib/ai/betParser.ts's own unreliableClaim) — never for a
// CORROBORATED/UNVERIFIED claim, which needs no explanation. `value` is
// always the number exactly as extracted (e.g. "100", "50") — never a
// larger substring, never marker-adjacent OCR context — and `marker` is
// always one of the closed vocabulary words already documented in
// lib/ai/numericRoleEvidence.ts (ставка/stake/usd/на/...), the same safety
// class already logged elsewhere in this module. supportingEvidence/
// conflictingEvidence are exactly the (already tier-filtered) arrays that
// produced the verdict below — every entry here is by construction already
// LABEL_STRONG/LABEL_WEAK (whichever tier survived filtering) or MARKER_LOW,
// so their presence alone shows whether a real field label or an unlabeled
// currency figure is what conflicted.
export interface Qa1NumericEvidenceEntry {
  value: string;
  confidence: "LABEL_STRONG" | "LABEL_WEAK" | "MARKER_LOW" | "SOLE_CANDIDATE";
  marker: string | null;
}

export interface Qa1NumericEvidenceDiagnostic {
  stage: "numeric_evidence";
  role: "STAKE" | "LINE" | "ODDS";
  verdict: "CORROBORATED" | "CONTRADICTED" | "UNVERIFIED" | "AMBIGUOUS";
  // The value Claude itself claimed for this role, stringified exactly as
  // NumericRoleClaim.value already carries it — never reformatted.
  claimedValue: string;
  supportingEvidence: Qa1NumericEvidenceEntry[];
  conflictingEvidence: Qa1NumericEvidenceEntry[];
}

// SCREENSHOT QA-2.1 — the ONE previously-invisible boundary from the QA-2
// dual-failure audit: buildBetSlipPreview.ts's reconcile1X2ParticipantClaim
// (lib/bets/buildBetSlipPreview.ts), reached only when a selection carries a
// pendingMarketReconciliation (lib/bets/betSlip.ts). Distinguishes the two
// branches a MARKET_INTENT_UNRECONCILED rejection could previously have come
// from without telling them apart: (A) the odds provider never resolved a
// real event/team names at all (oddsCheckMatched false, or
// homeTeamName/awayTeamName absent — resolutionKind stays null, since
// resolveParticipantSide is never even called in that case), vs (B) an event
// was resolved but the claimed participant name didn't cleanly resolve to
// the required side (resolutionKind is NO_MATCH/AMBIGUOUS, or resolves to
// the wrong HOME/AWAY side).
//
// Every field here is either a boolean/enum/number, or plain text content
// already of the same kind Qa1ParserDiagnostic above logs (a team/
// participant name is public sports data, the same category as
// selection.event/selection already logged there) — never player id, auth,
// tokens, or raw image/OCR content, same invariant as every other stage in
// this module.
export interface Qa1ReconciliationDiagnostic {
  stage: "reconciliation";
  // Claude's own raw claimed participant text (e.g. "Bayern Munich") and the
  // side the original OCR/message text evidence asserted — both already
  // known pre-reconciliation, from lib/bets/betSlip.ts's
  // PendingMarketReconciliation.
  claimedParticipant: string;
  requiredSide: "HOME" | "AWAY";
  // The CanonicalSelection shape BEFORE reconciliation — always
  // MONEYLINE_2WAY/PARTICIPANT in production today (the only shape
  // classifyReconcilable1X2Mismatch ever produces a pendingMarketReconciliation
  // for), reported as plain strings rather than importing lib/odds/domain.ts's
  // MarketType/SelectionType enums into this otherwise dependency-free module.
  marketTypeBefore: string | null;
  selectionTypeBefore: string | null;
  // Whether the odds provider matched a real event at all, and whether a
  // providerEventId was present — the first fork in the "why didn't this
  // reconcile" question (branch A above).
  oddsCheckMatched: boolean;
  providerEventIdPresent: boolean;
  // The provider's own resolved team names, when present — null whenever
  // the event never matched (branch A). Public sports data, not secret.
  homeTeamName: string | null;
  awayTeamName: string | null;
  // The second fork (branch B): what resolveParticipantSide (lib/odds/
  // teamNameMatcher.ts) actually decided, computed independently and purely
  // for observability — see buildBetSlipPreview.ts's own comment at the
  // call site. null only when resolution was never attempted at all
  // (homeTeamName/awayTeamName absent — branch A, not a real "NO_MATCH").
  resolutionKind: "HOME" | "AWAY" | "NO_MATCH" | "AMBIGUOUS" | null;
  // The real, production outcome of reconcile1X2ParticipantClaim for this
  // selection — never recomputed or duplicated, always the exact same value
  // the caller's own accept/reject branch already used.
  reconciled: boolean;
}

// MASTER STAGE M3, Phase 1 — the diagnostic gap M2.1's audit identified: a
// market_mismatch rejection's own errorCode says nothing about WHICH
// competing (marketType, selectionType) signatures actually produced an
// AMBIGUOUS/CONTRADICTED verdict, unlike numeric_mismatch's own
// numeric_evidence stage above. Mirrors that stage's shape exactly, one
// level up: marketType/selectionType are always present (MarketIntentClaim
// carries no participant/line at all, by this verifier's own deliberate
// design — see marketIntentVerifier.ts's own header for why); participantName/
// embeddedLine appear per EVIDENCE entry (from each entry's own
// ShorthandClassification), not on the claim, since that is the real shape
// the underlying data has — never fabricated to match a hoped-for shape.
// Fires only for the exact observation that caused a market_mismatch
// rejection (lib/ai/betParser.ts's own unreliableMarketClaim) — never for a
// CORROBORATED/UNVERIFIED claim, same discipline as numeric_evidence above.
// Team/participant names and market shorthand are public sports/UI data, the
// same category already logged in Qa1ParserDiagnostic/Qa1ReconciliationDiagnostic
// — never player id, auth, tokens, or raw image bytes/full OCR transcript.
export interface Qa1MarketIntentEvidenceEntry {
  marketType: string;
  selectionType: string;
  participantName: string | null;
  embeddedLine: string | null;
}

export interface Qa1MarketIntentEvidenceDiagnostic {
  stage: "market_intent_evidence";
  claimedMarketType: string;
  claimedSelectionType: string;
  verdict: "CORROBORATED" | "CONTRADICTED" | "UNVERIFIED" | "AMBIGUOUS";
  supportingEvidence: Qa1MarketIntentEvidenceEntry[];
  conflictingEvidence: Qa1MarketIntentEvidenceEntry[];
  // MASTER STAGE M3.1, Phase B — true when this claim was DEFERRED to
  // provider-informed reconciliation (lib/ai/betParser.ts's generalized
  // deferral, or the pre-existing narrow 1X2 case) rather than hard-rejected
  // — so production QA can distinguish "accepted despite local ambiguity,
  // because a supported market shape let the provider decide" from "hard
  // rejected, provider never consulted" without guessing from the parser
  // stage's own valid/errorCode fields alone.
  deferred: boolean;
}

export type Qa1Diagnostic =
  | Qa1PreprocessingDiagnostic
  | Qa1RegionDetectionDiagnostic
  | Qa1OcrDiagnostic
  | Qa1ParserDiagnostic
  | Qa1ReconciliationDiagnostic
  | Qa1NumericEvidenceDiagnostic
  | Qa1MarketIntentEvidenceDiagnostic;

export function logScreenshotQa1Diagnostic(diagnostic: Qa1Diagnostic): void {
  console.log(SCREENSHOT_QA1_DIAGNOSTIC_MARKER, JSON.stringify(diagnostic));
}

// Pure, exported separately so route.ts and tests can both compute/verify
// these booleans without duplicating the substring logic. Case-insensitive
// (Node's string .toLowerCase() correctly case-folds Cyrillic under the
// full-ICU builds this project already runs on) — a real bookmaker UI's
// exact capitalization is never something OCR/the player controls.
export function computeQa1OcrIndicators(normalizedText: string): Omit<Qa1OcrDiagnostic, "stage" | "normalizedTextLength"> {
  const lower = normalizedText.toLowerCase();
  return {
    containsBayern: lower.includes("bayern"),
    containsStuttgart: lower.includes("stuttgart"),
    containsOdds142: lower.includes("1.42"),
    containsStake100: lower.includes("100"),
    containsP1: lower.includes("п1"),
  };
}
