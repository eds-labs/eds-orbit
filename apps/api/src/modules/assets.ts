import { createHash } from "node:crypto";
import { z } from "zod";
import { normalizeRasterAsset } from "../../../../packages/creative/src/index.ts";
import { DomainError } from "../shared.ts";

const MAX_UPLOAD_BYTES = 1_000_000;
const MAX_OUTPUT_BYTES = 5_000_000;
const MAX_PIXELS = 16_000_000;

export const brandAssetUploadInput = z
  .object({
    name: z.string().trim().min(1).max(160),
    type: z.enum(["logo", "photo", "background", "banner", "icon"]),
    mime: z.enum(["image/png", "image/jpeg", "image/webp"]),
    base64: z.string().min(4).max(1_400_000),
    source: z.string().trim().min(1).max(500),
    license: z.string().trim().min(1).max(500),
    validUses: z
      .array(z.enum(["brand", "social", "blog", "newsletter", "ad"]))
      .min(1)
      .max(5),
    confirmRightsInformation: z.literal(true),
  })
  .strict();

function strictBase64(value: string, maxBytes = MAX_UPLOAD_BYTES) {
  const bytes = Buffer.from(value, "base64");
  if (!bytes.length || bytes.toString("base64") !== value)
    throw new DomainError("ASSET_BASE64_INVALID");
  if (bytes.length > maxBytes)
    throw new DomainError("ASSET_UPLOAD_TOO_LARGE", 413);
  return bytes;
}

export async function normalizeBrandAsset(
  raw: z.infer<typeof brandAssetUploadInput>,
) {
  const input = brandAssetUploadInput.parse(raw);
  const bytes = strictBase64(input.base64);
  let normalized: Awaited<ReturnType<typeof normalizeRasterAsset>>;
  try {
    normalized = await normalizeRasterAsset(bytes, {
      maxInputBytes: MAX_UPLOAD_BYTES,
      maxOutputBytes: MAX_OUTPUT_BYTES,
      maxPixels: MAX_PIXELS,
    });
  } catch {
    throw new DomainError("ASSET_IMAGE_INVALID");
  }
  const expected = {
    "image/png": "png",
    "image/jpeg": "jpeg",
    "image/webp": "webp",
  } as const;
  if (normalized.inputFormat !== expected[input.mime])
    throw new DomainError("ASSET_IMAGE_INVALID");
  return {
    name: input.name,
    type: input.type,
    mime: "image/png" as const,
    filename: `${
      input.name
        .replace(/[^a-z0-9]+/gi, "-")
        .replace(/^-|-$/g, "")
        .toLowerCase() || "asset"
    }.png`,
    base64: normalized.bytes.toString("base64"),
    sha256: normalized.sha256,
    width: normalized.width,
    height: normalized.height,
    bytes: normalized.bytes.length,
    source: input.source,
    license: input.license,
    validUses: input.validUses,
    originalMime: input.mime,
    metadataStripped: true,
    rightsInformationConfirmed: true,
  };
}

export function assetBytes(value: Record<string, unknown>) {
  const mime = z
    .enum(["image/png", "image/jpeg", "image/webp"])
    .parse(value.mime);
  const bytes = strictBase64(z.string().parse(value.base64), 20 * 1024 * 1024);
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== z.string().length(64).parse(value.sha256))
    throw new DomainError("ASSET_INTEGRITY_FAILED", 409);
  return { bytes, mime };
}

export async function normalizeGeneratedPng(bytes: Buffer) {
  if (
    !bytes.length ||
    bytes.length > 20 * 1024 * 1024 ||
    bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a"
  )
    throw new DomainError("GENERATED_IMAGE_INVALID");
  let output: Awaited<ReturnType<typeof normalizeRasterAsset>>;
  try {
    output = await normalizeRasterAsset(bytes, {
      maxInputBytes: 20 * 1024 * 1024,
      maxOutputBytes: 10 * 1024 * 1024,
      maxPixels: MAX_PIXELS,
    });
  } catch {
    throw new DomainError("GENERATED_IMAGE_INVALID");
  }
  return {
    bytes: output.bytes,
    width: output.width,
    height: output.height,
    sha256: output.sha256,
  };
}
