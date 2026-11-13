import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import sharp from "sharp";
import {
  AI_LABEL_TEXT,
  applyAiLabel,
  prepareSocialImage,
  provenanceXmp,
  readImageProvenance,
  verifyAiLabel,
} from "./index.ts";

// Social media images (ADR 0020, S3): a normalized original and a JPEG
// rendition that Instagram accepts; no metadata survives except the minimal
// provenance XMP of an AI image (ADR 0028).

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
  it("keeps a PNG with transparency as PNG and adds a JPEG rendition without alpha", async () => {
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

  it("turns an opaque WebP or PNG into a JPEG original, so photos stay small", async () => {
    for (const input of [await solid(400, 400).webp().toBuffer(), await solid(400, 400).png().toBuffer()]) {
      const result = await prepareSocialImage(input);
      expect(result.original.mime).toBe("image/jpeg");
      expect((await sharp(result.original.bytes).metadata()).format).toBe("jpeg");
    }
  });

  it("keeps transparency as PNG while the PNG stays under 10 MiB", async () => {
    const result = await prepareSocialImage(await solid(400, 400, true).webp().toBuffer());
    expect(result.original.mime).toBe("image/png");
    // Noise with transparency compresses badly: above 10 MiB it becomes JPEG.
    const noise = randomBytes(2600 * 2600 * 4);
    for (let i = 3; i < noise.length; i += 4) noise[i] = 128;
    const big = await sharp(noise, { raw: { width: 2600, height: 2600, channels: 4 } }).png({ compressionLevel: 1 }).toBuffer();
    const fallback = await prepareSocialImage(big);
    expect(fallback.original.mime).toBe("image/jpeg");
    expect(fallback.original.bytes.length).toBeLessThan(10 * 1024 * 1024);
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

  it("carries an AI label's provenance XMP to both outputs, and the label still verifies", async () => {
    const art = await sharp({
      create: { width: 2400, height: 1600, channels: 3, background: { r: 230, g: 180, b: 90 } },
    })
      .png()
      .toBuffer();
    const labelled = await applyAiLabel(art, { origin: "ai_generated" });
    const result = await prepareSocialImage(labelled.bytes);
    expect(result.original).toMatchObject({ mime: "image/jpeg", width: 2400, height: 1600 });
    expect(result.jpeg).toMatchObject({ width: 1440, height: 960 });
    for (const bytes of [result.original.bytes, result.jpeg.bytes]) {
      const provenance = await readImageProvenance(bytes);
      expect(provenance.xmp).toEqual({
        digitalSourceType: "trainedAlgorithmicMedia",
        origin: "ai_generated",
        label: { text: AI_LABEL_TEXT, version: labelled.label.version, box: labelled.label.box },
      });
      expect(provenance.declaresAi).toBe(true);
      expect((await verifyAiLabel(bytes, labelled.label.box)).ok).toBe(true);
      expect((await sharp(bytes).metadata()).exif).toBeUndefined();
    }
  });

  it("keeps the provenance XMP on a transparent PNG original", async () => {
    const labelled = await applyAiLabel(await solid(1200, 900, true).png().toBuffer(), { origin: "ai_generated" });
    const result = await prepareSocialImage(labelled.bytes);
    expect(result.original.mime).toBe("image/png");
    for (const bytes of [result.original.bytes, result.jpeg.bytes]) {
      expect((await readImageProvenance(bytes)).xmp.label?.box).toEqual(labelled.label.box);
      expect((await verifyAiLabel(bytes, labelled.label.box)).ok).toBe(true);
    }
  });

  it("writes no XMP at all for an image without provenance", async () => {
    const result = await prepareSocialImage(await solid(800, 600).jpeg().toBuffer());
    for (const bytes of [result.original.bytes, result.jpeg.bytes])
      expect((await sharp(bytes).metadata()).xmp).toBeUndefined();
  });

  it("drops private XMP fields and keeps only the provenance", async () => {
    const privateXmp =
      `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">` +
      `<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:exif="http://ns.adobe.com/exif/1.0/" exif:GPSLatitude="48,8.123N">` +
      `<dc:creator><rdf:Seq><rdf:li>Ada Lovelace</rdf:li></rdf:Seq></dc:creator></rdf:Description></rdf:RDF></x:xmpmeta>`;
    // Without provenance the private packet disappears completely.
    const tagged = await solid(800, 600).jpeg().withXmp(privateXmp).toBuffer();
    expect((await sharp(tagged).metadata()).xmp?.toString("utf8")).toContain("Ada Lovelace");
    const plain = await prepareSocialImage(tagged);
    for (const bytes of [plain.original.bytes, plain.jpeg.bytes])
      expect((await sharp(bytes).metadata()).xmp).toBeUndefined();
    // With provenance (here: the declaration added to the same packet) only
    // the provenance fields are written.
    const declared = privateXmp.replace(
      'exif:GPSLatitude="48,8.123N"',
      'exif:GPSLatitude="48,8.123N" xmlns:Iptc4xmpExt="http://iptc.org/std/Iptc4xmpExt/2008-02-29/" Iptc4xmpExt:DigitalSourceType="http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia"',
    );
    const result = await prepareSocialImage(await solid(800, 600).jpeg().withXmp(declared).toBuffer());
    for (const bytes of [result.original.bytes, result.jpeg.bytes]) {
      const xmp = (await sharp(bytes).metadata()).xmp!.toString("utf8");
      expect(xmp).toContain("trainedAlgorithmicMedia");
      for (const leak of ["Ada", "Lovelace", "GPS", "dc:creator"]) expect(xmp).not.toContain(leak);
      expect((await readImageProvenance(bytes)).xmp).toEqual({ digitalSourceType: "trainedAlgorithmicMedia" });
    }
    expect(provenanceXmp({ digitalSourceType: "trainedAlgorithmicMedia" })).not.toContain("Ada");
  });
});
