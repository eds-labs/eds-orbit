// Images for the social module (ADR 0020, S3): every upload becomes a
// normalized original (orientation applied, no metadata, PNG or JPEG, a
// bounded long side) and a JPEG rendition at most 1440 pixels wide in sRGB,
// the form Instagram accepts. WebP becomes PNG, because X takes only JPEG
// and PNG. Animated images and anything over the pixel limit are refused
// before they are decoded.

export type PreparedSocialImage = {
  original: { bytes: Buffer; mime: "image/png" | "image/jpeg"; width: number; height: number };
  jpeg: { bytes: Buffer; width: number; height: number };
};

const INVALID = "SOCIAL_MEDIA_INVALID";
const RENDITION_WIDTH = 1440;

export async function prepareSocialImage(
  bytes: Buffer,
  options: { maxPixels?: number; maxSide?: number } = {},
): Promise<PreparedSocialImage> {
  const maxPixels = options.maxPixels ?? 40_000_000;
  const maxSide = options.maxSide ?? 4096;
  const { default: sharp } = await import("sharp");
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
  try {
    const bounded = () =>
      open()
        .rotate()
        .resize({ width: maxSide, height: maxSide, fit: "inside", withoutEnlargement: true });
    const original =
      format === "jpeg"
        ? await bounded().toColorspace("srgb").jpeg({ quality: 92, mozjpeg: true }).toBuffer({ resolveWithObject: true })
        : await bounded().png({ compressionLevel: 9 }).toBuffer({ resolveWithObject: true });
    const jpeg = await open()
      .rotate()
      .resize({ width: RENDITION_WIDTH, withoutEnlargement: true })
      .flatten({ background: "#ffffff" })
      .toColorspace("srgb")
      .jpeg({ quality: 88, mozjpeg: true })
      .toBuffer({ resolveWithObject: true });
    return {
      original: {
        bytes: original.data,
        mime: format === "jpeg" ? "image/jpeg" : "image/png",
        width: original.info.width,
        height: original.info.height,
      },
      jpeg: { bytes: jpeg.data, width: jpeg.info.width, height: jpeg.info.height },
    };
  } catch {
    throw new Error(INVALID);
  }
}
