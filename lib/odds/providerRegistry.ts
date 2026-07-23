// Step 5 — minimal provider registry. See docs/ODDS_PROVIDER_DESIGN.md
// Section 10: "a thin getProvider(name?): OddsProvider lookup. Trivial for
// MVP (exactly one registered provider) — exists only so 'add a second
// provider' isn't blocked later... no dynamic multi-provider
// routing/fallback logic is justified until there's an actual second
// provider to route between." No production caller registers or resolves
// through this yet (Step 5 scope).

import type { OddsProvider, ProviderName } from "./oddsProvider";

export type ProviderRegistryErrorCode = "DUPLICATE_PROVIDER" | "UNKNOWN_PROVIDER";

// Same narrow-purpose "Error subclass with an explicit code" convention
// already used across this codebase (BetSlipValidationError,
// PreviewTokenSignError, CreateBetFromPreviewValidationError).
export class ProviderRegistryError extends Error {
  readonly code: ProviderRegistryErrorCode;

  constructor(code: ProviderRegistryErrorCode, message: string) {
    super(message);
    this.name = "ProviderRegistryError";
    this.code = code;
  }
}

export class OddsProviderRegistry {
  private readonly providers = new Map<ProviderName, OddsProvider>();

  register(provider: OddsProvider): void {
    if (this.providers.has(provider.name)) {
      throw new ProviderRegistryError(
        "DUPLICATE_PROVIDER",
        `A provider is already registered under the name "${provider.name}"`,
      );
    }
    this.providers.set(provider.name, provider);
  }

  resolve(name: ProviderName): OddsProvider | undefined {
    return this.providers.get(name);
  }

  requireResolve(name: ProviderName): OddsProvider {
    const provider = this.resolve(name);
    if (!provider) {
      throw new ProviderRegistryError("UNKNOWN_PROVIDER", `No provider is registered under the name "${name}"`);
    }
    return provider;
  }
}
