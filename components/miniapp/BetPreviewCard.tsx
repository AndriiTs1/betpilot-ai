import type { ReactNode } from "react";
import type { BetOddsCheck, BetPreview } from "./betPreviewApi";

// Shared preview display — used by both BetTextForm (text flow) and
// BetScreenshotForm (screenshot flow, Stage 4.5D). Extracted out of
// BetTextForm.tsx rather than duplicated: the two flows return the exact
// same BetPreviewSuccess shape, so there's exactly one preview UI, not two.

function formatAmount(value: number): string {
  return value.toFixed(2);
}

export function PreviewCard({ preview }: { preview: BetPreview }) {
  return (
    <div
      className="rounded-2xl p-4"
      style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)" }}
    >
      <PreviewRow label="Bet type" value="Single" />
      <PreviewRow label="Sport" value={preview.sport} />
      <PreviewRow label="Event" value={preview.event} wrap />
      <PreviewRow label="Selection" value={preview.outcome} wrap />
      <PreviewRow label="Stake" value={formatAmount(preview.stake)} />
      <PreviewRow
        label="Submitted odds"
        value={preview.odds !== null ? formatAmount(preview.odds) : "Not provided"}
      />
      <PreviewRow
        label="Potential win"
        value={preview.potentialWin !== null ? formatAmount(preview.potentialWin) : "Not available"}
        last
      />
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

export function OddsStatus({ oddsCheck }: { oddsCheck: BetOddsCheck | null }) {
  if (!oddsCheck) {
    return (
      <StatusBox
        tone="neutral"
        label="Odds not provided"
        description="Add odds to verify them against the bookmaker feed."
      />
    );
  }

  if (!oddsCheck.matched) {
    // Stage 9 — one fixed, player-facing message for every "couldn't verify"
    // case (event not found, sport not covered, provider error, etc.), same
    // across Football/Basketball/Tennis. The specific technical reason
    // (oddsCheck.note server-side) is never shown here — see the preview
    // API routes, which log it and strip it before the response reaches
    // this component. Never blocks Confirm bet — canConfirm doesn't depend
    // on oddsCheck at all (see BetTextForm.tsx/BetScreenshotForm.tsx).
    return (
      <StatusBox
        tone="warning"
        label="Odds could not be verified"
        description="This event is not currently available from the odds provider. You can still submit the bet for operator review."
      />
    );
  }

  const discrepancy =
    oddsCheck.discrepancyPercent !== null ? Math.abs(oddsCheck.discrepancyPercent).toFixed(2) : "—";

  if (oddsCheck.withinTolerance === true) {
    return (
      <StatusBox
        tone="success"
        label="Odds verified"
        description={
          <>
            Bookmaker odds: {oddsCheck.sourceOdds !== null ? formatAmount(oddsCheck.sourceOdds) : "—"}
            <br />
            Difference: {discrepancy}%
            {oddsCheck.bookmaker ? (
              <>
                <br />
                {oddsCheck.bookmaker}
              </>
            ) : null}
          </>
        }
      />
    );
  }

  // matched === true && withinTolerance === false
  return (
    <StatusBox
      tone="warning"
      label="Odds changed"
      description={
        <>
          Submitted: {formatAmount(oddsCheck.submittedOdds)}
          <br />
          Current: {oddsCheck.sourceOdds !== null ? formatAmount(oddsCheck.sourceOdds) : "—"}
          <br />
          Difference: {discrepancy}%
          {oddsCheck.bookmaker ? (
            <>
              <br />
              {oddsCheck.bookmaker}
            </>
          ) : null}
        </>
      }
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
