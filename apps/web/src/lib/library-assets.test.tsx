import { describe, expect, it } from "vitest";
import { libraryAssets, type Entity } from "./api";

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
