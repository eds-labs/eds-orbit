export type Scope = { workspaceId: string; projectId: string; userId: string };
export const RETRIEVER_VERSION = "hybrid-rrf-v1";
export const EMBEDDING_PROFILE = "openai:text-embedding-3-small:1536:chunk-v1";
export const CHUNK_VERSION = "structure-v1";
export const LIMITS = {
  maxBytes: 2_000_000,
  maxChunks: 500,
  candidates: 40,
  topK: 8,
  maxPerDocument: 3,
  contextTokens: 6000,
};
export type Purpose = "public" | "internal";
export type SourceData = {
  status: "active" | "paused" | "revoked";
  generation: number;
  publicUse: boolean;
  modelUse: boolean;
  authority: "official" | "website" | "research" | "generated";
  maxAgeHours: number;
  allowedOrigins: string[];
  allowedPaths: string[];
  embargoUntil?: string;
};
export type FactInput = {
  id?: string;
  key: string;
  value: string;
  valueType: "text" | "decimal" | "date" | "status" | "url";
  currency?: string;
  unit?: string;
  language: string;
  market?: string;
  sourceId: string;
  validFrom: string;
  validUntil?: string;
  status: "candidate" | "verified";
  publicUse: boolean;
  modelUse: boolean;
  supersedesId?: string;
  resolveConflictIds?: string[];
};
export type FactData = Omit<FactInput, "status"> & {
  verifiedBy: string | null;
  verifiedAt: string | null;
  sourceGeneration: number;
  recordedAt: string;
  status: "candidate" | "verified" | "conflicting" | "superseded" | "revoked";
};
export type ChunkInput = {
  position: number;
  heading: string;
  anchor: string;
  text: string;
  chunkHash: string;
  tokenEstimate: number;
};
export type EvidenceItem = {
  chunkId: string;
  documentVersionId: string;
  sourceId: string;
  sourceGeneration: number;
  authority: string;
  title: string;
  text: string;
  anchor: string;
  canonicalUrl: string | null;
  score: number;
  reasons: string[];
  publicUse: boolean;
  modelUse: boolean;
  fetchedAt: string;
  validUntil: string | null;
};
export type EvidenceFact = {
  id: string;
  version: number;
  key: string;
  value: string;
  valueType: string;
  currency?: string;
  unit?: string;
  sourceId: string;
  sourceGeneration: number;
  validFrom: string;
  validUntil?: string;
  publicUse: boolean;
  modelUse: boolean;
};
export type EvidenceData = {
  status: "ready" | "insufficient_evidence" | "invalidated";
  purpose: Purpose;
  forModel: boolean;
  query: string;
  language: string;
  at: string;
  createdAt: string;
  generation: number;
  retrieverVersion: string;
  indexProfile: string;
  indexId?: string;
  indexGeneration?: number;
  mode: "hybrid" | "lexical_degraded";
  facts: EvidenceFact[];
  items: EvidenceItem[];
  gaps: string[];
  excluded: { sourceId: string; reason: string }[];
  hash: string;
  durationMs: number;
  estimatedTokens: number;
};
export type IngestInput = {
  sourceId: string;
  externalId: string;
  title: string;
  text: string;
  mimeType: string;
  language: string;
  expectedGeneration?: number;
  canonicalUrl?: string;
  validFrom?: string;
  validUntil?: string;
  sourceUpdatedAt?: string;
  embeddings?: number[][];
  profile?: string;
};
export type RetrieveInput = {
  query: string;
  purpose: Purpose;
  at?: string | Date;
  language?: string;
  factKeys?: string[];
  sourceIds?: string[];
  market?: string;
  queryVector?: number[];
  profile?: string;
  forModel?: boolean;
  topK?: number;
};
export class KnowledgeError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}
