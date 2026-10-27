import { describe, expect, it } from "vitest";
import { libraryAssets, uploadAssetTypes, type Entity } from "./api";

const asset = (id: string, data: Record<string, unknown>) =>
  ({ id, version: 1, data }) as unknown as Entity;

describe("asset library and pickers (R78)", () => {
  it("leave out composed banners bound to their post", () => {
    const items = [
      asset("logo", { type: "logo", assetStatus: "approved" }),
      asset("banner", {
        type: "generated_artwork",
        assetStatus: "approved",
        boundTo: { runId: "run", contentId: "content" },
      }),
    ];
    expect(libraryAssets(items).map((item) => item.id)).toEqual(["logo"]);
    expect(libraryAssets(undefined)).toEqual([]);
  });
});

// R61: owners upload product screenshots and images with the Creative Studio
// on; off, the types are the ones from before it (CS-D6).
describe("upload asset types", () => {
  it("offers screenshot and product only with the Creative Studio on", () => {
    expect(uploadAssetTypes(false)).toEqual([
      "logo",
      "photo",
      "background",
      "banner",
      "icon",
    ]);
    expect(uploadAssetTypes(true)).toEqual([
      "logo",
      "photo",
      "background",
      "banner",
      "icon",
      "screenshot",
      "product",
    ]);
  });
});
