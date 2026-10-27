import { describe, expect, it } from "vitest";
import { sha256Hex } from "./brand.ts";
import { solidRaster } from "./raster.ts";

describe("solidRaster", () => {
  it("is an opaque PNG of the size and colour asked for, with its SHA-256", async () => {
    const { default: sharp } = await import("sharp");
    const raster = await solidRaster("#E8604C", 300, 200);
    expect(raster.sha256).toBe(sha256Hex(raster.bytes));
    const { data, info } = await sharp(raster.bytes)
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect([info.format, info.width, info.height]).toEqual(["raw", 300, 200]);
    expect((await sharp(raster.bytes).metadata()).format).toBe("png");
    expect([...data.subarray(0, 3)]).toEqual([0xe8, 0x60, 0x4c]);
  });
});
