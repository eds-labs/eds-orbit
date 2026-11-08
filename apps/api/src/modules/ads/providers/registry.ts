import type { AdsProvider, AdsProviderId } from "./types.ts";
import { metaAdsProvider } from "./meta/provider.ts";

// openai joins after gate O0 and google after gate G0; until then they resolve to null.
const providers: Partial<Record<AdsProviderId, AdsProvider>> = {
  meta: metaAdsProvider,
};

export function adsProvider(id: AdsProviderId): AdsProvider | null {
  return providers[id] ?? null;
}

export function adsProviderIds(): AdsProviderId[] {
  return Object.keys(providers) as AdsProviderId[];
}
