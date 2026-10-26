import { queueIndexBuild } from "./evaluation-tools.ts";
import {
  saveProfile,
  saveDraft,
  previewDraft,
  startAnalysis,
  cancelAnalysis,
  decideProposal,
  readKnowledgeFile,
  owner,
} from "./workspace.ts";
import { configureGithub, beginGithub } from "./github.ts";
import { z } from "zod";
import { scoped, type DbTx } from "../../../../../packages/db/src/index.ts";
import * as schemas from "../../../../../packages/schemas/src/index.ts";
import {
  activateIndexGeneration,
  beginIndexBuild,
  extractDocument,
  retrieve,
  rollbackIndexGeneration,
} from "../../../../../packages/knowledge/src/index.ts";
import {
  ingest,
  revokeDocument,
  revokeSource,
  setSourceAudiences,
  setSourceRights,
  restampSource,
  withdrawFact,
} from "../../platform/knowledge/engine.ts";
import {
  ownTransaction,
  sharedTransaction,
  type ActionContext,
  type ActionHandler,
} from "../../platform/http/actions.ts";
import { enqueue } from "../../platform/jobs/enqueue.ts";
import { create, data, entity } from "../../shared.ts";
import { retrieveHybrid } from "../../platform/knowledge/retrieval.ts";
import {
  queueIndexEvaluation,
  indexEvaluationRequest,
} from "../../platform/knowledge/index-evaluation.ts";
import { queueDocumentEmbedding } from "../../platform/knowledge/ingestion.ts";
import {
  queueEvaluationSet,
  startEvaluationSet,
} from "../../platform/knowledge/evaluation-set.ts";
import {
  commitKnowledgeImport,
  importPreview,
  knowledgeImportInput,
  retryKnowledgeImport,
} from "./import.ts";

const retrievalRequest = (input: ActionContext["input"]) => ({
  query: z.string().min(1).max(2000).parse(input.query),
  language: schemas.languageCode.default("en").parse(input.language),
  purpose: z
    .enum(["public", "internal"])
    .default("public")
    .parse(input.purpose),
  at: input.at ? new Date(z.iso.datetime().parse(input.at)) : new Date(),
  factKeys: z.array(z.string()).max(20).optional().parse(input.factKeys),
  sourceIds: z.array(schemas.id).max(30).optional().parse(input.sourceIds),
  // Lets an operator preview what one module retrieves (WP3.5); without it
  // only sources open to all modules are searched.
  consumer: z
    .enum(["marketing", "support"])
    .optional()
    .parse(input.consumer ?? undefined),
});

/**
 * Knowledge's project actions (WP2.1f), moved unchanged from server.ts.
 * Transitional: the handlers still call the knowledge services where they
 * live today; WP3.3 moves them into this module.
 */
export const knowledgeActions: Record<string, ActionHandler> = {
  "knowledge-file-read": ownTransaction(({ scope, input }) =>
    readKnowledgeFile(scope, input),
  ),
  "knowledge-profile-save": ownTransaction(({ scope, input }) =>
    saveProfile(scope, input),
  ),
  "knowledge-draft-save": ownTransaction(({ scope, input }) =>
    saveDraft(scope, input),
  ),
  "knowledge-draft-preview": ownTransaction(({ scope, input }) =>
    previewDraft(scope, input),
  ),
  "knowledge-analysis-start": ownTransaction(({ scope, input }) =>
    startAnalysis(scope, input),
  ),
  "knowledge-analysis-cancel": ownTransaction(({ scope, input }) =>
    cancelAnalysis(scope, input),
  ),
  "knowledge-proposal-decide": ownTransaction(({ scope, input }) =>
    decideProposal(scope, input),
  ),
  "knowledge-github-configure": ownTransaction(async ({ scope, input }) => {
    await owner(scope);
    return configureGithub(scope, input);
  }),
  "knowledge-github-connect": ownTransaction(async ({ scope, input }) => {
    await owner(scope);
    return beginGithub(scope, input);
  }),
  // Hybrid retrieval embeds the query outside the project transaction.
  retrieve: ownTransaction(({ scope, input }) =>
    input.useEmbeddings === true
      ? retrieveHybrid(scope, retrievalRequest(input))
      : scoped(scope.workspaceId, scope.projectId, (tx: DbTx) =>
          retrieve(tx, scope, retrievalRequest(input)),
        ),
  ),
  "knowledge-import-preview": ownTransaction(async ({ input }) =>
    importPreview(knowledgeImportInput.parse(input)),
  ),
  "knowledge-import-commit": sharedTransaction((tx, { scope, input }) =>
    commitKnowledgeImport(tx, scope, knowledgeImportInput.parse(input)),
  ),
  "knowledge-import-retry": sharedTransaction((tx, { scope, input }) =>
    retryKnowledgeImport(
      tx,
      scope,
      schemas.id.parse(input.importId),
      knowledgeImportInput.parse(input.payload),
    ),
  ),
  "withdraw-fact": sharedTransaction((tx, { scope, input }) =>
    withdrawFact(
      tx,
      scope,
      schemas.id.parse(input.factId),
      z.number().int().positive().parse(input.version),
    ),
  ),
  "evaluate-index": sharedTransaction((tx, { scope, input }) =>
    queueIndexEvaluation(tx, scope, indexEvaluationRequest.parse(input)),
  ),
  // Orbit writes the test questions; the owner reviews them and starts the evaluation.
  "generate-evaluation-set": sharedTransaction((tx, { scope, input }) =>
    queueEvaluationSet(tx, scope, schemas.id.parse(input.indexId)),
  ),
  "start-evaluation-set": sharedTransaction((tx, { scope, input }) =>
    startEvaluationSet(tx, scope, input),
  ),
  "begin-index": sharedTransaction((tx, { scope, input }) =>
    beginIndexBuild(tx, scope, z.string().max(200).parse(input.profile)),
  ),
  "build-index": sharedTransaction((tx, { scope, input }) =>
    queueIndexBuild(tx, scope, schemas.id.parse(input.indexId)),
  ),
  "activate-index": sharedTransaction((tx, { scope, input }) =>
    activateIndexGeneration(tx, scope, schemas.id.parse(input.indexId)),
  ),
  "rollback-index": sharedTransaction((tx, { scope, input }) =>
    rollbackIndexGeneration(tx, scope, schemas.id.parse(input.indexId)),
  ),
  import: sharedTransaction(async (tx, { scope, input }) => {
    const source = await entity(
      tx,
      scope,
      "sources",
      schemas.id.parse(input.sourceId),
    );
    if (input.url) {
      const url = z.url().parse(input.url);
      const request = await create(tx, scope, "sync_requests", {
        sourceId: source.id,
        url,
        expectedGeneration: data(source).generation,
        language: input.language ?? "en",
      });
      return enqueue(tx, scope, "ingestion", request.id, "sync:" + request.id);
    }
    const parsed = z
      .object({
        sourceId: schemas.id,
        externalId: z.string().min(1).max(300),
        title: z.string().min(1).max(300),
        text: z.string().max(1000000).optional(),
        base64: z.string().max(1400000).optional(),
        mimeType: z.enum([
          "text/plain",
          "text/markdown",
          "text/html",
          "application/pdf",
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        ]),
        language: schemas.languageCode,
      })
      .strict()
      .parse(input);
    const extracted = await extractDocument(
      parsed.base64
        ? Buffer.from(parsed.base64, "base64")
        : Buffer.from(parsed.text ?? ""),
      parsed.mimeType,
    );
    return ingest(tx, scope, {
      sourceId: source.id,
      externalId: parsed.externalId,
      title: parsed.title,
      text: extracted.text,
      mimeType: parsed.mimeType,
      language: parsed.language,
      expectedGeneration: data(source).generation,
    });
  }),
  "revoke-source": sharedTransaction((tx, { scope, input }) =>
    revokeSource(tx, scope, schemas.id.parse(input.sourceId)),
  ),
  "source-pause": sharedTransaction((tx, { scope, input }) =>
    setSourceRights(tx, scope, schemas.id.parse(input.sourceId), {
      paused: z.boolean().parse(input.paused),
    }),
  ),
  // Owner settings of a source: authority (how it ranks and whether it may
  // serve as evidence at all) and freshness window. Rights flags stay where
  // they are; the change re-attaches stored documents to the new generation.
  "source-settings": sharedTransaction((tx, { scope, input }) => {
    const i = z
      .object({
        sourceId: schemas.id,
        authority: z
          .enum(["official", "website", "research", "generated"])
          .optional(),
        maxAgeHours: z.number().int().min(1).max(8760).optional(),
      })
      .strict()
      .refine((v) => v.authority !== undefined || v.maxAgeHours !== undefined, {
        message: "Nothing to change",
      })
      .parse(input);
    return setSourceRights(tx, scope, i.sourceId, {
      ...(i.authority ? { authority: i.authority } : {}),
      ...(i.maxAgeHours ? { maxAgeHours: i.maxAgeHours } : {}),
    });
  }),
  // Re-attaches documents left on an older generation (idempotent; the
  // project transaction lock serializes parallel runs).
  "source-reindex": sharedTransaction((tx, { scope, input }) =>
    restampSource(tx, scope, schemas.id.parse(input.sourceId)),
  ),
  "source-audiences": sharedTransaction((tx, { scope, input }) =>
    setSourceAudiences(
      tx,
      scope,
      schemas.id.parse(input.sourceId),
      schemas.sourceAudiences.parse(input.audiences),
    ),
  ),
  "revoke-document": sharedTransaction((tx, { scope, input }) =>
    revokeDocument(
      tx,
      scope,
      schemas.id.parse(input.documentId),
      typeof input.versionId === "string" ? input.versionId : undefined,
    ),
  ),
  "embed-document": sharedTransaction(async (tx, { scope, input }) => {
    const i = z
      .object({
        documentId: schemas.id,
        confirmEmbeddingMayBeSentToOpenAI: z.literal(true),
      })
      .strict()
      .parse(input);
    return queueDocumentEmbedding(tx, scope, i.documentId);
  }),
};
