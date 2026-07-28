// Stage 3.5A — pure helpers for turning a Bet's (SINGLE) or BetSelection's
// (EXPRESS leg) persisted provider metadata into a typed, deduplicated,
// batchable set of events to ask the provider about. No AI, no display
// text, no event-title parsing, no team-name matching — every field read
// here is exactly one of the Stage 3.1 persisted columns
// (providerName/providerSportKey/providerEventId/eventStartTime), never
// Bet.event/Bet.outcome or BetSelection.event/BetSelection.outcome.

import type { ProviderName } from "@/lib/odds/oddsProvider";

export interface ProviderEventKey {
  readonly providerName: ProviderName;
  readonly providerSportKey: string;
  readonly providerEventId: string;
}

// Structural subset both Bet (SINGLE) and BetSelection (EXPRESS leg)
// already satisfy — mirrors the same "matching field names, deliberately
// separate types" convention Stage 3.4B's own mapExpressSelectionToCanonicalSelection.ts
// established for the analogous canonical-fields case.
export interface ProviderMetadataFields {
  readonly providerName: string | null;
  readonly providerSportKey: string | null;
  readonly providerEventId: string | null;
  readonly eventStartTime: Date | null;
}

export interface PollingWindow {
  readonly now: Date;
  readonly lookbackMs: number;
}

function isProviderName(value: string): value is ProviderName {
  return value === "THE_ODDS_API";
}

// Returns null (never throws, never guesses) whenever metadata is absent,
// the provider name isn't the one closed value this system knows, or the
// event's start time falls outside the polling window — all treated
// identically as "nothing to ask the provider for regarding this
// bet/leg right now," never as an error.
export function extractProviderEventKey(fields: ProviderMetadataFields, window: PollingWindow): ProviderEventKey | null {
  const { providerName, providerSportKey, providerEventId, eventStartTime } = fields;

  if (providerName === null || providerSportKey === null || providerEventId === null) return null;
  if (!isProviderName(providerName)) return null;
  if (eventStartTime === null) return null;

  const startMs = eventStartTime.getTime();
  const nowMs = window.now.getTime();
  if (startMs > nowMs) return null; // hasn't started yet
  if (startMs < nowMs - window.lookbackMs) return null; // too old — Stage 3.7/manual-review territory

  return { providerName, providerSportKey, providerEventId };
}

// EXPRESS convenience — one key per in-window, metadata-complete leg.
// Legs that fail extractProviderEventKey are simply omitted (never
// throw, never block the others) — the settlement service downstream
// (autoSettleExpressBet, Stage 3.4B) is what ultimately decides whether an
// omitted leg means REJECTED (missing metadata) or WAITING (not yet
// resolved); this helper's only job is deciding what to ask the provider
// for.
export function extractProviderEventKeys(
  legs: readonly ProviderMetadataFields[],
  window: PollingWindow,
): readonly ProviderEventKey[] {
  const keys: ProviderEventKey[] = [];
  for (const leg of legs) {
    const key = extractProviderEventKey(leg, window);
    if (key) keys.push(key);
  }
  return keys;
}

/* -------------------------------------------------------------------------- */
/* Grouping + deduplication                                                   */
/* -------------------------------------------------------------------------- */

export interface GroupedEventKeys {
  readonly providerName: ProviderName;
  readonly providerSportKey: string;
  // Deduplicated, stable first-seen order — never a Set (which has no
  // guaranteed serialization order contract across engines) and never
  // re-sorted, so a request is byte-for-byte reproducible for the same
  // input order.
  readonly providerEventIds: readonly string[];
}

function groupKeyFor(providerName: ProviderName, providerSportKey: string): string {
  return `${providerName}::${providerSportKey}`;
}

// Pure, does not mutate `keys`. Groups by (providerName, providerSportKey)
// — the two fields that actually determine which /scores URL a batch must
// be sent to — and deduplicates providerEventId within each group, so the
// same event referenced by ten different bets is only ever fetched once.
// Both group order and each group's providerEventId order are the
// input array's own first-seen order — deterministic, no hidden sort.
export function groupAndDeduplicateEventKeys(keys: readonly ProviderEventKey[]): readonly GroupedEventKeys[] {
  const groups = new Map<string, { providerName: ProviderName; providerSportKey: string; ids: string[]; seen: Set<string> }>();

  for (const key of keys) {
    const groupKey = groupKeyFor(key.providerName, key.providerSportKey);
    let group = groups.get(groupKey);
    if (!group) {
      group = { providerName: key.providerName, providerSportKey: key.providerSportKey, ids: [], seen: new Set() };
      groups.set(groupKey, group);
    }
    if (!group.seen.has(key.providerEventId)) {
      group.seen.add(key.providerEventId);
      group.ids.push(key.providerEventId);
    }
  }

  return Array.from(groups.values()).map((group) => ({
    providerName: group.providerName,
    providerSportKey: group.providerSportKey,
    providerEventIds: group.ids,
  }));
}

// Total distinct providerEventIds across every group — used for the
// PollingReport's uniqueEvents counter. Does not assume providerEventId is
// globally unique across groups (a data-inconsistency edge case where the
// same ID appears under two different sport keys is theoretically
// possible) — counts each group's own distinct IDs and sums them, which is
// the honest count of "how many distinct (provider, sport, id) triples we
// are about to ask about," not a claim that IDs never collide across
// groups.
export function countUniqueEvents(groups: readonly GroupedEventKeys[]): number {
  return groups.reduce((total, group) => total + group.providerEventIds.length, 0);
}
