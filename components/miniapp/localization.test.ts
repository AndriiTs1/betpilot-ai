import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

// Cross-cutting localization tests for files that either have no dedicated
// test file of their own (BottomNav, BetActionSheet, BalanceScreen,
// WelcomeBanner) or live outside components/miniapp (app/miniapp/page.tsx —
// the `npm test` glob only scans components/miniapp/*.test.ts and
// lib/**/*.test.ts, not app/miniapp/**, so this file reads it via a
// relative path, same readFileSync(fileURLToPath(...)) convention as every
// other source-based test in this project).

function readLocal(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

const pageSource = readLocal("../../app/miniapp/page.tsx");
const bottomNavSource = readLocal("./BottomNav.tsx");
const actionSheetSource = readLocal("./BetActionSheet.tsx");
const balanceScreenSource = readLocal("./BalanceScreen.tsx");
const welcomeBannerSource = readLocal("./WelcomeBanner.tsx");

// Requirement 15 — the language control stays visible across all four
// bottom-nav tabs: it must be rendered in DataScreen's shared shell,
// structurally BEFORE (outside) the `activeTab === ...` tab-content block,
// never inside BetScreen/ActiveBetsScreen/HistoryScreen/BalanceScreen
// themselves.
test("page.tsx: LanguageSwitcher renders in the shared DataScreen shell, before the per-tab content block — stays visible across every tab", () => {
  const dataScreenMatch = pageSource.match(/function DataScreen\(\{([\s\S]*?)\n\}\n/);
  assert.ok(dataScreenMatch, "expected DataScreen to be defined");
  const body = dataScreenMatch![1];

  const switcherIndex = body.indexOf("<LanguageSwitcher");
  const tabBlockIndex = body.indexOf('activeTab === "bet"');
  assert.notEqual(switcherIndex, -1, "expected <LanguageSwitcher /> to render in DataScreen");
  assert.notEqual(tabBlockIndex, -1, "expected the tab-content block to be found");
  assert.ok(switcherIndex < tabBlockIndex, "LanguageSwitcher must render before the per-tab content block");

  // Must not be nested inside any of the four tab components' own JSX —
  // i.e. it appears exactly once in DataScreen's own body, not per-tab.
  assert.equal((body.match(/<LanguageSwitcher/g) ?? []).length, 1);
});

test("page.tsx: the language control does not add a new full-width header row — it shares WelcomeBanner's existing top row via one flex container", () => {
  assert.match(
    pageSource,
    /<div className="flex items-start justify-between gap-3">\s*<div className="min-w-0 flex-1">\s*<WelcomeBanner[\s\S]*?<\/div>\s*<LanguageSwitcher \/>\s*<\/div>/,
  );
});

test("page.tsx: Telegram's own initDataUnsafe.user.language_code is read exactly once, inside handleScriptReady (the one place tg readiness is actually known), and passed to applyTelegramLanguageCode", () => {
  const handlerMatch = pageSource.match(/const handleScriptReady = useCallback\(\(\) => \{([\s\S]*?)\n {2}\}, \[loadData, applyTelegramLanguageCode\]\);/);
  assert.ok(handlerMatch, "expected handleScriptReady to be found");
  assert.match(handlerMatch![1], /applyTelegramLanguageCode\(tg\.initDataUnsafe\?\.user\?\.language_code\)/);
});

test("page.tsx: the raw initData string used for real Telegram auth verification is never touched by localization — a separate field from initDataUnsafe", () => {
  assert.match(pageSource, /Authorization: `tma \$\{tg\.initData\}`/);
  // initDataUnsafe is additive on the TelegramWebApp interface — initData
  // itself keeps its original `string` type, never widened/replaced.
  assert.match(pageSource, /initData: string;/);
});

// Requirement 5 — bottom navigation must re-render its labels from the
// centralized dictionary, never a hardcoded literal, so a locale switch is
// reflected immediately without any nav-specific cache to invalidate.
test("BottomNav: tab labels come from centralized translation keys, not hardcoded literals", () => {
  assert.match(bottomNavSource, /labelKey: "nav\.newBet"/);
  assert.match(bottomNavSource, /labelKey: "nav\.active"/);
  assert.match(bottomNavSource, /labelKey: "nav\.history"/);
  assert.match(bottomNavSource, /labelKey: "nav\.balance"/);
  assert.match(bottomNavSource, /\{t\(tab\.labelKey\)\}/);
  assert.equal(bottomNavSource.includes('"Новая ставка"'), false);
  assert.equal(bottomNavSource.includes('"Активные"'), false);
});

test("BetActionSheet: sheet title/options/cancel come from centralized translation keys", () => {
  assert.match(actionSheetSource, /\{t\("sheet\.title"\)\}/);
  assert.match(actionSheetSource, /\{t\("sheet\.sendScreenshot"\)\}/);
  assert.match(actionSheetSource, /\{t\("sheet\.sendText"\)\}/);
  assert.match(actionSheetSource, /\{t\("sheet\.cancel"\)\}/);
  assert.equal(actionSheetSource.includes('"Как отправить ставку?"'), false);
});

test("BalanceScreen: all four stat labels come from centralized translation keys", () => {
  assert.match(balanceScreenSource, /label=\{t\("balance\.available"\)\}/);
  assert.match(balanceScreenSource, /label=\{t\("balance\.limit"\)\}/);
  assert.match(balanceScreenSource, /label=\{t\("balance\.exposure"\)\}/);
  assert.match(balanceScreenSource, /label=\{t\("balance\.pending"\)\}/);
});

test("WelcomeBanner: the greeting is interpolated through home.welcome, never string-concatenated, and the player's own name is passed through untouched", () => {
  assert.match(welcomeBannerSource, /\{t\("home\.welcome", \{ name: playerName \}\)\}/);
  // playerName itself must never be re-derived, translated, or altered —
  // it flows straight from props into the interpolation params.
  assert.equal(/playerName\s*\+/.test(welcomeBannerSource), false);
});

// Architectural rule: translations must be centralized, never scattered as
// `locale === "ru" ? "..." : "..."` inline in a component. Scans every
// touched .tsx source for this exact anti-pattern.
test("no component scatters an inline locale === \"ru\" ? ... : ... ternary — every string goes through t()", () => {
  const forbidden = /locale\s*===\s*["']ru["']\s*\?/;
  const sources: Array<[string, string]> = [
    ["page.tsx", pageSource],
    ["BottomNav.tsx", bottomNavSource],
    ["BetActionSheet.tsx", actionSheetSource],
    ["BalanceScreen.tsx", balanceScreenSource],
    ["WelcomeBanner.tsx", welcomeBannerSource],
    ["BetScreen.tsx", readLocal("./BetScreen.tsx")],
    ["BetTextForm.tsx", readLocal("./BetTextForm.tsx")],
    ["ActiveBetsScreen.tsx", readLocal("./ActiveBetsScreen.tsx")],
    ["HistoryScreen.tsx", readLocal("./HistoryScreen.tsx")],
    ["LanguageSwitcher.tsx", readLocal("./LanguageSwitcher.tsx")],
    ["BetPreviewCard.tsx", readLocal("./BetPreviewCard.tsx")],
    ["BetTicket.tsx", readLocal("./BetTicket.tsx")],
    ["BetScreenshotForm.tsx", readLocal("./BetScreenshotForm.tsx")],
    ["betPreviewApi.ts", readLocal("./betPreviewApi.ts")],
    ["betConfirmApi.ts", readLocal("./betConfirmApi.ts")],
    ["betScreenshotApi.ts", readLocal("./betScreenshotApi.ts")],
    ["canConfirmBetSlip.ts", readLocal("./canConfirmBetSlip.ts")],
    ["telegramAuthError.ts", readLocal("./telegramAuthError.ts")],
  ];
  for (const [name, src] of sources) {
    assert.equal(forbidden.test(src), false, `${name} must not scatter a locale === "ru" ? ... ternary`);
  }
});

// ---------------------------------------------------------------------
// Localization completion pass — source audit for remaining hardcoded
// player-facing Russian text in the Mini App UI (requirement 3).
//
// Scoped deliberately to components/miniapp/*.tsx and app/miniapp/*.tsx
// only — never lib/ai (parser/OCR prompts, team-name normalization),
// lib/bets (settlement, canonical status values), or any fixture/test
// data. A Cyrillic string in those places is legitimate bet-input-language
// handling or test data, never a UI-localization defect (per this task's
// own explicit instruction not to flag those as bugs).
//
// Two patterns: Cyrillic directly between JSX tags (">...текст...<"), and
// Cyrillic inside a plain quoted string prop ('="...текст..."'). Both
// intentionally ignore prose inside comments (a `// ...` line or a JSX
// `{/* ... */}` block never matches either pattern, since neither is
// immediately preceded by `>` nor forms a `="...">` attribute), so this
// never flags this project's own extensive Russian-language code comments.
// A translated string is invisible to this scan by construction — it's
// `{t("namespace.key")}`, not literal text between tags.
// This project's own source comments are extensively written in Russian
// prose (documenting product/QA history) — stripped before scanning so a
// comment mentioning real Russian UI copy, or containing a stray "<"/">"
// from describing JSX (e.g. "renders the same <SportIcon>"), can never
// produce a false positive. Block comments first (handles multi-line
// /* ... */ and JSX {/* ... */}), then line comments — same two-pass order
// needed to correctly strip a /* */ block that itself contains "//".
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

function findHardcodedCyrillicUi(dir: string): string[] {
  const cyrillicBetweenTags = /(>[^<{]*[А-Яа-яЁё][^<{]*<)/g;
  const cyrillicInStringProp = /(="[^"]*[А-Яа-яЁё][^"]*")/g;
  const findings: string[] = [];

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      findings.push(...findHardcodedCyrillicUi(fullPath));
      continue;
    }
    if (!entry.name.endsWith(".tsx") || entry.name.endsWith(".test.tsx")) continue;

    const content = stripComments(readFileSync(fullPath, "utf8"));
    for (const match of [...content.matchAll(cyrillicBetweenTags), ...content.matchAll(cyrillicInStringProp)]) {
      findings.push(`${fullPath}: ${match[0].trim()}`);
    }
  }

  return findings;
}

test("source audit: no hardcoded Russian player-facing string remains in any components/miniapp/*.tsx file", () => {
  const findings = findHardcodedCyrillicUi(fileURLToPath(new URL(".", import.meta.url)));
  assert.deepEqual(findings, []);
});

test("source audit: no hardcoded Russian player-facing string remains in any app/miniapp/*.tsx file", () => {
  const findings = findHardcodedCyrillicUi(fileURLToPath(new URL("../../app/miniapp", import.meta.url)));
  assert.deepEqual(findings, []);
});

// ---------------------------------------------------------------------
// Requirement 7 — canonical bet/status/API values are unchanged. These
// pure functions all gained an optional `locale` parameter defaulting to
// "en" (preserving every pre-existing call site's exact behavior) — this
// proves the underlying failure/status CODE classification (never the
// translated text) is what actually drives each function's branch choice,
// completely independent of locale.
// ---------------------------------------------------------------------

test("getOddsStatusBadge: color is locale-independent — only the label text changes between locales, the canonical status/color mapping does not", async () => {
  const { getOddsStatusBadge, ODDS_STATUS_BADGES } = await import("../../lib/bets/oddsStatusBadge");
  for (const status of Object.keys(ODDS_STATUS_BADGES) as Array<keyof typeof ODDS_STATUS_BADGES>) {
    const en = getOddsStatusBadge(status, "en");
    const ru = getOddsStatusBadge(status, "ru");
    assert.equal(en.color, ru.color, `${status}'s color must not depend on locale`);
    assert.equal(en.color, ODDS_STATUS_BADGES[status].color);
    assert.notEqual(en.label, ru.label, `${status}'s label must actually differ between en/ru`);
  }
});
