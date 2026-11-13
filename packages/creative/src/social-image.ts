// Images for the social module (ADR 0020, S3): every upload becomes a
// normalized original (orientation applied, no metadata, a bounded long
// side) and a JPEG rendition at most 1440 pixels wide in sRGB, the form
// Instagram accepts. The original is JPEG unless the image has transparency
// (then PNG, while it stays under 10 MiB): X takes only JPEG and PNG, and a
// lossless PNG of a photo would be several times its upload. Animated images
// and anything over the pixel limit are refused before they are decoded.
//
// The one exception to "no metadata" is the minimal provenance XMP (ADR
// 0028), written only with `carryProvenance` (the label switch) and only for
// an AI image: the IPTC DigitalSourceType and Orbit's AI label fields of the
// input, so an AI label and its origin survive the re-encode. Camera,
// location and personal metadata never travel on. Without the option the
// output is byte for byte what it was before ADR 0028.
import {
  AI_DIGITAL_SOURCE_TYPES,
  carriedProvenanceXmp,
  findC2pa,
  parseProvenanceXmp,
} from "./ai-label.ts";

export type PreparedSocialImage = {
  original: { bytes: Buffer; mime: "image/png" | "image/jpeg"; width: number; height: number };
  jpeg: { bytes: Buffer; width: number; height: number };
};

const INVALID = "SOCIAL_MEDIA_INVALID";
const RENDITION_WIDTH = 1440;
const MAX_PNG_BYTES = 10 * 1024 * 1024;
let configured = false;

/**
 * The provenance XMP to carry, only for an AI image: an AI IPTC source type,
 * an Orbit label or a C2PA manifest naming an AI source. Null otherwise (a
 * camera's `digitalCapture` is no reason to write metadata).
 */
function aiProvenanceXmp(bytes: Buffer, metadata: import("sharp").Metadata): string | null {
  const xmp = metadata.xmp ? parseProvenanceXmp(metadata.xmp.toString("utf8")) : {};
  const c2pa = findC2pa(bytes);
  const ai =
    (AI_DIGITAL_SOURCE_TYPES as readonly string[]).includes(xmp.digitalSourceType ?? "") ||
    Boolean(xmp.label) ||
    Boolean(c2pa?.declaresAi);
  return ai ? carriedProvenanceXmp({ xmp, c2pa }) : null;
}

export async function prepareSocialImage(
  bytes: Buffer,
  options: {
    maxPixels?: number;
    maxSide?: number;
    /** Carry an AI image's provenance XMP (ADR 0028); default false: no metadata at all. */
    carryProvenance?: boolean;
  } = {},
): Promise<PreparedSocialImage> {
  const maxPixels = options.maxPixels ?? 40_000_000;
  const maxSide = options.maxSide ?? 4096;
  const { default: sharp } = await import("sharp");
  if (!configured) {
    // One upload at a time should not hold libvips' operation cache or
    // all cores: the process serves everything else too.
    sharp.cache(false);
    sharp.concurrency(2);
    configured = true;
  }
  const open = () => sharp(bytes, { limitInputPixels: maxPixels, failOn: "warning", animated: false });
  let metadata: import("sharp").Metadata;
  try {
    metadata = await open().metadata();
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
      open()
        .rotate()
        .resize({ width: maxSide, height: maxSide, fit: "inside", withoutEnlargement: true });
    const toJpeg = () =>
      tagged(
        bounded()
          .flatten({ background: "#ffffff" })
          .toColorspace("srgb")
          .jpeg({ quality: 92, mozjpeg: true }),
      ).toBuffer({ resolveWithObject: true });
    let original;
    if (format === "jpeg" || !metadata.hasAlpha) original = await toJpeg();
    else {
      const png = await tagged(bounded().png({ compressionLevel: 9 })).toBuffer({ resolveWithObject: true });
      original = png.data.length <= MAX_PNG_BYTES ? png : await toJpeg();
    }
    const jpeg = await tagged(
      open()
        .rotate()
        .resize({ width: RENDITION_WIDTH, withoutEnlargement: true })
        .flatten({ background: "#ffffff" })
        .toColorspace("srgb")
        .jpeg({ quality: 88, mozjpeg: true }),
    ).toBuffer({ resolveWithObject: true });
    return {
      original: {
        bytes: original.data,
        mime: original.info.format === "png" ? "image/png" : "image/jpeg",
        width: original.info.width,
        height: original.info.height,
      },
      jpeg: { bytes: jpeg.data, width: jpeg.info.width, height: jpeg.info.height },
    };
  } catch {
    throw new Error(INVALID);
  }
}
