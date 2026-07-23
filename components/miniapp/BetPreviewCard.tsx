import type { ReactNode } from "react";
import type { BetPreview } from "./betPreviewApi";
import SelectionList from "@/components/bets/SelectionList";
import type { DisplaySelection } from "@/lib/bets/mapBetForDisplay";
import { formatAmount } from "@/lib/bets/formatAmount";
import { normalizeSelectionToEnglish } from "@/lib/bets/normalizeSelectionToEnglish";

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
    return (
      <div
        className="rounded-2xl p-4"
        style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)" }}
      >
        <PreviewRow label="Bet type" value="Single" />
        <PreviewRow label="Sport" value={selection.sport} />
        <PreviewRow label="Event" value={selection.event} wrap />
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
    event: selection.event,
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

  if (selection.submittedOdds === null) {
    return (
      <StatusBox
        tone="neutral"
        label="Odds not provided"
        description="Add odds to verify them against the bookmaker feed."
      />
    );
  }

  if (selection.oddsStatus === "VERIFIED") {
    const discrepancy =
      selection.discrepancyPercent !== null ? Math.abs(selection.discrepancyPercent).toFixed(2) : "—";
    return (
      <StatusBox
        tone="success"
        label="Odds verified"
        description={
          <>
            Bookmaker odds: {selection.currentOdds !== null ? formatAmount(selection.currentOdds) : "—"}
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

  // NOT_FOUND, UNAVAILABLE, and the reserved-but-unreachable PENDING all
  // show the same fixed, friendly message (Stage 9) — the specific
  // technical reason is server-side only.
  return (
    <StatusBox
      tone="warning"
      label="Odds could not be verified"
      description="This event is not currently available from the odds provider. You can still submit the bet for operator review."
    />
  );
}

function ExpressOddsSummary({ preview }: { preview: BetPreview }) {
  const verifiedCount = preview.selections.filter((s) => s.oddsStatus === "VERIFIED").length;
  const total = preview.selections.length;
  const allVerified = verifiedCount === total;

  return (
    <StatusBox
      tone={allVerified ? "success" : "warning"}
      label={`${verifiedCount} of ${total} selections verified`}
      description="Each selection's status is shown above. You can still submit this express for operator review."
    />
  );
}

function StatusBox({
  tone,
  label,
  description,
}: {
  tone: "neutral" | "success" | "warning";
  label: string;
  description: ReactNode;
}) {
  const color = tone === "success" ? "#60E84A" : tone === "warning" ? "#E8B84A" : "#94a3b8";

  return (
    <div
      className="mt-2 rounded-2xl p-4"
      style={{ background: "rgba(255,255,255,0.03)", border: `1px solid ${color}33` }}
    >
      <p className="text-sm font-semibold" style={{ color }}>
        {label}
      </p>
      <p className="mt-1 text-xs leading-relaxed text-slate-400">{description}</p>
    </div>
  );
}
