import { forwardRef } from "react";
import type { LucideIcon } from "lucide-react";
import { Ban, Barcode, CircleCheckBig, CircleX, Trophy, Zap } from "lucide-react";
import { SportIcon } from "./sportIcons";
import { getOddsStatusBadge } from "@/lib/bets/oddsStatusBadge";
import { formatAmount } from "@/lib/bets/formatAmount";
import { getOddsPresentation } from "@/components/bets/SelectionRow";
import { formatPotentialWin } from "./BetPreviewCard";

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

// Stage M4.9 — CLEAN EXPRESS CURRENT-ODDS UX. This ticket screen has its
// own inline per-selection rendering (never went through
// components/bets/SelectionRow.tsx), so it never picked up Stage M4.1's
// "current price only, no comparison, no badge for a confirmable status"
// fix — it kept showing the submitted/screenshot odds on the main line
// plus a separate "Current: X" line plus a "Verified"/"Odds changed"
// badge for every EXPRESS leg. These two functions reuse
// SelectionRow.tsx's own getOddsPresentation (the exact same decision the
// preview screen already uses), so this screen can never drift out of
// sync with it again. SINGLE selections (oddsStatus undefined —
// toBetTicketData never sets it) are untouched: selection.odds already IS
// the single accepted price (Stage M4.8), so there is nothing to resolve.
export function resolveTicketSelectionOdds(selection: BetTicketSelection): number | null {
  if (selection.oddsStatus == null) return selection.odds;
  const presentation = getOddsPresentation(selection.oddsStatus, selection.currentOdds ?? null);
  return presentation.mode === "prominent" ? presentation.value : null;
}

// A status badge is shown ONLY when there is no confirmable current price
// to display (NOT_FOUND/UNAVAILABLE/PENDING, e.g. an exempt leg that never
// had a submitted price at all) — the same "explain the absence, never
// annotate a real price" rule SelectionRow.tsx already enforces. VERIFIED
// and ODDS_CHANGED never render a badge here.
export function resolveTicketStatusBadge(selection: BetTicketSelection): string | null {
  if (selection.oddsStatus == null) return null;
  const presentation = getOddsPresentation(selection.oddsStatus, selection.currentOdds ?? null);
  return presentation.mode === "unavailable" ? selection.oddsStatus : null;
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

// Stage M5.1 — `detail` replaces the old `subtitle` field (a full
// explanatory sentence per status, e.g. spelling out that a submitted bet
// awaits confirmation) with a short phrase for the new one-line compact
// status ("Submitted · Awaiting confirmation"). Applied uniformly across
// every status, not special-cased to "submitted" — this config drives one
// shared render path. Exported so the exact badge/detail text is
// unit-testable without this project's deliberately absent DOM-rendering
// test infra.
export const STATUS_CONFIG: Record<
  BetTicketStatus,
  { badgeLabel: string; detail: string; icon: LucideIcon; color: string }
> = {
  submitted: {
    badgeLabel: "Submitted",
    detail: "Awaiting confirmation",
    icon: CircleCheckBig,
    color: "#60E84A",
  },
  confirmed: {
    badgeLabel: "Confirmed",
    detail: "Now active",
    icon: CircleCheckBig,
    color: "#60A5FA",
  },
  rejected: {
    badgeLabel: "Rejected",
    detail: "Not accepted",
    icon: CircleX,
    color: "#94A3B8",
  },
  settled_won: {
    badgeLabel: "Won",
    detail: "Settled",
    icon: Trophy,
    color: "#60E84A",
  },
  settled_lost: {
    badgeLabel: "Lost",
    detail: "Settled",
    icon: CircleX,
    color: "#F87171",
  },
  void: {
    badgeLabel: "Void",
    detail: "Voided",
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
// Stage M5.1 — one compact row now (Ticket ID · Player · Date · Time on a
// single line), not four separate grid cells.
const TICKET_META_ROW_COUNT = 1;

function ticketRowDelay(index: number): string {
  return `${Math.min(index, STAGGER_MAX_STEPS) * STAGGER_STEP_MS}ms`;
}

// Locale is pinned to "en-US" rather than left to the runtime default —
// the server (Node) and the client (the player's browser) can have
// different default locales, and an undefined locale produced a real
// SSR/client hydration mismatch in testing (e.g. "Jul 20, 2026" server-side
// vs "20 июл. 2026 г." on a browser with a Russian locale).
const TICKET_LOCALE = "en-US";

// Stage M5.1 — exported (were module-private) so the compact meta line's
// content is unit-testable without this project's deliberately absent
// DOM-rendering test infra, same pattern as resolveTicketSelectionOdds/
// resolveTicketStatusBadge above.
export function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString(TICKET_LOCALE, { day: "2-digit", month: "short", year: "numeric" });
}

export function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleTimeString(TICKET_LOCALE, { hour: "2-digit", minute: "2-digit" });
}

export function shortTicketId(id: string): string {
  const clean = id.replace(/-/g, "");
  return `#${clean.slice(-8).toUpperCase()}`;
}

// Stage M5.2 — exported (was inline in the component body) so the
// potential-win computation itself is unit-testable without this project's
// deliberately absent DOM-rendering test infra, same pattern as every other
// pure decision in this file. Byte-for-byte the same formula as before this
// stage — this extraction changes nothing about the calculation, only where
// it's written.
export function computeTicketPotentialWin(stake: number, totalOdds: number | null): number | null {
  return totalOdds !== null && Number.isFinite(totalOdds) && Number.isFinite(stake) ? stake * totalOdds : null;
}

const BetTicket = forwardRef<HTMLDivElement, BetTicketProps>(function BetTicket(
  { ticket, onDone, onViewHistory },
  ref,
) {
  const status = STATUS_CONFIG[ticket.status];
  const StatusIcon = status.icon;
  const isParlay = ticket.selections.length > 1;
  const potentialWin = computeTicketPotentialWin(ticket.stake, ticket.totalOdds);

  // Financial rows pick up the stagger sequence right after the ticket-meta
  // row and one row per selection — a pure index calculation instead of a
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
        {/* Header + status + meta — Stage M5.1: one compact block replacing
            the old branding block, large 64px status icon circle, status
            pill, full explanatory sentence, and 2×2 metadata grid. The
            ticket screen fully replaces BetScreen's own top app bar while
            shown (see BetScreen.tsx — confirmedBet renders ONLY this
            component), so a small brand mark stays, just no longer a
            dedicated multi-line section. Status is still immediately
            readable — icon + label + short detail, all on one line — and
            Ticket ID/Player/Date/Time are still all present, on one
            de-emphasized line directly below, before the actual bet
            content begins. Stage M5.6: outer padding/internal gap trimmed
            slightly (pt-5 -> pt-4, pb-4 -> pb-3, gap-2 -> gap-1.5) — every
            line (wordmark, status, meta) is still present, just closer
            together. */}
        <div className="flex flex-col gap-1.5 px-5 pt-4 pb-3">
          <span className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">
            <Zap size={11} strokeWidth={2.5} style={{ color: "#60E84A" }} aria-hidden="true" />
            BetPilot AI
          </span>

          <div className="ticket-check-animate flex items-center gap-1.5">
            <StatusIcon size={18} strokeWidth={2.5} color={status.color} aria-hidden="true" />
            <span className="text-[15px] font-bold" style={{ color: status.color }}>
              {status.badgeLabel}
            </span>
            <span className="text-[15px] text-slate-500">· {status.detail}</span>
          </div>

          <p className="ticket-row-animate text-xs text-slate-500" style={{ animationDelay: ticketRowDelay(0) }}>
            {shortTicketId(ticket.id)} · {ticket.player} · {formatDate(ticket.createdAt)} · {formatTime(ticket.createdAt)}
          </p>
        </div>

        <TicketDivider notched />

        {/* Event — Stage M5.4: section padding and leg-internal spacing
            tightened (py-5 -> py-4, mt-4 -> mt-3 between legs, mb-1.5 -> mb-1
            leg label gap, mt-1 -> mt-0.5 event gap) so an EXPRESS ×2 ticket
            has a realistic shot at fitting a normal iPhone viewport without
            scrolling. No line of information was removed — only the gaps
            between them shrank.
            Stage M5.6: this was still the single largest remaining block of
            vertical waste — each EXPRESS leg spent two full lines on
            secondary metadata ("Leg N" on its own line, "FOOTBALL" on the
            next). Both values are still shown, in the same order, just
            combined onto one line (py-4 -> py-3, mt-3 -> mt-2 between legs)
            — the primary content (event name, selection, odds) is
            untouched in text, size, and line count. */}
        <div className="px-5 py-3">
          {ticket.selections.map((selection, index) => {
            // Stage M4.9 — one value only: the current/accepted price
            // (SINGLE) or the current provider price (EXPRESS VERIFIED/
            // ODDS_CHANGED), never the submitted/screenshot number, never
            // both. A status badge appears only when there is genuinely no
            // confirmable price to show at all.
            const displayOdds = resolveTicketSelectionOdds(selection);
            const statusBadge = resolveTicketStatusBadge(selection);

            return (
              <div
                key={index}
                className={`ticket-row-animate ${index > 0 ? "mt-2" : ""}`}
                style={{ animationDelay: ticketRowDelay(TICKET_META_ROW_COUNT + index) }}
              >
                <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                  {isParlay && (
                    <>
                      <span>Leg {index + 1}</span>
                      <span aria-hidden="true">·</span>
                    </>
                  )}
                  <SportIcon sport={selection.sport} size={13} />
                  <span>
                    {selection.sport}
                    {selection.league ? ` · ${selection.league}` : ""}
                  </span>
                </div>
                <p className="mt-0.5 text-[15px] font-semibold text-white break-words">{selection.event}</p>
                <p className="mt-0.5 text-sm break-words" style={{ color: "#60E84A" }}>
                  {selection.selection}
                  {selection.market ? ` · ${selection.market}` : ""}
                  {displayOdds !== null ? ` · ${formatAmount(displayOdds)}` : ""}
                </p>
                {statusBadge && (
                  <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-500">
                    <OddsStatusPill status={statusBadge} />
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <TicketDivider />

        {/* Financial — Stage M5.2: Potential win now carries its currency
            (reusing BetPreviewCard.tsx's formatPotentialWin, the project's
            one existing currency-suffix source — the data model has no
            per-bet asset/currency field to derive it from instead, and
            preview already established " USDC" as the single fixed
            convention for a payout figure specifically). Stake/Combined
            odds/Available credit deliberately keep their existing bare
            (no-suffix) formatting — see this file's own header comment on
            why. Available credit is now visually muted relative to
            Stake/Combined odds, on top of already being visually secondary
            to Potential win (emphasize). No spacing/margin changes — the
            hierarchy is conveyed by weight/color only. Stage M5.4: section
            padding tightened (py-5 -> py-4), same reasoning as the Event
            section above. Stage M5.6: tightened again (py-4 -> py-3). */}
        <div className="px-5 py-3">
          <FinancialRow label="Stake" value={formatAmount(ticket.stake)} delay={ticketRowDelay(financialRowStart)} />
          <FinancialRow
            label={isParlay ? "Combined odds" : "Odds"}
            value={ticket.totalOdds !== null ? formatAmount(ticket.totalOdds) : "Not provided"}
            delay={ticketRowDelay(financialRowStart + 1)}
          />
          <FinancialRow
            label="Potential win"
            value={formatPotentialWin(potentialWin)}
            delay={ticketRowDelay(financialRowStart + 2)}
            emphasize
            last={ticket.availableCredit == null}
          />
          {ticket.availableCredit != null && (
            <FinancialRow
              label="Available credit"
              value={ticket.availableCredit}
              delay={ticketRowDelay(financialRowStart + 3)}
              muted
              last
            />
          )}
        </div>

        <TicketDivider notched />

        {/* Bottom — Stage M5.3: a subtle authenticity mark, not a major
            content section. Reduced padding + the barcode's own shrunk
            height (see TicketBarcode) + a tighter gap before "Verified by
            BetPilot AI" so the two elements read as one compact
            verification unit, closer together than the rest of the
            ticket's section rhythm. Barcode data/generation (barcodeWidths)
            is completely untouched — only its container's height shrank.
            Stage M5.6: outer container padding trimmed once more
            (pt-4 pb-5 -> pt-3 pb-4) — the barcode's own height and the gap
            before "Verified by BetPilot AI" are deliberately left alone,
            per this stage's own instruction not to shrink the barcode
            again. */}
        <div className="flex flex-col items-center px-5 pt-3 pb-4">
          <TicketBarcode seed={ticket.id} />
          <p className="mt-1.5 flex items-center gap-1.5 text-[11px] text-slate-500">
            <Barcode size={12} strokeWidth={2} aria-hidden="true" />
            Verified by BetPilot AI
          </p>
        </div>
      </div>

      {/* Actions — intentionally only Done/View History. Download, Share,
          Print, and QR verification are prepared for by this component's
          data-driven shape, not implemented here (Stage 4.5G scope).
          Stage M5.6: the gaps around/between the buttons were tightened
          (mt-4 -> mt-3, gap-3 -> gap-2.5) — per this stage's own guidance,
          button height (min-h-11, the real accessible touch-target
          minimum) is deliberately left untouched; only the space around it
          shrank. */}
      <div className="mt-3 flex flex-col gap-2.5">
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

function FinancialRow({
  label,
  value,
  delay,
  emphasize = false,
  muted = false,
  last = false,
}: {
  label: string;
  value: string;
  delay: string;
  emphasize?: boolean;
  // Stage M5.2 — tertiary tier, one step below the default Stake/Combined
  // odds weight (never used together with `emphasize`, which stays
  // Potential win's own, strongest tier). Only Available credit uses this
  // today — a smaller, more muted treatment for account-context
  // information that isn't part of the bet's own numbers.
  muted?: boolean;
  last?: boolean;
}) {
  return (
    <div
      className={`ticket-row-animate flex items-baseline justify-between gap-3 ${last ? "" : "mb-1.5"}`}
      style={{ animationDelay: delay }}
    >
      <span className={`text-xs ${muted ? "text-slate-500" : "text-slate-400"}`}>{label}</span>
      <span
        className={`text-right font-semibold ${emphasize ? "text-base" : muted ? "text-xs font-medium" : "text-sm"}`}
        style={{ color: emphasize ? "#60E84A" : muted ? "#94A3B8" : "#F7F9FC" }}
      >
        {value}
      </span>
    </div>
  );
}

// EXPRESS-only, per-selection status badge (Step 5) — the canonical
// odds-verification palette (lib/bets/oddsStatusBadge.ts), previously a
// local copy duplicating BetPreviewCard.tsx's own STATUS_BADGE
// byte-for-byte. Wording/colors are unchanged, only the definition moved.
function OddsStatusPill({ status }: { status: string }) {
  const { label, color } = getOddsStatusBadge(status);
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
// Stage M5.3 — height reduced from h-10 (40px) to h-6 (24px), a 40%
// reduction, matching the requested ~30-40% smaller footprint. Bar
// count/widths/gap (barcodeWidths, the seed-derived pattern itself) are
// completely untouched — narrowing was deliberately avoided per this
// stage's own guidance ("prefer reducing height ... rather than making it
// so narrow that it stops looking like a barcode").
function TicketBarcode({ seed }: { seed: string }) {
  const bars = barcodeWidths(seed);

  return (
    <div className="flex h-6 items-center gap-[3px]" aria-hidden="true">
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
