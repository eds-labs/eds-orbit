import type {
  C2paFinding,
  EmbeddedProvenance,
  ImageOrigin,
  ProvenanceXmpFields,
  RelBox,
} from "../../../../../packages/creative/src/index.ts";

/** Whether an image version carries the visible AI label (ADR 0028). */
export type ImageLabelState = "labeled" | "not_required" | "unlabeled_source";
export const IMAGE_LABEL_STATES: readonly ImageLabelState[] = [
  "labeled",
  "not_required",
  "unlabeled_source",
];

/** The module object an image version was produced for. */
export type ImageProvenanceSubject = {
  /** The producing module, e.g. "marketing", "social". */
  module: string;
  /** The object kind within it, e.g. "asset", "media". */
  kind: string;
  id: string;
};

/**
 * What the bytes declared about themselves, as stored with the record: the
 * engine's `EmbeddedProvenance` without the C2PA manifest bytes (those are
 * kept in their own column).
 */
export type StoredEmbeddedProvenance = Omit<EmbeddedProvenance, "c2pa"> & {
  c2pa: Omit<C2paFinding, "bytes"> | null;
};

/** One immutable record of an image byte version. */
export type ImageProvenanceRecord = {
  id: string;
  workspaceId: string;
  projectId: string;
  sha256: string;
  origin: ImageOrigin;
  labelState: ImageLabelState;
  labelVersion: number | null;
  labelBox: RelBox | null;
  labelContrast: number | null;
  digitalSourceType: string | null;
  parentSha256: string | null;
  componentSha256s: string[];
  embedded: StoredEmbeddedProvenance | null;
  c2paManifest: Buffer | null;
  subjectModule: string;
  subjectKind: string;
  subjectId: string;
  createdBy: string;
  createdAt: Date;
};

export type RecordImageProvenanceInput = {
  sha256: string;
  origin: ImageOrigin;
  labelState: ImageLabelState;
  labelVersion?: number | null;
  labelBox?: RelBox | null;
  labelContrast?: number | null;
  digitalSourceType?: string | null;
  parentSha256?: string | null;
  componentSha256s?: readonly string[];
  /**
   * The engine's reading; its C2PA bytes go to `c2paManifest` unless given.
   * Manifest bytes are kept only for an AI origin or AI-declaring bytes.
   */
  embedded?: EmbeddedProvenance | StoredEmbeddedProvenance | null;
  c2paManifest?: Buffer | null;
  subject: ImageProvenanceSubject;
  createdBy: string;
};

export type { ProvenanceXmpFields };
