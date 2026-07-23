// Step 6 — OddsVerificationService: a provider-neutral application/
// orchestration layer that coordinates verification through an
// OddsProvider. See docs/ODDS_PROVIDER_DESIGN.md Section 10 ("verification
// orchestration service... depends only on OddsProvider, never on
// TheOddsApiProvider directly").
//
// This is NOT wired into buildBetSlipPreview.ts or any route in this step
// — buildBetSlipPreview.ts continues calling verifyOdds() directly, exactly
// as it does today. This file only proves the orchestration layer can
// exist and behave correctly on its own (docs/ODDS_PROVIDER_DESIGN.md
// Section 18 Phase D).
//
// Deliberately does not know about: Telegram, the AI parser, preview
// tokens, Prisma, Bet/BetSelection, EXPRESS combined-odds math, or route
// types — it only ever sees VerifySelectionRequest/VerificationResult, the
// same provider-neutral shapes lib/odds/oddsProvider.ts and
// lib/odds/verification.ts already define.

import { createFailedResult } from "./verification";
import type { VerificationResult } from "./verification";
import type { OddsProvider, VerifySelectionRequest } from "./oddsProvider";

const DEFAULT_CONCURRENCY = 4;

export type OddsVerificationServiceErrorCode = "INVALID_CONCURRENCY";

// Same narrow-purpose "Error subclass with an explicit code" convention
// already used throughout this codebase (BetSlipValidationError,
// PreviewTokenSignError, CreateBetFromPreviewValidationError,
// ProviderRegistryError).
export class OddsVerificationServiceError extends Error {
  readonly code: OddsVerificationServiceErrorCode;

  constructor(code: OddsVerificationServiceErrorCode, message: string) {
    super(message);
    this.name = "OddsVerificationServiceError";
    this.code = code;
  }
}

export interface OddsVerificationServiceOptions {
  readonly concurrency?: number;
}

export interface VerifyManyOptions {
  readonly concurrency?: number;
}

// Positive safe integer only — Number.isSafeInteger() rejects non-integers
// (2.5), NaN, Infinity, and anything beyond Number.MAX_SAFE_INTEGER in one
// check; `<= 0` separately rejects zero and negative values. Used
// identically for the constructor's service-level default and
// verifyMany()'s per-call override, so both fail fast the same way.
function validateConcurrency(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new OddsVerificationServiceError(
      "INVALID_CONCURRENCY",
      `concurrency must be a positive safe integer, got ${value}`,
    );
  }
  return value;
}

// Cursor-based worker pool: a shared `nextIndex` counter, `min(concurrency,
// items.length)` workers, each claims-awaits-stores until exhausted.
// Results land at their original index regardless of completion order, so
// input order is always preserved. `worker` here (verifyOne) is guaranteed
// to never reject — every provider exception is already caught internally
// — so this loop has no unhandled-rejection risk and needs no try/catch of
// its own.
async function runWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  if (items.length === 0) return results;

  let nextIndex = 0;
  const workerCount = Math.min(concurrency, items.length);

  async function runWorker(): Promise<void> {
    for (;;) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      if (currentIndex >= items.length) return;
      results[currentIndex] = await worker(items[currentIndex]);
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
  return results;
}

export class OddsVerificationService {
  private readonly provider: OddsProvider;
  private readonly concurrency: number;

  constructor(provider: OddsProvider, options: OddsVerificationServiceOptions = {}) {
    this.provider = provider;
    this.concurrency = validateConcurrency(options.concurrency ?? DEFAULT_CONCURRENCY);
  }

  // Calls provider.verifySelection() and returns its typed result
  // unchanged for every expected outcome (VERIFIED/ODDS_CHANGED/FAILED/
  // NOT_CHECKED — the provider contract already guarantees these are
  // returned as values, never thrown, per
  // docs/ODDS_PROVIDER_DESIGN.md Section 10). This method itself never
  // rejects: an unexpected thrown value from a misbehaving provider
  // implementation is caught here and converted into a provider-neutral
  // FAILED result instead of propagating.
  async verifyOne(request: VerifySelectionRequest): Promise<VerificationResult> {
    try {
      return await this.provider.verifySelection(request);
    } catch {
      // The caught value is intentionally never inspected, logged, or
      // embedded in the result — no exception message or stack trace may
      // ever reach a VerificationResult (this file's own security
      // requirement, mirroring lib/odds/theOddsApiProvider.ts's "no raw
      // provider payload" diagnosticCode discipline). diagnosticCode below
      // is a fixed, stable string, not derived from the exception.
      const submittedOdds = request.submittedOdds ?? request.selection.submittedOdds ?? null;
      return createFailedResult({
        submittedOdds,
        provider: this.provider.name,
        checkedAt: new Date().toISOString(),
        reasonCode: "PROVIDER_UNAVAILABLE",
        diagnosticCode: "ODDS_PROVIDER_UNEXPECTED_ERROR",
      });
    }
  }

  // Verifies every request, bounded by `concurrency` (service default,
  // overridable per call), preserving input order and never mutating the
  // input array or its elements. Uses verifyOne() for every request, so
  // exception mapping is centralized in exactly one place. No fail-fast:
  // one request's outcome (returned or exception-mapped) never affects any
  // sibling request.
  async verifyMany(
    requests: readonly VerifySelectionRequest[],
    options: VerifyManyOptions = {},
  ): Promise<readonly VerificationResult[]> {
    if (requests.length === 0) return [];

    const concurrency = validateConcurrency(options.concurrency ?? this.concurrency);
    return runWithConcurrency(requests, concurrency, (request) => this.verifyOne(request));
  }
}

/* -------------------------------------------------------------------------- */
/* Optional pure summary helper                                               */
/* -------------------------------------------------------------------------- */

export interface VerificationBatchSummary {
  readonly total: number;
  readonly verified: number;
  readonly oddsChanged: number;
  readonly failed: number;
  readonly notChecked: number;
  // A result is "blocking" whenever acceptedOdds is null — consistent with
  // docs/ODDS_PROVIDER_DESIGN.md Section 6: VERIFIED is the only status
  // that ever produces a non-null acceptedOdds at this layer (ODDS_CHANGED
  // stays null here since Step 6 does not implement explicit acceptance).
  // This is a pure count, not a confirmability decision — that policy
  // belongs to a later application layer, not this service.
  readonly blocking: number;
  readonly retryable: number;
}

export function summarizeVerificationResults(results: readonly VerificationResult[]): VerificationBatchSummary {
  let verified = 0;
  let oddsChanged = 0;
  let failed = 0;
  let notChecked = 0;
  let blocking = 0;
  let retryable = 0;

  for (const result of results) {
    switch (result.status) {
      case "VERIFIED":
        verified += 1;
        break;
      case "ODDS_CHANGED":
        oddsChanged += 1;
        break;
      case "FAILED":
        failed += 1;
        break;
      case "NOT_CHECKED":
        notChecked += 1;
        break;
    }
    if (result.acceptedOdds === null) blocking += 1;
    if (result.retryable) retryable += 1;
  }

  return { total: results.length, verified, oddsChanged, failed, notChecked, blocking, retryable };
}
