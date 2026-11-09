import { describe, expect, it } from "vitest";
import { META_ADS_API_VERSION } from "../src/modules/ads/providers/meta/version.ts";
import { metaAdsProvider } from "../src/modules/ads/providers/meta/provider.ts";
import { adsProvider, adsProviderIds } from "../src/modules/ads/providers/registry.ts";

describe("ads provider registry", () => {
  it("resolves the Meta provider", () => {
    expect(adsProvider("meta")).toBe(metaAdsProvider);
  });

  it("returns null for providers whose gates have not passed", () => {
    expect(adsProvider("openai")).toBeNull();
    expect(adsProvider("google")).toBeNull();
  });

  it("returns null for inherited Object.prototype keys, not only for unknown ids", () => {
    expect(adsProvider("constructor" as never)).toBeNull();
    expect(adsProvider("__proto__" as never)).toBeNull();
    expect(adsProvider("toString" as never)).toBeNull();
    expect(adsProvider("hasOwnProperty" as never)).toBeNull();
  });

  it("lists only the Meta provider", () => {
    expect(adsProviderIds()).toEqual(["meta"]);
  });

  it("pins the Meta Ads API version, separate from Social", () => {
    expect(metaAdsProvider.id).toBe("meta");
    expect(metaAdsProvider.manifest.apiVersion).toBe(META_ADS_API_VERSION);
    expect(metaAdsProvider.manifest.apiVersion).toBe("v27.0");
    expect(metaAdsProvider.manifest).toEqual({ apiVersion: "v27.0", currencyUnit: "minor", validateOnly: true });
  });
});
