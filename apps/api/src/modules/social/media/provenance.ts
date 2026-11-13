import { createHash } from "node:crypto";
import { labelRequired, type ImageOrigin } from "../../../../../../packages/creative/src/index.ts";
import { scoped, type DbTx } from "../../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import {
  aiImageLabelsEnabled,
  imageProvenance,
  labelFinalImage,
  recordDerivedImage,
  recordOriginalUpload,
  type ImageProvenanceRecord,
} from "../../../platform/provenance/image-provenance.ts";
import { DomainError } from "../../../shared.ts";

// AI image provenance in the social library (ADR 0028). The central record
// (keyed by the SHA-256 of exact bytes) is the truth; the XMP a re-encode
// carries is only a convenience. With ORBIT_AI_IMAGE_LABELS off nothing
// here reads or writes a record.

const sha256Of = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const subjectOf = (assetId: string) => ({ module: "social", kind: "media", id: assetId });

/** What ingest prepares: the bytes to normalize and the record they derive from. */
export type IngestSource = { bytes: Buffer; sha256: string };

/**
 * Before an image enters the library: an image recorded as AI with a label
 * goes on as it is; an image recorded as AI without one (raw generated art)
 * is refused with 409 AI_LABEL_MISSING, because Social never labels another
 * module's source material implicitly; bytes whose own XMP/C2PA declare AI
 * are labelled here (ADR 0028 §6); anything else is an original upload.
 * Null while the flag is off.
 */
export async function provenanceBeforeIngest(scope: Scope, bytes: Buffer, assetId: string): Promise<IngestSource | null> {
  if (!aiImageLabelsEnabled()) return null;
  const subject = subjectOf(assetId);
  return scoped(scope.workspaceId, scope.projectId, async (tx) => {
    let upload;
    try {
      upload = await recordOriginalUpload(tx, scope, { bytes, subject, createdBy: scope.userId });
    } catch (error) {
      // Bytes the engine cannot read are what the library calls unusable.
      if (error instanceof DomainError && error.code === "AI_LABEL_INPUT_INVALID")
        throw new DomainError("SOCIAL_MEDIA_INVALID", 422);
      throw error;
    }
    if (!upload.declaresAi) return { bytes, sha256: upload.embedded.sha256 };
    if (upload.provenance && labelRequired(upload.provenance.origin))
      throw new DomainError("AI_LABEL_MISSING", 409);
    const origin = upload.embedded.xmp.origin;
    const labelled = await labelFinalImage(tx, scope, {
      bytes,
      origin: origin === "ai_substantially_modified" ? origin : "ai_generated",
      subject,
      createdBy: scope.userId,
    });
    return { bytes: labelled.result.bytes, sha256: labelled.result.sha256 };
  });
}

/**
 * Records the stored original and JPEG rendition as derivatives of the
 * ingest source, in the transaction that lists the image. A labelled source
 * whose label no longer verifies on a rendition throws 409
 * AI_LABEL_INVALID, so the image is not listed.
 */
export async function recordStoredRenditions(
  tx: DbTx,
  scope: Scope,
  input: { source: IngestSource; original: Buffer; jpeg: Buffer; assetId: string },
): Promise<void> {
  const subject = subjectOf(input.assetId);
  for (const bytes of [input.original, input.jpeg])
    await recordDerivedImage(tx, scope, { sourceSha256: input.source.sha256, bytes, subject, createdBy: scope.userId });
}

type AssetRef = { id: string; sha256: string; jpegFileId: string };

/** The records of an asset's two stored renditions (original by its sha256, JPEG by its file's). */
async function renditionRecords(tx: DbTx, scope: Scope, assets: readonly AssetRef[]) {
  const files = assets.length
    ? await tx.file.findMany({
        where: { projectId: scope.projectId, id: { in: assets.map((a) => a.jpegFileId) } },
        select: { id: true, sha256: true },
      })
    : [];
  const jpegSha = new Map(files.map((f) => [f.id, f.sha256]));
  const cache = new Map<string, Promise<ImageProvenanceRecord | null>>();
  const record = (sha: string | undefined) => {
    if (!sha) return Promise.resolve(null);
    if (!cache.has(sha)) cache.set(sha, imageProvenance(tx, scope, sha));
    return cache.get(sha)!;
  };
  const out = new Map<string, Array<ImageProvenanceRecord | null>>();
  for (const asset of assets)
    out.set(asset.id, [await record(asset.sha256), await record(jpegSha.get(asset.jpegFileId))]);
  return out;
}

const isAi = (row: ImageProvenanceRecord | null) => row !== null && labelRequired(row.origin);

/**
 * The library images (by id) that would publish an AI image without a
 * label: a rendition recorded with an AI origin and not `labeled`, or one
 * rendition recorded as AI while the other has no record at all. Empty
 * while the flag is off.
 */
export async function assetsMissingAiLabel(tx: DbTx, scope: Scope, assets: readonly AssetRef[]): Promise<Set<string>> {
  const missing = new Set<string>();
  if (!aiImageLabelsEnabled() || !assets.length) return missing;
  for (const [id, rows] of await renditionRecords(tx, scope, assets)) {
    if (!rows.some(isAi)) continue;
    if (rows.some((row) => row === null || (isAi(row) && row.labelState !== "labeled"))) missing.add(id);
  }
  return missing;
}

/**
 * The AI origin recorded for any rendition of the library image a file
 * belongs to, so the publish gate requires a label even for bytes that have
 * no record of their own (a file whose bytes changed after ingest).
 */
export async function recordedAiOrigin(tx: DbTx, scope: Scope, fileId: string, bytes: Buffer): Promise<ImageOrigin | null> {
  const asset = await tx.socialMediaAsset.findFirst({
    where: { projectId: scope.projectId, OR: [{ fileId }, { jpegFileId: fileId }] },
    select: { id: true, sha256: true, jpegFileId: true },
  });
  const rows = asset ? ((await renditionRecords(tx, scope, [asset])).get(asset.id) ?? []) : [];
  const own = await imageProvenance(tx, scope, sha256Of(bytes));
  const ai = [own, ...rows].find(isAi);
  return ai ? ai.origin : null;
}
