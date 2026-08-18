import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
// betSlip.ts's own import of this file's types is `import type`-only (erased
// at compile time), so this is not a real runtime circular dependency —
// only this file ends up depending on betSlip.ts at runtime, not the
// reverse.
import { normalizeParsedBet, type ParsedBetSlip, type PendingMarketReconciliation } from "@/lib/bets/betSlip";
import { chatPrompt, ocrPrompt } from "./betParserPrompt";
import { mapRawBetSlipToParsedBetSlip, type RawBetSelectionFields, type NumericRoleObservation, type MarketIntentObservation } from "./betDraftMapper";
import { normalizeOcrParticipantClaim } from "./ocrParticipantClaimNormalizer";
import { logScreenshotQa1Diagnostic, type Qa1NumericEvidenceEntry, type Qa1MarketIntentEvidenceEntry } from "@/lib/logging/screenshotQa1Diagnostic";
import type { NumericRoleEvidence } from "./numericRoleEvidence";
import type { MarketIntentEvidence } from "./marketIntentEvidence";

const OLLAMA_HOST = process.env.OLLAMA_HOST ?? "http://localhost:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? "llama3.2";
const OLLAMA_TIMEOUT_MS = 8000;

const CLAUDE_MODEL = "claude-sonnet-4-6";
const CLAUDE_TIMEOUT_MS = 8000;

// Shared across every odds field this file validates (SINGLE, EXPRESS legs,
// both CHAT and OCR mode) — a single ceiling, not a per-schema guess. Real
// bookmaker decimal odds essentially never reach four figures; this exists
// to catch an obvious OCR/decimal-separator misread (e.g. "2,10" read as
// 210, or "10.50" read as 1050) rather than to model a genuine odds limit —
// see SCREENSHOT_RECOGNITION_REPORT.md.
export const MAX_DECIMAL_ODDS = 1000;

// league/market/period/line: Anthropic's strict tool schema (extractBetTool
// below) declares these as REQUIRED keys whose value may be null — under
// strict:true + additionalProperties:false, a real Claude response is
// guaranteed to always include every one of them. This is therefore the
// strict Claude-tool-payload contract: .nullable() (never .optional() or
// .nullish()), so an omitted key is a validation FAILURE, not a silently
// accepted shape — a payload missing one of these keys is malformed and
// must be caught here, not passed through as if it meant "not stated".
//
// This schema is shared by both real producers of an actual Claude
// extract_bet tool_use.input: parseTextSlipWithClaude (below) and the
// legacy parseWithClaude (same extractBetTool, effectively unreachable in
// production but no less bound by the same real contract).
//
// Ollama's freeform JSON response is a genuinely different producer with no
// structural schema enforcement of its own — see ollamaBetFieldsSchema and
// parseWithOllama's compatibility-enrichment step below, the ONE place an
// omitted key is expected and legitimate.
const betFieldsSchema = z.object({
  sport: z.string().min(1),
  league: z.string().min(1).nullable(),
  event: z.string().min(1),
  market: z.string().min(1).nullable(),
  selection: z.string().min(1),
  period: z.string().min(1).nullable(),
  line: z.string().min(1).nullable(),
  stake: z.number().positive(),
  odds: z.number().finite().positive().max(MAX_DECIMAL_ODDS, "Decimal odds exceed the supported maximum").nullable(),
});

const validBetSchema = betFieldsSchema.extend({ valid: z.literal(true) });

const invalidBetSchema = z.object({ valid: z.literal(false) });

export type ParsedBet = z.infer<typeof validBetSchema>;

export type ParseBetResult = ParsedBet | { valid: false; error: string };

/* -------------------------------------------------------------------------- */
/* Ollama                                                                      */
/* -------------------------------------------------------------------------- */

const OLLAMA_SYSTEM_PROMPT = `You extract structured sports betting data from a WhatsApp message sent by a player to their bookmaker.

Return a single strict JSON object, with no extra text, matching one of these two shapes:

1. The message is a bet request:
{"valid": true, "sport": string, "event": string, "selection": string, "stake": number, "odds": number | null}

- "sport": the sport being bet on (e.g. "Football", "Tennis").
- "event": the match or event (e.g. "Real Madrid vs Barcelona").
- "selection": the specific outcome the player is betting on (e.g. "Real Madrid Win").
- "stake": the amount the player wants to bet, as a number.
- "odds": the odds the player mentioned, as a number. If the player did not mention odds, set this to null — it will be verified separately.

2. The message does not look like a bet request:
{"valid": false}`;

interface OllamaChatResponse {
  message?: {
    content?: string;
  };
}

// Ollama's OWN raw JSON shape — deliberately NOT betFieldsSchema.
// OLLAMA_SYSTEM_PROMPT (above) never asks the local model for league/
// market/period/line, and Ollama's freeform JSON output has no structural
// enforcement mechanism (unlike Anthropic's strict tool-use), so those four
// keys can never be trusted to be present here. This is the ONE
// compatibility boundary in this file where an omitted key is expected and
// legitimate, never a malformed payload.
const ollamaBetFieldsSchema = z.object({
  sport: z.string().min(1),
  event: z.string().min(1),
  selection: z.string().min(1),
  stake: z.number().positive(),
  odds: z.number().finite().positive().max(MAX_DECIMAL_ODDS, "Decimal odds exceed the supported maximum").nullable(),
});

const ollamaValidBetSchema = ollamaBetFieldsSchema.extend({ valid: z.literal(true) });

const ollamaModelResponseSchema = z.union([ollamaValidBetSchema, invalidBetSchema]);

async function parseWithOllama(text: string): Promise<ParseBetResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OLLAMA_TIMEOUT_MS);

  let rawContent: string;

  try {
    const response = await fetch(`${OLLAMA_HOST}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        stream: false,
        format: "json",
        messages: [
          { role: "system", content: OLLAMA_SYSTEM_PROMPT },
          { role: "user", content: text },
        ],
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      return {
        valid: false,
        error: `Ollama request failed with status ${response.status}`,
      };
    }

    const data = (await response.json()) as OllamaChatResponse;
    rawContent = data.message?.content ?? "";
  } catch (err) {
    const message =
      err instanceof Error && err.name === "AbortError"
        ? `Ollama request timed out after ${OLLAMA_TIMEOUT_MS}ms`
        : err instanceof Error
          ? err.message
          : "Unknown error calling Ollama";

    return { valid: false, error: message };
  } finally {
    clearTimeout(timeout);
  }

  let parsedJson: unknown;

  try {
    parsedJson = JSON.parse(rawContent);
  } catch {
    return { valid: false, error: "Ollama returned invalid JSON" };
  }

  const result = ollamaModelResponseSchema.safeParse(parsedJson);

  if (!result.success) {
    return { valid: false, error: result.error.message };
  }

  if (!result.data.valid) {
    return { valid: false, error: "Message does not appear to be a bet request" };
  }

  // Compatibility enrichment: Ollama's own schema has no slot for the four
  // new fields, so they're added here as null before being validated
  // against the exact same strict contract every other ParsedBet producer
  // must satisfy (validBetSchema) — this re-validation is a deliberate
  // integrity check, not just a type cast, so an enrichment bug here would
  // still be caught rather than silently producing a malformed ParsedBet.
  const enriched = { ...result.data, league: null, market: null, period: null, line: null };
  const strictResult = validBetSchema.safeParse(enriched);

  if (!strictResult.success) {
    return { valid: false, error: strictResult.error.message };
  }

  return strictResult.data;
}

/* -------------------------------------------------------------------------- */
/* Claude                                                                      */
/* -------------------------------------------------------------------------- */

const CLAUDE_SYSTEM_PROMPT = `You extract structured sports betting data from a WhatsApp message sent by a player to their bookmaker.

Call "extract_bet" if the message is a bet request. Players are never required to state odds — the odds provider always supplies and verifies the real price. If the player did not mention odds, pass odds as null; a missing odds value is never a reason to reject the message.

Call "reject_bet" if the message does not look like a bet request.`;

export const extractBetTool: Anthropic.Beta.BetaTool = {
  name: "extract_bet",
  description: "Record the structured details of a sports bet extracted from the player's message.",
  strict: true,
  input_schema: {
    type: "object",
    properties: {
      sport: { type: "string", description: "The sport being bet on, e.g. Football, Tennis." },
      league: {
        type: ["string", "null"],
        description: "The league or competition, e.g. Premier League, La Liga — only when explicitly stated. Null if not mentioned.",
      },
      event: { type: "string", description: "The match or event, e.g. Real Madrid vs Barcelona." },
      market: {
        type: ["string", "null"],
        description:
          "The market or bet type, e.g. Match Winner, Total Goals, Both Teams to Score — only when explicitly stated or unambiguous from context. Null if not identifiable.",
      },
      selection: { type: "string", description: "The outcome the player is betting on, e.g. Real Madrid Win." },
      period: {
        type: ["string", "null"],
        description: "The period the bet applies to, e.g. First Half, Full Game — only when explicitly stated. Null if not mentioned.",
      },
      line: {
        type: ["string", "null"],
        description: "The exact numeric line as written, e.g. 2.5, -0.5, +4.5 — only when explicitly stated. Null if not applicable.",
      },
      stake: { type: "number", description: "The amount the player wants to bet." },
      odds: {
        type: ["number", "null"],
        description: "The odds the player mentioned, or null if not mentioned.",
      },
    },
    required: ["sport", "league", "event", "market", "selection", "period", "line", "stake", "odds"],
    additionalProperties: false,
  },
};

export const rejectBetTool: Anthropic.Beta.BetaTool = {
  name: "reject_bet",
  description: "Call this when the message does not look like a sports betting request.",
  strict: true,
  input_schema: {
    type: "object",
    properties: {
      reason: { type: "string", description: "Why the message isn't a bet request." },
    },
    required: ["reason"],
    additionalProperties: false,
  },
};

let anthropicClient: Anthropic | null = null;

function getAnthropicClient(): Anthropic {
  if (!anthropicClient) {
    // maxRetries: 0 — matches lib/ocr/claudeOcrProvider.ts's existing
    // client. Without this, the SDK's default (2 retries, each getting its
    // own fresh `timeout` budget plus backoff) makes any `timeout` value
    // meaningless: a transient 5xx could cost up to ~3x the configured
    // timeout in real wall-clock time. Timeout behavior must be
    // deterministic, so retries are handled by the caller (or not at all),
    // never silently by the SDK underneath a timeout value that's
    // supposed to be a hard ceiling.
    anthropicClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 0 });
  }
  return anthropicClient;
}

async function parseWithClaude(text: string): Promise<ParseBetResult> {
  const client = getAnthropicClient();

  let response: Anthropic.Beta.BetaMessage;

  try {
    response = await client.beta.messages.create(
      {
        model: CLAUDE_MODEL,
        max_tokens: 1024,
        system: CLAUDE_SYSTEM_PROMPT,
        tools: [extractBetTool, rejectBetTool],
        tool_choice: { type: "any" },
        messages: [{ role: "user", content: text }],
      },
      { timeout: CLAUDE_TIMEOUT_MS },
    );
  } catch (err) {
    const message =
      err instanceof Anthropic.APIError
        ? err.message
        : err instanceof Error
          ? err.message
          : "Unknown error calling Claude";

    return { valid: false, error: message };
  }

  const toolUse = response.content.find(
    (block): block is Anthropic.Beta.BetaToolUseBlock => block.type === "tool_use",
  );

  if (!toolUse) {
    return { valid: false, error: "Claude did not return a tool call" };
  }

  if (toolUse.name === "reject_bet") {
    return { valid: false, error: "Message does not appear to be a bet request" };
  }

  const result = betFieldsSchema.safeParse(toolUse.input);

  if (!result.success) {
    return { valid: false, error: result.error.message };
  }

  return { valid: true, ...result.data };
}

/* -------------------------------------------------------------------------- */
/* Public entry point                                                          */
/* -------------------------------------------------------------------------- */

export async function parseBetMessage(
  text: string,
  _playerId: string,
): Promise<ParseBetResult> {
  const provider = process.env.AI_PROVIDER ?? "ollama";

  if (provider === "claude") {
    return parseWithClaude(text);
  }

  return parseWithOllama(text);
}

// Shared by the text EXPRESS path (extract_express_bet, below) — no
// image-specific parsing remains in this file as of Stage 14.3 (see
// betParserPrompt.ts / recognizeScreenshot.ts for how a screenshot's text
// now reaches this same module instead).
// Same strict "required key, nullable value" contract as betFieldsSchema
// above — this validates a real extract_express_bet leg (tool_use.input),
// never a legacy/Ollama-shaped payload, so an omitted key must fail here
// too.
const parlaySelectionFieldsSchema = z.object({
  sport: z.string().trim().min(1),
  league: z.string().trim().min(1).nullable(),
  event: z.string().trim().min(1),
  market: z.string().trim().min(1).nullable(),
  selection: z.string().trim().min(1),
  period: z.string().trim().min(1).nullable(),
  line: z.string().trim().min(1).nullable(),
  odds: z.number().finite().positive().max(MAX_DECIMAL_ODDS, "Decimal odds exceed the supported maximum").nullable(),
});

const parlayBetFieldsSchema = z.object({
  stake: z.number().positive().finite(),
  selections: z.array(parlaySelectionFieldsSchema).min(2),
});

/* -------------------------------------------------------------------------- */
/* Text SINGLE/EXPRESS parsing — Stage 12, Phase 3. Stage 14.3 extended this  */
/* single entry point to also serve OCR-transcribed screenshot text, rather  */
/* than adding a second parser.                                              */
/* -------------------------------------------------------------------------- */
//
// Purely additive: parseBetMessage()/parseWithClaude()/parseWithOllama()
// above are byte-for-byte unchanged, so every existing caller keeps working
// exactly as before. This is a new, separate entry point.
//
// EXPRESS detection is Claude-only — Ollama's default model has no tool-use
// reliability proven for a 3-way (single/express/reject) branch, so on
// Ollama this normalizes the existing SINGLE-only parseBetMessage() result
// instead of attempting to detect EXPRESS (or OCR-specific parsing) at all.
// Production runs AI_PROVIDER=claude, so this only affects local
// Ollama-provider dev.

export type ParseBetSlipResult =
  | ({ valid: true } & ParsedBetSlip)
  // Stage BA-2B, Step 4 — "numeric_mismatch" added alongside the existing
  // "timeout" code. Stage BA-2D, Step 5 — "market_mismatch" added the same
  // way. Purely additive: every existing caller only ever checks
  // `code === "timeout"` (app/api/miniapp/bets/text/preview/route.ts,
  // app/api/miniapp/bets/screenshot/preview/route.ts) and folds every other
  // value, old or new, into the exact same generic PARSE_FAILED/
  // IMAGE_NOT_RECOGNIZED response — so this change requires, and receives,
  // zero route changes.
  | { valid: false; error: string; code?: "timeout" | "numeric_mismatch" | "market_mismatch" };

// Stage 14.3 — one parser, two prompts (lib/ai/betParserPrompt.ts), never
// two parsers. CHAT is a player's own free-form message (unchanged
// behavior/callers from Stage 12); OCR is text transcribed from a bet-slip
// screenshot by lib/ocr/recognizeScreenshot.ts. Both modes call the exact
// same three tools below (extract_bet / extract_express_bet / reject_bet) —
// only the system prompt differs, so both modes produce byte-identical
// output shapes and nothing downstream (buildBetSlipPreview, previewToken,
// confirm, Prisma) needs to know or care which mode produced a given
// ParsedBetSlip.
export type BetSlipParseMode = "CHAT" | "OCR";

// Stage 14.4A — OCR mode gets its own, larger timeout. ocrPrompt is ~5x
// chatPrompt by size and OCR-mode input (transcribed screen text) is
// typically both longer and noisier than a short chat message, so the
// original single 8000ms budget (still used for CHAT below) was sized for
// a case OCR-mode never actually is.
//
// 15000ms is an INITIAL OPERATIONAL VALUE, not a permanent architectural
// constant. It's reasoned from confirmed prompt-size ratios and known
// Claude tool-use latency characteristics (output-token-generation-bound,
// not input-size-bound), not from real production measurements — this
// codebase had no per-stage timing before this same stage added it (see
// the screenshot preview route's new timing instrumentation). Once enough
// production durationMs samples exist to compute real p50/p95/p99 for the
// OCR-mode parser call, this value must be re-evaluated against that data
// rather than left as a one-time guess.
const CLAUDE_OCR_PARSER_TIMEOUT_MS = 15000;

// Deliberately the same shape as extract_bet's — reuses betFieldsSchema.
export const extractExpressBetTool: Anthropic.Beta.BetaTool = {
  name: "extract_express_bet",
  description: "Record a multi-selection (accumulator/express) bet described in the player's message.",
  strict: true,
  input_schema: {
    type: "object",
    properties: {
      stake: { type: "number", description: "The total stake amount for the express." },
      selections: {
        type: "array",
        description: "Every leg of the express, in the order mentioned.",
        items: {
          type: "object",
          properties: {
            sport: { type: "string" },
            league: {
              type: ["string", "null"],
              description: "The league or competition, e.g. Premier League, La Liga — only when explicitly stated. Null if not mentioned.",
            },
            event: { type: "string" },
            market: {
              type: ["string", "null"],
              description: "The market or bet type — only when explicitly stated or unambiguous from context. Null if not identifiable.",
            },
            selection: { type: "string" },
            period: {
              type: ["string", "null"],
              description: "The period the bet applies to — only when explicitly stated. Null if not mentioned.",
            },
            line: {
              type: ["string", "null"],
              description: "The exact numeric line as written, e.g. 2.5, -0.5, +4.5 — only when explicitly stated. Null if not applicable.",
            },
            odds: { type: ["number", "null"] },
          },
          required: ["sport", "league", "event", "market", "selection", "period", "line", "odds"],
          additionalProperties: false,
        },
        // No minItems here — Anthropic's strict tool schema only supports
        // minItems 0 or 1 (a value >1 makes the entire messages.create()
        // call fail with a 400 before any tool is even selected, confirmed
        // against production logs — see the regression test in
        // betParser.test.ts). The real "at least 2" rule lives at the
        // application layer instead: parlayBetFieldsSchema's `.min(2)`
        // below, and one layer further downstream,
        // lib/bets/betSlipRules.ts's validateBetSlipType().
      },
    },
    required: ["stake", "selections"],
    additionalProperties: false,
  },
};

// Stage BA-2B, Step 4 — the one place a computed numeric-role verdict
// becomes a parser-level safety decision. Deliberately NOT inside
// lib/ai/numericRoleVerifier.ts (which stays pure evidence/verdict logic,
// no policy) and NOT inside lib/ai/betDraftMapper.ts (whose
// mapRawBetSlipToParsedBetSlip contract is "map raw AI output to
// ParsedBetSlip," not "decide whether this parse is trustworthy" — its
// Step 3 observation hook exists exactly so this decision can live here
// instead). CORROBORATED and UNVERIFIED both continue normally —
// UNVERIFIED means "no strong evidence either way," not "wrong," so the
// AI's own claim is trusted exactly as it always has been (this is what
// keeps a short, common message like "Арсенал победа 10" working, per
// this stage's own player-convenience requirement). CONTRADICTED and
// AMBIGUOUS both fail closed: real text evidence disagrees with (or
// cannot be reconciled for) this specific claimed value, so the parse is
// rejected — the claimed value itself is NEVER read again or altered
// anywhere in this function; only whether to proceed at all is decided.
//
// No EXPRESS per-leg enforcement is possible here even in principle:
// computeNumericRoleObservations (betDraftMapper.ts) only ever produces a
// LINE/ODDS observation for a SINGLE slip's one selection — EXPRESS legs
// never produce one at all (leg attribution is out of scope, unchanged
// from Step 3) — so this loop enforces exactly STAKE (both bet types) and,
// for SINGLE only, LINE/ODDS, with no bet-type branching needed here.
function isUnreliableNumericClaim(observation: NumericRoleObservation): boolean {
  return observation.verification.verdict === "CONTRADICTED" || observation.verification.verdict === "AMBIGUOUS";
}

// Stage BA-2D, Step 5 — the market/selection sibling of
// isUnreliableNumericClaim immediately above, same CORROBORATED/UNVERIFIED-
// continue, CONTRADICTED/AMBIGUOUS-reject policy, same reasoning: UNVERIFIED
// means "no strong market-shape evidence either way" (a short natural
// message like "Арсенал 10" or "ставка 10 на Арсенал"), never "wrong" — this
// is what keeps player convenience intact, exactly like BA-2B's own
// UNVERIFIED handling. CONTRADICTED/AMBIGUOUS both fail closed: real text
// evidence disagrees with (or cannot be reconciled for) the AI's own
// derived market/selection claim, so the parse is rejected — the claim
// itself (and the ParsedBetSlip it would have produced) is NEVER read
// again or altered anywhere in this function; only whether to proceed at
// all is decided. This is a completely independent guard from
// isUnreliableNumericClaim — deliberately not merged into one verifier or
// one check, so a CORROBORATED market claim can never mask a CONTRADICTED
// numeric one, or vice versa (see this function's own two separate
// `.find()` calls below).
//
// SINGLE only, same as BA-2D Step 4's own observation computation
// (computeMarketIntentObservations in betDraftMapper.ts already returns no
// observations at all for EXPRESS — no leg attribution exists yet — so
// this check is naturally a no-op for EXPRESS without any bet-type
// branching needed here).
function isUnreliableMarketClaim(observation: MarketIntentObservation): boolean {
  return observation.verification.verdict === "CONTRADICTED" || observation.verification.verdict === "AMBIGUOUS";
}

// SCREENSHOT QA-1.2 through QA-1.5 — a real, proven production case: a
// bookmaker screenshot's OCR text contains explicit 1X2 shorthand ("П1"/
// "П2"/"Home win"/"Away win", classified by lib/ai/marketIntentEvidence.ts
// as MONEYLINE_3WAY/HOME or MONEYLINE_3WAY/AWAY), but Claude's own
// extraction normalizes the selection to the team's real name — a
// legitimate, even desirable translation that the claim-side classifier
// (lib/odds/shorthandClassifier.ts) can only ever read back as generic
// MONEYLINE_2WAY/PARTICIPANT (see that file's own comments: a bare
// participant name carries no market-shape information of its own). This
// function recognizes ONLY that one exact, narrow signature — never a
// general "let a contradiction through" escape hatch:
//
//   claim  = { MONEYLINE_2WAY, PARTICIPANT }
//   verdict = CONTRADICTED (never AMBIGUOUS — a source with two DISTINCT
//             high-confidence market signatures is genuinely ambiguous and
//             must still fail closed here, exactly as before)
//   every conflicting evidence entry shares one signature:
//             { MONEYLINE_3WAY, HOME } or { MONEYLINE_3WAY, AWAY }
//
// Every other CONTRADICTED/AMBIGUOUS combination (DRAW mismatches, SPREAD/
// TOTALS/TEAM_TOTAL contradictions, an unrelated MONEYLINE disagreement,
// AMBIGUOUS source text) returns null here and is rejected immediately by
// the caller, completely unchanged from before this stage.
//
// This function does NOT decide whether the claim is actually correct — it
// cannot: it has no provider/event access, only the original text and
// Claude's own claim. It only decides whether the question is WORTH
// deferring to a later stage that does have real data — see
// buildBetSlipPreview.ts's reconcile1X2ParticipantClaim, the only place
// that ever turns this into an accept/reject decision.
// MASTER STAGE M3.1, Phase B — widened to also accept AMBIGUOUS (previously
// CONTRADICTED only). The original CONTRADICTED-only restriction predates
// MASTER STAGE M3 Phase 2's shared UI-noise normalization: at the time it
// was written, an AMBIGUOUS verdict was disproportionately likely to be a
// quick-add-control/icon artifact rather than genuine dual intent (the exact
// bug class M1.1/M1.3/M3-Phase-2 fixed). Now that marketIntentEvidence.ts no
// longer produces evidence from UI-control rows at all, AMBIGUOUS is a more
// trustworthy signal — but this function still does NOT weaken what counts
// as "safe to defer": every conflicting entry must share the exact same
// MONEYLINE_3WAY/one-consistent-side signature (checked explicitly below,
// not merely assumed from the first entry as the old CONTRADICTED-only
// guarantee allowed) — a source that genuinely disagrees about WHICH side
// (MONEYLINE_3WAY/HOME vs MONEYLINE_3WAY/AWAY both present), or that mixes
// in a genuinely different market shape (TOTALS/SPREAD), still returns null
// here and is rejected immediately, exactly as before this stage.
function classifyReconcilable1X2Mismatch(
  observation: MarketIntentObservation,
  claimedSelectionText: string | undefined,
): PendingMarketReconciliation | null {
  const verdict = observation.verification.verdict;
  if (verdict !== "CONTRADICTED" && verdict !== "AMBIGUOUS") return null;
  if (observation.claim.marketType !== "MONEYLINE_2WAY" || observation.claim.selectionType !== "PARTICIPANT") return null;

  const conflicting = observation.verification.conflictingEvidence;
  if (conflicting.length === 0) return null;

  const allMoneyline3Way = conflicting.every((entry) => entry.classification.marketType === "MONEYLINE_3WAY");
  if (!allMoneyline3Way) return null;

  const sides = new Set(conflicting.map((entry) => entry.classification.selectionType));
  if (sides.size !== 1) return null;
  const [evidenceSide] = sides;
  if (evidenceSide !== "HOME" && evidenceSide !== "AWAY") return null;

  const claimedParticipant = claimedSelectionText?.trim();
  if (!claimedParticipant) return null;

  // MASTER STAGE M3.2 — explicitly compute whether the conflicting evidence
  // named a participant of its own. Checks EVERY conflicting entry (not
  // just the first): if ANY entry named a participant, this is treated as a
  // real, named signal, never "safely unattributed" — conservative by
  // design, matching this function's own existing "every entry must agree"
  // discipline above. null only when NONE of them carried a name at all
  // (every entry is a bare shorthand token, e.g. "2"/"П2" with no team text)
  // — exactly the shape reconcile1X2ParticipantClaim's own new trust rule
  // (buildBetSlipPreview.ts) checks for.
  const namedConflictingParticipant = conflicting.find((entry) => entry.classification.participantName !== null)?.classification
    .participantName;
  const conflictingParticipantName = namedConflictingParticipant ?? null;

  return { requiredSide: evidenceSide, claimedParticipant, conflictingParticipantName };
}

// MASTER STAGE M3.1, Phase B — the generalized deferral for TOTALS/SPREAD
// claims. Unlike the 1X2 case above, these need NO pre-processing/relabeling
// step at all: SPREAD's own selectionType is "PARTICIPANT" already (a real,
// valid CanonicalSelection shape — verifySpreadOdds resolves the participant
// name against the provider's own team names via the exact same fuzzy
// matcher every other participant claim already relies on, confirmed by
// reading lib/odds/domain.ts's SelectionType/CanonicalSelection and
// lib/odds/theOddsApiProvider.ts's supportedMarketTypes), and TOTALS/OVER
// and TOTALS/UNDER are already the claim's own final shape. Deferring here
// means exactly one thing: do not hard-reject locally — let
// buildBetSlipPreview.ts's existing, UNCHANGED, already-exact-match odds
// verification be the real arbiter (the identical safety net that already
// protects every ordinary, non-deferred TOTALS/SPREAD claim today — this is
// not a weaker path, it is the SAME path, reached one gate earlier). Scoped
// to exactly the four claim shapes this stage's own brief names as
// supported — every other market/selection combination is untouched and
// still rejected immediately, exactly as before.
function isDeferrableLineMarketClaim(observation: MarketIntentObservation, rawSelection: RawBetSelectionFields | undefined): boolean {
  const verdict = observation.verification.verdict;
  if (verdict !== "CONTRADICTED" && verdict !== "AMBIGUOUS") return false;

  const { marketType, selectionType } = observation.claim;
  const isSupportedShape =
    (marketType === "TOTALS" && (selectionType === "OVER" || selectionType === "UNDER")) ||
    (marketType === "SPREAD" && selectionType === "PARTICIPANT");
  if (!isSupportedShape) return false;

  // Structurally complete: a claim with no line, or (for SPREAD) no
  // participant text, is not a "one concrete canonical claim" — it is
  // incomplete, and incompleteness is never something provider verification
  // can resolve on its own. Still rejected immediately, unchanged.
  const claimedLine = rawSelection?.line?.trim();
  if (!claimedLine) return false;
  if (marketType === "SPREAD" && !rawSelection?.selection?.trim()) return false;

  // Only CROSS-market-type ambiguity is safe to defer — proven real by a
  // production incident (M1.2/M3 Phase 1/2: a quick-add control row
  // misclassified as an unrelated SPREAD signature next to a genuine TOTALS
  // claim). A SAME-market-type conflict (TOTALS/OVER claimed but
  // TOTALS/UNDER also strongly present in the text, or a different SPREAD
  // line/side) is a genuine, meaningful semantic disagreement about THIS
  // bet — the AI may simply have gotten the direction backwards — and must
  // still be rejected immediately, never silently trusted to the provider.
  // A real regression test (BA-2D Step 5 (6): "original says UNDER, AI
  // claims OVER") proved this exact gap when first built without this check.
  const conflicting = observation.verification.conflictingEvidence;
  const hasSameMarketTypeConflict = conflicting.some((entry) => entry.classification.marketType === marketType);
  if (hasSameMarketTypeConflict) return false;

  return true;
}

// CORE BETTING PIPELINE STABILIZATION (Stage S2), Phase 3 — evaluated and
// deliberately NOT implemented. The obvious version (defer a numeric-role
// LINE ambiguity whenever the corresponding market-intent claim is an
// otherwise-safe TOTALS/SPREAD shape with no CROSS-market-type conflict —
// mirroring isDeferrableLineMarketClaim above) turned out to be unsafe: it
// is blind to a genuine, same-market-type NUMERIC contradiction. Concrete
// counter-example, proven by a real existing regression test (BA-2B Step 4
// (6)): claim TOTALS/OVER, line "10"; text "Арсенал ТБ 2.5" — the
// market-intent SIGNATURE matches perfectly (TOTALS/OVER both sides, zero
// market-intent conflicting evidence), so that proposed rule would defer
// this claim to the provider — silently accepting a claimed line (10) the
// message plainly contradicts (2.5), which is exactly the class of
// hallucinated-value bug this codebase's numeric-role safety net exists to
// catch. A safe version would need its own, independently-proven
// side-attribution check on the NUMERIC conflict itself — Phase 1's
// evidence-vs-evidence attribution comparison already provides exactly
// that, directly inside verifyNumericRoleClaim (see
// numericRoleVerifier.ts's hasGenuineHighConfidenceConflict), which is why
// both production regressions (SPREAD Ф1/Ф2, TOTALS bare-word-vs-odds) are
// already fully resolved by Phase 1/2 without touching this file's
// deferral order at all. Numeric safety is therefore still checked before,
// and independently of, market-intent safety — unchanged from before this
// stage.

// Wraps mapRawBetSlipToParsedBetSlip() so a programmer-error throw (the
// mapper/adapter only ever throws for a non-finite stake/odds or a sport
// with no raw text at all — both impossible given betFieldsSchema/
// parlayBetFieldsSchema already validated the input) degrades to the
// established invalid-parser-result shape rather than propagating an
// exception into the route layer. Never logs or returns the caught error's
// own message, since a LegacyAdapterError's message can embed the raw
// malformed value.
function buildParsedBetSlipResult(
  raw: { type: "SINGLE" | "EXPRESS"; stake: number; selections: readonly RawBetSelectionFields[] },
  text: string,
  mode: BetSlipParseMode,
): ParseBetSlipResult {
  try {
    let numericRoleObservations: readonly NumericRoleObservation[] = [];
    let marketIntentObservations: readonly MarketIntentObservation[] = [];

    const parsedSlip = mapRawBetSlipToParsedBetSlip(raw, {
      originalText: text,
      sourceType: mode,
      onNumericRoleObservation: (observations) => {
        numericRoleObservations = observations;
      },
      onMarketIntentObservation: (observations) => {
        marketIntentObservations = observations;
      },
    });

    // Order: numeric safety (BA-2B) is checked before market-intent safety
    // (BA-2D) — an arbitrary but deterministic choice (both are independent
    // fail-closed gates; either one alone is sufficient to reject, and
    // whichever is checked "second" would never even run once the first
    // already rejected, so the ORDER itself has no effect on final
    // behavior, only on which `code`/`error` a doubly-invalid message
    // happens to surface — a detail no caller currently branches on).
    const unreliableClaim = numericRoleObservations.find(isUnreliableNumericClaim);
    if (unreliableClaim) {
      // SCREENSHOT QA-4 — OCR-mode only (mirrors the S1 claim-normalizer's
      // own mode gate immediately below in this same function): logs
      // exactly which evidence produced this rejection, so a future
      // reproduction never again has to guess at competing values from a
      // bare role/verdict string alone. See screenshotQa1Diagnostic.ts's own
      // Qa1NumericEvidenceDiagnostic header for the full safety rationale.
      if (mode === "OCR") {
        const toDiagnosticEntry = (entry: NumericRoleEvidence): Qa1NumericEvidenceEntry => ({
          value: entry.value,
          confidence: entry.confidence,
          marker: entry.marker,
        });
        logScreenshotQa1Diagnostic({
          stage: "numeric_evidence",
          role: unreliableClaim.role,
          verdict: unreliableClaim.verification.verdict,
          claimedValue: unreliableClaim.claimedValue,
          supportingEvidence: unreliableClaim.verification.supportingEvidence.map(toDiagnosticEntry),
          conflictingEvidence: unreliableClaim.verification.conflictingEvidence.map(toDiagnosticEntry),
        });
      }

      // Internal diagnostic only — never sent to the client. Both preview
      // routes already log `parsed.error` server-side and respond with
      // their own generic PARSE_FAILED/IMAGE_NOT_RECOGNIZED body
      // regardless of its content, exactly like every other non-timeout
      // invalid-result reason already does.
      return {
        valid: false,
        error: `Numeric claim not corroborated by message text (role=${unreliableClaim.role}, verdict=${unreliableClaim.verification.verdict})`,
        code: "numeric_mismatch",
      };
    }

    const unreliableMarketClaim = marketIntentObservations.find(isUnreliableMarketClaim);
    if (unreliableMarketClaim) {
      // SCREENSHOT QA-1.6 — before rejecting, check whether this is
      // specifically the one narrow, proven-real 1X2-shorthand-vs-
      // normalized-participant-name case (see classifyReconcilable1X2Mismatch's
      // own header). Only that exact signature ever defers instead of
      // rejecting here — every other contradiction/ambiguity falls straight
      // through to the unchanged rejection below.
      // SCREENSHOT QA-CORE S1 — OCR-mode only: a screenshot's own `selection`
      // text (e.g. "Bayern Win (П1)") is cleaned into something closer to a
      // bare participant name before it becomes claimedParticipant, fixing
      // the proven NO_MATCH-via-diluted-word-overlap failure (see
      // lib/ai/ocrParticipantClaimNormalizer.ts's own header). CHAT mode's
      // claim text is passed through completely unchanged — this can never
      // alter typed-chat behavior, not even for an identical claim string.
      const claimedSelectionText =
        mode === "OCR" ? normalizeOcrParticipantClaim(raw.selections[0]?.selection ?? "") : raw.selections[0]?.selection;

      const pendingMarketReconciliation = classifyReconcilable1X2Mismatch(unreliableMarketClaim, claimedSelectionText);
      // MASTER STAGE M3.1, Phase B — the generalized TOTALS/SPREAD deferral.
      // Checked independently of pendingMarketReconciliation above (mutually
      // exclusive by construction: isDeferrableLineMarketClaim's own market/
      // selectionType check can never overlap classifyReconcilable1X2Mismatch's
      // MONEYLINE_2WAY/PARTICIPANT requirement). No shape conversion is
      // needed here — see isDeferrableLineMarketClaim's own header for why
      // the claim already IS its final, correct canonical form.
      const isDeferredLineMarket = !pendingMarketReconciliation && isDeferrableLineMarketClaim(unreliableMarketClaim, raw.selections[0]);
      const deferred = pendingMarketReconciliation !== null || isDeferredLineMarket;

      // MASTER STAGE M3, Phase 1 (extended by M3.1, Phase B) — OCR-mode only
      // (mirrors the numeric_evidence diagnostic immediately above and the S1
      // claim-normalizer's own mode gate): logs exactly which (marketType,
      // selectionType) signatures competed AND whether this claim was
      // deferred instead of rejected, so a future reproduction never again
      // has to guess at this from a bare marketType/selectionType/verdict
      // string alone — the exact diagnostic gap the M2.1 audit identified.
      // Fires for BOTH outcomes (deferred and rejected) — unlike the
      // numeric_evidence diagnostic above, this is no longer only-on-
      // rejection, since "deferred, not rejected" is itself the interesting
      // fact production QA needs to see now that this stage exists.
      if (mode === "OCR") {
        const toDiagnosticEntry = (entry: MarketIntentEvidence): Qa1MarketIntentEvidenceEntry => ({
          marketType: entry.classification.marketType,
          selectionType: entry.classification.selectionType,
          participantName: entry.classification.participantName,
          embeddedLine: entry.classification.embeddedLine,
          matchedText: entry.matchedText,
          confidence: entry.confidence,
        });
        logScreenshotQa1Diagnostic({
          stage: "market_intent_evidence",
          claimedMarketType: unreliableMarketClaim.claim.marketType,
          claimedSelectionType: unreliableMarketClaim.claim.selectionType,
          verdict: unreliableMarketClaim.verification.verdict,
          supportingEvidence: unreliableMarketClaim.verification.supportingEvidence.map(toDiagnosticEntry),
          conflictingEvidence: unreliableMarketClaim.verification.conflictingEvidence.map(toDiagnosticEntry),
          deferred,
        });
      }

      if (pendingMarketReconciliation) {
        const [firstSelection, ...restSelections] = parsedSlip.selections;
        return {
          valid: true,
          ...parsedSlip,
          selections: [{ ...firstSelection, pendingMarketReconciliation }, ...restSelections],
        };
      }

      if (isDeferredLineMarket) {
        return { valid: true, ...parsedSlip };
      }

      // Same internal-diagnostic-only discipline as numeric_mismatch above
      // — never sent to the client, never exposes CONTRADICTED/AMBIGUOUS/
      // MarketIntentVerdict or the claimed marketType/selectionType to the
      // player, folded into the same generic PARSE_FAILED response.
      return {
        valid: false,
        error: `Market claim not corroborated by message text (marketType=${unreliableMarketClaim.claim.marketType}, selectionType=${unreliableMarketClaim.claim.selectionType}, verdict=${unreliableMarketClaim.verification.verdict})`,
        code: "market_mismatch",
      };
    }

    return { valid: true, ...parsedSlip };
  } catch (err) {
    console.error("parseTextSlipWithClaude: failed to build bet draft", err instanceof Error ? err.name : "unknown error");
    return { valid: false, error: "Failed to process the extracted bet details" };
  }
}

async function parseTextSlipWithClaude(
  text: string,
  mode: BetSlipParseMode,
  // Test-only override — production always uses CLAUDE_TIMEOUT_MS (CHAT)
  // or CLAUDE_OCR_PARSER_TIMEOUT_MS (OCR). Lets tests verify mode-based
  // timeout selection deterministically (tiny values) instead of waiting
  // out real timeouts — same convention as
  // lib/ocr/claudeOcrProvider.ts's CreateClaudeOcrProviderOptions.timeoutMs.
  timeoutMsOverride?: number,
): Promise<ParseBetSlipResult> {
  const client = getAnthropicClient();
  const timeoutMs = timeoutMsOverride ?? (mode === "OCR" ? CLAUDE_OCR_PARSER_TIMEOUT_MS : CLAUDE_TIMEOUT_MS);

  let response: Anthropic.Beta.BetaMessage;

  try {
    response = await client.beta.messages.create(
      {
        model: CLAUDE_MODEL,
        max_tokens: 1024,
        // Stage AI-1 — this is structured field extraction (event/market/
        // selection/line/odds/stake via a strict tool schema), not creative
        // generation, so a low temperature reduces run-to-run variance on
        // ambiguous input without a documented quality cost (Anthropic's
        // own SDK docs recommend closer to 0.0 for "analytical" tasks).
        // Applied identically to CHAT and OCR modes — both share this exact
        // call site and schema, only the system prompt below differs.
        temperature: 0.1,
        // Only the system prompt varies by mode — both share the exact
        // same `tools` array immediately below, which is what guarantees
        // CHAT and OCR always produce the identical JSON schema.
        system: mode === "OCR" ? ocrPrompt : chatPrompt,
        tools: [extractBetTool, extractExpressBetTool, rejectBetTool],
        tool_choice: { type: "any" },
        messages: [{ role: "user", content: text }],
      },
      { timeout: timeoutMs },
    );
  } catch (err) {
    // A timeout is reported with a discriminated `code` (rather than left
    // to blend into the same opaque `error` string every other failure
    // uses) so a caller like the screenshot preview route can correctly
    // map it to a "took too long, try again" response instead of folding
    // it into "we couldn't recognize a bet slip" — the old image-specific
    // parseImageWithClaude() made this same distinction before Stage 14.3
    // routed screenshots through this shared function instead.
    if (err instanceof Anthropic.APIConnectionTimeoutError) {
      return { valid: false, error: err.message, code: "timeout" };
    }

    const message =
      err instanceof Anthropic.APIError
        ? err.message
        : err instanceof Error
          ? err.message
          : "Unknown error calling Claude";

    return { valid: false, error: message };
  }

  const toolUse = response.content.find(
    (block): block is Anthropic.Beta.BetaToolUseBlock => block.type === "tool_use",
  );

  if (!toolUse) {
    return { valid: false, error: "Claude did not return a tool call" };
  }

  if (toolUse.name === "reject_bet") {
    return { valid: false, error: "Message does not appear to be a bet request" };
  }

  if (toolUse.name === "extract_bet") {
    const result = betFieldsSchema.safeParse(toolUse.input);
    if (!result.success) {
      return { valid: false, error: result.error.message };
    }
    const rawSelection: RawBetSelectionFields = {
      sport: result.data.sport,
      league: result.data.league,
      event: result.data.event,
      market: result.data.market,
      selection: result.data.selection,
      period: result.data.period,
      line: result.data.line,
      odds: result.data.odds,
    };
    return buildParsedBetSlipResult({ type: "SINGLE", stake: result.data.stake, selections: [rawSelection] }, text, mode);
  }

  if (toolUse.name === "extract_express_bet") {
    const result = parlayBetFieldsSchema.safeParse(toolUse.input);
    if (!result.success) {
      return { valid: false, error: result.error.message };
    }
    const rawSelections: RawBetSelectionFields[] = result.data.selections.map((selection) => ({
      sport: selection.sport,
      league: selection.league,
      event: selection.event,
      market: selection.market,
      selection: selection.selection,
      period: selection.period,
      line: selection.line,
      odds: selection.odds,
    }));
    return buildParsedBetSlipResult({ type: "EXPRESS", stake: result.data.stake, selections: rawSelections }, text, mode);
  }

  return { valid: false, error: `Unexpected tool call: ${toolUse.name}` };
}

// mode defaults to "CHAT" — every existing caller (the text-bet preview
// route) keeps calling this with just a string, unchanged. timeoutMsOverride
// is test-only (see parseTextSlipWithClaude's own comment) and never passed
// by any production call site.
export async function parseBetSlipMessage(
  text: string,
  mode: BetSlipParseMode = "CHAT",
  timeoutMsOverride?: number,
): Promise<ParseBetSlipResult> {
  const provider = process.env.AI_PROVIDER ?? "ollama";

  if (provider !== "claude") {
    // No OCR-tuned prompt exists for the Ollama fallback — same
    // Claude-only limitation this file already documents for EXPRESS
    // detection above. Local dev without AI_PROVIDER=claude falls back to
    // the same chat-oriented legacy parser regardless of mode; production
    // always runs AI_PROVIDER=claude.
    const legacy = await parseBetMessage(text, "");
    if (!legacy.valid) {
      return { valid: false, error: legacy.error };
    }
    return { valid: true, ...normalizeParsedBet(legacy) };
  }

  return parseTextSlipWithClaude(text, mode, timeoutMsOverride);
}
