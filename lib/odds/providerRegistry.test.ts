import { test } from "node:test";
import assert from "node:assert/strict";
import { OddsProviderRegistry, ProviderRegistryError } from "./providerRegistry";
import type { OddsProvider, ProviderHealthResult, ProviderName } from "./oddsProvider";

function fakeProvider(name: ProviderName): OddsProvider {
  return {
    name,
    getCapabilities: () => ({
      provider: name,
      supportedSports: [],
      supportedMarketTypes: [],
      leagueSelectionSupported: false,
      livePrematchSupport: "PREMATCH_ONLY",
      eventSearchSupported: false,
      eventByIdLookupSupported: false,
      regions: [],
      notes: [],
    }),
    findEvents: async () => ({ ok: true, value: [] }),
    getEventMarkets: async () => ({ ok: true, value: [] }),
    verifySelection: async () => {
      throw new Error("not used in this test");
    },
    healthCheck: async (): Promise<ProviderHealthResult> => ({
      healthy: true,
      provider: name,
      checkedAt: new Date().toISOString(),
    }),
  };
}

/* -------------------------------------------------------------------------- */
/* Group E — registry                                                         */
/* -------------------------------------------------------------------------- */

test("resolve returns the registered provider by name", () => {
  const registry = new OddsProviderRegistry();
  const provider = fakeProvider("THE_ODDS_API");

  registry.register(provider);

  assert.equal(registry.resolve("THE_ODDS_API"), provider);
});

test("registering the same provider name twice throws DUPLICATE_PROVIDER", () => {
  const registry = new OddsProviderRegistry();
  registry.register(fakeProvider("THE_ODDS_API"));

  assert.throws(
    () => registry.register(fakeProvider("THE_ODDS_API")),
    (err: unknown) => err instanceof ProviderRegistryError && err.code === "DUPLICATE_PROVIDER",
  );
});

test("resolving an unregistered provider name returns undefined", () => {
  const registry = new OddsProviderRegistry();
  assert.equal(registry.resolve("THE_ODDS_API"), undefined);
});

test("requireResolve throws UNKNOWN_PROVIDER for an unregistered name", () => {
  const registry = new OddsProviderRegistry();

  assert.throws(
    () => registry.requireResolve("THE_ODDS_API"),
    (err: unknown) => err instanceof ProviderRegistryError && err.code === "UNKNOWN_PROVIDER",
  );
});

test("requireResolve returns the provider once registered", () => {
  const registry = new OddsProviderRegistry();
  const provider = fakeProvider("THE_ODDS_API");
  registry.register(provider);

  assert.equal(registry.requireResolve("THE_ODDS_API"), provider);
});
