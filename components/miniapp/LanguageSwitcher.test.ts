import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const source = readFileSync(fileURLToPath(new URL("./LanguageSwitcher.tsx", import.meta.url)), "utf8");

test("LanguageSwitcher: collapsed control shows the uppercased current locale with a chevron, no flag/globe icon import", () => {
  assert.match(source, /\{locale\.toUpperCase\(\)\}/);
  assert.match(source, /<ChevronDown/);
  // Checked against the actual icon import line, not the whole file (this
  // component's own explanatory comments legitimately use the word "flags"
  // in prose when describing what NOT to render).
  const importLine = source.split("\n").find((line) => line.includes('from "lucide-react"'));
  assert.ok(importLine, "expected a lucide-react icon import line");
  assert.equal(/flag/i.test(importLine!), false);
  assert.equal(/globe/i.test(importLine!), false);
});

// Design brief: green is reserved for the selected-state accent inside the
// open menu only — the collapsed trigger must never be a bright filled
// button. "#60E84A" (BetPilot's green accent) must therefore appear
// exactly once in this file, and only inside the selected-option Check
// icon's own style, never on the collapsed trigger button.
test("LanguageSwitcher: the green accent is used exactly once, only for the selected-option checkmark — never on the collapsed trigger", () => {
  const occurrences = source.match(/#60E84A/g) ?? [];
  assert.equal(occurrences.length, 1);

  const triggerButtonMatch = source.match(/aria-label=\{t\("common\.language"\)\}[\s\S]*?<\/button>/);
  assert.ok(triggerButtonMatch, "expected the collapsed trigger button");
  assert.equal(triggerButtonMatch![0].includes("#60E84A"), false);

  assert.match(source, /isSelected && \([\s\S]*?<Check[\s\S]*?color: "#60E84A"/);
});

test("LanguageSwitcher: both language options render via centralized translation keys, never a hardcoded literal 'Русский'/'English' string", () => {
  assert.match(source, /t\(option === "ru" \? "common\.russian" : "common\.english"\)/);
  assert.equal(source.includes('"Русский"'), false);
  assert.equal(source.includes('"English"'), false);
});

test("LanguageSwitcher: selecting an option calls setLocale and closes the menu — no page navigation, no full-screen sheet", () => {
  const handleSelectMatch = source.match(/function handleSelect\(next: Locale\) \{([\s\S]*?)\n  \}/);
  assert.ok(handleSelectMatch, "expected handleSelect to be defined");
  assert.match(handleSelectMatch![1], /setLocale\(next\)/);
  assert.match(handleSelectMatch![1], /setOpen\(false\)/);
  assert.equal(source.includes("router.push"), false);
  assert.equal(source.includes("window.location"), false);
});

test("LanguageSwitcher: dismisses on outside click/touch and on Escape — no modal backdrop", () => {
  assert.match(source, /document\.addEventListener\("mousedown", handlePointerDown\)/);
  assert.match(source, /document\.addEventListener\("touchstart", handlePointerDown\)/);
  assert.match(source, /event\.key === "Escape"/);
});

test("LanguageSwitcher: the open menu is an absolutely positioned anchored panel, not a fixed full-screen overlay — never shifts page layout", () => {
  assert.match(source, /className="absolute right-0 top-\[calc\(100%\+6px\)\]/);
  assert.equal(/className="fixed inset-0/.test(source), false);
});

test("LanguageSwitcher: the collapsed control meets a comfortable minimum touch target (>= 36px) and the open menu marks the selected option via aria-selected", () => {
  assert.match(source, /className="flex min-h-9 items-center/);
  assert.match(source, /aria-selected=\{isSelected\}/);
  assert.match(source, /role="listbox"/);
  assert.match(source, /role="option"/);
});
