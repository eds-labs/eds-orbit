import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { OG_SIZE, prepareWebImage, variantWidths } from "./index.ts";

// Website images (ADR 0029, CH1.9): a normalized original, responsive WebP
// variants and an Open Graph card; no metadata survives.

const solid = (width: number, height: number, alpha = false) =>
  sharp({
    create: {
      width,
      height,
      channels: alpha ? 4 : 3,
      background: alpha ? { r: 20, g: 120, b: 200, alpha: 0.5 } : { r: 20, g: 120, b: 200 },
    },
  });

describe("variantWidths", () => {
  it("renders target widths up to the first that covers the original", () => {
    expect(variantWidths(3000)).toEqual([
      { name: "w480", width: 480 },
      { name: "w960", width: 960 },
      { name: "w1600", width: 1600 },
    ]);
    expect(variantWidths(1000)).toEqual([
      { name: "w480", width: 480 },
      { name: "w960", width: 960 },
      { name: "w1600", width: 1000 },
    ]);
    expect(variantWidths(300)).toEqual([{ name: "w480", width: 300 }]);
  });
});

describe("prepareWebImage", () => {
  it("makes a JPEG original, WebP variants and a cropped 1200x630 card", async () => {
    const jpeg = await solid(2000, 1500).withMetadata({ orientation: 6 }).jpeg().toBuffer();
    const result = await prepareWebImage(jpeg);
    // Orientation 6 turns the image upright: 1500 x 2000.
    expect(result.original).toMatchObject({ mime: "image/jpeg", width: 1500, height: 2000 });
    expect(result.variants.map((v) => [v.name, v.width, v.mime])).toEqual([
      ["w480", 480, "image/webp"],
      ["w960", 960, "image/webp"],
      ["w1600", 1500, "image/webp"],
    ]);
    expect((await sharp(result.variants[0]!.bytes).metadata()).format).toBe("webp");
    expect(result.og).toMatchObject({ name: "og", mime: "image/jpeg", ...OG_SIZE });
    const meta = await sharp(result.original.bytes).metadata();
    expect(meta.exif).toBeUndefined();
    expect(meta.orientation ?? 1).toBe(1);
  });

  it("keeps transparency as PNG and letterboxes the card when asked", async () => {
    const png = await solid(400, 400, true).png().toBuffer();
    const result = await prepareWebImage(png, { keepWhole: true });
    expect(result.original.mime).toBe("image/png");
    expect(result.variants.map((v) => v.width)).toEqual([400]);
    // Letterboxed: the square sits in the middle, white bars at the sides.
    const { data, info } = await sharp(result.og.bytes).raw().toBuffer({ resolveWithObject: true });
    const pixel = (x: number, y: number) => [...data.subarray((y * info.width + x) * info.channels, (y * info.width + x) * info.channels + 3)];
    expect(pixel(5, 315).every((v) => v > 245)).toBe(true);
    expect(pixel(600, 315).every((v) => v > 245)).toBe(false);
  });

  it("refuses animations, unknown formats and garbage", async () => {
    const gif = await sharp({ create: { width: 10, height: 10, channels: 3, background: "#fff" } }).gif().toBuffer();
    await expect(prepareWebImage(gif)).rejects.toThrow("WEB_IMAGE_INVALID");
    await expect(prepareWebImage(Buffer.from("not an image"))).rejects.toThrow("WEB_IMAGE_INVALID");
  });
});
