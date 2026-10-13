import type { ServerModule } from "../../../../../packages/module-contracts/src/index.ts";

/**
 * Transitional manifest (WP1.3): declares what the knowledge module owns.
 * Its code still lives in packages/knowledge and the flat api modules; routes,
 * jobs and tools join the manifest when those registries open (WP1.6, WP3.3).
 */
export const knowledgeModule: ServerModule = {
  id: "knowledge",
  version: "1.0.0",
  displayName: { en: "Knowledge", de: "Wissen" },
  dependsOn: [],
  defaultEnabled: true,
  entityKinds: [
    {
      kind: "sources",
      description: "Knowledge sources with rights and sync settings",
    },
    { kind: "facts", description: "Versioned verified facts" },
    { kind: "evidence", description: "Retrieval evidence packs" },
    { kind: "revocations", description: "Document revocation tombstones" },
    { kind: "sync_requests", description: "Requested source synchronisations" },
    { kind: "retrieval_runs", description: "Cached hybrid retrieval results" },
    {
      kind: "index_evaluations",
      description: "Index generation evaluation runs",
    },
    { kind: "knowledge_imports", description: "Bulk knowledge import jobs" },
  ],
  tables: [
    "KnowledgeDocument",
    "DocumentVersion",
    "KnowledgeChunk",
    "ChunkEmbedding",
    "KnowledgeIndex",
  ],
  permissions: [],
};
