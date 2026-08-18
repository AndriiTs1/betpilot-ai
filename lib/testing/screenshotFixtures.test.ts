import { test } from "node:test";
import assert from "node:assert/strict";
import { validateScreenshotFixtureManifest, type ScreenshotFixtureMetadata } from "./screenshotFixtures";

// Every fixture below is SYNTHETIC (privacy: "SYNTHETIC") — no real
// screenshot content, no real bookmaker pixels, imagePath points at nothing
// real. These exist only to prove the manifest schema/validator itself
// works, exactly like this codebase's existing convention of generating
// blank sharp() images with the right byte signature for OCR-route tests
// (lib/ocr/recognizeBetSlipScreenshot.test.ts) rather than shipping real
// photos. Populating this corpus with real (redacted or private-local)
// screenshots is a follow-up this stage's own report explicitly defers.

function validFixture(overrides: Partial<ScreenshotFixtureMetadata> = {}): ScreenshotFixtureMetadata {
  return {
    id: "single-moneyline-home-01",
    sourceCategory: "generic-mobile-sportsbook",
    deviceClass: "IPHONE_PORTRAIT",
    imageWidth: 1170,
    imageHeight: 2532,
    isFullScreen: true,
    hasSiblingUi: true,
    hasQuickStakeControls: true,
    hasOtherMarketOddsVisible: true,
    privacy: "SYNTHETIC",
    expected: {
      betType: "SINGLE",
      marketFamily: "MONEYLINE",
      selectedEvent: "Athletic Bilbao vs Sevilla",
      selectedParticipantOrDirection: "Athletic Bilbao",
      line: null,
      stake: 5,
      shouldFailClosed: false,
    },
    annotatedBetSlipRegion: null,
    annotatedSelectedRegion: null,
    imagePath: "fixtures/synthetic/single-moneyline-home-01.jpg",
    ...overrides,
  };
}

test("a single valid fixture passes validation", () => {
  const result = validateScreenshotFixtureManifest([validFixture()]);
  assert.equal(result.valid, true);
  if (!result.valid) return;
  assert.equal(result.fixtures.length, 1);
  assert.equal(result.fixtures[0].id, "single-moneyline-home-01");
});

test("a manifest with a manually annotated region round-trips unchanged", () => {
  const withRegions = validFixture({
    annotatedBetSlipRegion: { x: 0.05, y: 0.3, width: 0.9, height: 0.4 },
    annotatedSelectedRegion: { x: 0.1, y: 0.35, width: 0.3, height: 0.05 },
  });
  const result = validateScreenshotFixtureManifest([withRegions]);
  assert.equal(result.valid, true);
  if (!result.valid) return;
  assert.deepEqual(result.fixtures[0].annotatedSelectedRegion, { x: 0.1, y: 0.35, width: 0.3, height: 0.05 });
});

test("malformed shape (wrong type) is rejected with a field-level error, not a thrown exception", () => {
  const malformed = { ...validFixture(), imageWidth: "not a number" };
  const result = validateScreenshotFixtureManifest([malformed]);
  assert.equal(result.valid, false);
  if (result.valid) return;
  assert.ok(result.errors.length > 0);
  assert.ok(result.errors.some((e) => e.message.includes("imageWidth")));
});

test("duplicate fixture ids are rejected", () => {
  const result = validateScreenshotFixtureManifest([validFixture(), validFixture()]);
  assert.equal(result.valid, false);
  if (result.valid) return;
  assert.ok(result.errors.some((e) => e.fixtureId === "single-moneyline-home-01" && e.message.includes("duplicate")));
});

test("a tightly-cropped fixture claiming sibling UI is rejected as self-contradictory", () => {
  const contradictory = validFixture({ isFullScreen: false, hasSiblingUi: true });
  const result = validateScreenshotFixtureManifest([contradictory]);
  assert.equal(result.valid, false);
  if (result.valid) return;
  assert.ok(result.errors.some((e) => e.message.includes("tightly-cropped")));
});

test("a tightly-cropped fixture with no sibling UI is valid", () => {
  const tightCrop = validFixture({
    id: "single-totals-tight-crop-01",
    deviceClass: "TIGHT_CROP",
    isFullScreen: false,
    hasSiblingUi: false,
    hasQuickStakeControls: false,
    hasOtherMarketOddsVisible: false,
  });
  const result = validateScreenshotFixtureManifest([tightCrop]);
  assert.equal(result.valid, true);
});

test("REAL_PRIVATE_LOCAL_ONLY fixture with a repository-relative imagePath is rejected", () => {
  const leaky = validFixture({ privacy: "REAL_PRIVATE_LOCAL_ONLY", imagePath: "fixtures/real/leaked.jpg" });
  const result = validateScreenshotFixtureManifest([leaky]);
  assert.equal(result.valid, false);
  if (result.valid) return;
  assert.ok(result.errors.some((e) => e.message.includes("REAL_PRIVATE_LOCAL_ONLY")));
});

test("REAL_PRIVATE_LOCAL_ONLY fixture with a genuinely external path is accepted", () => {
  const outsideRepo = validFixture({
    id: "real-private-01",
    privacy: "REAL_PRIVATE_LOCAL_ONLY",
    imagePath: "/Users/qa/private-screenshot-corpus/real-private-01.jpg",
  });
  const result = validateScreenshotFixtureManifest([outsideRepo]);
  assert.equal(result.valid, true);
});

test("the genuine-ambiguity expectation (shouldFailClosed: true) is representable and validates", () => {
  const ambiguous = validFixture({
    id: "single-totals-genuine-ambiguity-01",
    expected: {
      betType: "SINGLE",
      marketFamily: "TOTALS",
      selectedEvent: "Real Betis vs Real Sociedad",
      selectedParticipantOrDirection: "Over",
      line: "2.5",
      stake: 5,
      shouldFailClosed: true,
    },
  });
  const result = validateScreenshotFixtureManifest([ambiguous]);
  assert.equal(result.valid, true);
  if (!result.valid) return;
  assert.equal(result.fixtures[0].expected.shouldFailClosed, true);
});

test("an empty manifest is valid (no fixtures yet is a legitimate starting state)", () => {
  const result = validateScreenshotFixtureManifest([]);
  assert.equal(result.valid, true);
  if (!result.valid) return;
  assert.equal(result.fixtures.length, 0);
});

test("a completely malformed top-level value (not an array) fails validation without throwing", () => {
  const result = validateScreenshotFixtureManifest({ not: "an array" });
  assert.equal(result.valid, false);
});
