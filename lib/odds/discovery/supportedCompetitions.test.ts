import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SPORTS } from "@/lib/odds/domain";
import { SUPPORTED_COMPETITIONS, getSupportedSportKeys, isSupportedSportKey } from "./supportedCompetitions";

const EXPECTED_SPORT_KEYS = [
  "soccer_epl",
  "soccer_spain_la_liga",
  "soccer_italy_serie_a",
  "soccer_germany_bundesliga",
  "soccer_france_ligue_one",
  "soccer_uefa_champs_league",
  "soccer_uefa_champs_league_qualification",
  "soccer_uefa_europa_league",
  "soccer_uefa_europa_conference_league",
];

/* -------------------------------------------------------------------------- */
/* Shape                                                                      */
/* -------------------------------------------------------------------------- */

test("no duplicate sportKey values", () => {
  const keys = SUPPORTED_COMPETITIONS.map((c) => c.sportKey);
  assert.equal(new Set(keys).size, keys.length);
});

test("no empty/blank sportKey", () => {
  for (const competition of SUPPORTED_COMPETITIONS) {
    assert.ok(competition.sportKey.trim().length > 0, `sportKey must not be blank: "${competition.sportKey}"`);
  }
});

test("no empty/blank displayName", () => {
  for (const competition of SUPPORTED_COMPETITIONS) {
    assert.ok(competition.displayName.trim().length > 0, `displayName must not be blank for "${competition.sportKey}"`);
  }
});

test("every entry's sport is a real, valid Sport enum member", () => {
  for (const competition of SUPPORTED_COMPETITIONS) {
    assert.ok(
      (SPORTS as readonly string[]).includes(competition.sport),
      `"${competition.sportKey}" has an invalid sport: "${competition.sport}"`,
    );
  }
});

test("every entry is FOOTBALL at this stage (product scope: football-only for now)", () => {
  for (const competition of SUPPORTED_COMPETITIONS) {
    assert.equal(competition.sport, "FOOTBALL");
  }
});

/* -------------------------------------------------------------------------- */
/* Content — every approved competition present, with the exact provider     */
/* sport_key confirmed live against GET /v4/sports (2026-07-30), not guessed */
/* -------------------------------------------------------------------------- */

test("all nine approved competitions are present with their exact confirmed sport_key", () => {
  const actualKeys = new Set(SUPPORTED_COMPETITIONS.map((c) => c.sportKey));
  for (const expectedKey of EXPECTED_SPORT_KEYS) {
    assert.ok(actualKeys.has(expectedKey), `missing expected sport_key: "${expectedKey}"`);
  }
  assert.equal(actualKeys.size, EXPECTED_SPORT_KEYS.length, "no extra, unapproved competitions expected at this stage");
});

/* -------------------------------------------------------------------------- */
/* getSupportedSportKeys                                                     */
/* -------------------------------------------------------------------------- */

test("getSupportedSportKeys() with no argument returns every supported sportKey", () => {
  const keys = getSupportedSportKeys();
  assert.equal(keys.length, SUPPORTED_COMPETITIONS.length);
  for (const expectedKey of EXPECTED_SPORT_KEYS) {
    assert.ok(keys.includes(expectedKey));
  }
});

test("getSupportedSportKeys('FOOTBALL') returns every entry (all entries are FOOTBALL today)", () => {
  assert.equal(getSupportedSportKeys("FOOTBALL").length, SUPPORTED_COMPETITIONS.length);
});

test("getSupportedSportKeys('BASKETBALL') returns an empty list (no basketball entries exist yet)", () => {
  assert.deepEqual(getSupportedSportKeys("BASKETBALL"), []);
});

/* -------------------------------------------------------------------------- */
/* isSupportedSportKey                                                       */
/* -------------------------------------------------------------------------- */

test("isSupportedSportKey() is true for every approved key", () => {
  for (const key of EXPECTED_SPORT_KEYS) {
    assert.equal(isSupportedSportKey(key), true, key);
  }
});

test("isSupportedSportKey() is false for an unapproved-but-real provider key (Eredivisie)", () => {
  assert.equal(isSupportedSportKey("soccer_netherlands_eredivisie"), false);
});

test("isSupportedSportKey() is false for an empty string and for garbage input", () => {
  assert.equal(isSupportedSportKey(""), false);
  assert.equal(isSupportedSportKey("not-a-real-sport-key"), false);
});

/* -------------------------------------------------------------------------- */
/* Immutability                                                              */
/* -------------------------------------------------------------------------- */

test("SUPPORTED_COMPETITIONS array itself cannot be mutated at runtime", () => {
  assert.throws(() => {
    (SUPPORTED_COMPETITIONS as SupportedCompetitionMutable[]).push({
      sportKey: "fake",
      sport: "FOOTBALL",
      displayName: "Fake",
    });
  });
});

test("an individual SUPPORTED_COMPETITIONS entry cannot be mutated at runtime", () => {
  const [first] = SUPPORTED_COMPETITIONS;
  assert.throws(() => {
    (first as { sportKey: string }).sportKey = "tampered";
  });
});

// Local, test-only widened type — SUPPORTED_COMPETITIONS itself stays
// readonly (SupportedCompetition[]); this exists only so the mutation
// attempt above type-checks as "calling a real array method" rather than
// needing an `any` cast, without loosening the exported type itself.
type SupportedCompetitionMutable = { sportKey: string; sport: string; displayName: string };

/* -------------------------------------------------------------------------- */
/* Isolation — Stage 2 explicitly must not touch the live pipeline           */
/* -------------------------------------------------------------------------- */
//
// Two checks: (1) a precise list of the exact files Stage 2's own spec
// names as "must not change" — these must not reference this module at all;
// (2) a broader repo-wide scan (app/, components/, lib/ minus
// lib/generated) as a secondary safety net. Check (1) is expected to keep
// passing indefinitely as a real invariant of "nothing live depends on this
// yet"; check (2) is a point-in-time Stage 2 boundary and is EXPECTED to
// need updating once a later stage (Candidate Resolver, then eventually
// buildBetSlipPreview.ts) legitimately starts importing this module — that
// is the intended, planned outcome of this whole initiative, not a
// regression to guard against forever.

const MUST_NOT_IMPORT_YET = [
  "lib/odds/oddsVerifier.ts",
  "lib/odds/footballLeagues.ts",
  "lib/odds/legacyOddsBridge.ts",
  "lib/odds/oddsVerificationService.ts",
  "lib/odds/theOddsApiProvider.ts",
  "lib/bets/buildBetSlipPreview.ts",
  "app/api/miniapp/bets/text/preview/route.ts",
  "app/api/miniapp/bets/text/confirm/route.ts",
  "app/api/miniapp/bets/screenshot/preview/route.ts",
  "components/miniapp/BetTextForm.tsx",
  "components/miniapp/BetScreenshotForm.tsx",
  "components/miniapp/BetPreviewCard.tsx",
  "components/miniapp/canConfirmBetSlip.ts",
];

test("none of Stage 2's explicitly-named live-pipeline files import supportedCompetitions", () => {
  for (const relativePath of MUST_NOT_IMPORT_YET) {
    const contents = readFileSync(join(process.cwd(), relativePath), "utf8");
    assert.ok(
      !contents.includes("supportedCompetitions"),
      `${relativePath} must not import supportedCompetitions.ts at this stage`,
    );
  }
});

// Durable rule (post-Stage 4): importing supportedCompetitions.ts is
// legitimate from anywhere INSIDE the Event Discovery Engine's own module
// tree — lib/odds/discovery/ (its sibling Discovery modules, e.g. the
// future Event Catalog/Candidate Resolver) and lib/odds/providers/theOddsApi/
// (provider adapters, e.g. eventsAdapter.ts, which must consult the
// allowlist before querying a sport_key). It remains forbidden everywhere
// else: app/, components/, every legacy odds module directly under
// lib/odds/ (oddsVerifier.ts, footballLeagues.ts, legacyOddsBridge.ts,
// oddsVerificationService.ts, theOddsApiProvider.ts, providerRegistry.ts),
// lib/bets/ (including buildBetSlipPreview.ts), and every API route/Mini
// App component. This is a directory-scoped rule, not a per-file
// exception — a hypothetical new file dropped directly into lib/odds/ (as
// opposed to one of the two allowed subdirectories) would still be caught.
const ALLOWED_IMPORT_DIR_SUFFIXES = [join("lib", "odds", "discovery"), join("lib", "odds", "providers", "theOddsApi")];

function isInsideDiscoveryEngineOwnTree(fullPath: string): boolean {
  return ALLOWED_IMPORT_DIR_SUFFIXES.some((suffix) => fullPath.includes(suffix));
}

test("no import of this module exists outside the Discovery Engine's own directories (lib/odds/discovery/, lib/odds/providers/theOddsApi/)", async () => {
  const { readdirSync, statSync } = await import("node:fs");

  const EXCLUDED_DIR_NAMES = new Set(["node_modules", ".next", ".git", "generated"]);
  const roots = ["app", "components", "lib"].map((dir) => join(process.cwd(), dir));
  const offenders: string[] = [];

  function walk(dir: string): void {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }

    for (const entry of entries) {
      if (EXCLUDED_DIR_NAMES.has(entry)) continue;
      const fullPath = join(dir, entry);
      const stats = statSync(fullPath);

      if (stats.isDirectory()) {
        walk(fullPath);
        continue;
      }

      if (!/\.(ts|tsx)$/.test(entry)) continue;
      if (isInsideDiscoveryEngineOwnTree(fullPath)) continue;

      const contents = readFileSync(fullPath, "utf8");
      if (contents.includes("discovery/supportedCompetitions")) {
        offenders.push(fullPath);
      }
    }
  }

  for (const root of roots) walk(root);

  assert.deepEqual(
    offenders,
    [],
    `unexpected imports of supportedCompetitions found outside the Discovery Engine's own tree: ${offenders.join(", ")}`,
  );
});
