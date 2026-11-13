// AI image labelling (ADR 0028): the visible "KI erstellt" label on the
// finished image, its machine-readable provenance (IPTC DigitalSourceType in
// XMP) and the pixel check that every publish path runs before an image
// leaves Orbit.
//
// The label is drawn from fixed vector glyphs, never from an installed font,
// so drawing and checking give the same pixels on every machine. Its
// geometry is stored as a box in fractions of the canvas, which stays valid
// when a delivery step scales the image down.
import { createHash } from "node:crypto";
import { contrastRatio, LINEAR_CHANNEL } from "./color.ts";
import { CreativeError } from "./errors.ts";
import type { Box, RelBox } from "./templates.ts";

/** The exact visible label. */
export const AI_LABEL_TEXT = "KI erstellt";
/** Bumped whenever the drawing or the check changes. */
export const AI_LABEL_VERSION = 1;

/** Where an image came from, as Orbit records it centrally. */
export type ImageOrigin =
  | "ai_generated"
  | "ai_substantially_modified"
  | "original_upload";
export const IMAGE_ORIGINS: readonly ImageOrigin[] = [
  "ai_generated",
  "ai_substantially_modified",
  "original_upload",
];
/** Origins whose images must carry the visible label. */
export const labelRequired = (origin: ImageOrigin) =>
  origin !== "original_upload";

const IPTC_DST = "http://cv.iptc.org/newscodes/digitalsourcetype/";
/** IPTC Digital Source Type terms Orbit writes or recognises as AI. */
export const AI_DIGITAL_SOURCE_TYPES = [
  "trainedAlgorithmicMedia",
  "compositeWithTrainedAlgorithmicMedia",
] as const;
export type AiDigitalSourceType = (typeof AI_DIGITAL_SOURCE_TYPES)[number];
/** The IPTC term for an origin: a pure generation, or a composite with AI parts. */
export function digitalSourceTypeFor(
  origin: Exclude<ImageOrigin, "original_upload">,
  composite = false,
): AiDigitalSourceType {
  return origin === "ai_generated" && !composite
    ? "trainedAlgorithmicMedia"
    : "compositeWithTrainedAlgorithmicMedia";
}

// ---------------------------------------------------------------------------
// Glyphs: one stroke font for the ten letters of the label, in units where
// the baseline is y=100, capitals reach y=30 and the stroke is 12 wide.
const GLYPHS: Record<string, { d: string; advance: number }> = {
  K: { d: "M6 30V100M44 30L8 70M20 58L46 100", advance: 54 },
  I: { d: "M6 30V100", advance: 24 },
  " ": { d: "", advance: 20 },
  e: { d: "M4 76H44A20 24 0 1 0 39 93", advance: 52 },
  r: { d: "M6 52V100M6 70Q10 54 32 54", advance: 38 },
  s: {
    d: "M34 58Q28 52 19 52Q5 52 5 63Q5 73 19 76Q35 79 35 89Q35 100 19 100Q7 100 2 93",
    advance: 42,
  },
  t: { d: "M14 36V88Q14 100 26 100M2 54H28", advance: 32 },
  l: { d: "M6 28V100", advance: 22 },
};
const STROKE = 12;
const INK_TOP = 22; // highest stroke edge (the l), in glyph units
const INK_HEIGHT = 84; // 22..106
const CAP_HEIGHT = 70;
const glyphRuns = (() => {
  let x = 0;
  const runs: { d: string; x: number }[] = [];
  for (const char of AI_LABEL_TEXT) {
    const glyph = GLYPHS[char];
    if (!glyph) throw new Error(`no glyph for ${char}`);
    if (glyph.d) runs.push({ d: glyph.d, x });
    x += glyph.advance;
  }
  // The last glyph's ink ends at its own x 28 plus half a stroke.
  return { runs, inkWidth: x - GLYPHS.t!.advance + 28 + STROKE / 2 };
})();
const PAD_X = 44;
const PAD_Y = 30;
/** The plate in glyph units; the label keeps this aspect ratio at any size. */
const PLATE_W = glyphRuns.inkWidth + 2 * PAD_X;
const PLATE_H = INK_HEIGHT + 2 * PAD_Y;

type LabelColours = { plate: string; text: string; opacity: number };

/** The label as SVG of the given pixel size; `maskOnly` draws only the letters, in white. */
function labelSvg(
  width: number,
  height: number,
  colours: LabelColours | "mask",
) {
  const mask = colours === "mask";
  const radius = PLATE_H * 0.28;
  const letters = glyphRuns.runs
    .map((run) => `<path transform="translate(${run.x} 0)" d="${run.d}"/>`)
    .join("");
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${PLATE_W} ${PLATE_H}" preserveAspectRatio="none">` +
      (mask
        ? ""
        : `<rect width="${PLATE_W}" height="${PLATE_H}" rx="${radius}" fill="${colours.plate}" fill-opacity="${colours.opacity}"/>`) +
      `<g transform="translate(${PAD_X} ${PAD_Y - INK_TOP})" fill="none" stroke="${mask ? "#FFFFFF" : colours.text}" stroke-width="${STROKE}" stroke-linecap="round" stroke-linejoin="round">${letters}</g></svg>`,
  );
}

// ---------------------------------------------------------------------------
// Geometry

/** Pixels around the canvas edge the label keeps clear of, per side. */
export type SafeInsets = { right: number; bottom: number };

/** Size of the label on a canvas: the capitals are 2.4 % of the short side, 16..72 px. */
export function aiLabelSize(width: number, height: number) {
  const cap = Math.min(
    72,
    Math.max(16, Math.round(Math.min(width, height) * 0.024)),
  );
  const scale = cap / CAP_HEIGHT;
  return {
    w: Math.round(PLATE_W * scale),
    h: Math.round(PLATE_H * scale),
    gap: Math.max(8, Math.round(cap * 0.6)),
  };
}

const overlaps = (a: Box, b: Box, gap: number) =>
  a.x < b.x + b.w + gap &&
  b.x < a.x + a.w + gap &&
  a.y < b.y + b.h + gap &&
  b.y < a.y + a.h + gap;

/**
 * Where the label goes: the bottom-right corner inside the safety margin
 * (3.5 % of the short side, at least 16 px, or the format's safe insets when
 * larger). When a protected layer (logo, logo plate, text) is there, the
 * label moves up above it, right-aligned, or else left of it on the same
 * line; it never covers a protected box. No room throws
 * `AI_LABEL_PLACEMENT_FAILED`.
 */
export function aiLabelBox(
  width: number,
  height: number,
  options: { safe?: Partial<SafeInsets>; avoid?: readonly Box[] } = {},
): Box {
  const { w, h, gap } = aiLabelSize(width, height);
  const margin = Math.max(16, Math.round(Math.min(width, height) * 0.035));
  const right = Math.max(margin, options.safe?.right ?? 0);
  const bottom = Math.max(margin, options.safe?.bottom ?? 0);
  const avoid = options.avoid ?? [];
  const fits = (box: Box) =>
    box.x >= margin &&
    box.y >= margin &&
    box.x + box.w <= width - right &&
    box.y + box.h <= height - bottom &&
    avoid.every((other) => !overlaps(box, other, gap));
  const start: Box = { x: width - right - w, y: height - bottom - h, w, h };
  const queue: Box[] = [start];
  const seen = new Set<string>();
  while (queue.length) {
    const box = queue.shift()!;
    const key = `${box.x},${box.y}`;
    if (seen.has(key) || box.x < margin || box.y < margin) continue;
    seen.add(key);
    if (fits(box)) return box;
    // Candidates stay as close to the corner as they can: above a blocking
    // box first (still right-aligned), then left of it on the same line.
    const blocking = avoid
      .filter((other) => overlaps(box, other, gap))
      .sort((a, b) => b.y + b.h - (a.y + a.h));
    for (const other of blocking) {
      queue.push({ ...box, y: other.y - gap - h });
      queue.push({ ...box, x: other.x - gap - w });
    }
    if (queue.length > 64) break;
  }
  throw new CreativeError("AI_LABEL_PLACEMENT_FAILED");
}

const toRel = (box: Box, width: number, height: number): RelBox => ({
  x: round6(box.x / width),
  y: round6(box.y / height),
  w: round6(box.w / width),
  h: round6(box.h / height),
});
const round6 = (n: number) => Math.round(n * 1e6) / 1e6;
const fromRel = (rel: RelBox, width: number, height: number): Box => ({
  x: Math.round(rel.x * width),
  y: Math.round(rel.y * height),
  w: Math.round(rel.w * width),
  h: Math.round(rel.h * height),
});

// ---------------------------------------------------------------------------
// Pixels

type Sharp = typeof import("sharp");
let sharpModule: Sharp | null = null;
async function loadSharp(): Promise<Sharp> {
  sharpModule ??= (await import("sharp")).default;
  return sharpModule;
}
const MAX_PIXELS = 40_000_000;
const open = (sharp: Sharp, bytes: Buffer) =>
  sharp(bytes, {
    limitInputPixels: MAX_PIXELS,
    failOn: "warning",
    animated: false,
  });

/** Relative luminance of every pixel of a region, alpha flattened onto white. */
async function regionLuminance(sharp: Sharp, bytes: Buffer, box: Box) {
  const { data } = await open(sharp, bytes)
    .extract({ left: box.x, top: box.y, width: box.w, height: box.h })
    .flatten({ background: "#ffffff" })
    .removeAlpha()
    .toColourspace("srgb")
    .raw()
    .toBuffer({ resolveWithObject: true });
  const out = new Float64Array(box.w * box.h);
  for (let i = 0; i < out.length; i++)
    out[i] =
      0.2126 * LINEAR_CHANNEL[data[i * 3]!]! +
      0.7152 * LINEAR_CHANNEL[data[i * 3 + 1]!]! +
      0.0722 * LINEAR_CHANNEL[data[i * 3 + 2]!]!;
  return { lum: out, rgb: data };
}

/**
 * The plate colours for a region: a dark plate with white letters on dark or
 * mid backgrounds, a light plate with near-black letters on light ones. The
 * plate starts translucent (0.6) and gets more opaque until the letters
 * reach 4.5:1 against even the brightest (or darkest) 5 % of the plate.
 */
function chooseColours(rgb: Buffer, lum: Float64Array): LabelColours & {
  scheme: "dark" | "light";
  contrast: number;
} {
  const mean = lum.reduce((a, b) => a + b, 0) / lum.length;
  const scheme = mean > 0.4 ? "light" : "dark";
  const plate = scheme === "light" ? 255 : 0;
  const text = scheme === "light" ? "#111111" : "#FFFFFF";
  for (let opacity = 0.6; opacity <= 0.96 + 1e-9; opacity += 0.06) {
    const blended = new Float64Array(lum.length);
    for (let i = 0; i < lum.length; i++) {
      const c = (k: number) =>
        Math.round(rgb[i * 3 + k]! * (1 - opacity) + plate * opacity);
      blended[i] =
        0.2126 * LINEAR_CHANNEL[c(0)]! +
        0.7152 * LINEAR_CHANNEL[c(1)]! +
        0.0722 * LINEAR_CHANNEL[c(2)]!;
    }
    blended.sort();
    // The plate pixels closest to the letter colour decide.
    const worst =
      scheme === "light"
        ? blended[Math.floor(blended.length * 0.05)]!
        : blended[Math.ceil(blended.length * 0.95) - 1]!;
    const contrast = contrastRatio(text, worst);
    if (contrast >= 4.5)
      return {
        plate: scheme === "light" ? "#FFFFFF" : "#000000",
        text,
        opacity: Math.round(opacity * 100) / 100,
        scheme,
        contrast: Math.round(contrast * 100) / 100,
      };
  }
  // 96 % of black or white under the letters always clears 4.5:1.
  throw new CreativeError("AI_LABEL_CONTRAST_FAILED");
}

export type AiLabelCheck =
  | { ok: true; contrast: number; textPixels: number; platePixels: number }
  | {
      ok: false;
      reason:
        | "LABEL_OUT_OF_BOUNDS"
        | "LABEL_TOO_SMALL"
        | "LABEL_NOT_LEGIBLE"
        | "IMAGE_UNREADABLE";
      contrast?: number;
    };

/**
 * Whether an image shows the label at `rel` (fractions of the canvas). The
 * letters of the expected label are rendered at that box as a mask; the
 * image's pixels under the letter cores must stand clearly apart from the
 * plate around them (3:1 at least, 90 % of each group on its own side).
 * That tolerates JPEG compression and scaling, and fails when the label is
 * missing, covered, cut off or a different text.
 */
export async function verifyAiLabel(
  bytes: Buffer,
  rel: RelBox,
): Promise<AiLabelCheck> {
  const sharp = await loadSharp();
  let width: number, height: number;
  try {
    const meta = await open(sharp, bytes).metadata();
    if (!meta.width || !meta.height) return { ok: false, reason: "IMAGE_UNREADABLE" };
    width = meta.width;
    height = meta.height;
  } catch {
    return { ok: false, reason: "IMAGE_UNREADABLE" };
  }
  const box = fromRel(rel, width, height);
  if (
    !(box.w > 0 && box.h > 0) ||
    box.x < 0 ||
    box.y < 0 ||
    box.x + box.w > width ||
    box.y + box.h > height
  )
    return { ok: false, reason: "LABEL_OUT_OF_BOUNDS" };
  // Below 10 px of plate height the letters no longer read (cap ~5 px).
  if (box.h < 10) return { ok: false, reason: "LABEL_TOO_SMALL" };
  let lum: Float64Array;
  try {
    ({ lum } = await regionLuminance(sharp, bytes, box));
  } catch {
    return { ok: false, reason: "IMAGE_UNREADABLE" };
  }
  const { data: mask } = await sharp(labelSvg(box.w, box.h, "mask"))
    .ensureAlpha()
    .extractChannel(3)
    .raw()
    .toBuffer({ resolveWithObject: true });
  // Plate pixels: away from every letter by `spread`, and off the rounded corners.
  const spread = Math.max(1, Math.round(box.h * 0.06));
  const radius = Math.ceil((box.h * 0.28) / 1);
  const nearInk = new Uint8Array(box.w * box.h);
  for (let y = 0; y < box.h; y++)
    for (let x = 0; x < box.w; x++) {
      if (mask[y * box.w + x]! === 0) continue;
      for (let dy = -spread; dy <= spread; dy++)
        for (let dx = -spread; dx <= spread; dx++) {
          const yy = y + dy,
            xx = x + dx;
          if (yy >= 0 && yy < box.h && xx >= 0 && xx < box.w)
            nearInk[yy * box.w + xx] = 1;
        }
    }
  const text: number[] = [];
  const plate: number[] = [];
  const edge = Math.max(1, Math.round(box.h * 0.04));
  for (let y = 0; y < box.h; y++)
    for (let x = 0; x < box.w; x++) {
      const i = y * box.w + x;
      if (mask[i]! >= 250) text.push(lum[i]!);
      else if (!nearInk[i]) {
        const cornerX = x < radius || x >= box.w - radius;
        const cornerY = y < radius || y >= box.h - radius;
        const border =
          x < edge || y < edge || x >= box.w - edge || y >= box.h - edge;
        if (!(cornerX && cornerY) && !border) plate.push(lum[i]!);
      }
    }
  if (text.length < 20 || plate.length < 20)
    return { ok: false, reason: "LABEL_TOO_SMALL" };
  const mean = (values: number[]) =>
    values.reduce((a, b) => a + b, 0) / values.length;
  const lt = mean(text),
    lp = mean(plate);
  const contrast = Math.round(contrastRatio(lt, lp) * 100) / 100;
  const mid = (lt + lp) / 2;
  const side = (values: number[], above: boolean) =>
    values.filter((v) => (above ? v > mid : v < mid)).length / values.length;
  const textAbove = lt > lp;
  if (
    contrast < 3 ||
    side(text, textAbove) < 0.9 ||
    side(plate, !textAbove) < 0.9
  )
    return { ok: false, reason: "LABEL_NOT_LEGIBLE", contrast };
  return {
    ok: true,
    contrast,
    textPixels: text.length,
    platePixels: plate.length,
  };
}

// ---------------------------------------------------------------------------
// Machine-readable provenance

const ORBIT_NS = "https://eds-labs.io/ns/orbit/1.0/";

/** What Orbit writes into (and reads back from) an image's XMP packet. */
export type ProvenanceXmpFields = {
  digitalSourceType: string;
  label?: { text: string; version: number; box: RelBox };
  origin?: ImageOrigin;
  /** SHA-256 of a C2PA manifest store the source carried, kept by reference. */
  sourceC2paSha256?: string;
  /** The IPTC term the source declared, when Orbit's differs. */
  sourceDigitalSourceType?: string;
};

const xmlAttr = (value: string) =>
  value.replace(/[&<>"]/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&quot;",
  );

/**
 * A minimal XMP packet: the IPTC Digital Source Type and Orbit's label
 * fields. Nothing else of a source's XMP is carried, so camera or personal
 * metadata never travels with a published image.
 */
export function provenanceXmp(fields: ProvenanceXmpFields): string {
  const term = /^https?:\/\//.test(fields.digitalSourceType)
    ? fields.digitalSourceType
    : IPTC_DST + fields.digitalSourceType;
  const attrs = [
    `Iptc4xmpExt:DigitalSourceType="${xmlAttr(term)}"`,
    fields.origin ? `orbit:origin="${fields.origin}"` : "",
    fields.label
      ? `orbit:aiLabel="${xmlAttr(fields.label.text)}" orbit:aiLabelVersion="${fields.label.version}" orbit:aiLabelBox="${[fields.label.box.x, fields.label.box.y, fields.label.box.w, fields.label.box.h].join(",")}"`
      : "",
    fields.sourceC2paSha256
      ? `orbit:sourceC2paSha256="${fields.sourceC2paSha256}"`
      : "",
    fields.sourceDigitalSourceType
      ? `orbit:sourceDigitalSourceType="${xmlAttr(fields.sourceDigitalSourceType)}"`
      : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">` +
    `<rdf:Description rdf:about="" xmlns:Iptc4xmpExt="http://iptc.org/std/Iptc4xmpExt/2008-02-29/" xmlns:orbit="${ORBIT_NS}" ${attrs}/>` +
    `</rdf:RDF></x:xmpmeta>`
  );
}

const xmpValue = (xmp: string, name: string) => {
  const escaped = name.replace(":", "\\:");
  const attr = new RegExp(`${escaped}\\s*=\\s*"([^"]*)"`).exec(xmp);
  if (attr) return attr[1]!.trim();
  const element = new RegExp(`<${escaped}(?:\\s[^>]*)?>([^<]*)</${escaped}>`).exec(xmp);
  if (element) return element[1]!.trim();
  const resource = new RegExp(`<${escaped}[^>]*rdf:resource\\s*=\\s*"([^"]*)"`).exec(xmp);
  return resource ? resource[1]!.trim() : undefined;
};
const shortTerm = (term: string | undefined) =>
  term ? term.replace(/^https?:\/\/cv\.iptc\.org\/newscodes\/digitalsourcetype\//, "") : undefined;

/** Orbit's fields of an XMP packet, if any; malformed values are ignored. */
export function parseProvenanceXmp(xmp: string): Partial<ProvenanceXmpFields> {
  const out: Partial<ProvenanceXmpFields> = {};
  const term = shortTerm(xmpValue(xmp, "Iptc4xmpExt:DigitalSourceType"));
  if (term && term.length <= 200) out.digitalSourceType = term;
  const origin = xmpValue(xmp, "orbit:origin");
  if (origin && (IMAGE_ORIGINS as readonly string[]).includes(origin))
    out.origin = origin as ImageOrigin;
  const text = xmpValue(xmp, "orbit:aiLabel");
  const version = Number(xmpValue(xmp, "orbit:aiLabelVersion"));
  const box = (xmpValue(xmp, "orbit:aiLabelBox") ?? "").split(",").map(Number);
  if (
    text &&
    Number.isInteger(version) &&
    version > 0 &&
    box.length === 4 &&
    box.every((n) => Number.isFinite(n) && n >= 0 && n <= 1)
  )
    out.label = {
      text,
      version,
      box: { x: box[0]!, y: box[1]!, w: box[2]!, h: box[3]! },
    };
  const c2pa = xmpValue(xmp, "orbit:sourceC2paSha256");
  if (c2pa && /^[0-9a-f]{64}$/.test(c2pa)) out.sourceC2paSha256 = c2pa;
  const source = shortTerm(xmpValue(xmp, "orbit:sourceDigitalSourceType"));
  if (source && source.length <= 200) out.sourceDigitalSourceType = source;
  return out;
}

export type C2paFinding = {
  present: true;
  /** SHA-256 and size of the embedded manifest store (JUMBF). */
  sha256: string;
  size: number;
  /** Whether the manifest names an AI digital source type. */
  declaresAi: boolean;
  /** The manifest store bytes, kept by Orbit when they are at most 1 MiB. */
  bytes?: Buffer;
};

const MAX_KEPT_MANIFEST = 1024 * 1024;

/** The embedded C2PA manifest store of a PNG (caBX), JPEG (APP11 JUMBF) or WebP (C2PA chunk). */
export function findC2pa(bytes: Buffer): C2paFinding | null {
  const parts: Buffer[] = [];
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    for (let at = 8; at + 12 <= bytes.length; ) {
      const length = bytes.readUInt32BE(at);
      const type = bytes.toString("latin1", at + 4, at + 8);
      if (at + 12 + length > bytes.length) break;
      if (type === "caBX") parts.push(bytes.subarray(at + 8, at + 8 + length));
      if (type === "IEND") break;
      at += 12 + length;
    }
  } else if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    for (let at = 2; at + 4 <= bytes.length; ) {
      if (bytes[at] !== 0xff) break;
      const marker = bytes[at + 1]!;
      if (marker === 0xd9 || marker === 0xda) break;
      if (marker >= 0xd0 && marker <= 0xd7) {
        at += 2;
        continue;
      }
      const length = bytes.readUInt16BE(at + 2);
      const payload = bytes.subarray(at + 4, at + 2 + length);
      // APP11 with the JPEG XT "JP" common identifier carries JUMBF boxes.
      if (marker === 0xeb && payload.toString("latin1", 0, 2) === "JP")
        parts.push(payload.subarray(8));
      at += 2 + length;
    }
  } else if (
    bytes.toString("latin1", 0, 4) === "RIFF" &&
    bytes.toString("latin1", 8, 12) === "WEBP"
  ) {
    for (let at = 12; at + 8 <= bytes.length; ) {
      const type = bytes.toString("latin1", at, at + 4);
      const length = bytes.readUInt32LE(at + 4);
      if (at + 8 + length > bytes.length) break;
      if (type === "C2PA") parts.push(bytes.subarray(at + 8, at + 8 + length));
      at += 8 + length + (length % 2);
    }
  }
  if (!parts.length) return null;
  const store = Buffer.concat(parts);
  if (!store.includes("c2pa", 0, "latin1")) return null;
  return {
    present: true,
    sha256: createHash("sha256").update(store).digest("hex"),
    size: store.length,
    declaresAi: AI_DIGITAL_SOURCE_TYPES.some((term) =>
      store.includes(term, 0, "latin1"),
    ),
    ...(store.length <= MAX_KEPT_MANIFEST ? { bytes: Buffer.from(store) } : {}),
  };
}

export type ImageFormat = "png" | "jpeg" | "webp";
export type EmbeddedProvenance = {
  format: ImageFormat;
  width: number;
  height: number;
  sha256: string;
  xmp: Partial<ProvenanceXmpFields>;
  c2pa: C2paFinding | null;
  /** True when XMP or C2PA declares the image AI-generated or AI-composited. */
  declaresAi: boolean;
};

/** What an image says about itself: format, Orbit/IPTC XMP fields and C2PA. */
export async function readImageProvenance(
  bytes: Buffer,
): Promise<EmbeddedProvenance> {
  const sharp = await loadSharp();
  let meta: import("sharp").Metadata;
  try {
    meta = await open(sharp, bytes).metadata();
  } catch {
    throw new CreativeError("AI_LABEL_INPUT_INVALID");
  }
  const format = meta.format;
  if (
    (format !== "png" && format !== "jpeg" && format !== "webp") ||
    !meta.width ||
    !meta.height ||
    (meta.pages ?? 1) !== 1
  )
    throw new CreativeError("AI_LABEL_INPUT_INVALID");
  const xmp = meta.xmp ? parseProvenanceXmp(meta.xmp.toString("utf8")) : {};
  const c2pa = findC2pa(bytes);
  return {
    format,
    width: meta.width,
    height: meta.height,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    xmp,
    c2pa,
    declaresAi:
      (AI_DIGITAL_SOURCE_TYPES as readonly string[]).includes(
        xmp.digitalSourceType ?? "",
      ) ||
      Boolean(xmp.label) ||
      Boolean(c2pa?.declaresAi),
  };
}

/**
 * The XMP an encoder should write on a derived image (resize, re-encode) so
 * the provenance survives: only Orbit's and the IPTC fields, never the rest.
 * Null when the source carried none of them.
 */
export function carriedProvenanceXmp(
  source: Pick<EmbeddedProvenance, "xmp" | "c2pa">,
): string | null {
  const { xmp, c2pa } = source;
  const digitalSourceType =
    xmp.digitalSourceType ?? (c2pa?.declaresAi ? "trainedAlgorithmicMedia" : undefined);
  if (!digitalSourceType && !xmp.label) return null;
  return provenanceXmp({
    digitalSourceType: digitalSourceType ?? "trainedAlgorithmicMedia",
    ...(xmp.label ? { label: xmp.label } : {}),
    ...(xmp.origin ? { origin: xmp.origin } : {}),
    ...((xmp.sourceC2paSha256 ?? c2pa?.sha256)
      ? { sourceC2paSha256: xmp.sourceC2paSha256 ?? c2pa!.sha256 }
      : {}),
    ...(xmp.sourceDigitalSourceType
      ? { sourceDigitalSourceType: xmp.sourceDigitalSourceType }
      : {}),
  });
}

// ---------------------------------------------------------------------------
// Applying the label

export type AiLabelRecord = {
  text: typeof AI_LABEL_TEXT;
  version: number;
  /** The plate in fractions of the canvas; valid at any scale of the image. */
  box: RelBox;
  /** The plate in pixels of this image. */
  pixels: Box;
  scheme: "dark" | "light";
  plateOpacity: number;
  /** Letters against the plate as drawn (planned) and as checked afterwards. */
  contrast: number;
  verifiedContrast: number;
};

export type AiLabelInput = {
  origin: Exclude<ImageOrigin, "original_upload">;
  /** The image is a composite with AI parts (a creative over generated art). */
  composite?: boolean;
  /** Protected layers (logo, logo plate, text) the label must not cover, in pixels. */
  avoid?: readonly Box[];
  safe?: Partial<SafeInsets>;
  /** A label Orbit already recorded for these bytes (when their XMP was stripped). */
  knownLabel?: RelBox;
};

export type AiLabelResult = {
  bytes: Buffer;
  format: ImageFormat;
  mime: "image/png" | "image/jpeg" | "image/webp";
  width: number;
  height: number;
  sha256: string;
  inputSha256: string;
  /** True when the image already carried a valid label and was returned unchanged. */
  alreadyLabeled: boolean;
  label: AiLabelRecord;
  digitalSourceType: string;
  /** What the input said about itself (kept by the caller with the record). */
  source: EmbeddedProvenance;
};

const MIME = { png: "image/png", jpeg: "image/jpeg", webp: "image/webp" } as const;

/**
 * Draws "KI erstellt" on a finished image and writes the provenance XMP.
 * Call it on the final bytes, after every layout, crop and resize step; it
 * keeps the input's format (PNG, JPEG, WebP) and size. An image that already
 * carries Orbit's label (in its XMP, or as `knownLabel`) is checked and
 * returned unchanged, so running it twice never draws a second label; a
 * recorded label that no longer checks out throws `AI_LABEL_INVALID` rather
 * than being covered by another one.
 */
export async function applyAiLabel(
  bytes: Buffer,
  input: AiLabelInput,
): Promise<AiLabelResult> {
  if (!Buffer.isBuffer(bytes) || !bytes.length)
    throw new CreativeError("AI_LABEL_INPUT_INVALID");
  const sharp = await loadSharp();
  const source = await readImageProvenance(bytes);
  const { width, height, format } = source;
  const digitalSourceType = digitalSourceTypeFor(input.origin, input.composite);
  const existing = source.xmp.label?.box ?? input.knownLabel;
  if (existing) {
    const check = await verifyAiLabel(bytes, existing);
    if (!check.ok) throw new CreativeError("AI_LABEL_INVALID");
    return {
      bytes,
      format,
      mime: MIME[format],
      width,
      height,
      sha256: source.sha256,
      inputSha256: source.sha256,
      alreadyLabeled: true,
      label: {
        text: AI_LABEL_TEXT,
        version: source.xmp.label?.version ?? AI_LABEL_VERSION,
        box: existing,
        pixels: fromRel(existing, width, height),
        scheme: "dark",
        plateOpacity: 0,
        contrast: check.contrast,
        verifiedContrast: check.contrast,
      },
      digitalSourceType: source.xmp.digitalSourceType ?? digitalSourceType,
      source,
    };
  }
  const box = aiLabelBox(width, height, {
    ...(input.safe ? { safe: input.safe } : {}),
    ...(input.avoid ? { avoid: input.avoid } : {}),
  });
  const { lum, rgb } = await regionLuminance(sharp, bytes, box);
  const colours = chooseColours(rgb, lum);
  const rel = toRel(box, width, height);
  const xmp = provenanceXmp({
    digitalSourceType,
    origin: input.origin,
    label: { text: AI_LABEL_TEXT, version: AI_LABEL_VERSION, box: rel },
    ...(source.c2pa ? { sourceC2paSha256: source.c2pa.sha256 } : {}),
    ...(source.xmp.digitalSourceType &&
    source.xmp.digitalSourceType !== digitalSourceType
      ? { sourceDigitalSourceType: source.xmp.digitalSourceType }
      : {}),
  });
  let pipeline = open(sharp, bytes).composite([
    { input: labelSvg(box.w, box.h, colours), left: box.x, top: box.y },
  ]);
  pipeline =
    format === "png"
      ? pipeline.png({ compressionLevel: 9, adaptiveFiltering: true })
      : format === "jpeg"
        ? pipeline.jpeg({ quality: 92, mozjpeg: true })
        : pipeline.webp({ quality: 90 });
  let output: Buffer;
  try {
    output = await pipeline.withXmp(xmp).timeout({ seconds: 20 }).toBuffer();
  } catch {
    throw new CreativeError("AI_LABEL_RENDER_FAILED");
  }
  const check = await verifyAiLabel(output, rel);
  if (!check.ok) throw new CreativeError("AI_LABEL_SELF_CHECK_FAILED");
  return {
    bytes: output,
    format,
    mime: MIME[format],
    width,
    height,
    sha256: createHash("sha256").update(output).digest("hex"),
    inputSha256: source.sha256,
    alreadyLabeled: false,
    label: {
      text: AI_LABEL_TEXT,
      version: AI_LABEL_VERSION,
      box: rel,
      pixels: box,
      scheme: colours.scheme,
      plateOpacity: colours.opacity,
      contrast: colours.contrast,
      verifiedContrast: check.contrast,
    },
    digitalSourceType,
    source,
  };
}

export type AiLabelInspection =
  | { state: "labeled"; box: RelBox; contrast: number; declaresAi: true }
  | { state: "not_declared"; declaresAi: false }
  | {
      state: "missing" | "invalid";
      declaresAi: true;
      reason: string;
    };

/**
 * The publish-side check of one image's bytes. `requireLabel` is the
 * central record's verdict (an AI origin); the image's own XMP/C2PA can
 * also require it. With a label box from the record or the XMP, the pixels
 * must show the label there; without any box, a required label is missing.
 */
export async function inspectAiLabel(
  bytes: Buffer,
  options: { requireLabel?: boolean; knownLabel?: RelBox } = {},
): Promise<AiLabelInspection> {
  let source: EmbeddedProvenance;
  try {
    source = await readImageProvenance(bytes);
  } catch {
    return options.requireLabel
      ? { state: "invalid", declaresAi: true, reason: "IMAGE_UNREADABLE" }
      : { state: "not_declared", declaresAi: false };
  }
  const required = options.requireLabel === true || source.declaresAi;
  const box = options.knownLabel ?? source.xmp.label?.box;
  if (!required && !box) return { state: "not_declared", declaresAi: false };
  if (!box) return { state: "missing", declaresAi: true, reason: "NO_LABEL" };
  const check = await verifyAiLabel(bytes, box);
  return check.ok
    ? { state: "labeled", box, contrast: check.contrast, declaresAi: true }
    : { state: "invalid", declaresAi: true, reason: check.reason };
}
