import type { AdsProvider, AdsProviderId } from "./types.ts";
import { metaAdsProvider } from "./meta/provider.ts";

// A Map, not a plain object: lookups must not see Object.prototype keys such as "constructor" or "__proto__".
// openai joins after gate O0 and google after gate G0; until then they resolve to null.
const providers = new Map<AdsProviderId, AdsProvider>([["meta", metaAdsProvider]]);

export function adsProvider(id: AdsProviderId): AdsProvider | null {
  return providers.get(id) ?? null;
}

export function adsProviderIds(): AdsProviderId[] {
  return [...providers.keys()];
}
