import type { ServerModule } from "../../../../../packages/module-contracts/src/index.ts";
import { knowledgePermissions } from "./permissions.ts";

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
    ...[
      "knowledge_profiles",
      "knowledge_drafts",
      "knowledge_runs",
      "knowledge_previews",
      "knowledge_proposals",
      "knowledge_github_config",
      "knowledge_github_connections",
      "knowledge_github_oauth",
    ].map((kind) => ({
      kind,
      description: "Reviewed knowledge workspace storage",
      exported: false as const,
    })),
    {
      kind: "sources",
      description: "Knowledge sources with rights and sync settings",
    },
    { kind: "facts", description: "Versioned verified facts" },
    // Evidence is rebuilt from sources and facts; the export leaves it out.
    {
      kind: "evidence",
      description: "Retrieval evidence packs",
      exported: false,
    },
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
  permissions: knowledgePermissions,
};
