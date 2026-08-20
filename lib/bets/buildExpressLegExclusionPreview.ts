import type { BetSelectionOddsStatus } from "@/lib/generated/prisma/client";
import type { ExpressPreviewTokenPayload } from "@/lib/betPreview/previewToken";
import { reconstructParsedBetSlip } from "@/lib/bets/verifyPreviewFreshness";
import { buildBetSlipPreview, type BuildBetSlipPreviewOptions, type BuildBetSlipPreviewResult } from "@/lib/bets/buildBetSlipPreview";
import { MIN_EXPRESS_SELECTIONS } from "@/lib/bets/betSlipRules";
import type { ParsedBetSlip } from "@/lib/bets/betSlip";

// Sector 1 (ADR-0002) — EXPRESS per-leg unavailable recovery, Variant B (the
// approved architecture): the client never supplies odds/market/event, only
// the index(es) of legs to exclude against an already-signed, already-
// verified ExpressPreviewTokenPayload. Every field this module reads comes
// from that payload (server-authoritative, HMAC-signed — see
// lib/betPreview/previewToken.ts's verifyExpressPreviewToken, which the
// caller must run BEFORE this function is ever invoked) or from
// buildBetSlipPreview()'s own fresh, live re-verification. No AI parsing
// happens anywhere in this file — reconstructParsedBetSlip only reads
// already-extracted token fields, never raw text/image input.
//
// This file owns exactly one decision: which remaining legs to re-preview
// after exclusion, and whether that remaining set is SINGLE, EXPRESS, or
// invalid. It does not touch buildBetSlipPreview's own odds-verification
// logic, previewToken's signing/shape, or betSlipRules' validation rules —
// all three are reused completely unmodified.

export type ExpressLegExclusionErrorCode =
  | "NOT_EXPRESS_TOKEN"
  | "NO_LEGS_EXCLUDED"
  | "DUPLICATE_LEG_INDEX"
  | "INVALID_LEG_INDEX"
  | "LEG_NOT_RECOVERABLE"
  | "ALL_LEGS_EXCLUDED";

// Same narrow-purpose "Error subclass with an explicit code" convention as
// lib/bets/betSlipRules.ts's BetSlipValidationError and
// lib/betPreview/previewToken.ts's PreviewTokenSignError.
export class ExpressLegExclusionError extends Error {
  readonly code: ExpressLegExclusionErrorCode;

  constructor(code: ExpressLegExclusionErrorCode, message: string) {
    super(message);
    this.name = "ExpressLegExclusionError";
    this.code = code;
  }
}

// The only statuses Sector 1 allows a player to exclude — mirrors the
// approved product decision exactly: recoverable means "the provider could
// not confirm this leg right now" (NOT_FOUND/UNAVAILABLE), never "the
// player changed their mind about a leg that IS verified" (out of Sector
// 1's scope by design, see ADR-0002) and never the reserved-but-
// practically-unreachable PENDING. This is the server-side enforcement of
// the same rule components/miniapp/canConfirmBetSlip.ts's isRecoverableLeg
// mirrors client-side for the Remove button's own visibility — never trust
// the client to have only offered Remove on a genuinely recoverable leg.
const RECOVERABLE_ODDS_STATUSES: ReadonlySet<BetSelectionOddsStatus> = new Set(["NOT_FOUND", "UNAVAILABLE"]);

export interface BuildExpressLegExclusionPreviewOptions {
  verifyOddsFn?: BuildBetSlipPreviewOptions["verifyOddsFn"];
  oddsVerificationService?: BuildBetSlipPreviewOptions["oddsVerificationService"];
}

// `payload` must already be verified (signature + expiry + shape) by the
// caller — this function trusts it completely, exactly like
// verifyPreviewFreshness.ts's own reconstructParsedBetSlip usage does.
// `excludeIndices` are positions into payload.selections (0-based) — the
// same index BetPreviewCard.tsx renders each leg at (guaranteed
// index-aligned with the token by construction — see
// buildBetSlipPreview.ts's previewSelections.map/signExpressPreviewToken
// call, which build both arrays from the same single .map pass).
export async function buildExpressLegExclusionPreview(
  payload: ExpressPreviewTokenPayload,
  excludeIndices: readonly number[],
  previewTokenSecret: string,
  options: BuildExpressLegExclusionPreviewOptions = {},
): Promise<BuildBetSlipPreviewResult> {
  if (payload.type !== "EXPRESS") {
    throw new ExpressLegExclusionError("NOT_EXPRESS_TOKEN", "Leg exclusion only applies to an EXPRESS previewToken");
  }

  if (excludeIndices.length === 0) {
    throw new ExpressLegExclusionError("NO_LEGS_EXCLUDED", "At least one leg index must be excluded");
  }

  const uniqueIndices = new Set(excludeIndices);
  if (uniqueIndices.size !== excludeIndices.length) {
    throw new ExpressLegExclusionError("DUPLICATE_LEG_INDEX", "excludeIndices contains a duplicate index");
  }

  for (const index of uniqueIndices) {
    if (!Number.isInteger(index) || index < 0 || index >= payload.selections.length) {
      throw new ExpressLegExclusionError("INVALID_LEG_INDEX", `excludeIndices contains an out-of-range index: ${index}`);
    }

    const status = payload.selections[index]?.oddsStatus;
    if (!RECOVERABLE_ODDS_STATUSES.has(status)) {
      throw new ExpressLegExclusionError(
        "LEG_NOT_RECOVERABLE",
        `Leg at index ${index} has oddsStatus ${status}, which cannot be excluded in Sector 1`,
      );
    }
  }

  // The only place the already-signed token is read — reconstructs the
  // full ParsedBetSlip from it (no AI, no client-supplied odds/market/
  // event), then this function's own filtering removes the excluded legs.
  const fullSlip = reconstructParsedBetSlip(payload);
  const remainingSelections = fullSlip.selections.filter((_selection, index) => !uniqueIndices.has(index));

  if (remainingSelections.length === 0) {
    throw new ExpressLegExclusionError("ALL_LEGS_EXCLUDED", "Excluding every leg leaves nothing to preview");
  }

  const buildOptions: BuildBetSlipPreviewOptions = {};
  if (options.oddsVerificationService) buildOptions.oddsVerificationService = options.oddsVerificationService;
  else if (options.verifyOddsFn) buildOptions.verifyOddsFn = options.verifyOddsFn;

  // Below MIN_EXPRESS_SELECTIONS (today: exactly 1 leg, since 0 was already
  // rejected above) — reuse the existing, already-proven SINGLE path
  // (Sector 1's approved minimal recovery UX) instead of inventing a new
  // "EXPRESS below minimum" concept. If remainingSelections somehow held
  // more than 1 element here (impossible while MIN_EXPRESS_SELECTIONS = 2),
  // buildBetSlipPreview's own validateBetSlipType would reject it with
  // SINGLE_INVALID_SELECTION_COUNT — fails safe either way, never silently.
  const remainingSlip: ParsedBetSlip =
    remainingSelections.length < MIN_EXPRESS_SELECTIONS
      ? { type: "SINGLE", stake: fullSlip.stake, selections: remainingSelections }
      : { type: "EXPRESS", stake: fullSlip.stake, selections: remainingSelections };

  // The one and only re-verification call — identical to how a fresh
  // preview or a confirm-time freshness check both already re-price every
  // leg against the live provider. Never trusts any odds/market/event value
  // that didn't just come from this call.
  return buildBetSlipPreview(remainingSlip, payload.playerId, previewTokenSecret, buildOptions);
}
