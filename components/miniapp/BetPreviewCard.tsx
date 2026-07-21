import type { ReactNode } from "react";
import type { BetPreview, BetPreviewSelection, BetSelectionOddsStatus } from "./betPreviewApi";

// Shared preview display — used by both BetTextForm (text flow) and
// BetScreenshotForm (screenshot flow, Stage 4.5D). Extracted out of
// BetTextForm.tsx rather than duplicated: the two flows return the exact
// same BetPreviewSuccess shape, so there's exactly one preview UI, not two.
//
// Stage 12, Phase 3 — now renders SINGLE (selections.length === 1) exactly
// as it always did, reading from selections[0] instead of top-level
// fields, and adds an EXPRESS rendering path (a list of selections plus a
// stake/total-odds/potential-win summary). No visual change for SINGLE.

function formatAmount(value: number): string {
  return value.toFixed(2);
}

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
        <PreviewRow label="Selection" value={selection.selection} wrap />
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

  return (
    <div
      className="rounded-2xl p-4"
      style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)" }}
    >
      <PreviewRow label="Bet type" value={`Express ×${preview.selections.length}`} />

      <div className="mt-3 space-y-3">
        {preview.selections.map((selection, index) => (
          <SelectionRow key={index} selection={selection} />
        ))}
      </div>

      <div className="mt-3 border-t border-white/5 pt-3">
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

function SelectionRow({ selection }: { selection: BetPreviewSelection }) {
  return (
    <div className="rounded-xl p-3" style={{ background: "rgba(255,255,255,0.03)" }}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-white">{selection.event}</p>
          <p className="truncate text-xs text-slate-400">
            {selection.selection}
            {selection.market ? ` · ${selection.market}` : ""}
          </p>
        </div>
        <SelectionStatusBadge status={selection.oddsStatus} />
      </div>
      <div className="mt-1.5 flex items-center gap-3 text-xs text-slate-500">
        <span>Submitted: {selection.submittedOdds !== null ? formatAmount(selection.submittedOdds) : "—"}</span>
        {selection.currentOdds !== null && <span>Current: {formatAmount(selection.currentOdds)}</span>}
      </div>
    </div>
  );
}

const STATUS_BADGE: Record<BetSelectionOddsStatus, { label: string; color: string }> = {
  VERIFIED: { label: "Verified", color: "#60E84A" },
  ODDS_CHANGED: { label: "Odds changed", color: "#E8B84A" },
  NOT_FOUND: { label: "Not found", color: "#94a3b8" },
  UNAVAILABLE: { label: "Unavailable", color: "#94a3b8" },
  // Reserved default, not actually reachable today — see
  // lib/generated/prisma/enums.ts's BetSelectionOddsStatus and
  // lib/odds/mapOddsStatus.ts's doc comment.
  PENDING: { label: "Pending", color: "#94a3b8" },
};

function SelectionStatusBadge({ status }: { status: BetSelectionOddsStatus }) {
  const { label, color } = STATUS_BADGE[status];
  return (
    <span
      className="shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium"
      style={{ background: `${color}1A`, color }}
    >
      {label}
    </span>
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
