// Images for websites (Content module, ADR 0029 §3.2, CH1.9): every upload
// becomes a normalized original (orientation applied, no metadata, long side
// at most 4096 px; JPEG unless it has transparency, then PNG), WebP variants
// 480, 960 and 1600 px wide (never wider than the original) for responsive
// `srcset`, and a 1200x630 JPEG for Open Graph cards.
//
// The Open Graph image of an AI image (`keepWhole`) is letterboxed instead
// of cropped, so the visible "KI erstellt" label in its corner stays in the
// picture (ADR 0028). Only the minimal provenance XMP of an AI image travels
// on (`carryProvenance`); camera, location and personal metadata never do.
import { aiProvenanceXmp } from "./social-image.ts";

export const WEB_IMAGE_WIDTHS = [480, 960, 1600] as const;
export const OG_SIZE = { width: 1200, height: 630 } as const;

export type WebImageVariant = {
  name: string;
  bytes: Buffer;
  mime: "image/webp" | "image/jpeg";
  width: number;
  height: number;
};

export type PreparedWebImage = {
  original: { bytes: Buffer; mime: "image/png" | "image/jpeg"; width: number; height: number };
  /** WebP widths, smallest first, named by target width (see variantWidths). */
  variants: WebImageVariant[];
  og: WebImageVariant;
};

const INVALID = "WEB_IMAGE_INVALID";
const MAX_PNG_BYTES = 10 * 1024 * 1024;
let configured = false;

/**
 * The variants to render for an original this wide: each target width up to
 * and including the first that is not below it, named by the target
 * (`w480` of a 300 px image is 300 px wide).
 */
export function variantWidths(width: number): Array<{ name: string; width: number }> {
  const out: Array<{ name: string; width: number }> = [];
  for (const target of WEB_IMAGE_WIDTHS) {
    out.push({ name: `w${target}`, width: Math.min(target, width) });
    if (target >= width) break;
  }
  return out;
}

export async function prepareWebImage(
  bytes: Buffer,
  options: {
    maxPixels?: number;
    maxSide?: number;
    carryProvenance?: boolean;
    /** Letterbox the Open Graph image instead of cropping it (AI images keep their label). */
    keepWhole?: boolean;
  } = {},
): Promise<PreparedWebImage> {
  const maxPixels = options.maxPixels ?? 40_000_000;
  const maxSide = options.maxSide ?? 4096;
  const { default: sharp } = await import("sharp");
  if (!configured) {
    sharp.cache(false);
    sharp.concurrency(2);
    configured = true;
  }
  const open = (input: Buffer) => sharp(input, { limitInputPixels: maxPixels, failOn: "warning", animated: false });
  let metadata: import("sharp").Metadata;
  try {
    metadata = await open(bytes).metadata();
  } catch {
    throw new Error(INVALID);
  }
  const format = metadata.format;
  if (
    (format !== "png" && format !== "jpeg" && format !== "webp") ||
    !metadata.width ||
    !metadata.height ||
    metadata.width * metadata.height > maxPixels ||
    (metadata.pages ?? 1) !== 1
  )
    throw new Error(INVALID);
  const provenance = options.carryProvenance ? aiProvenanceXmp(bytes, metadata) : null;
  const tagged = (image: import("sharp").Sharp) => (provenance ? image.withXmp(provenance) : image);
  try {
    const bounded = () =>
      open(bytes).rotate().resize({ width: maxSide, height: maxSide, fit: "inside", withoutEnlargement: true });
    const toJpeg = () =>
      tagged(bounded().flatten({ background: "#ffffff" }).toColorspace("srgb").jpeg({ quality: 90, mozjpeg: true })).toBuffer({
        resolveWithObject: true,
      });
    let original;
    if (format === "jpeg" || !metadata.hasAlpha) original = await toJpeg();
    else {
      const png = await tagged(bounded().png({ compressionLevel: 9 })).toBuffer({ resolveWithObject: true });
      original = png.data.length <= MAX_PNG_BYTES ? png : await toJpeg();
    }
    // Variants derive from the normalized original: already upright and sRGB.
    const base = original.data;
    const variants: WebImageVariant[] = [];
    for (const { name, width } of variantWidths(original.info.width)) {
      const out = await tagged(open(base).resize({ width, withoutEnlargement: true }).webp({ quality: 82 })).toBuffer({
        resolveWithObject: true,
      });
      variants.push({ name, bytes: out.data, mime: "image/webp", width: out.info.width, height: out.info.height });
    }
    const og = await tagged(
      open(base)
        .resize({
          ...OG_SIZE,
          fit: options.keepWhole ? "contain" : "cover",
          position: options.keepWhole ? "centre" : "attention",
          background: "#ffffff",
        })
        .flatten({ background: "#ffffff" })
        .jpeg({ quality: 85, mozjpeg: true }),
    ).toBuffer({ resolveWithObject: true });
    return {
      original: {
        bytes: original.data,
        mime: original.info.format === "png" ? "image/png" : "image/jpeg",
        width: original.info.width,
        height: original.info.height,
      },
      variants,
      og: { name: "og", bytes: og.data, mime: "image/jpeg", width: og.info.width, height: og.info.height },
    };
  } catch {
    throw new Error(INVALID);
  }
}
