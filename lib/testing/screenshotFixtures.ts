// MASTER STAGE M4.0 — Phase 2: the fixture METADATA schema and a pure,
// in-memory manifest validator for a future real-screenshot regression
// corpus. Deliberately does NOT ship any real image bytes, a fixture
// directory, or a file-system loader — see this stage's own report (Phase
// 2) for why: real bookmaker screenshots are the one thing this stage
// cannot safely fabricate or commit without a private-storage decision the
// user has not yet made. This file only defines the SHAPE a fixture must
// have, and validates a manifest against it — the actual image corpus is a
// follow-up that populates this shape once a storage location is chosen.
//
// Bookmaker-agnostic by construction: `sourceCategory` is a free-form QA
// label (e.g. "generic-mobile-sportsbook"), never a production code path
// keyed on a bookmaker name — nothing in lib/ai/ or lib/odds/ reads this
// field, or any field in this file, at all. This module is test/QA
// infrastructure only; it is never imported by production request-handling
// code.
//
// Privacy discipline (this stage's own explicit requirement): a fixture's
// metadata must never carry a user name, account id, balance, Telegram
// metadata, device notification content, personal identifier, credential/
// token, or production database id. `privacy` below is a required,
// self-documenting field precisely so a reviewer can see at a glance which
// category a fixture claims to be, rather than having to infer it from the
// image itself.

import { z } from "zod";

/* -------------------------------------------------------------------------- */
/* Enums — closed vocabularies, matching this codebase's existing preference */
/* for enums over free-form strings wherever the domain is genuinely closed. */
/* -------------------------------------------------------------------------- */

export const FIXTURE_BET_TYPES = ["SINGLE", "EXPRESS"] as const;
export type FixtureBetType = (typeof FIXTURE_BET_TYPES)[number];

export const FIXTURE_MARKET_FAMILIES = ["MONEYLINE", "TOTALS", "SPREAD", "MIXED"] as const;
export type FixtureMarketFamily = (typeof FIXTURE_MARKET_FAMILIES)[number];

// Device CLASS, not device model — real screenshot pixel dimensions vary
// continuously across real devices; this only records the coarse shape
// category a fixture is meant to exercise (see the architecture audit's own
// Q6 finding on why "portrait mobile" as a class is exactly the shape that
// currently bypasses region detection).
export const FIXTURE_DEVICE_CLASSES = ["IPHONE_PORTRAIT", "ANDROID_PORTRAIT", "TIGHT_CROP", "DESKTOP_FULL", "OTHER"] as const;
export type FixtureDeviceClass = (typeof FIXTURE_DEVICE_CLASSES)[number];

// SYNTHETIC — no real screenshot content at all (a generated placeholder
// image, or a hand-typed OCR-text-only fixture with no accompanying image).
// REDACTED_REAL — derived from a real screenshot with all of the above
// privacy-sensitive content manually removed/blacked out before this
// manifest or any accompanying image is committed anywhere.
// REAL_PRIVATE_LOCAL_ONLY — a real, unredacted screenshot that must NEVER
// be committed to this repository; its manifest entry may exist (so the
// expectation/coverage design is reviewable), but `imagePath` for such an
// entry must point outside version control (see loadScreenshotFixtureManifest's
// own validation) — this classification exists specifically so a manifest
// can document the FULL intended corpus (including real, local-only images
// a developer keeps outside git) without ever making a real screenshot's
// bytes reachable through this repository.
export const FIXTURE_PRIVACY_CLASSIFICATIONS = ["SYNTHETIC", "REDACTED_REAL", "REAL_PRIVATE_LOCAL_ONLY"] as const;
export type FixturePrivacyClassification = (typeof FIXTURE_PRIVACY_CLASSIFICATIONS)[number];

/* -------------------------------------------------------------------------- */
/* Schema                                                                     */
/* -------------------------------------------------------------------------- */

// A manually-annotated normalized region — the same [0,1]-normalized shape
// lib/ocr/screenshotPreprocessing.ts's NormalizedRegion already uses for a
// model-produced region, reused here (not re-derived) so a fixture's
// annotation and a real detectBettingRegion()/future localization result
// are always directly comparable without a conversion step.
const normalizedRegionSchema = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  width: z.number().min(0).max(1),
  height: z.number().min(0).max(1),
});

const expectationSchema = z.object({
  betType: z.enum(FIXTURE_BET_TYPES),
  marketFamily: z.enum(FIXTURE_MARKET_FAMILIES),
  // Free text is unavoidable here (a real event/participant name), but this
  // is already the exact same category of content
  // lib/logging/screenshotQa1Diagnostic.ts's Qa1ParserSelectionDiagnostic
  // logs today (public sports data) — never a player identifier.
  selectedEvent: z.string().min(1),
  selectedParticipantOrDirection: z.string().min(1),
  line: z.string().min(1).nullable(),
  stake: z.number().positive(),
  // true for the "genuine ambiguity" fixture the audit's Phase 9 explicitly
  // requires — the corpus must prove the pipeline STILL fails closed on a
  // real screenshot that is actually ambiguous, not just that it stops
  // false-rejecting good ones.
  shouldFailClosed: z.boolean(),
});

export const screenshotFixtureMetadataSchema = z.object({
  id: z
    .string()
    .min(1)
    .regex(/^[a-z0-9][a-z0-9-]*$/, "fixture id must be lowercase kebab-case"),
  sourceCategory: z.string().min(1),
  deviceClass: z.enum(FIXTURE_DEVICE_CLASSES),
  imageWidth: z.number().int().positive(),
  imageHeight: z.number().int().positive(),
  isFullScreen: z.boolean(),
  hasSiblingUi: z.boolean(),
  hasQuickStakeControls: z.boolean(),
  hasOtherMarketOddsVisible: z.boolean(),
  privacy: z.enum(FIXTURE_PRIVACY_CLASSIFICATIONS),
  expected: expectationSchema,
  // Manual annotations — both optional/nullable: most fixtures (especially
  // early ones) will not have a human-verified region yet, and the
  // architecture audit's own Phase 2 requirement is that these are only
  // ever "if manually annotated", never inferred or auto-filled.
  annotatedBetSlipRegion: normalizedRegionSchema.nullable(),
  annotatedSelectedRegion: normalizedRegionSchema.nullable(),
  // Relative path only (never an absolute filesystem path, which could leak
  // local developer directory structure into a committed manifest). Not
  // resolved or read by this module at all — see this file's own header on
  // why no image-loading code exists here yet.
  imagePath: z.string().min(1),
});

export type ScreenshotFixtureMetadata = z.infer<typeof screenshotFixtureMetadataSchema>;

export const screenshotFixtureManifestSchema = z.array(screenshotFixtureMetadataSchema);

/* -------------------------------------------------------------------------- */
/* Validation                                                                 */
/* -------------------------------------------------------------------------- */

export interface FixtureManifestValidationError {
  readonly fixtureId: string | null;
  readonly message: string;
}

export type FixtureManifestValidationResult =
  | { readonly valid: true; readonly fixtures: readonly ScreenshotFixtureMetadata[] }
  | { readonly valid: false; readonly errors: readonly FixtureManifestValidationError[] };

// Pure — takes already-parsed JSON (never reads a file itself, matching
// this file's own "no I/O" scope), returns every problem found rather than
// throwing on the first one, so a manifest with several bad entries reports
// all of them in a single review pass.
export function validateScreenshotFixtureManifest(rawManifest: unknown): FixtureManifestValidationResult {
  const parsed = screenshotFixtureManifestSchema.safeParse(rawManifest);
  if (!parsed.success) {
    const errors: FixtureManifestValidationError[] = parsed.error.issues.map((issue) => ({
      fixtureId: null,
      message: `${issue.path.join(".") || "(root)"}: ${issue.message}`,
    }));
    return { valid: false, errors };
  }

  const errors: FixtureManifestValidationError[] = [];
  const seenIds = new Set<string>();

  for (const fixture of parsed.data) {
    if (seenIds.has(fixture.id)) {
      errors.push({ fixtureId: fixture.id, message: "duplicate fixture id" });
    }
    seenIds.add(fixture.id);

    // REAL_PRIVATE_LOCAL_ONLY is the one classification this module actively
    // enforces beyond shape validation — see this file's own header. A
    // manifest is free to document such a fixture's existence, but its
    // imagePath must never point inside this repository's tracked tree
    // (checked structurally: no repository-relative-looking path segment
    // like a leading "lib/", "app/", "public/", or bare filename with no
    // directory at all — conservative and deliberately over-inclusive
    // rather than attempting real filesystem/git awareness in a pure
    // function).
    if (fixture.privacy === "REAL_PRIVATE_LOCAL_ONLY") {
      const looksRepoRelative = /^(lib|app|components|public|fixtures)\//.test(fixture.imagePath) || !fixture.imagePath.includes("/");
      if (looksRepoRelative) {
        errors.push({
          fixtureId: fixture.id,
          message: "REAL_PRIVATE_LOCAL_ONLY fixtures must not use a repository-relative imagePath",
        });
      }
    }

    // A fixture explicitly marked "not full-screen" (a tight crop) that also
    // claims sibling-UI content is a contradiction worth catching at review
    // time — a tight crop is, by this corpus's own definition (Phase 9),
    // the case with NO sibling content to contaminate evidence.
    if (!fixture.isFullScreen && (fixture.hasSiblingUi || fixture.hasQuickStakeControls || fixture.hasOtherMarketOddsVisible)) {
      errors.push({
        fixtureId: fixture.id,
        message: "a tightly-cropped fixture (isFullScreen: false) cannot also report sibling UI / quick-stake / other-market content",
      });
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return { valid: true, fixtures: parsed.data };
}
