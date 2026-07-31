import type { ReactNode } from "react";
import type { BetPreview, BetSelectionOddsStatus } from "./betPreviewApi";
import SelectionList from "@/components/bets/SelectionList";
import type { DisplaySelection } from "@/lib/bets/mapBetForDisplay";
import { formatAmount } from "@/lib/bets/formatAmount";
import { normalizeSelectionToEnglish } from "@/lib/bets/normalizeSelectionToEnglish";
import { formatFullEventName } from "@/lib/bets/formatFullEventName";
import { formatEventDateTime } from "@/lib/bets/formatEventDateTime";
import { hasUnverifiedOddsStatus } from "./canConfirmBetSlip";

// Shown whenever the odds provider could not positively confirm a
// selection's exact event/market (NOT_FOUND) or couldn't verify anything
// right now (the reserved-but-unreachable PENDING) — the same condition
// canConfirmBetSlip.ts's hasUnverifiedOddsStatus disables the Confirm
// button for. Deliberately does not invite the player to "submit for
// operator review" — a bet the provider never confirmed must never reach
// the operator queue at all, so this message only explains why
// confirmation is blocked, never implies a submit-anyway path exists.
// UNAVAILABLE specifically is handled separately below (see
// PROVIDER_UNAVAILABLE_TITLE/MESSAGE) — this message must never be shown
// for a provider-technical failure, since it reads as "we looked and
// couldn't find this," which is not what happened.
const ODDS_UNVERIFIED_MESSAGE =
  "We couldn't verify this event or market with the odds provider. Please check the bet details or try again later.";

// Provider-level technical failure (timeout, rate limit, quota exhausted,
// auth failure, generic outage — see lib/odds/verification.ts's
// PROVIDER_FAILURE reasonCodes, all of which map to BetSelectionOddsStatus
// "UNAVAILABLE" via lib/odds/mapOddsStatus.ts). Deliberately neutral: never
// implies the team/event wasn't found, that the event doesn't exist, or
// that the player entered the bet incorrectly — those are genuinely
// different situations (NOT_FOUND), with their own, different message
// above.
export const PROVIDER_UNAVAILABLE_TITLE = "Live odds are temporarily unavailable";
export const PROVIDER_UNAVAILABLE_MESSAGE = "We couldn't verify this bet right now. Please try again later.";

// Exported so this exact decision is unit-testable without this project's
// deliberately absent DOM-rendering test infra (see e.g.
// ActiveBetsScreen.test.ts's own comment on why). Answers a narrower
// question than canConfirmBetSlip.ts's hasUnverifiedOddsStatus (which also
// blocks Confirm for NOT_FOUND/PENDING): specifically, is this a
// PROVIDER-technical failure, the one case that must show the neutral
// "temporarily unavailable" copy instead of the "could not verify"/"odds
// unavailable" copy.
export function isProviderUnavailable(oddsStatus: BetSelectionOddsStatus): boolean {
  return oddsStatus === "UNAVAILABLE";
}

// Shared preview display — used by both BetTextForm (text flow) and
// BetScreenshotForm (screenshot flow, Stage 4.5D). Extracted out of
// BetTextForm.tsx rather than duplicated: the two flows return the exact
// same BetPreviewSuccess shape, so there's exactly one preview UI, not two.
//
// Stage 12, Phase 3 — now renders SINGLE (selections.length === 1) exactly
// as it always did, reading from selections[0] instead of top-level
// fields, and adds an EXPRESS rendering path (a list of selections plus a
// stake/total-odds/potential-win summary). No visual change for SINGLE.
//
// Bet UI Design System, Phase 2/4 — the EXPRESS branch's per-selection row
// now renders through the shared components/bets/SelectionRow (via
// SelectionList in "full" mode — a decision context, so every selection
// stays visible unconditionally, exactly as before, just no longer a local
// one-off implementation). Financial figures are grouped into their own
// bordered block for a clearer summary, and the whole card uses a
// consistent gap rhythm instead of ad hoc mt-3 chaining, so the content
// balances across the card's width instead of reading as top/left-heavy.

export function PreviewCard({ preview }: { preview: BetPreview }) {
  if (preview.type === "SINGLE") {
    const selection = preview.selections[0];
    const fullEventName = formatFullEventName(selection.event, selection.homeTeamName, selection.awayTeamName);
    const eventDateTime = formatEventDateTime(selection.eventStartTime);
    return (
      <div
        className="rounded-2xl p-4"
        style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)" }}
      >
        <PreviewRow label="Bet type" value="Single" />
        <PreviewRow label="Sport" value={selection.sport} />
        <PreviewRow label="Event" value={fullEventName} wrap />
        {selection.competitionName && <PreviewRow label="Competition" value={selection.competitionName} wrap />}
        {eventDateTime && <PreviewRow label="Date" value={eventDateTime} />}
        <PreviewRow
          label="Selection"
          value={normalizeSelectionToEnglish({
            selection: selection.selection,
            sport: selection.sport,
            event: selection.event,
            market: selection.market,
          })}
          wrap
        />
        <PreviewRow label="Stake" value={formatAmount(preview.stake)} />
        <PreviewRow
          label="Submitted odds"
          value={selection.submittedOdds !== null ? formatAmount(selection.submittedOdds) : "Not provided"}
        />
        <PreviewRow
          label="Potential win"
          value={preview.potentialWin !== null ? formatAmount(preview.potentialWin) : "Not available"}
          last
        />
      </div>
    );
  }

  // BetPreviewSelection's own field names (selection/submittedOdds) map
  // onto the shared DisplaySelection shape (outcome/odds) the promoted
  // SelectionRow/SelectionList expect — no id exists yet pre-confirmation,
  // so the selection's own index stands in for it (stable for this
  // render's lifetime, never re-sorted).
  const selections: DisplaySelection[] = preview.selections.map((selection, index) => ({
    id: String(index),
    sport: selection.sport,
    event: formatFullEventName(selection.event, selection.homeTeamName, selection.awayTeamName),
    outcome: normalizeSelectionToEnglish({
      selection: selection.selection,
      sport: selection.sport,
      event: selection.event,
      market: selection.market,
    }),
    market: selection.market,
    odds: selection.submittedOdds !== null ? String(selection.submittedOdds) : null,
    currentOdds: selection.currentOdds !== null ? String(selection.currentOdds) : null,
    oddsStatus: selection.oddsStatus,
    competitionName: selection.competitionName,
    eventStartTime: selection.eventStartTime,
  }));

  return (
    <div
      className="rounded-2xl p-4"
      style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)" }}
    >
      <PreviewRow label="Bet type" value={`Express ×${preview.selections.length}`} />

      {/* Decision context (the player is about to confirm) — every
          selection is always shown, never truncated, regardless of count. */}
      <div className="mt-4">
        <SelectionList selections={selections} mode="full" showStatus />
      </div>

      <div
        className="mt-4 rounded-xl p-3"
        style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)" }}
      >
        <PreviewRow label="Stake" value={formatAmount(preview.stake)} />
        <PreviewRow
          label="Total odds"
          value={preview.totalOdds !== null ? formatAmount(preview.totalOdds) : "Not available"}
        />
        <PreviewRow
          label="Potential win"
          value={preview.potentialWin !== null ? formatAmount(preview.potentialWin) : "Not available"}
          last
        />
      </div>
    </div>
  );
}

function PreviewRow({
  label,
  value,
  wrap = false,
  last = false,
}: {
  label: string;
  value: string;
  wrap?: boolean;
  last?: boolean;
}) {
  return (
    <div className={`flex items-start justify-between gap-3 ${last ? "" : "mb-2"}`}>
      <span className="shrink-0 text-xs text-slate-400">{label}</span>
      <span className={`min-w-0 text-right text-sm font-medium text-white ${wrap ? "break-words" : ""}`}>
        {value}
      </span>
    </div>
  );
}

// Stage 12, Phase 3 — driven by each selection's oddsStatus instead of the
// old flat matched/withinTolerance booleans. For SINGLE, renders the exact
// same 4 states as before (not provided / verified / changed / couldn't
// verify) with identical wording — "not provided" is still checked first,
// off submittedOdds directly, so it's never conflated with a real
// verification failure (oddsStatus alone can't distinguish those two,
// since both currently produce UNAVAILABLE — see mapOddsStatus.ts). For
// EXPRESS, shows a compact summary across all selections instead of one
// box per leg (each leg's own badge is already shown in PreviewCard above).
export function OddsStatus({ preview }: { preview: BetPreview }) {
  if (preview.type === "EXPRESS") {
    return <ExpressOddsSummary preview={preview} />;
  }

  const selection = preview.selections[0];

  // Checked BEFORE the submittedOdds===null branch below: a provider
  // outage/timeout/rate-limit/quota-exhaustion also always leaves
  // submittedOdds null (no price was ever found to promote), so this must
  // be distinguished first, or every provider-technical failure would fall
  // into the generic "Odds unavailable... edit your bet" copy below, which
  // wrongly implies something about the player's own input.
  if (isProviderUnavailable(selection.oddsStatus)) {
    return <StatusBox tone="warning" label={PROVIDER_UNAVAILABLE_TITLE} description={PROVIDER_UNAVAILABLE_MESSAGE} />;
  }

  // Step 15J.1 — the backend now blocks confirmation outright whenever this
  // is null (app/api/miniapp/bets/text/confirm/route.ts's
  // ODDS_REQUIRED_BEFORE_CONFIRMATION), so this can no longer say "add odds
  // to verify" (odds are optional; the provider is expected to supply and
  // verify them automatically) or otherwise imply the bet is still
  // submittable — see components/miniapp/canConfirmBetSlip.ts's
  // hasUnresolvedSingleOdds, which gates the Confirm button off this exact
  // same condition. Deliberately not more specific about *why* the lookup
  // didn't resolve (event not found vs. mapping failure, etc.) — that
  // distinction is server-side only.
  if (selection.submittedOdds === null) {
    return (
      <StatusBox
        tone="warning"
        label="Odds unavailable"
        description="This bet cannot be confirmed because current odds are unavailable. Try again later or edit your bet."
      />
    );
  }

  if (selection.oddsStatus === "VERIFIED") {
    const discrepancy =
      selection.discrepancyPercent !== null ? Math.abs(selection.discrepancyPercent).toFixed(2) : "—";
    return (
      <StatusBox
        tone="success"
        label="✓ Odds verified"
        centered
        description={
          <>
            Verified odds: {selection.currentOdds !== null ? formatAmount(selection.currentOdds) : "—"}
            <br />
            Difference: {discrepancy}%
          </>
        }
      />
    );
  }

  if (selection.oddsStatus === "ODDS_CHANGED") {
    const discrepancy =
      selection.discrepancyPercent !== null ? Math.abs(selection.discrepancyPercent).toFixed(2) : "—";
    return (
      <StatusBox
        tone="warning"
        label="Odds changed"
        description={
          <>
            Submitted: {formatAmount(selection.submittedOdds)}
            <br />
            Current: {selection.currentOdds !== null ? formatAmount(selection.currentOdds) : "—"}
            <br />
            Difference: {discrepancy}%
            {selection.bookmaker ? (
              <>
                <br />
                {selection.bookmaker}
              </>
            ) : null}
          </>
        }
      />
    );
  }

  // NOT_FOUND and the reserved-but-unreachable PENDING share this fixed,
  // friendly message and block confirmation outright (canConfirmBetSlip.ts's
  // hasUnverifiedOddsStatus) — UNAVAILABLE is already handled above, before
  // this point is ever reached. There is deliberately no "submit anyway"
  // framing here either: the provider never confirmed this selection, so it
  // must never reach the operator queue.
  return <StatusBox tone="warning" label="Odds could not be verified" description={ODDS_UNVERIFIED_MESSAGE} />;
}

function ExpressOddsSummary({ preview }: { preview: BetPreview }) {
  // A blocking status on any leg (NOT_FOUND/UNAVAILABLE/PENDING) blocks the
  // whole slip — mirrors canConfirmBetSlip.ts's hasUnverifiedOddsStatus
  // exactly, and the backend's own verifyPreviewFreshness.ts priority order
  // (a provider outage or an unmatched leg always wins over a merely
  // "some legs verified" summary). UNAVAILABLE is checked first (same
  // reasoning as the SINGLE branch above): a provider-technical failure on
  // any leg must show the neutral "temporarily unavailable" copy, never the
  // generic "could not be verified" wording, which reads as a matching
  // failure rather than an outage.
  if (preview.selections.some((selection) => isProviderUnavailable(selection.oddsStatus))) {
    return <StatusBox tone="warning" label={PROVIDER_UNAVAILABLE_TITLE} description={PROVIDER_UNAVAILABLE_MESSAGE} />;
  }

  if (hasUnverifiedOddsStatus(preview.selections)) {
    return <StatusBox tone="warning" label="Odds could not be verified" description={ODDS_UNVERIFIED_MESSAGE} />;
  }

  const verifiedCount = preview.selections.filter((s) => s.oddsStatus === "VERIFIED").length;
  const total = preview.selections.length;
  const allVerified = verifiedCount === total;

  return (
    <StatusBox
      tone={allVerified ? "success" : "warning"}
      label={`${verifiedCount} of ${total} selections verified`}
      description="Each selection's status is shown above."
    />
  );
}

function StatusBox({
  tone,
  label,
  description,
  centered = false,
}: {
  tone: "neutral" | "success" | "warning";
  label: string;
  description: ReactNode;
  centered?: boolean;
}) {
  const color = tone === "success" ? "#60E84A" : tone === "warning" ? "#E8B84A" : "#94a3b8";

  return (
    <div
      className={`mt-2 rounded-2xl p-4 ${centered ? "text-center" : ""}`}
      style={{ background: "rgba(255,255,255,0.03)", border: `1px solid ${color}33` }}
    >
      <p className="text-sm font-semibold" style={{ color }}>
        {label}
      </p>
      <p className={`${centered ? "mt-3" : "mt-1"} text-xs leading-relaxed text-slate-400`}>{description}</p>
    </div>
  );
}
