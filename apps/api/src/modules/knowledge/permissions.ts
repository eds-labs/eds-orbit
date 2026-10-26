import {
  actionPermissions,
  permission,
} from "../../platform/tenancy/permissions.ts";

/** Knowledge actions (plans/orbit-modularization 04 §2.4). */
export const knowledgeActionPermissions = actionPermissions("knowledge", {
  owner: [
    "knowledge-file-read",
    "knowledge-profile-save",
    "knowledge-draft-save",
    "knowledge-draft-preview",
    "knowledge-analysis-start",
    "knowledge-analysis-cancel",
    "knowledge-proposal-decide",
    "knowledge-github-configure",
    "knowledge-github-connect",
    "activate-index",
    "begin-index",
    "build-index",
    "embed-document",
    "evaluate-index",
    "generate-evaluation-set",
    "knowledge-import-commit",
    "knowledge-import-retry",
    "revoke-document",
    "revoke-source",
    "rollback-index",
    "source-audiences",
    "source-pause",
    "source-reindex",
    "source-settings",
    "start-evaluation-set",
    "withdraw-fact",
  ],
  write: ["import", "knowledge-import-preview"],
  read: ["retrieve"],
});

/** Owner-only writes of the generic collection route. */
export const knowledgeCollectionPermissions = {
  sources: permission("knowledge.sources.write", "Create sources", ["owner"]),
  facts: permission("knowledge.facts.write", "Record facts", ["owner"]),
};

export const knowledgePermissions = [
  ...Object.values(knowledgeActionPermissions),
  ...Object.values(knowledgeCollectionPermissions),
];
