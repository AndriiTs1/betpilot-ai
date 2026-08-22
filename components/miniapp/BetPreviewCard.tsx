import type { ReactNode } from "react";
import type { BetPreview, BetSelectionOddsStatus } from "./betPreviewApi";
import SelectionRow from "@/components/bets/SelectionRow";
import { getOddsStatusBadge } from "@/lib/bets/oddsStatusBadge";
import type { DisplaySelection } from "@/lib/bets/mapBetForDisplay";
import { formatAmount } from "@/lib/bets/formatAmount";
import { normalizeSelectionToEnglish } from "@/lib/bets/normalizeSelectionToEnglish";
import { formatSelectionDisplay } from "@/lib/bets/formatSelectionDisplay";
import { formatFullEventName } from "@/lib/bets/formatFullEventName";
import { formatEventDateTime } from "@/lib/bets/formatEventDateTime";
import { hasUnverifiedOddsStatus, isSingleSelectionOddsUnavailable, isRecoverableLeg } from "./canConfirmBetSlip";
import { useLocale } from "./LocaleProvider";
import { translate } from "@/lib/i18n/translations";
import type { Locale } from "@/lib/i18n/locale";

// Localization completion pass — these module-level constants keep their
// EXACT original names/exports (nothing importing them breaks), but are now
// derived via translate(..., "en") so their value is byte-for-byte
// identical to before this pass. The actually-rendered copy in this file's
// own components now goes through useLocale()'s t() instead of these
// constants directly — kept only for any external consumer that still
// imports them by name (confirmed via a repo-wide check: nothing outside
// this file does today, but they stay exported since they're part of this
// module's existing public surface).
//
// Stage M4.5 — CLEAN UNAVAILABLE-ODDS UX. Replaces every previous SINGLE
// "could not be verified" / "provider unavailable" / "odds unavailable"
// warning box with one compact, visually secondary line — the player
// never needs to know *why* odds aren't available (that distinction stays
// server/log-side only, see Stage M4.4's diagnosticCode), only that they
// aren't. See OddsStatus below for the one condition that triggers it.
// Stage M4.6 — shortened further, same meaning, no added explanation.
export const ODDS_UNAVAILABLE_NOTICE = translate("en", "preview.oddsUnavailableNotice");

// Provider-level technical failure (timeout, rate limit, quota exhausted,
// auth failure, generic outage — see lib/odds/verification.ts's
// PROVIDER_FAILURE reasonCodes, all of which map to BetSelectionOddsStatus
// "UNAVAILABLE" via lib/odds/mapOddsStatus.ts). Deliberately neutral: never
// implies the team/event wasn't found, that the event doesn't exist, or
// that the player entered the bet incorrectly — those are genuinely
// different situations (NOT_FOUND), with their own, different message
// above.
export const PROVIDER_UNAVAILABLE_TITLE = translate("en", "preview.providerUnavailableTitle");
export const PROVIDER_UNAVAILABLE_MESSAGE = translate("en", "preview.providerUnavailableMessage");

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

// UI Polish — currency-suffixed Potential win display. Formatting only
// (formatAmount already does the Decimal-safe 2-decimal string conversion
// upstream) — this just appends the unit, never recomputes the value.
// Exported so the requirement ("Potential win must include the currency")
// is unit-testable without this project's absent DOM-rendering test infra.
export function formatPotentialWin(potentialWin: number | null, locale: Locale = "en"): string {
  return potentialWin !== null ? `${formatAmount(potentialWin)} USDC` : translate(locale, "preview.notAvailable");
}

// M4.1 — CLEAN PLAYER ODDS UX. The single "Odds" value a SINGLE preview
// shows the player: BetPilot's CURRENT provider price, never the
// screenshot/typed submittedOdds a player's input merely claimed (see this
// file's own header — a screenshot is an INPUT, never an offer). currentOdds
// is null only when the provider never matched this selection at all
// (NOT_FOUND/UNAVAILABLE/PENDING) — confirmation is already blocked in that
// case (canConfirmBetSlip.ts's hasUnverifiedOddsStatus), and the
// OddsStatus box below explains why; there is deliberately no fallback to
// submittedOdds here; showing it would misrepresent an unconfirmed
// screenshot/typed number as a real offer. Exported so this is
// unit-testable without this project's absent DOM-rendering test infra
// (same pattern as formatPotentialWin above).
export function formatSingleOdds(currentOdds: number | null, locale: Locale = "en"): string {
  return currentOdds !== null ? formatAmount(currentOdds) : translate(locale, "preview.notAvailable");
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

// Sector 1 (ADR-0002) — onExcludeLeg/excludingLegIndex are optional so
// every other caller of PreviewCard (none currently render EXPRESS without
// these, but the props stay opt-in for forward compatibility) is
// byte-for-byte unaffected when they're omitted. onExcludeLeg receives the
// leg's index into preview.selections — the same index/id SelectionRow
// already keys on below — never any odds/market/event data; the caller
// (BetTextForm.tsx/BetScreenshotForm.tsx) is responsible for calling
// fetchExpressLegExclusionPreview with it. excludingLegIndex, when
// non-null, disables every Remove button while that leg's request is
// in-flight — the double-click safety guard.
export function PreviewCard({
  preview,
  onExcludeLeg,
  excludingLegIndex = null,
}: {
  preview: BetPreview;
  onExcludeLeg?: (legIndex: number) => void;
  excludingLegIndex?: number | null;
}) {
  const { locale, t } = useLocale();

  if (preview.type === "SINGLE") {
    const selection = preview.selections[0];
    const fullEventName = formatFullEventName(selection.event, selection.homeTeamName, selection.awayTeamName);
    const eventDateTime = formatEventDateTime(selection.eventStartTime);
    // Stage M4.5 — CLEAN UNAVAILABLE-ODDS UX. Same single source of truth
    // as OddsStatus below and the Confirm button's own visibility
    // (canConfirmBetSlip.ts's isOddsUnavailableForConfirm): when this is
    // false, "Potential win" is a real number derived from real odds; when
    // true, it would only ever read "Not available", which the unavailable
    // state's own compact notice already communicates, so the row is
    // omitted entirely rather than repeating the same fact twice.
    // Semantic review fix — this must key off oddsStatus (server truth),
    // not merely submittedOdds: a screenshot bet's raw submitted price
    // survives into effectiveSubmittedOdds even when the provider lookup
    // failed (see buildBetSlipPreview.ts's own comment), so
    // isConfirmableSingleOdds alone would wrongly call a genuine NOT_FOUND
    // "available." isSingleSelectionOddsUnavailable checks oddsStatus first.
    const oddsAvailable = !isSingleSelectionOddsUnavailable(selection);
    return (
      <div
        className="rounded-2xl p-4"
        style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)" }}
      >
        <h3 className="mb-3 text-base font-bold text-white">{t("bet.single")}</h3>
        <PreviewRow label={t("preview.sport")} value={selection.sport} />
        <PreviewRow label={t("preview.event")} value={fullEventName} wrap />
        {selection.competitionName && <PreviewRow label={t("preview.competition")} value={selection.competitionName} wrap />}
        {eventDateTime && <PreviewRow label={t("preview.date")} value={eventDateTime} />}
        <PreviewRow
          label={t("preview.selection")}
          value={
            // RU betting-terminology consistency fix — same
            // normalizeSelectionToEnglish() call as before (untouched),
            // now followed by the exact same lib/bets/formatSelectionDisplay.ts
            // pass BetTicket.tsx's final ticket already applies. This row
            // has never shown a separate market value (SINGLE has no
            // market row, in either locale) — only `.selection` is read
            // here, so EN output is byte-for-byte unchanged and RU gets
            // the same outcome-wording rule as the final ticket.
            formatSelectionDisplay(
              normalizeSelectionToEnglish({
                selection: selection.selection,
                sport: selection.sport,
                event: selection.event,
                market: selection.market,
                marketType: selection.marketType,
                participant: selection.participant,
                line: selection.line,
                selectionType: selection.selectionType,
              }),
              selection.market,
              locale,
            ).selection
          }
          wrap
        />
        <PreviewRow label={t("preview.stake")} value={formatAmount(preview.stake)} />
        <PreviewRow
          label={t("preview.odds")}
          value={formatSingleOdds(selection.currentOdds, locale)}
          emphasis="prominent"
          last={!oddsAvailable}
        />
        {oddsAvailable && (
          <PreviewRow
            label={t("preview.potentialWin")}
            value={formatPotentialWin(preview.potentialWin, locale)}
            emphasis="hero"
            last
          />
        )}
      </div>
    );
  }

  // BetPreviewSelection's own field names (selection/submittedOdds) map
  // onto the shared DisplaySelection shape (outcome/odds) the promoted
  // SelectionRow/SelectionList expect — no id exists yet pre-confirmation,
  // so the selection's own index stands in for it (stable for this
  // render's lifetime, never re-sorted).
  const selections: DisplaySelection[] = preview.selections.map((selection, index) => {
    const normalizedOutcome = normalizeSelectionToEnglish({
      selection: selection.selection,
      sport: selection.sport,
      event: selection.event,
      market: selection.market,
      marketType: selection.marketType,
      participant: selection.participant,
      line: selection.line,
      selectionType: selection.selectionType,
    });
    // Same {selection, market} presentation pass BetTicket.tsx's final
    // ticket already applies — this is that one shared formatter, called
    // per leg, independently, at the same point normalizeSelectionToEnglish
    // itself already runs.
    const display = formatSelectionDisplay(normalizedOutcome, selection.market, locale);

    return {
      id: String(index),
      sport: selection.sport,
      event: formatFullEventName(selection.event, selection.homeTeamName, selection.awayTeamName),
      outcome: display.selection,
      market: display.market,
      odds: selection.submittedOdds !== null ? String(selection.submittedOdds) : null,
      currentOdds: selection.currentOdds !== null ? String(selection.currentOdds) : null,
      oddsStatus: selection.oddsStatus,
      competitionName: selection.competitionName,
      eventStartTime: selection.eventStartTime,
    };
  });

  return (
    <div
      className="rounded-2xl p-4"
      style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)" }}
    >
      <h3 className="mb-2 text-base font-bold text-white">
        {t("preview.expressCount", { count: String(preview.selections.length) })}
      </h3>

      {/* Decision context (the player is about to confirm) — every
          selection is always shown, never truncated, regardless of count.
          Sector 1 (ADR-0002) — no longer delegated to SelectionList (a
          shared component also used by Dashboard/History surfaces this
          sector must not touch): mapped here directly, still through the
          exact same SelectionRow (its own display logic/decisions
          unmodified — only the localization closure pass added optional,
          plain-string oddsLabel/statusBadgeLabel presentation overrides),
          so a per-leg Remove affordance can be attached only in this
          preview context. oddsLabel/statusBadgeLabel are resolved here,
          via the Mini App's own i18n layer — SelectionRow itself still
          imports no localization mechanism, so the operator dashboard's
          own (unrelated) callers are completely unaffected. */}
      <div className="space-y-1.5">
        {preview.selections.map((selection, index) => (
          <div key={selections[index].id}>
            <SelectionRow
              selection={selections[index]}
              showStatus
              oddsLabel={t("preview.odds")}
              statusBadgeLabel={getOddsStatusBadge(selection.oddsStatus, locale).label}
            />
            {onExcludeLeg && isRecoverableLeg(selection) && (
              <button
                type="button"
                onClick={() => onExcludeLeg(index)}
                disabled={excludingLegIndex !== null}
                className="mt-1 w-full rounded-lg py-1.5 text-center text-xs font-medium transition-colors disabled:opacity-50"
                style={{
                  color: "#f87171",
                  background: "rgba(248,113,113,0.06)",
                  border: "1px solid rgba(248,113,113,0.18)",
                }}
              >
                {excludingLegIndex === index ? t("preview.removing") : t("preview.removeAndRecalculate")}
              </button>
            )}
          </div>
        ))}
      </div>

      <div
        className="mt-3 rounded-xl p-2.5"
        style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)" }}
      >
        <PreviewRow label={t("preview.stake")} value={formatAmount(preview.stake)} />
        <PreviewRow
          label={t("preview.totalOdds")}
          value={preview.totalOdds !== null ? formatAmount(preview.totalOdds) : t("preview.notAvailable")}
          emphasis="prominent"
        />
        <PreviewRow
          label={t("preview.potentialWin")}
          value={formatPotentialWin(preview.potentialWin, locale)}
          emphasis="hero"
          last
        />
      </div>
    </div>
  );
}

// emphasis — UI Polish: three-tier visual hierarchy for the summary block.
// "normal" (default) is unchanged from before this task. "prominent" (Total
// odds / Submitted odds) is bigger/bolder than ordinary metadata but still
// neutral-colored. "hero" (Potential win — the bottom-line figure) is the
// most prominent, in the same accent green already used for Confirm/
// Verified elsewhere, not a new color.
function PreviewRow({
  label,
  value,
  wrap = false,
  last = false,
  emphasis = "normal",
}: {
  label: string;
  value: string;
  wrap?: boolean;
  last?: boolean;
  emphasis?: "normal" | "prominent" | "hero";
}) {
  const valueClass =
    emphasis === "hero" ? "text-lg font-bold" : emphasis === "prominent" ? "text-base font-bold" : "text-sm font-medium";
  const valueColor = emphasis === "hero" ? "#60E84A" : "#ffffff";

  return (
    <div className={`flex items-start justify-between gap-3 ${last ? "" : "mb-1.5"}`}>
      <span className="shrink-0 text-xs text-slate-400">{label}</span>
      <span
        className={`min-w-0 text-right ${valueClass} ${wrap ? "break-words" : ""}`}
        style={{ color: valueColor }}
      >
        {value}
      </span>
    </div>
  );
}

// Stage M4.5 — CLEAN UNAVAILABLE-ODDS UX. For SINGLE, every reason this
// selection ends up with no confirmable current odds (provider outage,
// NOT_FOUND, the reserved-but-unreachable PENDING, or the defensive
// submittedOdds===null case) now collapses into ONE compact, visually
// secondary notice — isSingleSelectionOddsUnavailable checks oddsStatus
// (server truth) first, exactly like canConfirmBetSlip.ts's own gate and
// the Confirm button's own visibility (isOddsUnavailableForConfirm), never
// a second, independently-maintained condition. Deliberately NOT just
// isConfirmableSingleOdds/submittedOdds alone: a screenshot's raw OCR'd
// price survives into submittedOdds even when the provider never matched
// anything (see buildBetSlipPreview.ts's effectiveSubmittedOdds), so
// oddsStatus must be checked first or a genuine NOT_FOUND selection with a
// visible screenshot price would wrongly read as "available." The player
// never needs to know *why* odds aren't available (that distinction stays
// server/log-side only — see Stage M4.4's diagnosticCode), only that they
// aren't. For EXPRESS, unchanged: a compact summary across all selections
// instead of one box per leg (each leg's own badge is already shown in
// PreviewCard above).
export function OddsStatus({ preview }: { preview: BetPreview }) {
  const { t } = useLocale();

  if (preview.type === "EXPRESS") {
    return <ExpressOddsSummary preview={preview} />;
  }

  const selection = preview.selections[0];

  if (isSingleSelectionOddsUnavailable(selection)) {
    return <p className="mt-2 text-xs leading-relaxed text-slate-400">{t("preview.oddsUnavailableNotice")}</p>;
  }

  // VERIFIED and ODDS_CHANGED are both a normal, confirmable selection —
  // the "Odds" row above already shows the real current price, so there is
  // nothing left to explain here.
  return null;
}

function ExpressOddsSummary({ preview }: { preview: BetPreview }) {
  const { t } = useLocale();

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
    return <StatusBox tone="warning" label={t("preview.providerUnavailableTitle")} description={t("preview.providerUnavailableMessage")} />;
  }

  if (hasUnverifiedOddsStatus(preview.selections)) {
    return <StatusBox tone="warning" label={t("preview.oddsUnverifiedTitle")} description={t("preview.oddsUnverifiedMessage")} />;
  }

  // M4.1 — every leg is VERIFIED/ODDS_CHANGED (both real, confirmable,
  // provider-matched prices) — same reasoning as the SINGLE branch above:
  // each leg's own current odds is already shown, nothing left to explain.
  return null;
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
