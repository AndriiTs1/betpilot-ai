import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// This project deliberately has no DOM-rendering test infra (see
// ActiveBetsScreen.test.ts's own comment on why) — SelectionList.tsx has no
// exported pure decision logic beyond its own JSX, so this file uses the
// same source-text inspection technique as BetTicket.test.ts/
// BetScreenshotForm.test.ts to prove the Stage M5.4 spacing change landed
// and nothing else in the truncation logic moved.

const source = readFileSync(fileURLToPath(new URL("./SelectionList.tsx", import.meta.url)), "utf8");

test("source: the gap between selection rows was tightened (space-y-2 -> space-y-1.5)", () => {
  assert.match(source, /className="space-y-1\.5"/);
  assert.equal(source.includes('className="space-y-2"'), false, "old, looser inter-row gap must be gone");
});

test("source: the 'full' mode / decision-context truncation guarantee is untouched — every selection still renders unconditionally in 'full' mode", () => {
  assert.match(source, /const isTruncated = mode === "list" && !expanded && selections\.length > LIST_VISIBLE_THRESHOLD;/);
});
