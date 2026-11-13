import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { DbTx, Prisma } from "../../../../../packages/db/src/index.ts";
import { loadConfig } from "../../../../../packages/config/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import {
  applyAiLabel,
  CreativeError,
  digitalSourceTypeFor,
  IMAGE_ORIGINS,
  inspectAiLabel,
  labelRequired,
  readImageProvenance,
  type AiLabelResult,
  type Box,
  type EmbeddedProvenance,
  type ImageOrigin,
  type RelBox,
  type SafeInsets,
} from "../../../../../packages/creative/src/index.ts";
import { audit, DomainError } from "../shared.ts";
import {
  IMAGE_LABEL_STATES,
  type ImageLabelState,
  type ImageProvenanceRecord,
  type ImageProvenanceSubject,
  type RecordImageProvenanceInput,
  type StoredEmbeddedProvenance,
} from "./types.ts";

export type * from "./types.ts";

/**
 * Central image provenance (ADR 0028). Every image version Orbit produces or
 * ingests can be recorded here by the SHA-256 of its exact bytes: its
 * origin, whether it carries the visible "KI erstellt" label and where, and
 * what the bytes declared about themselves. Records are immutable: the first
 * record of a byte version wins and is returned as it is to every later
 * caller, so no path can downgrade an AI image to an original.
 *
 * Every function takes the caller's project transaction (`scoped()`); row-
 * level security keeps records inside their project. With
 * `ORBIT_AI_IMAGE_LABELS` off, callers do not label or record and the
 * publish gate does not check (ADR 0028 §7).
 */

/** The ADR 0028 switch; off, nothing is labelled, recorded or checked. */
export function aiImageLabelsEnabled(): boolean {
  return loadConfig().ORBIT_AI_IMAGE_LABELS === "true";
}

const sha256Of = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");

const HEX64 = /^[0-9a-f]{64}$/;
const fraction = z.number().min(0).max(1);
const relBox = z
  .object({ x: fraction, y: fraction, w: fraction, h: fraction })
  .strict()
  .refine((b) => b.w > 0 && b.h > 0 && b.x + b.w <= 1.000001 && b.y + b.h <= 1.000001);
const subjectSchema = z
  .object({
    module: z.string().min(1).max(64),
    kind: z.string().min(1).max(64),
    id: z.string().min(1).max(200),
  })
  .strict();
const recordInput = z
  .object({
    sha256: z.string().regex(HEX64),
    origin: z.enum(IMAGE_ORIGINS as [ImageOrigin, ...ImageOrigin[]]),
    labelState: z.enum(IMAGE_LABEL_STATES as [ImageLabelState, ...ImageLabelState[]]),
    labelVersion: z.number().int().min(1).nullish(),
    labelBox: relBox.nullish(),
    labelContrast: z.number().positive().finite().nullish(),
    digitalSourceType: z.string().min(1).max(200).nullish(),
    parentSha256: z.string().regex(HEX64).nullish(),
    componentSha256s: z.array(z.string().regex(HEX64)).max(64).optional(),
    subject: subjectSchema,
    createdBy: z.string().min(1).max(200),
  })
  .refine(
    (v) =>
      v.labelState !== "labeled" ||
      (v.labelBox != null && v.labelVersion != null),
  )
  .refine(
    (v) => (v.origin === "original_upload") === (v.labelState === "not_required"),
  );

const MAX_MANIFEST = 1024 * 1024;

/** The engine's reading without the manifest bytes (stored in their own column). */
function storedEmbedded(
  embedded: EmbeddedProvenance | StoredEmbeddedProvenance,
): StoredEmbeddedProvenance {
  const { c2pa, ...rest } = embedded;
  return {
    ...rest,
    c2pa: c2pa
      ? { present: true, sha256: c2pa.sha256, size: c2pa.size, declaresAi: c2pa.declaresAi }
      : null,
  };
}
const manifestOf = (embedded: RecordImageProvenanceInput["embedded"]) => {
  const bytes = (embedded?.c2pa as { bytes?: Buffer } | null | undefined)?.bytes;
  return bytes && bytes.length > 0 && bytes.length <= MAX_MANIFEST ? bytes : null;
};

type Row = NonNullable<Awaited<ReturnType<DbTx["imageProvenance"]["findFirst"]>>>;
const toRecord = (row: Row): ImageProvenanceRecord => ({
  ...row,
  origin: row.origin as ImageOrigin,
  labelState: row.labelState as ImageLabelState,
  labelBox: (row.labelBox as RelBox | null) ?? null,
  embedded: (row.embedded as StoredEmbeddedProvenance | null) ?? null,
  c2paManifest: row.c2paManifest ? Buffer.from(row.c2paManifest) : null,
});

/** Engine refusals as API errors with the same stable code, so callers fail closed. */
const ENGINE_STATUS: Readonly<Record<string, number>> = {
  AI_LABEL_INPUT_INVALID: 422,
  AI_LABEL_RENDER_FAILED: 500,
  AI_LABEL_SELF_CHECK_FAILED: 500,
};
function engineError(error: unknown): never {
  if (error instanceof CreativeError)
    throw new DomainError(error.code, ENGINE_STATUS[error.code] ?? 409);
  throw error;
}
async function engine<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    engineError(error);
  }
}

/** The record of exactly these bytes (by SHA-256) in the project, if any. */
export async function imageProvenance(
  tx: DbTx,
  scope: Pick<Scope, "workspaceId" | "projectId">,
  sha256: string,
): Promise<ImageProvenanceRecord | null> {
  if (!HEX64.test(sha256)) return null;
  const row = await tx.imageProvenance.findFirst({
    where: { workspaceId: scope.workspaceId, projectId: scope.projectId, sha256 },
  });
  return row ? toRecord(row) : null;
}

/**
 * Records one image version. An existing record of the same bytes wins and
 * is returned unchanged (first record wins, never downgraded); records are
 * never updated. Inconsistent input is refused (422
 * IMAGE_PROVENANCE_INVALID).
 */
export async function recordImageProvenance(
  tx: DbTx,
  scope: Pick<Scope, "workspaceId" | "projectId">,
  input: RecordImageProvenanceInput,
): Promise<ImageProvenanceRecord> {
  const parsed = recordInput.safeParse(input);
  if (!parsed.success) throw new DomainError("IMAGE_PROVENANCE_INVALID", 422);
  const v = parsed.data;
  const existing = await imageProvenance(tx, scope, v.sha256);
  if (existing) return existing;
  const c2paManifest = input.c2paManifest ?? manifestOf(input.embedded);
  if (c2paManifest && (c2paManifest.length === 0 || c2paManifest.length > MAX_MANIFEST))
    throw new DomainError("IMAGE_PROVENANCE_INVALID", 422);
  // ON CONFLICT DO NOTHING: a record written meanwhile for the same bytes
  // stays, and is what the caller gets back.
  await tx.imageProvenance.createMany({
    data: [
      {
        id: randomUUID(),
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        sha256: v.sha256,
        origin: v.origin,
        labelState: v.labelState,
        labelVersion: v.labelVersion ?? null,
        labelBox: (v.labelBox ?? undefined) as Prisma.InputJsonValue | undefined,
        labelContrast: v.labelContrast ?? null,
        digitalSourceType: v.digitalSourceType ?? null,
        parentSha256: v.parentSha256 ?? null,
        componentSha256s: [...new Set(v.componentSha256s ?? [])],
        embedded: (input.embedded
          ? storedEmbedded(input.embedded)
          : undefined) as Prisma.InputJsonValue | undefined,
        c2paManifest: c2paManifest ? new Uint8Array(c2paManifest) : null,
        subjectModule: v.subject.module,
        subjectKind: v.subject.kind,
        subjectId: v.subject.id,
        createdBy: v.createdBy,
      },
    ],
    skipDuplicates: true,
  });
  const row = await imageProvenance(tx, scope, v.sha256);
  if (!row) throw new DomainError("IMAGE_PROVENANCE_INVALID", 422);
  return row;
}

type AiOrigin = Exclude<ImageOrigin, "original_upload">;
const isAiOrigin = (origin: unknown): origin is AiOrigin =>
  origin === "ai_generated" || origin === "ai_substantially_modified";

/**
 * Raw generated art (ADR 0028 §3): internal source material that is
 * composed further, recorded as `unlabeled_source`. Reads the embedded
 * provenance from the bytes when it is not given, keeping a C2PA manifest
 * store of at most 1 MiB with the record.
 */
export async function recordUnlabeledSource(
  tx: DbTx,
  scope: Pick<Scope, "workspaceId" | "projectId">,
  input: {
    bytes: Buffer;
    origin: AiOrigin;
    subject: ImageProvenanceSubject;
    createdBy: string;
    embedded?: EmbeddedProvenance;
  },
): Promise<ImageProvenanceRecord> {
  if (!isAiOrigin(input.origin)) throw new DomainError("IMAGE_PROVENANCE_INVALID", 422);
  const embedded =
    input.embedded ?? (await engine(() => readImageProvenance(input.bytes)));
  return recordImageProvenance(tx, scope, {
    sha256: sha256Of(input.bytes),
    origin: input.origin,
    labelState: "unlabeled_source",
    digitalSourceType: digitalSourceTypeFor(input.origin),
    embedded,
    subject: input.subject,
    createdBy: input.createdBy,
  });
}

export type OriginalUploadResult =
  | {
      /** The bytes (or an earlier record of them) say AI: label them first. */
      declaresAi: true;
      embedded: EmbeddedProvenance;
      /** An existing AI record of these exact bytes, if there is one. */
      provenance: ImageProvenanceRecord | null;
    }
  | {
      declaresAi: false;
      embedded: EmbeddedProvenance;
      provenance: ImageProvenanceRecord;
    };

/**
 * An uploaded image (ADR 0028 §6). Bytes whose XMP or C2PA declares AI, or
 * that are already recorded with an AI origin and no label, are not recorded
 * as original: the result says `declaresAi` and the caller labels them with
 * `labelFinalImage`. Anything else is recorded `original_upload` /
 * `not_required` (an existing record of the bytes is returned as it is).
 */
export async function recordOriginalUpload(
  tx: DbTx,
  scope: Pick<Scope, "workspaceId" | "projectId">,
  input: { bytes: Buffer; subject: ImageProvenanceSubject; createdBy: string },
): Promise<OriginalUploadResult> {
  const embedded = await engine(() => readImageProvenance(input.bytes));
  const existing = await imageProvenance(tx, scope, embedded.sha256);
  if (existing && labelRequired(existing.origin))
    return existing.labelState === "labeled"
      ? { declaresAi: false, embedded, provenance: existing }
      : { declaresAi: true, embedded, provenance: existing };
  if (embedded.declaresAi)
    return { declaresAi: true, embedded, provenance: existing };
  const provenance = await recordImageProvenance(tx, scope, {
    sha256: embedded.sha256,
    origin: "original_upload",
    labelState: "not_required",
    digitalSourceType: embedded.xmp.digitalSourceType ?? null,
    embedded,
    subject: input.subject,
    createdBy: input.createdBy,
  });
  return { declaresAi: false, embedded, provenance };
}

/**
 * Labels a finished image (ADR 0028 §3) and records the labelled version.
 * A record of the input bytes with a label box is handed to the engine, so
 * an image whose XMP was stripped is verified there instead of labelled a
 * second time; the engine returns an already labelled image unchanged.
 * Engine refusals surface as DomainError with the engine's code
 * (AI_LABEL_PLACEMENT_FAILED, AI_LABEL_CONTRAST_FAILED, AI_LABEL_INVALID:
 * 409; AI_LABEL_INPUT_INVALID: 422; render/self-check failures: 500).
 */
export async function labelFinalImage(
  tx: DbTx,
  scope: Pick<Scope, "workspaceId" | "projectId">,
  input: {
    bytes: Buffer;
    origin: AiOrigin;
    composite?: boolean;
    avoid?: readonly Box[];
    safe?: Partial<SafeInsets>;
    subject: ImageProvenanceSubject;
    createdBy: string;
    parentSha256?: string;
    componentSha256s?: readonly string[];
  },
): Promise<{ result: AiLabelResult; provenance: ImageProvenanceRecord }> {
  if (!isAiOrigin(input.origin)) throw new DomainError("IMAGE_PROVENANCE_INVALID", 422);
  if (!Buffer.isBuffer(input.bytes) || !input.bytes.length)
    throw new DomainError("AI_LABEL_INPUT_INVALID", 422);
  const inputSha = sha256Of(input.bytes);
  const known = await imageProvenance(tx, scope, inputSha);
  const knownLabel = known?.labelState === "labeled" ? known.labelBox : null;
  const result = await engine(() =>
    applyAiLabel(input.bytes, {
      origin: input.origin,
      ...(input.composite !== undefined ? { composite: input.composite } : {}),
      ...(input.avoid ? { avoid: input.avoid } : {}),
      ...(input.safe ? { safe: input.safe } : {}),
      ...(knownLabel ? { knownLabel } : {}),
    }),
  );
  const provenance = await recordImageProvenance(tx, scope, {
    sha256: result.sha256,
    origin: input.origin,
    labelState: "labeled",
    labelVersion: result.label.version,
    labelBox: result.label.box,
    labelContrast: result.label.verifiedContrast,
    digitalSourceType: result.digitalSourceType,
    parentSha256:
      input.parentSha256 ?? (result.sha256 !== inputSha ? inputSha : null),
    componentSha256s: input.componentSha256s ?? [],
    embedded: result.source,
    subject: input.subject,
    createdBy: input.createdBy,
  });
  return { result, provenance };
}

/**
 * A re-encoded rendition of a recorded image (e.g. Social's JPEG): it takes
 * the source record's origin. For a labelled AI source the label must still
 * verify on the derived bytes at the source's box (else 409
 * AI_LABEL_INVALID); an unlabelled AI source gives an unlabelled derivative;
 * an original gives an original. Null when the source has no record.
 */
export async function recordDerivedImage(
  tx: DbTx,
  scope: Pick<Scope, "workspaceId" | "projectId">,
  input: {
    sourceSha256: string;
    bytes: Buffer;
    subject: ImageProvenanceSubject;
    createdBy: string;
  },
): Promise<ImageProvenanceRecord | null> {
  const source = await imageProvenance(tx, scope, input.sourceSha256);
  if (!source) return null;
  const embedded = await engine(() => readImageProvenance(input.bytes));
  if (embedded.sha256 === source.sha256) return source;
  const common = {
    sha256: embedded.sha256,
    origin: source.origin,
    parentSha256: source.sha256,
    embedded,
    subject: input.subject,
    createdBy: input.createdBy,
  };
  if (!labelRequired(source.origin))
    return recordImageProvenance(tx, scope, {
      ...common,
      labelState: "not_required",
      digitalSourceType: source.digitalSourceType,
    });
  if (source.labelState !== "labeled" || !source.labelBox)
    return recordImageProvenance(tx, scope, {
      ...common,
      labelState: "unlabeled_source",
      digitalSourceType: source.digitalSourceType,
    });
  const inspection = await inspectAiLabel(input.bytes, {
    requireLabel: true,
    knownLabel: source.labelBox,
  });
  if (inspection.state !== "labeled") throw new DomainError("AI_LABEL_INVALID", 409);
  return recordImageProvenance(tx, scope, {
    ...common,
    labelState: "labeled",
    labelVersion: source.labelVersion,
    labelBox: source.labelBox,
    labelContrast: inspection.contrast,
    digitalSourceType: source.digitalSourceType,
  });
}

export type PublishCheck =
  | { checked: false }
  | {
      checked: true;
      /** The recorded (or declared) origin; null for unknown bytes that declare nothing. */
      origin: ImageOrigin | null;
      labelState: "labeled" | "not_declared";
    };

const CONTEXT = /^[a-z0-9_.:-]{1,64}$/;

/**
 * THE publish gate (ADR 0028 §4): every outbound path calls it with the
 * exact bytes that leave Orbit. Off (flag), it checks nothing. On, the
 * bytes' record decides whether a label is required (else the caller's
 * `declaredOrigin`, else the bytes' own XMP/C2PA), and the label must
 * verify in the pixels at the recorded (or embedded) box.
 *
 * Refusals: 409 AI_LABEL_MISSING (required, no label known) and 409
 * AI_LABEL_INVALID (a label box that does not verify). The error's detail
 * carries only `context` and the bytes' SHA-256. An audit record
 * `image.ai_label.blocked` is written in the caller's transaction, so it is
 * kept when the caller catches the refusal and commits its block.
 */
export async function assertAiLabelPublishable(
  tx: DbTx,
  scope: Pick<Scope, "workspaceId" | "projectId" | "userId">,
  input: { bytes: Buffer; declaredOrigin?: ImageOrigin | null; context: string },
): Promise<PublishCheck> {
  if (!aiImageLabelsEnabled()) return { checked: false };
  const context = CONTEXT.test(input.context) ? input.context : "unknown";
  const sha256 = sha256Of(input.bytes);
  const row = await imageProvenance(tx, scope, sha256);
  const declared =
    input.declaredOrigin && IMAGE_ORIGINS.includes(input.declaredOrigin)
      ? input.declaredOrigin
      : null;
  const requireLabel = row
    ? labelRequired(row.origin)
    : declared
      ? labelRequired(declared)
      : false;
  const inspection = await inspectAiLabel(input.bytes, {
    requireLabel,
    ...(row?.labelBox ? { knownLabel: row.labelBox } : {}),
  });
  const origin = row?.origin ?? declared;
  if (inspection.state === "labeled" || inspection.state === "not_declared")
    return { checked: true, origin: origin ?? null, labelState: inspection.state };
  const code = inspection.state === "missing" ? "AI_LABEL_MISSING" : "AI_LABEL_INVALID";
  await audit(tx, scope, "image.ai_label.blocked", sha256, {
    code,
    context,
    ...(origin ? { origin } : {}),
    recorded: Boolean(row),
  });
  throw Object.assign(new DomainError(code, 409), { detail: { context, sha256 } });
}
