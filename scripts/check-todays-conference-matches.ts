import "dotenv/config";

// Read-only, deep diagnostic — WHY does Sportmonks return the fixture but
// not pre-match odds for Hibernian vs Malisheva (fixture 19720920)?
// No production code touched, no API key ever printed. Not committed.

const BASE_URL = "https://api.sportmonks.com/v3";
const FIXTURE_ID = 19720920;
// A fixture already confirmed (Stage 10) to have real, live odds right
// now — used purely as a "control" to prove the odds pipeline itself is
// generally working today, isolating whether THIS fixture/competition is
// the actual difference.
const REFERENCE_FIXTURE_ID = 19743018; // Juventus vs Nice, Club Friendlies 1

let requestCount = 0;
const calledEndpoints: string[] = [];

async function call(path: string): Promise<{ status: number; body: unknown }> {
  const token = process.env.SPORTMONKS_API_TOKEN;
  if (!token) {
    console.error("SPORTMONKS_API_TOKEN is not set");
    process.exit(1);
  }
  requestCount += 1;
  calledEndpoints.push(path);
  const response = await fetch(`${BASE_URL}${path}`, { headers: { Authorization: token } });
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = await response.text().catch(() => null);
  }
  return { status: response.status, body };
}

function print(title: string, obj: unknown) {
  console.log(`\n--- ${title} ---`);
  console.log(JSON.stringify(obj, null, 2));
}

async function main() {
  console.log("################ 1. SUBSCRIPTION / PLAN ################");

  const marketSearch = await call(`/odds/markets/search/${encodeURIComponent("Fulltime Result")}`);
  console.log(`GET /odds/markets/search/Fulltime Result -> HTTP ${marketSearch.status}`);
  const marketBody = marketSearch.body as Record<string, unknown>;
  print("subscription block (from market search response)", marketBody?.subscription);
  print("rate_limit (from market search response)", marketBody?.rate_limit);

  const myResources = await call(`/my/resources`);
  console.log(`\nGET /my/resources -> HTTP ${myResources.status}`);
  const resourcesBody = myResources.body as { data?: Array<{ id: number; description: string }> };
  const oddsResources = (resourcesBody?.data ?? []).filter((r) => {
    const d = r.description.toLowerCase();
    return d.includes("odds") || d.includes("bookmaker") || d.includes("market");
  });
  console.log(`Total resources: ${resourcesBody?.data?.length ?? 0}, odds/bookmaker/market-related: ${oddsResources.length}`);
  for (const r of oddsResources) console.log(`  id=${r.id} "${r.description}"`);

  const myLeagues = await call(`/my/leagues`);
  console.log(`\nGET /my/leagues -> HTTP ${myLeagues.status}`);
  const leaguesBody = myLeagues.body as { data?: Array<{ id: number; name: string }> };
  print("my/leagues data", leaguesBody?.data);
  const hasConferenceLeague = (leaguesBody?.data ?? []).some((l) => l.id === 2286);
  console.log(`league_id 2286 (Europa Conference League) present in my/leagues: ${hasConferenceLeague}`);

  console.log("\n\n################ 2. FIXTURE DETAIL ################");
  const fixtureResult = await call(`/football/fixtures/${FIXTURE_ID}?include=participants;league;stage;round;season`);
  console.log(`GET /football/fixtures/${FIXTURE_ID}?include=participants;league;stage;round;season -> HTTP ${fixtureResult.status}`);
  const fixtureBody = (fixtureResult.body as { data?: Record<string, unknown> })?.data;
  print("fixture data", fixtureBody);

  console.log("\n\n################ 3. ODDS ENDPOINT VARIANTS FOR THIS FIXTURE ################");

  const variant1 = await call(`/football/odds/pre-match/fixtures/${FIXTURE_ID}`);
  console.log(`\nA. GET /football/odds/pre-match/fixtures/${FIXTURE_ID} -> HTTP ${variant1.status}`);
  print("body", variant1.body);

  const variant2 = await call(`/football/odds/pre-match/fixtures/${FIXTURE_ID}?include=bookmaker;market`);
  console.log(`\nB. GET .../fixtures/${FIXTURE_ID}?include=bookmaker;market -> HTTP ${variant2.status}`);
  print("meta/pagination only", (variant2.body as Record<string, unknown>)?.pagination ?? (variant2.body as Record<string, unknown>)?.meta ?? null);
  print("data length", { length: Array.isArray((variant2.body as { data?: unknown[] })?.data) ? (variant2.body as { data: unknown[] }).data.length : null });

  const variant3 = await call(`/football/odds/pre-match/fixtures/${FIXTURE_ID}/markets/1`);
  console.log(`\nC. GET .../fixtures/${FIXTURE_ID}/markets/1 (Fulltime Result only) -> HTTP ${variant3.status}`);
  print("body", variant3.body);

  const variant4 = await call(`/football/odds/pre-match?filters=fixtureIds:${FIXTURE_ID}&include=bookmaker;market`);
  console.log(`\nD. GET /football/odds/pre-match?filters=fixtureIds:${FIXTURE_ID}&include=bookmaker;market (the "All Prematch Odds" endpoint, filtered) -> HTTP ${variant4.status}`);
  const v4Body = variant4.body as { data?: Array<Record<string, unknown>>; pagination?: unknown; message?: string };
  const v4Data = v4Body?.data ?? [];
  console.log(`  data length (page 1): ${v4Data.length}`);
  print("pagination", v4Body?.pagination);
  if (v4Body?.message) print("message", v4Body.message);

  const marketIdsSeen = new Set(v4Data.map((r) => Number(r.market_id)));
  console.log(`  distinct market_ids on page 1: ${[...marketIdsSeen].sort((a, b) => a - b).join(", ")}`);
  const fulltimeRows = v4Data.filter((r) => Number(r.market_id) === 1);
  console.log(`  market_id=1 (Fulltime Result) rows on page 1: ${fulltimeRows.length}`);
  for (const r of fulltimeRows) {
    console.log(
      `    bookmaker_id=${r.bookmaker_id} bookmaker=${(r.bookmaker as Record<string, unknown> | undefined)?.name ?? "?"} label=${r.label} value=${r.value} updated=${r.latest_bookmaker_update ?? r.updated_at}`,
    );
  }

  // Page 2, in case market_id=1 sits beyond the first 25 rows.
  if (v4Body?.pagination && (v4Body.pagination as { has_more?: boolean }).has_more) {
    const variant4b = await call(`/football/odds/pre-match?filters=fixtureIds:${FIXTURE_ID}&include=bookmaker;market&page=2`);
    const v4bBody = variant4b.body as { data?: Array<Record<string, unknown>> };
    const v4bData = v4bBody?.data ?? [];
    console.log(`\n  page 2 -> HTTP ${variant4b.status}, data length: ${v4bData.length}`);
    const marketIdsSeen2 = new Set(v4bData.map((r) => Number(r.market_id)));
    console.log(`  distinct market_ids on page 2: ${[...marketIdsSeen2].sort((a, b) => a - b).join(", ")}`);
    const fulltimeRows2 = v4bData.filter((r) => Number(r.market_id) === 1);
    console.log(`  market_id=1 (Fulltime Result) rows on page 2: ${fulltimeRows2.length}`);
    for (const r of fulltimeRows2) {
      console.log(
        `    bookmaker_id=${r.bookmaker_id} bookmaker=${(r.bookmaker as Record<string, unknown> | undefined)?.name ?? "?"} label=${r.label} value=${r.value} updated=${r.latest_bookmaker_update ?? r.updated_at}`,
      );
    }
  }

  const variant5 = await call(`/football/odds/inplay/fixtures/${FIXTURE_ID}`);
  console.log(`\nE. GET /football/odds/inplay/fixtures/${FIXTURE_ID} (sanity check — should also be empty pre-match) -> HTTP ${variant5.status}`);
  const v5Body = variant5.body as { data?: unknown[] };
  console.log(`  data length: ${Array.isArray(v5Body?.data) ? v5Body.data.length : "n/a"}`);

  console.log("\n\n################ 4. CONTROL FIXTURE (known-good odds, for comparison) ################");
  const controlOdds = await call(`/football/odds/pre-match/fixtures/${REFERENCE_FIXTURE_ID}?include=bookmaker;market`);
  const controlBody = controlOdds.body as { data?: Array<Record<string, unknown>> };
  const controlData = controlBody?.data ?? [];
  console.log(`GET .../fixtures/${REFERENCE_FIXTURE_ID} (Juventus vs Nice, control) -> HTTP ${controlOdds.status}, data length: ${controlData.length}`);
  console.log("This proves whether the odds pipeline itself is generally live today, independent of this specific fixture/competition.");
  const controlFulltime = controlData.filter((r) => Number(r.market_id) === 1).slice(0, 5);
  console.log(`  market_id=1 (Fulltime Result) sample rows (first 5 of ${controlData.filter((r) => Number(r.market_id) === 1).length}):`);
  for (const r of controlFulltime) {
    console.log(`    bookmaker_id=${r.bookmaker_id} label=${r.label} value=${r.value} updated=${r.latest_bookmaker_update ?? r.updated_at}`);
  }

  console.log("\n\n################ ENDPOINTS CALLED (no API keys) ################");
  for (const e of calledEndpoints) console.log(`  ${e}`);
  console.log(`\nTotal Sportmonks requests: ${requestCount}`);
  console.log("(No requests made to The Odds API in this script.)");
}

main().catch((err) => {
  console.error("Script error (message only):", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
