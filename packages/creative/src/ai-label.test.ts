import { createHash } from "node:crypto";
import { crc32 } from "node:zlib";
import { beforeAll, describe, expect, it } from "vitest";
import sharp, { type Sharp } from "sharp";
import {
  AI_LABEL_TEXT,
  AI_LABEL_VERSION,
  aiLabelBox,
  aiLabelSize,
  applyAiLabel,
  carriedProvenanceXmp,
  digitalSourceTypeFor,
  findC2pa,
  inspectAiLabel,
  parseProvenanceXmp,
  provenanceXmp,
  readImageProvenance,
  verifyAiLabel,
  type AiLabelResult,
  type ImageFormat,
} from "./ai-label.ts";
import { CreativeError } from "./errors.ts";
import type { Box, RelBox } from "./templates.ts";

// AI image labelling (ADR 0028): the visible "KI erstellt" label, the
// provenance XMP, C2PA detection and the pixel check publish paths run.

type Rgb = { r: number; g: number; b: number };

const solid = (width: number, height: number, colour: Rgb, alpha?: number) =>
  sharp({
    create: {
      width,
      height,
      channels: alpha === undefined ? 3 : 4,
      background: alpha === undefined ? colour : { ...colour, alpha },
    },
  });

/** Deterministic noise (mulberry32), so busy backgrounds never make a test flaky. */
function noise(width: number, height: number, seed = 7) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) & 0xff;
  };
  const data = Buffer.alloc(width * height * 3);
  for (let i = 0; i < data.length; i++) data[i] = next();
  return sharp(data, { raw: { width, height, channels: 3 } });
}

const encode = (image: Sharp, format: ImageFormat) =>
  (format === "png"
    ? image.png()
    : format === "jpeg"
      ? image.jpeg({ quality: 95 })
      : image.webp({ quality: 95 })
  ).toBuffer();

const margin = (width: number, height: number) =>
  Math.max(16, Math.round(Math.min(width, height) * 0.035));

const overlapsWithGap = (a: Box, b: Box, gap: number) =>
  a.x < b.x + b.w + gap &&
  b.x < a.x + a.w + gap &&
  a.y < b.y + b.h + gap &&
  b.y < a.y + a.h + gap;

/** Raw RGBA pixels of a region (or the whole image). */
async function rawRegion(bytes: Buffer, box?: Box) {
  let image = sharp(bytes).ensureAlpha();
  if (box) image = image.extract({ left: box.x, top: box.y, width: box.w, height: box.h });
  return image.raw().toBuffer();
}

async function codeOf(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(CreativeError);
    return (error as CreativeError).code;
  }
  throw new Error("expected a CreativeError");
}

const ORIGIN = { origin: "ai_generated" } as const;
const BACKGROUND: Rgb = { r: 40, g: 90, b: 140 };

describe("applyAiLabel across formats and canvas shapes", () => {
  const FORMATS: ImageFormat[] = ["png", "jpeg", "webp"];
  const SIZES = [
    { name: "square", width: 1080, height: 1080 },
    { name: "vertical", width: 1080, height: 1920 },
    { name: "horizontal", width: 1200, height: 630 },
  ];
  const cases = FORMATS.flatMap((format) =>
    SIZES.map((size) => ({ format, ...size })),
  );

  it.each(cases)(
    "$format $name $width x $height: keeps format and size, labels bottom right, writes XMP",
    async ({ format, width, height }) => {
      // PNG inputs carry a half-transparent alpha channel that must survive.
      const input = await encode(
        format === "png"
          ? solid(width, height, BACKGROUND, 0.5)
          : solid(width, height, BACKGROUND),
        format,
      );
      const result = await applyAiLabel(input, ORIGIN);

      expect(result).toMatchObject({
        format,
        mime: `image/${format}`,
        width,
        height,
        alreadyLabeled: false,
        digitalSourceType: "trainedAlgorithmicMedia",
      });
      expect(result.sha256).toBe(createHash("sha256").update(result.bytes).digest("hex"));
      const meta = await sharp(result.bytes).metadata();
      expect(meta).toMatchObject({ format, width, height });

      // Bottom right, exactly inside the margin, at the documented size.
      const { w, h } = aiLabelSize(width, height);
      const m = margin(width, height);
      expect(result.label.pixels).toEqual({ x: width - m - w, y: height - m - h, w, h });
      expect(result.label.box).toEqual({
        x: expect.closeTo(result.label.pixels.x / width, 5),
        y: expect.closeTo(result.label.pixels.y / height, 5),
        w: expect.closeTo(w / width, 5),
        h: expect.closeTo(h / height, 5),
      });

      const provenance = await readImageProvenance(result.bytes);
      expect(provenance.format).toBe(format);
      expect(provenance.declaresAi).toBe(true);
      expect(provenance.xmp).toEqual({
        digitalSourceType: "trainedAlgorithmicMedia",
        origin: "ai_generated",
        label: { text: AI_LABEL_TEXT, version: AI_LABEL_VERSION, box: result.label.box },
      });
      expect(provenance.xmp.label?.text).toBe("KI erstellt");

      const check = await verifyAiLabel(result.bytes, result.label.box);
      expect(check.ok).toBe(true);

      if (format === "png") {
        expect(meta.hasAlpha).toBe(true);
        expect(meta.channels).toBe(4);
        // PNG is lossless: everything outside the label is byte-identical,
        // alpha included.
        const before = await rawRegion(input);
        const after = await rawRegion(result.bytes);
        const box = result.label.pixels;
        let changedOutside = 0;
        for (let y = 0; y < height; y++)
          for (let x = 0; x < width; x++) {
            if (x >= box.x && x < box.x + box.w && y >= box.y && y < box.y + box.h) continue;
            const i = (y * width + x) * 4;
            if (before.readUInt32BE(i) !== after.readUInt32BE(i)) changedOutside++;
          }
        expect(changedOutside).toBe(0);
        expect(after[3]).toBe(128);
      }
    },
  );
});

describe("idempotency and tampering", () => {
  let input: Buffer;
  let first: AiLabelResult;
  beforeAll(async () => {
    input = await solid(1080, 1080, BACKGROUND).png().toBuffer();
    first = await applyAiLabel(input, ORIGIN);
  });

  it("keeps an opaque PNG opaque", async () => {
    // Compositing the plate must not add an alpha channel to an opaque image.
    const meta = await sharp(first.bytes).metadata();
    expect(meta).toMatchObject({ format: "png", channels: 3, hasAlpha: false });
  });

  it("returns a labelled image unchanged when applied again", async () => {
    const second = await applyAiLabel(first.bytes, ORIGIN);
    expect(second.alreadyLabeled).toBe(true);
    expect(second.bytes.equals(first.bytes)).toBe(true);
    expect(second.sha256).toBe(first.sha256);
    expect(second.inputSha256).toBe(first.sha256);
    expect(second.label.box).toEqual(first.label.box);
    expect(second.label.version).toBe(AI_LABEL_VERSION);
  });

  it("does not draw a second label when the XMP was stripped but Orbit knows the label", async () => {
    // sharp writes no metadata unless asked: a plain re-encode strips the XMP.
    const stripped = await sharp(first.bytes).png().toBuffer();
    expect((await readImageProvenance(stripped)).xmp).toEqual({});
    const again = await applyAiLabel(stripped, { ...ORIGIN, knownLabel: first.label.box });
    expect(again.alreadyLabeled).toBe(true);
    expect(again.bytes.equals(stripped)).toBe(true);
    expect(again.label.box).toEqual(first.label.box);
  });

  it("refuses to cover a recorded label that no longer verifies", async () => {
    // Paint the plate over with the background, keep the XMP that names it.
    const box = first.label.pixels;
    const tampered = await sharp(first.bytes)
      .composite([
        {
          input: await solid(box.w, box.h, BACKGROUND).png().toBuffer(),
          left: box.x,
          top: box.y,
        },
      ])
      .png()
      .keepXmp()
      .toBuffer();
    expect((await readImageProvenance(tampered)).xmp.label?.box).toEqual(first.label.box);
    expect(await codeOf(applyAiLabel(tampered, ORIGIN))).toBe("AI_LABEL_INVALID");
    expect(await inspectAiLabel(tampered)).toMatchObject({
      state: "invalid",
      declaresAi: true,
      reason: "LABEL_NOT_LEGIBLE",
    });
    // A known label that the pixels do not show is refused the same way.
    expect(await codeOf(applyAiLabel(input, { ...ORIGIN, knownLabel: first.label.box }))).toBe(
      "AI_LABEL_INVALID",
    );
  });
});

describe("automatic contrast", () => {
  it.each([
    { name: "white", colour: { r: 255, g: 255, b: 255 }, scheme: "light" },
    { name: "black", colour: { r: 0, g: 0, b: 0 }, scheme: "dark" },
    { name: "mid grey #777777", colour: { r: 0x77, g: 0x77, b: 0x77 }, scheme: "dark" },
  ])("$name background gets the $scheme plate", async ({ colour, scheme }) => {
    const input = await solid(1080, 1080, colour).png().toBuffer();
    const result = await applyAiLabel(input, ORIGIN);
    expect(result.label.scheme).toBe(scheme);
    expect(result.label.contrast).toBeGreaterThanOrEqual(4.5);
    expect(result.label.verifiedContrast).toBeGreaterThanOrEqual(4.5);
    expect((await verifyAiLabel(result.bytes, result.label.box)).ok).toBe(true);
  });

  it("makes the plate opaque enough on a busy background", async () => {
    const input = await noise(1080, 1080).png().toBuffer();
    const result = await applyAiLabel(input, ORIGIN);
    expect(result.label.contrast).toBeGreaterThanOrEqual(4.5);
    expect(result.label.verifiedContrast).toBeGreaterThanOrEqual(4.5);
    // Even the brightest noise pixel under the plate keeps 4.5:1 to the letters.
    expect(result.label.plateOpacity).toBeGreaterThanOrEqual(0.6);
    expect(result.label.plateOpacity).toBeLessThanOrEqual(0.96);
    expect((await verifyAiLabel(result.bytes, result.label.box)).ok).toBe(true);
  });
});

describe("protected boxes and safe insets", () => {
  const W = 1080;
  const m = margin(W, W);
  const logo: Box = { x: W - m - 200, y: W - m - 120, w: 200, h: 120 };

  it("moves the label clear of a logo in the corner and leaves the logo untouched", async () => {
    // A recognisable logo: a red plate with a white square inside.
    const logoPng = await solid(logo.w, logo.h, { r: 220, g: 30, b: 40 })
      .composite([
        { input: await solid(60, 60, { r: 255, g: 255, b: 255 }).png().toBuffer(), left: 70, top: 30 },
      ])
      .png()
      .toBuffer();
    const input = await solid(W, W, BACKGROUND)
      .composite([{ input: logoPng, left: logo.x, top: logo.y }])
      .png()
      .toBuffer();
    const result = await applyAiLabel(input, { ...ORIGIN, avoid: [logo] });
    const { gap } = aiLabelSize(W, W);
    const label = result.label.pixels;
    expect(overlapsWithGap(label, logo, gap)).toBe(false);
    // Above the logo, still right-aligned at the margin.
    expect(label.x + label.w).toBe(W - m);
    expect(label.y + label.h).toBe(logo.y - gap);
    expect((await rawRegion(result.bytes, logo)).equals(await rawRegion(input, logo))).toBe(true);
    expect((await verifyAiLabel(result.bytes, result.label.box)).ok).toBe(true);
  });

  it("goes left of a protected box that reaches up to the top", () => {
    const column: Box = { x: W - m - 150, y: 0, w: 150, h: W };
    const { w, h, gap } = aiLabelSize(W, W);
    const box = aiLabelBox(W, W, { avoid: [column] });
    expect(overlapsWithGap(box, column, gap)).toBe(false);
    expect(box).toEqual({ x: column.x - gap - w, y: W - m - h, w, h });
  });

  it("fails closed when there is no room", async () => {
    const everything: Box = { x: 0, y: 0, w: W, h: W };
    expect(() => aiLabelBox(W, W, { avoid: [everything] })).toThrow("AI_LABEL_PLACEMENT_FAILED");
    const input = await solid(W, W, BACKGROUND).png().toBuffer();
    expect(await codeOf(applyAiLabel(input, { ...ORIGIN, avoid: [everything] }))).toBe(
      "AI_LABEL_PLACEMENT_FAILED",
    );
  });

  it("respects the safe insets of a story", async () => {
    const input = await solid(1080, 1920, BACKGROUND).png().toBuffer();
    const result = await applyAiLabel(input, { ...ORIGIN, safe: { bottom: 340, right: 100 } });
    const { w, h } = aiLabelSize(1080, 1920);
    expect(result.label.pixels).toEqual({ x: 1080 - 100 - w, y: 1920 - 340 - h, w, h });
    expect((await verifyAiLabel(result.bytes, result.label.box)).ok).toBe(true);
    // Insets smaller than the margin do not pull the label closer to the edge.
    const small = aiLabelBox(1080, 1920, { safe: { bottom: 4, right: 4 } });
    expect(small.x + small.w).toBe(1080 - margin(1080, 1920));
    expect(small.y + small.h).toBe(1920 - margin(1080, 1920));
  });
});

describe("digital source type", () => {
  it("names composites and substantial AI edits compositeWithTrainedAlgorithmicMedia", async () => {
    expect(digitalSourceTypeFor("ai_generated")).toBe("trainedAlgorithmicMedia");
    expect(digitalSourceTypeFor("ai_generated", true)).toBe("compositeWithTrainedAlgorithmicMedia");
    expect(digitalSourceTypeFor("ai_substantially_modified")).toBe(
      "compositeWithTrainedAlgorithmicMedia",
    );
    const input = await solid(600, 600, BACKGROUND).jpeg().toBuffer();
    for (const options of [
      { origin: "ai_generated", composite: true },
      { origin: "ai_substantially_modified" },
    ] as const) {
      const result = await applyAiLabel(input, options);
      expect(result.digitalSourceType).toBe("compositeWithTrainedAlgorithmicMedia");
      const { xmp } = await readImageProvenance(result.bytes);
      expect(xmp.digitalSourceType).toBe("compositeWithTrainedAlgorithmicMedia");
      expect(xmp.origin).toBe(options.origin);
    }
  });

  it("records a different source term the input declared", async () => {
    const xmp = provenanceXmp({ digitalSourceType: "trainedAlgorithmicMedia" });
    const input = await solid(600, 600, BACKGROUND).png().withXmp(xmp).toBuffer();
    const result = await applyAiLabel(input, { origin: "ai_generated", composite: true });
    const read = await readImageProvenance(result.bytes);
    expect(read.xmp.digitalSourceType).toBe("compositeWithTrainedAlgorithmicMedia");
    expect(read.xmp.sourceDigitalSourceType).toBe("trainedAlgorithmicMedia");
  });
});

/** A plate like the label's with other letters ("HOAX HOAX"), drawn as strokes. */
function otherTextPlate(width: number, height: number) {
  const letters = [
    "M6 30V100M44 30V100M6 65H44", // H
    "M25 30A19 35 0 1 0 25.01 30", // O
    "M4 100L24 30L44 100M11 76H37", // A
    "M4 30L44 100M44 30L4 100", // X
  ];
  const paths = [...letters, ...letters]
    .map((d, i) => `<path transform="translate(${i * 54 + (i >= 4 ? 20 : 0)} 0)" d="${d}"/>`)
    .join("");
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 480 144" preserveAspectRatio="none">` +
      `<rect width="480" height="144" rx="40" fill="#000000" fill-opacity="0.9"/>` +
      `<g transform="translate(44 8)" fill="none" stroke="#FFFFFF" stroke-width="12" stroke-linecap="round" stroke-linejoin="round">${paths}</g></svg>`,
  );
}

describe("verifyAiLabel", () => {
  let plain: Buffer;
  let rel: RelBox;
  let labelled: AiLabelResult;
  beforeAll(async () => {
    plain = await solid(1080, 1080, BACKGROUND).png().toBuffer();
    labelled = await applyAiLabel(plain, ORIGIN);
    rel = labelled.label.box;
  });

  it("fails on an image without the label", async () => {
    expect(await verifyAiLabel(plain, rel)).toMatchObject({ ok: false, reason: "LABEL_NOT_LEGIBLE" });
    const busy = await noise(1080, 1080).png().toBuffer();
    expect(await verifyAiLabel(busy, rel)).toMatchObject({ ok: false, reason: "LABEL_NOT_LEGIBLE" });
  });

  it("fails on a box outside the canvas or an empty box", async () => {
    for (const box of [
      { x: 0.95, y: 0.9, w: 0.1, h: 0.05 },
      { x: 0.5, y: 0.98, w: 0.1, h: 0.05 },
      { x: 0.5, y: 0.5, w: 0, h: 0.05 },
    ])
      expect(await verifyAiLabel(labelled.bytes, box)).toMatchObject({
        ok: false,
        reason: "LABEL_OUT_OF_BOUNDS",
      });
  });

  it("fails when a different text is drawn in the box", async () => {
    const box = labelled.label.pixels;
    const forged = await sharp(plain)
      .composite([{ input: otherTextPlate(box.w, box.h), left: box.x, top: box.y }])
      .png()
      .toBuffer();
    // The forged plate has strong contrast of its own; only the letters differ.
    expect(await verifyAiLabel(forged, rel)).toMatchObject({ ok: false, reason: "LABEL_NOT_LEGIBLE" });
  });

  it("fails when the image is scaled down until the plate is under 10 px high", async () => {
    const tiny = await sharp(labelled.bytes).resize({ width: 160 }).png().toBuffer();
    expect(Math.round(rel.h * 160)).toBeLessThan(10);
    expect(await verifyAiLabel(tiny, rel)).toMatchObject({ ok: false, reason: "LABEL_TOO_SMALL" });
  });

  it("reports unreadable bytes", async () => {
    expect(await verifyAiLabel(Buffer.from("not an image"), rel)).toMatchObject({
      ok: false,
      reason: "IMAGE_UNREADABLE",
    });
  });

  it("survives a delivery downscale to 1440 JPEG q88 and WebP q75", async () => {
    const big = await applyAiLabel(await noise(2048, 2048, 11).jpeg({ quality: 90 }).toBuffer(), ORIGIN);
    const rendition = await sharp(big.bytes).resize({ width: 1440 }).jpeg({ quality: 88 }).toBuffer();
    expect((await sharp(rendition).metadata()).width).toBe(1440);
    expect((await verifyAiLabel(rendition, big.label.box)).ok).toBe(true);
    const webp = await sharp(big.bytes).webp({ quality: 75 }).toBuffer();
    expect((await verifyAiLabel(webp, big.label.box)).ok).toBe(true);
  });
});

/** An image whose every pixel is `colour(x, y)`. */
function pattern(width: number, height: number, colour: (x: number, y: number) => number[]) {
  const data = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const [r, g, b] = colour(x, y);
      const i = (y * width + x) * 3;
      data[i] = r!;
      data[i + 1] = g ?? r!;
      data[i + 2] = b ?? r!;
    }
  return sharp(data, { raw: { width, height, channels: 3 } });
}

describe("legibility on two-tone and busy backgrounds", () => {
  const W = 1080;
  const H = 1350;
  const box = aiLabelBox(W, H);
  let state = 99;
  const random = () => {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    return state / 2 ** 32;
  };
  const cases: { name: string; colour: (x: number, y: number) => number[] }[] = [
    // 30 % of the label area black, 70 % white: the 5 % worst pixels are the
    // black ones, so the plate is drawn for them, and the check must accept
    // a plate that is two clearly separate tones.
    { name: "30/70 black/white", colour: (x) => [x < box.x + box.w * 0.3 ? 0 : 255] },
    { name: "30/70 grey 30/230", colour: (x) => [x < box.x + box.w * 0.3 ? 30 : 230] },
    { name: "70/30 black/white", colour: (x) => [x < box.x + box.w * 0.7 ? 0 : 255] },
    { name: "salt and pepper", colour: () => [0, 1, 2].map(() => (random() < 0.5 ? 0 : 255)) },
    {
      name: "hard diagonal split",
      colour: (x, y) => [(x - box.x) * box.h > (y - box.y) * box.w ? 0 : 255],
    },
    {
      name: "photo-like gradient",
      colour: (x, y) => {
        // A sky-to-ground gradient with a bright sun near the label.
        const sun = Math.hypot(x - box.x - box.w * 0.6, y - box.y) < box.h * 0.8 ? 120 : 0;
        const base = 230 - (y / H) * 180;
        return [base + sun, base * 0.9 + sun, base * 0.7 + sun].map((v) =>
          Math.max(0, Math.min(255, Math.round(v + (random() - 0.5) * 30))),
        );
      },
    },
  ];

  it.each(cases)("$name labels, self-verifies and still fails without the label", async ({ colour }) => {
    const input = await pattern(W, H, colour).png().toBuffer();
    const result = await applyAiLabel(input, ORIGIN);
    expect(result.label.pixels).toEqual(box);
    expect(result.label.contrast).toBeGreaterThanOrEqual(4.5);
    expect(result.label.verifiedContrast).toBeGreaterThanOrEqual(3);
    expect((await verifyAiLabel(result.bytes, result.label.box)).ok).toBe(true);
    // The same background without the label never passes.
    expect(await verifyAiLabel(input, result.label.box)).toMatchObject({
      ok: false,
      reason: "LABEL_NOT_LEGIBLE",
    });
    // And the label survives a JPEG delivery copy.
    const jpeg = await sharp(result.bytes).resize({ width: 720 }).jpeg({ quality: 85 }).toBuffer();
    expect((await verifyAiLabel(jpeg, result.label.box)).ok).toBe(true);
  });
});

describe("forged label boxes", () => {
  const forgedXmp = (box: RelBox) =>
    provenanceXmp({
      digitalSourceType: "trainedAlgorithmicMedia",
      label: { text: AI_LABEL_TEXT, version: AI_LABEL_VERSION, box },
    });
  const WHOLE: RelBox = { x: 0, y: 0, w: 1, h: 1 };

  it.each([
    { width: 1600, height: 1600 },
    { width: 4000, height: 3000 },
  ])("refuses a whole-canvas box on $width x $height fast", async ({ width, height }) => {
    const bytes = await solid(width, height, { r: 128, g: 128, b: 128 })
      .jpeg()
      .withXmp(forgedXmp(WHOLE))
      .toBuffer();
    const started = performance.now();
    expect(await verifyAiLabel(bytes, WHOLE)).toEqual({ ok: false, reason: "LABEL_GEOMETRY_INVALID" });
    expect(await inspectAiLabel(bytes)).toEqual({
      state: "invalid",
      declaresAi: true,
      reason: "LABEL_GEOMETRY_INVALID",
    });
    expect(await codeOf(applyAiLabel(bytes, ORIGIN))).toBe("AI_LABEL_INVALID");
    // Before the fix this took 24 s at 1600 px and hours at 40 MP.
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("refuses boxes with the wrong aspect ratio, too high for the canvas or too large", async () => {
    const W = 4000;
    const H = 3000;
    const bytes = await solid(W, H, BACKGROUND).jpeg().toBuffer();
    const { w, h } = aiLabelSize(W, H);
    const rel = (pw: number, ph: number): RelBox => ({ x: 0.01, y: 0.01, w: pw / W, h: ph / H });
    for (const forged of [
      rel(h * 2, h), // aspect 2 instead of 3.33
      rel(w * 1.3, h), // 30 % too wide
      rel(w * 2.5, h * 2.5), // right aspect, 2.5x the drawn height
      rel(1000, 300), // right aspect, 300 000 px
    ])
      expect(await verifyAiLabel(bytes, forged)).toMatchObject({
        ok: false,
        reason: "LABEL_GEOMETRY_INVALID",
      });
    // The real geometry gets past the check to the pixels (and fails there).
    expect(await verifyAiLabel(bytes, rel(w, h))).toMatchObject({ reason: "LABEL_NOT_LEGIBLE" });
  });

  it("keeps the pixel check fast for the largest box the geometry check admits", async () => {
    const W = 6000;
    const H = 6000;
    const bytes = await noise(W, 60).resize(W, H, { kernel: "nearest" }).jpeg().toBuffer();
    // 2x the drawn height of 148 px would be 296; the area cap stops at 273x910.
    const rel: RelBox = { x: 0.1, y: 0.1, w: 910 / W, h: 273 / H };
    const started = performance.now();
    expect(await verifyAiLabel(bytes, rel)).toMatchObject({ ok: false, reason: "LABEL_NOT_LEGIBLE" });
    expect(performance.now() - started).toBeLessThan(3000);
  });

  it.each([
    { size: 1080, widths: [720, 540, 320] },
    { size: 2048, widths: [1440, 1080, 600] },
    { size: 4096, widths: [2048, 1440, 1080, 640] },
  ])("lets downscales of a labelled $size px image pass", async ({ size, widths }) => {
    // Coarse noise (1 px of noise per 4 px of canvas) keeps the fixture cheap.
    const source = await sharp(await noise(size / 4, size / 4, size).png().toBuffer())
      .resize(size, size, { kernel: "nearest" })
      .jpeg({ quality: 90 })
      .toBuffer();
    const labelled = await applyAiLabel(source, ORIGIN);
    expect((await verifyAiLabel(labelled.bytes, labelled.label.box)).ok).toBe(true);
    for (const width of widths) {
      const copy = await sharp(labelled.bytes).resize({ width }).jpeg({ quality: 85 }).toBuffer();
      expect((await verifyAiLabel(copy, labelled.label.box)).ok, `${size} -> ${width}`).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// C2PA containers, built by hand around a synthetic JUMBF payload.

const C2PA_PAYLOAD = Buffer.concat([
  Buffer.from([0, 0, 0, 0x40]),
  Buffer.from("jumb", "latin1"),
  Buffer.from([0, 0, 0, 0x20]),
  Buffer.from("jumdc2pa\0\0\0\0", "latin1"),
  Buffer.from("c2pa.actions digitalSourceType http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia", "latin1"),
]);
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

function pngWithChunk(png: Buffer, type: string, payload: Buffer) {
  const chunk = Buffer.alloc(12 + payload.length);
  chunk.writeUInt32BE(payload.length, 0);
  chunk.write(type, 4, "latin1");
  payload.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, 8 + payload.length)) >>> 0, 8 + payload.length);
  // After the IHDR chunk (8 signature + 25 IHDR bytes).
  return Buffer.concat([png.subarray(0, 33), chunk, png.subarray(33)]);
}

function jpegWithApp11(jpeg: Buffer, content: Buffer) {
  // "JP" common identifier, 2-byte instance, 4-byte sequence number, then JUMBF.
  const payload = Buffer.concat([Buffer.from("JP", "latin1"), Buffer.from([0, 1, 0, 0, 0, 1]), content]);
  const segment = Buffer.alloc(4 + payload.length);
  segment.writeUInt16BE(0xffeb, 0);
  segment.writeUInt16BE(2 + payload.length, 2);
  payload.copy(segment, 4);
  return Buffer.concat([jpeg.subarray(0, 2), segment, jpeg.subarray(2)]);
}

function webpWithChunk(webp: Buffer, type: string, payload: Buffer) {
  const chunk = Buffer.alloc(8 + payload.length + (payload.length % 2));
  chunk.write(type, 0, "latin1");
  chunk.writeUInt32LE(payload.length, 4);
  payload.copy(chunk, 8);
  const out = Buffer.concat([webp, chunk]);
  out.writeUInt32LE(out.length - 8, 4);
  return out;
}

describe("C2PA detection", () => {
  let containers: { name: string; bytes: Buffer; plain: Buffer }[];
  beforeAll(async () => {
    const base = solid(320, 240, BACKGROUND);
    const png = await base.clone().png().toBuffer();
    const jpeg = await base.clone().jpeg().toBuffer();
    const webp = await base.clone().webp().toBuffer();
    containers = [
      { name: "PNG caBX", bytes: pngWithChunk(png, "caBX", C2PA_PAYLOAD), plain: png },
      { name: "JPEG APP11", bytes: jpegWithApp11(jpeg, C2PA_PAYLOAD), plain: jpeg },
      { name: "WebP C2PA", bytes: webpWithChunk(webp, "C2PA", C2PA_PAYLOAD), plain: webp },
    ];
  });

  it("finds the manifest store in PNG, JPEG and WebP and reads its AI declaration", async () => {
    for (const { name, bytes, plain } of containers) {
      expect(findC2pa(plain), name).toBeNull();
      const found = findC2pa(bytes);
      expect(found, name).toMatchObject({
        present: true,
        declaresAi: true,
        size: C2PA_PAYLOAD.length,
        sha256: sha256(C2PA_PAYLOAD),
      });
      expect(found?.bytes?.equals(C2PA_PAYLOAD), name).toBe(true);
      // Still a decodable image, and its own provenance says AI.
      const provenance = await readImageProvenance(bytes);
      expect(provenance.declaresAi, name).toBe(true);
      expect(provenance.c2pa?.sha256, name).toBe(sha256(C2PA_PAYLOAD));
      expect(provenance.xmp, name).toEqual({});
    }
  });

  it("ignores chunks without a C2PA store and stores without an AI term", async () => {
    const png = containers[0]!.plain;
    expect(findC2pa(pngWithChunk(png, "caBX", Buffer.from("jumb nothing here")))).toBeNull();
    const humanMade = Buffer.from("jumb....c2pa.actions digitalCapture", "latin1");
    expect(findC2pa(pngWithChunk(png, "caBX", humanMade))).toMatchObject({ present: true, declaresAi: false });
    expect(findC2pa(Buffer.from("not an image"))).toBeNull();
    const provenance = await readImageProvenance(pngWithChunk(png, "caBX", humanMade));
    expect(provenance.declaresAi).toBe(false);
  });

  it("records the source manifest's hash in the labelled output's XMP", async () => {
    for (const { name, bytes } of containers) {
      const result = await applyAiLabel(bytes, ORIGIN);
      expect(result.source.c2pa?.sha256, name).toBe(sha256(C2PA_PAYLOAD));
      const read = await readImageProvenance(result.bytes);
      expect(read.xmp.sourceC2paSha256, name).toBe(sha256(C2PA_PAYLOAD));
      // The manifest itself is not re-signed into the output (ADR limitation).
      expect(read.c2pa, name).toBeNull();
    }
  });
});

describe("carried provenance XMP", () => {
  it("is null for an image without provenance", async () => {
    const plain = await solid(64, 64, BACKGROUND).png().toBuffer();
    expect(carriedProvenanceXmp(await readImageProvenance(plain))).toBeNull();
    expect(carriedProvenanceXmp({ xmp: {}, c2pa: null })).toBeNull();
  });

  it("carries only the provenance fields, never other XMP content", async () => {
    const privateXmp =
      `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">` +
      `<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:exif="http://ns.adobe.com/exif/1.0/" ` +
      `xmlns:Iptc4xmpExt="http://iptc.org/std/Iptc4xmpExt/2008-02-29/" exif:GPSLatitude="48,8.123N" exif:GPSLongitude="11,34.5E" ` +
      `Iptc4xmpExt:DigitalSourceType="http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia">` +
      `<dc:creator><rdf:Seq><rdf:li>Ada Lovelace</rdf:li></rdf:Seq></dc:creator>` +
      `</rdf:Description></rdf:RDF></x:xmpmeta>`;
    const input = await solid(64, 64, BACKGROUND).png().withXmp(privateXmp).toBuffer();
    const provenance = await readImageProvenance(input);
    expect(provenance.declaresAi).toBe(true);
    const carried = carriedProvenanceXmp(provenance)!;
    expect(carried).toContain(
      'Iptc4xmpExt:DigitalSourceType="http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia"',
    );
    for (const leak of ["Ada", "Lovelace", "GPS", "48,8", "dc:", "exif:"]) expect(carried).not.toContain(leak);
    expect(parseProvenanceXmp(carried)).toEqual({ digitalSourceType: "trainedAlgorithmicMedia" });
  });

  it("carries a label and a C2PA reference", async () => {
    const labelled = await applyAiLabel(await solid(600, 400, BACKGROUND).png().toBuffer(), ORIGIN);
    const carried = carriedProvenanceXmp(await readImageProvenance(labelled.bytes))!;
    expect(parseProvenanceXmp(carried)).toEqual({
      digitalSourceType: "trainedAlgorithmicMedia",
      origin: "ai_generated",
      label: { text: AI_LABEL_TEXT, version: AI_LABEL_VERSION, box: labelled.label.box },
    });
    const c2paOnly = carriedProvenanceXmp({
      xmp: {},
      c2pa: { present: true, sha256: "a".repeat(64), size: 10, declaresAi: true },
    })!;
    expect(parseProvenanceXmp(c2paOnly)).toEqual({
      digitalSourceType: "trainedAlgorithmicMedia",
      sourceC2paSha256: "a".repeat(64),
    });
  });
});

describe("inspectAiLabel", () => {
  let plain: Buffer;
  let labelled: AiLabelResult;
  beforeAll(async () => {
    plain = await solid(800, 800, BACKGROUND).jpeg().toBuffer();
    labelled = await applyAiLabel(plain, ORIGIN);
  });

  it("does not require a label on an image nothing declares AI", async () => {
    expect(await inspectAiLabel(plain)).toEqual({ state: "not_declared", declaresAi: false });
    expect(await inspectAiLabel(Buffer.from("garbage"))).toEqual({ state: "not_declared", declaresAi: false });
  });

  it("reports a required label without any box as missing", async () => {
    expect(await inspectAiLabel(plain, { requireLabel: true })).toEqual({
      state: "missing",
      declaresAi: true,
      reason: "NO_LABEL",
    });
    // The image's own XMP can require the label too.
    const declared = await sharp(plain)
      .jpeg()
      .withXmp(provenanceXmp({ digitalSourceType: "trainedAlgorithmicMedia" }))
      .toBuffer();
    expect(await inspectAiLabel(declared)).toMatchObject({ state: "missing", reason: "NO_LABEL" });
  });

  it("accepts a labelled image, also by the recorded box after the XMP was stripped", async () => {
    expect(await inspectAiLabel(labelled.bytes)).toMatchObject({
      state: "labeled",
      box: labelled.label.box,
      declaresAi: true,
    });
    const stripped = await sharp(labelled.bytes).jpeg({ quality: 90 }).toBuffer();
    expect(await inspectAiLabel(stripped, { requireLabel: true })).toMatchObject({ state: "missing" });
    expect(
      await inspectAiLabel(stripped, { requireLabel: true, knownLabel: labelled.label.box }),
    ).toMatchObject({ state: "labeled" });
  });

  it("reports unreadable bytes as invalid when a label is required", async () => {
    expect(await inspectAiLabel(Buffer.from("garbage"), { requireLabel: true })).toEqual({
      state: "invalid",
      declaresAi: true,
      reason: "IMAGE_UNREADABLE",
    });
  });
});

describe("EXIF orientation", () => {
  it("applies the orientation first, so the image stays upright and the label sits at the visible corner", async () => {
    // Stored 1200x800 landscape, displayed as 800x1200 portrait (orientation 6).
    const oriented = await solid(1200, 800, BACKGROUND).jpeg().withMetadata({ orientation: 6 }).toBuffer();
    expect((await sharp(oriented).metadata()).orientation).toBe(6);
    const result = await applyAiLabel(oriented, ORIGIN);
    const meta = await sharp(result.bytes).metadata();
    expect(meta.orientation ?? 1).toBe(1);
    expect(meta).toMatchObject({ format: "jpeg", width: 800, height: 1200 });
    expect(result).toMatchObject({ width: 800, height: 1200 });
    const { w, h } = aiLabelSize(800, 1200);
    const m = margin(800, 1200);
    expect(result.label.pixels).toEqual({ x: 800 - m - w, y: 1200 - m - h, w, h });
    expect((await verifyAiLabel(result.bytes, result.label.box)).ok).toBe(true);
    expect(result.inputSha256).toBe(sha256(oriented));
  });
});

describe("applyAiLabel input checks", () => {
  it("refuses empty, unreadable and unsupported input", async () => {
    expect(await codeOf(applyAiLabel(Buffer.alloc(0), ORIGIN))).toBe("AI_LABEL_INPUT_INVALID");
    expect(await codeOf(applyAiLabel(Buffer.from("nope"), ORIGIN))).toBe("AI_LABEL_INPUT_INVALID");
    const gif = await solid(64, 64, BACKGROUND).gif().toBuffer();
    expect(await codeOf(applyAiLabel(gif, ORIGIN))).toBe("AI_LABEL_INPUT_INVALID");
  });
});
