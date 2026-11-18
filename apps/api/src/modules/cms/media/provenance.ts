import { labelRequired } from "../../../../../../packages/creative/src/index.ts";
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

// AI image provenance in the content media library (ADR 0028, CH1.9), as in
// the social library: the central record keyed by the SHA-256 of exact bytes
// is the truth. An AI image is labelled before it is normalized, so every
// stored rendition derives from labelled bytes; a rendition on which the
// label no longer verifies is not stored at all. With ORBIT_AI_IMAGE_LABELS
// off nothing here reads or writes a record.

const subjectOf = (assetId: string) => ({ module: "cms", kind: "asset", id: assetId });

/** The bytes to normalize, the record they derive from, and whether they are AI. */
export type IngestSource = { bytes: Buffer; sha256: string; ai: boolean };

/**
 * Before an image enters the library: a labelled AI image goes on as it is;
 * a recorded AI image without a label (raw generated art) is refused with 409
 * AI_LABEL_MISSING; bytes whose own XMP/C2PA declare AI are labelled here;
 * anything else is an original upload. Null while the flag is off.
 */
export async function provenanceBeforeIngest(scope: Scope, bytes: Buffer, assetId: string): Promise<IngestSource | null> {
  if (!aiImageLabelsEnabled()) return null;
  const subject = subjectOf(assetId);
  return scoped(scope.workspaceId, scope.projectId, async (tx) => {
    let upload;
    try {
      upload = await recordOriginalUpload(tx, scope, { bytes, subject, createdBy: scope.userId });
    } catch (error) {
      if (error instanceof DomainError && error.code === "AI_LABEL_INPUT_INVALID") throw new DomainError("CMS_MEDIA_INVALID", 422);
      throw error;
    }
    if (!upload.declaresAi)
      return { bytes, sha256: upload.embedded.sha256, ai: labelRequired(upload.provenance.origin) };
    if (upload.provenance && labelRequired(upload.provenance.origin)) throw new DomainError("AI_LABEL_MISSING", 409);
    const origin = upload.embedded.xmp.origin;
    const labelled = await labelFinalImage(tx, scope, {
      bytes,
      origin: origin === "ai_substantially_modified" ? origin : "ai_generated",
      subject,
      createdBy: scope.userId,
    });
    return { bytes: labelled.result.bytes, sha256: labelled.result.sha256, ai: true };
  });
}

/**
 * Records the renditions as derivatives of the ingest source. The original
 * must keep a valid label (else 409 AI_LABEL_INVALID); a variant that loses
 * it is left out. Returns the original's record and the names left out.
 */
export async function recordRenditions(
  scope: Scope,
  source: IngestSource,
  assetId: string,
  original: Buffer,
  variants: ReadonlyArray<{ name: string; bytes: Buffer }>,
): Promise<{ original: ImageProvenanceRecord | null; dropped: Set<string> }> {
  const subject = subjectOf(assetId);
  return scoped(scope.workspaceId, scope.projectId, async (tx) => {
    const record = await recordDerivedImage(tx, scope, { sourceSha256: source.sha256, bytes: original, subject, createdBy: scope.userId });
    const dropped = new Set<string>();
    for (const variant of variants) {
      try {
        await recordDerivedImage(tx, scope, { sourceSha256: source.sha256, bytes: variant.bytes, subject, createdBy: scope.userId });
      } catch (error) {
        if (!(error instanceof DomainError && error.code === "AI_LABEL_INVALID")) throw error;
        dropped.add(variant.name);
      }
    }
    return { original: record, dropped };
  });
}

const isAi = (row: ImageProvenanceRecord | null) => row !== null && labelRequired(row.origin);

/**
 * True when serving these bytes would show an AI image without its label:
 * the rendition is recorded as AI and not labelled, or the asset's original
 * is AI and the rendition has no record. False while the flag is off.
 */
export async function renditionMissingLabel(
  tx: DbTx,
  scope: Pick<Scope, "workspaceId" | "projectId">,
  originalSha256: string,
  renditionSha256: string,
) {
  if (!aiImageLabelsEnabled()) return false;
  const original = await imageProvenance(tx, scope, originalSha256);
  const rendition = renditionSha256 === originalSha256 ? original : await imageProvenance(tx, scope, renditionSha256);
  if (isAi(rendition)) return rendition!.labelState !== "labeled";
  return isAi(original) && (rendition === null || original!.labelState !== "labeled");
}
