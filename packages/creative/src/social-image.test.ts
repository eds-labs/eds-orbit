import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { prepareSocialImage } from "./index.ts";

// Social media images (ADR 0020, S3): a normalized original and a JPEG
// rendition that Instagram accepts; no metadata survives.

const solid = (width: number, height: number, alpha = false) =>
  sharp({
    create: {
      width,
      height,
      channels: alpha ? 4 : 3,
      background: alpha ? { r: 20, g: 120, b: 200, alpha: 0.5 } : { r: 20, g: 120, b: 200 },
    },
  });

describe("prepareSocialImage", () => {
  it("keeps a PNG as PNG and adds a JPEG rendition without alpha", async () => {
    const png = await solid(800, 600, true).png().toBuffer();
    const result = await prepareSocialImage(png);
    expect(result.original).toMatchObject({ mime: "image/png", width: 800, height: 600 });
    expect(result.jpeg).toMatchObject({ width: 800, height: 600 });
    const jpegMeta = await sharp(result.jpeg.bytes).metadata();
    expect(jpegMeta.format).toBe("jpeg");
    expect(jpegMeta.hasAlpha).toBe(false);
    expect(jpegMeta.space).toBe("srgb");
  });

  it("applies the EXIF orientation and drops all metadata", async () => {
    const tagged = await solid(3000, 2000)
      .jpeg()
      .withMetadata({ orientation: 6 })
      .withExif({ IFD0: { Copyright: "Ada", ImageDescription: "home" } })
      .toBuffer();
    expect((await sharp(tagged).metadata()).exif).toBeDefined();
    const result = await prepareSocialImage(tagged);
    expect(result.original).toMatchObject({ mime: "image/jpeg", width: 2000, height: 3000 });
    for (const bytes of [result.original.bytes, result.jpeg.bytes]) {
      const meta = await sharp(bytes).metadata();
      expect(meta.exif).toBeUndefined();
      expect(meta.orientation ?? 1).toBe(1);
    }
  });

  it("turns a WebP into a PNG original", async () => {
    const webp = await solid(400, 400).webp().toBuffer();
    const result = await prepareSocialImage(webp);
    expect(result.original.mime).toBe("image/png");
    expect((await sharp(result.original.bytes).metadata()).format).toBe("png");
  });

  it("scales the rendition to at most 1440 pixels wide and keeps the ratio", async () => {
    const wide = await solid(2000, 1000).png().toBuffer();
    const result = await prepareSocialImage(wide);
    expect(result.original).toMatchObject({ width: 2000, height: 1000 });
    expect(result.jpeg).toMatchObject({ width: 1440, height: 720 });
  });

  it("limits the original's longer side", async () => {
    const tall = await solid(1000, 5000).png().toBuffer();
    const result = await prepareSocialImage(tall, { maxSide: 4096 });
    expect(result.original).toMatchObject({ width: 819, height: 4096 });
  });

  it("refuses animated images", async () => {
    // A two-frame GIF built by hand (this sharp build cannot write animations).
    const frame = [0x21, 0xf9, 0x04, 0x00, 0x0a, 0x00, 0x00, 0x00, 0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0x02, 0x02, 0x44, 0x01, 0x00];
    const animated = Buffer.from([
      0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0, 0x80, 0, 0, 0, 0, 0, 255, 255, 255,
      0x21, 0xff, 0x0b, ...Buffer.from("NETSCAPE2.0"), 0x03, 0x01, 0x00, 0x00, 0x00,
      ...frame, ...frame, 0x3b,
    ]);
    expect((await sharp(animated).metadata()).pages).toBe(2);
    await expect(prepareSocialImage(animated)).rejects.toThrow("SOCIAL_MEDIA_INVALID");
  });

  it("refuses images over the pixel limit before decoding them", async () => {
    const big = await solid(5000, 5000).png({ compressionLevel: 9 }).toBuffer();
    await expect(prepareSocialImage(big, { maxPixels: 20_000_000 })).rejects.toThrow("SOCIAL_MEDIA_INVALID");
  });

  it("refuses what is not an image", async () => {
    await expect(prepareSocialImage(Buffer.from("not an image at all"))).rejects.toThrow("SOCIAL_MEDIA_INVALID");
    const gif = await solid(64, 64).gif().toBuffer();
    await expect(prepareSocialImage(gif)).rejects.toThrow("SOCIAL_MEDIA_INVALID");
  });
});
