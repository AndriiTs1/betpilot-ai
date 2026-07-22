import { forwardRef } from "react";
import type { LucideIcon } from "lucide-react";
import { Ban, Barcode, Calendar, CircleCheckBig, CircleX, Clock, Hash, Trophy, User, Zap } from "lucide-react";
import { SportIcon } from "./sportIcons";

// The signature post-submission screen (Stage 4.5G) — replaces the plain
// BetConfirmedCard that used to live inline in BetScreen.tsx. Deliberately
// data-driven (BetTicketData/BetTicketStatus) instead of tied to
// ConfirmedBet's SINGLE-only shape, so PARLAY legs, a settled outcome
// (won/lost/void), and a later PDF/PNG export or QR verification can reuse
// this exact component without a redesign — see docs/CHANGELOG.md's
// Stage 4.5G entry for what's intentionally deferred (those exports/share
// actions are not implemented here, only the layout is shaped for them).
// Stage 12, Phase 4, Step 5 — that deferred multi-leg case is now real:
// BetScreen.tsx's toBetTicketData builds a real multi-entry selections[]
// for a confirmed EXPRESS bet, using this exact same component unchanged
// in structure — only the per-selection row grew market/currentOdds/
// oddsStatus, all optional so a SINGLE ticket (which never sets them)
// renders identically to before.
//
// No shared Card/Button/Badge primitives exist in this codebase (verified —
// every miniapp screen uses inline styles), so "reuse existing" here means
// following the same color/spacing/typography language already established
// in BetPreviewCard.tsx/BetTextForm.tsx (the #60E84A accent, the
// rgba(255,255,255,0.03..0.08) surfaces) and the same status vocabulary
// StatusBadge.tsx already uses on the operator dashboard, not importing a
// component that doesn't exist.

export type BetTicketStatus = "submitted" | "confirmed" | "rejected" | "settled_won" | "settled_lost" | "void";

export interface BetTicketSelection {
  sport: string;
  league?: string | null;
  event: string;
  selection: string;
  odds: number | null;
  // EXPRESS-only (Step 5) — left undefined for SINGLE, exactly as before.
  // oddsStatus/currentOdds are independently optional: an EXPRESS leg can
  // have a real oddsStatus (e.g. UNAVAILABLE) with no currentOdds value at
  // all, and that's shown as-is, never backfilled with a fake number.
  market?: string | null;
  currentOdds?: number | null;
  oddsStatus?: string | null;
}

export interface BetTicketData {
  id: string;
  status: BetTicketStatus;
  player: string;
  createdAt: string;
  /** One entry for a SINGLE bet, more than one for a PARLAY leg list. */
  selections: BetTicketSelection[];
  stake: number;
  totalOdds: number | null;
  availableCredit?: string | null;
}

interface BetTicketProps {
  ticket: BetTicketData;
  onDone: () => void;
  onViewHistory: () => void;
}

// Approximates MiniAppBackground's mid-gradient stop (#050915) so the
// punched-out notch blends into the page instead of showing a visible seam.
// A true transparent cutout (mask-image with composited radial-gradients)
// was considered and rejected as unnecessary complexity for a background
// that's already a near-solid dark gradient in the zone this ticket renders.
const NOTCH_COLOR = "#050915";

const STATUS_CONFIG: Record<
  BetTicketStatus,
  { badgeLabel: string; subtitle: string; icon: LucideIcon; color: string }
> = {
  submitted: {
    badgeLabel: "Submitted",
    subtitle: "Your bet has been submitted and is awaiting confirmation.",
    icon: CircleCheckBig,
    color: "#60E84A",
  },
  confirmed: {
    badgeLabel: "Confirmed",
    subtitle: "Your bet has been confirmed and is now active.",
    icon: CircleCheckBig,
    color: "#60A5FA",
  },
  rejected: {
    badgeLabel: "Rejected",
    subtitle: "This bet was not accepted.",
    icon: CircleX,
    color: "#94A3B8",
  },
  settled_won: {
    badgeLabel: "Won",
    subtitle: "Congratulations — this bet won.",
    icon: Trophy,
    color: "#60E84A",
  },
  settled_lost: {
    badgeLabel: "Lost",
    subtitle: "This bet did not win.",
    icon: CircleX,
    color: "#F87171",
  },
  void: {
    badgeLabel: "Void",
    subtitle: "This bet was voided.",
    icon: Ban,
    color: "#94A3B8",
  },
};

// Row stagger is capped at 10 steps (25ms each = 250ms) so a future
// many-leg PARLAY ticket can't push the total animation past the 500ms
// budget — extra rows beyond the cap simply animate in together at the
// same final delay instead of the sequence growing unbounded.
const STAGGER_STEP_MS = 25;
const STAGGER_MAX_STEPS = 10;
const TICKET_META_ROW_COUNT = 4; // Ticket ID, Player, Date, Time

function ticketRowDelay(index: number): string {
  return `${Math.min(index, STAGGER_MAX_STEPS) * STAGGER_STEP_MS}ms`;
}

function formatAmount(value: number): string {
  return value.toFixed(2);
}

// Locale is pinned to "en-US" rather than left to the runtime default —
// the server (Node) and the client (the player's browser) can have
// different default locales, and an undefined locale produced a real
// SSR/client hydration mismatch in testing (e.g. "Jul 20, 2026" server-side
// vs "20 июл. 2026 г." on a browser with a Russian locale).
const TICKET_LOCALE = "en-US";

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString(TICKET_LOCALE, { day: "2-digit", month: "short", year: "numeric" });
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleTimeString(TICKET_LOCALE, { hour: "2-digit", minute: "2-digit" });
}

function shortTicketId(id: string): string {
  const clean = id.replace(/-/g, "");
  return `#${clean.slice(-8).toUpperCase()}`;
}

const BetTicket = forwardRef<HTMLDivElement, BetTicketProps>(function BetTicket(
  { ticket, onDone, onViewHistory },
  ref,
) {
  const status = STATUS_CONFIG[ticket.status];
  const StatusIcon = status.icon;
  const isParlay = ticket.selections.length > 1;
  const potentialWin =
    ticket.totalOdds !== null && Number.isFinite(ticket.totalOdds) && Number.isFinite(ticket.stake)
      ? ticket.stake * ticket.totalOdds
      : null;

  // Financial rows pick up the stagger sequence right after the 4 ticket-meta
  // rows and one row per selection — a pure index calculation instead of a
  // mutable counter closure (React Compiler forbids reassigning a variable
  // captured by a render-time closure).
  const financialRowStart = TICKET_META_ROW_COUNT + ticket.selections.length;

  return (
    <div className="mx-auto w-full max-w-[420px]">
      <div
        ref={ref}
        role="group"
        aria-label={`Digital bet ticket, status: ${status.badgeLabel}`}
        className="ticket-animate-in relative overflow-hidden rounded-3xl"
        style={{
          background: "linear-gradient(180deg, #0B121D 0%, #060A11 100%)",
          border: "1px solid rgba(255,255,255,0.08)",
          boxShadow: "0 30px 80px rgba(0,0,0,0.55), 0 0 0 1px rgba(255,255,255,0.02)",
        }}
      >
        {/* Header */}
        <div className="flex flex-col items-center px-5 pt-6">
          <span className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-[0.14em] text-white">
            <Zap size={13} strokeWidth={2.5} style={{ color: "#60E84A" }} aria-hidden="true" />
            BetPilot AI
          </span>
          <span className="mt-1 text-[10px] font-medium uppercase tracking-[0.22em] text-slate-500">
            Digital Bet Ticket
          </span>
        </div>

        {/* Status */}
        <div className="flex flex-col items-center px-5 pb-5 pt-5 text-center">
          <div
            className="ticket-check-animate flex h-16 w-16 items-center justify-center rounded-full"
            style={{ background: `${status.color}1A`, boxShadow: `0 0 28px 4px ${status.color}26` }}
          >
            <StatusIcon size={34} strokeWidth={2} color={status.color} aria-hidden="true" />
          </div>

          <span
            className="mt-3 inline-flex items-center rounded-full px-3 py-1 text-[11px] font-bold uppercase tracking-wide"
            style={{ background: `${status.color}1A`, color: status.color, border: `1px solid ${status.color}40` }}
          >
            {status.badgeLabel}
          </span>

          <p className="mt-2 max-w-[280px] text-sm text-slate-400">{status.subtitle}</p>
        </div>

        <TicketDivider notched />

        {/* Ticket information */}
        <div className="grid grid-cols-2 gap-x-4 gap-y-3 px-5 py-5">
          <TicketMeta icon={Hash} label="Ticket ID" value={shortTicketId(ticket.id)} delay={ticketRowDelay(0)} />
          <TicketMeta icon={User} label="Player" value={ticket.player} delay={ticketRowDelay(1)} />
          <TicketMeta icon={Calendar} label="Date" value={formatDate(ticket.createdAt)} delay={ticketRowDelay(2)} />
          <TicketMeta icon={Clock} label="Time" value={formatTime(ticket.createdAt)} delay={ticketRowDelay(3)} />
        </div>

        <TicketDivider />

        {/* Event */}
        <div className="px-5 py-5">
          {ticket.selections.map((selection, index) => {
            // Both undefined for SINGLE (toBetTicketData never sets them) —
            // this row renders nothing extra, identical to before Step 5.
            const showStatusRow = selection.currentOdds != null || selection.oddsStatus != null;

            return (
              <div
                key={index}
                className={`ticket-row-animate ${index > 0 ? "mt-4" : ""}`}
                style={{ animationDelay: ticketRowDelay(TICKET_META_ROW_COUNT + index) }}
              >
                {isParlay && (
                  <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                    Leg {index + 1}
                  </p>
                )}
                <div className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-slate-500">
                  <SportIcon sport={selection.sport} size={13} stroke={2} />
                  {selection.sport}
                  {selection.league ? ` · ${selection.league}` : ""}
                </div>
                <p className="mt-1 text-[15px] font-semibold text-white break-words">{selection.event}</p>
                <p className="mt-0.5 text-sm break-words" style={{ color: "#60E84A" }}>
                  {selection.selection}
                  {selection.market ? ` · ${selection.market}` : ""}
                  {selection.odds !== null ? ` · ${formatAmount(selection.odds)}` : ""}
                </p>
                {showStatusRow && (
                  <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-500">
                    {selection.currentOdds != null && <span>Current: {formatAmount(selection.currentOdds)}</span>}
                    {selection.oddsStatus != null && <OddsStatusPill status={selection.oddsStatus} />}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <TicketDivider />

        {/* Financial */}
        <div className="px-5 py-5">
          <FinancialRow label="Stake" value={formatAmount(ticket.stake)} delay={ticketRowDelay(financialRowStart)} />
          <FinancialRow
            label={isParlay ? "Combined odds" : "Odds"}
            value={ticket.totalOdds !== null ? formatAmount(ticket.totalOdds) : "Not provided"}
            delay={ticketRowDelay(financialRowStart + 1)}
          />
          <FinancialRow
            label="Potential win"
            value={potentialWin !== null ? formatAmount(potentialWin) : "Not available"}
            delay={ticketRowDelay(financialRowStart + 2)}
            emphasize
            last={ticket.availableCredit == null}
          />
          {ticket.availableCredit != null && (
            <FinancialRow
              label="Available credit"
              value={ticket.availableCredit}
              delay={ticketRowDelay(financialRowStart + 3)}
              last
            />
          )}
        </div>

        <TicketDivider notched />

        {/* Bottom */}
        <div className="flex flex-col items-center px-5 pb-6 pt-5">
          <TicketBarcode seed={ticket.id} />
          <p className="mt-3 flex items-center gap-1.5 text-[11px] text-slate-500">
            <Barcode size={12} strokeWidth={2} aria-hidden="true" />
            Verified by BetPilot AI
          </p>
        </div>
      </div>

      {/* Actions — intentionally only Done/View History. Download, Share,
          Print, and QR verification are prepared for by this component's
          data-driven shape, not implemented here (Stage 4.5G scope). */}
      <div className="mt-4 flex flex-col gap-3">
        <button
          type="button"
          onClick={onDone}
          aria-label="Done"
          className="min-h-11 w-full rounded-2xl text-[15px] font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
          style={{ background: "#60E84A", color: "#04170C", outlineColor: "#60E84A" }}
        >
          Done
        </button>
        <button
          type="button"
          onClick={onViewHistory}
          aria-label="View history"
          className="min-h-11 w-full rounded-2xl text-[15px] font-medium text-slate-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
          style={{
            background: "rgba(255,255,255,0.03)",
            border: "1px solid rgba(255,255,255,0.08)",
            outlineColor: "rgba(255,255,255,0.4)",
          }}
        >
          View History
        </button>
      </div>
    </div>
  );
});

export default BetTicket;

// Perforated "tear line" between ticket stubs. `notched` adds the two
// half-circle side cut-outs (used at the major stub boundaries); the plain
// dashed line alone is used for the minor internal separators. Rendered as
// a full-bleed direct child of the card (no horizontal padding) so its
// -10px notch offsets land exactly on the card's real left/right edges,
// regardless of the padding used by the sections around it.
function TicketDivider({ notched = false }: { notched?: boolean }) {
  return (
    <div className="relative" aria-hidden="true">
      {notched && (
        <>
          <span
            className="absolute top-1/2 -left-[10px] h-5 w-5 -translate-y-1/2 rounded-full"
            style={{
              background: NOTCH_COLOR,
              border: "1px solid rgba(255,255,255,0.10)",
              boxShadow: "inset 0 1px 2px rgba(0,0,0,0.6)",
            }}
          />
          <span
            className="absolute top-1/2 -right-[10px] h-5 w-5 -translate-y-1/2 rounded-full"
            style={{
              background: NOTCH_COLOR,
              border: "1px solid rgba(255,255,255,0.10)",
              boxShadow: "inset 0 1px 2px rgba(0,0,0,0.6)",
            }}
          />
        </>
      )}
      <div className="border-t border-dashed" style={{ borderColor: "rgba(255,255,255,0.12)" }} />
    </div>
  );
}

function TicketMeta({
  icon: Icon,
  label,
  value,
  delay,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  delay: string;
}) {
  return (
    <div className="ticket-row-animate min-w-0" style={{ animationDelay: delay }}>
      <div className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wide text-slate-500">
        <Icon size={12} strokeWidth={2} aria-hidden="true" />
        {label}
      </div>
      <p className="mt-0.5 truncate text-sm font-semibold text-white">{value}</p>
    </div>
  );
}

function FinancialRow({
  label,
  value,
  delay,
  emphasize = false,
  last = false,
}: {
  label: string;
  value: string;
  delay: string;
  emphasize?: boolean;
  last?: boolean;
}) {
  return (
    <div
      className={`ticket-row-animate flex items-baseline justify-between gap-3 ${last ? "" : "mb-2.5"}`}
      style={{ animationDelay: delay }}
    >
      <span className="text-xs text-slate-400">{label}</span>
      <span
        className={`text-right font-semibold ${emphasize ? "text-base" : "text-sm"}`}
        style={{ color: emphasize ? "#60E84A" : "#F7F9FC" }}
      >
        {value}
      </span>
    </div>
  );
}

// EXPRESS-only, per-selection status badge (Step 5) — same palette
// BetPreviewCard.tsx's SelectionStatusBadge already established for the
// same five statuses, kept as its own small local copy rather than an
// import (BetPreviewCard.tsx is out of this step's scope) so this
// component's known set stays self-contained. An unrecognized string
// (oddsStatus is typed loosely as `string` on the wire) falls back to a
// neutral label instead of silently rendering nothing.
const ODDS_STATUS_LABELS: Record<string, { label: string; color: string }> = {
  VERIFIED: { label: "Verified", color: "#60E84A" },
  ODDS_CHANGED: { label: "Odds changed", color: "#E8B84A" },
  NOT_FOUND: { label: "Not found", color: "#94a3b8" },
  UNAVAILABLE: { label: "Unavailable", color: "#94a3b8" },
  PENDING: { label: "Pending", color: "#94a3b8" },
};

function OddsStatusPill({ status }: { status: string }) {
  const { label, color } = ODDS_STATUS_LABELS[status] ?? { label: status, color: "#94a3b8" };
  return (
    <span
      className="shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium"
      style={{ background: `${color}1A`, color }}
    >
      {label}
    </span>
  );
}

// Decorative only — a deterministic bar pattern derived from the ticket id,
// not a real scannable barcode (see BarcodePlaceholder note in the stage
// spec). Swapping this for a real barcode/QR image later only means
// replacing this one function's render output; every consumer of BetTicket
// stays the same.
function TicketBarcode({ seed }: { seed: string }) {
  const bars = barcodeWidths(seed);

  return (
    <div className="flex h-10 items-center gap-[3px]" aria-hidden="true">
      {bars.map((width, index) => (
        <span
          key={index}
          className="h-full"
          style={{ width, background: index % 5 === 0 ? "rgba(255,255,255,0.35)" : "rgba(255,255,255,0.18)" }}
        />
      ))}
    </div>
  );
}

function barcodeWidths(seed: string): number[] {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }

  const bars: number[] = [];
  for (let i = 0; i < 36; i += 1) {
    hash = (hash * 1103515245 + 12345) >>> 0;
    bars.push(1 + (hash % 3));
  }
  return bars;
}
