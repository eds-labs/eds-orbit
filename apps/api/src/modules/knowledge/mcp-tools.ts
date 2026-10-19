import { modelFacts } from "../../platform/knowledge/mcp-read.ts";
import { z } from "zod";
import {
  readOperation,
  approvedOperation,
} from "../../platform/tasks/operation-tools.ts";
import {
  PROJECT_READ,
  PROJECT_WRITE,
  PROJECT_OWN,
} from "../../platform/tenancy/permissions.ts";
import { create, data, entity } from "../../shared.ts";
import {
  ingest,
  setFact,
  withdrawFact,
} from "../../platform/knowledge/engine.ts";
import { enqueue } from "../../platform/jobs/enqueue.ts";
import { source as sourceSchema } from "../../../../../packages/schemas/src/index.ts";

const page = z
  .object({
    cursor: z.uuid().optional(),
    limit: z.number().int().min(1).max(20).default(10),
  })
  .strict();
const factInput = z
  .object({
    sourceId: z.uuid(),
    key: z.string().min(1).max(200),
    value: z.string().min(1).max(4000),
    valueType: z.enum(["text", "decimal", "date", "status", "url"]),
    currency: z.string().max(3).optional(),
    unit: z.string().max(100).optional(),
    language: z.enum(["en", "de"]),
    validFrom: z.iso.datetime(),
    validUntil: z.iso.datetime().optional(),
    publicUse: z.boolean(),
    modelUse: z.boolean(),
    supersedesId: z.uuid().optional(),
  })
  .strict();
const shared = { module: "knowledge" };
async function sources(tx: any, scope: any, args: any) {
  const found = await tx.entity.findMany({
    where: {
      projectId: scope.projectId,
      kind: "sources",
      ...(args.cursor ? { id: { gt: args.cursor } } : {}),
    },
    orderBy: { id: "asc" },
    take: args.limit + 1,
  });
  return {
    items: found.slice(0, args.limit).map((r: any) => {
      const s = data(r);
      return {
        id: r.id,
        name: s.name,
        status: s.status,
        type: s.type,
        generation: s.generation,
        modelUse: s.modelUse,
        publicUse: s.publicUse,
        lastSuccessfulSyncAt: s.lastSuccessfulSyncAt ?? null,
        stale:
          !s.lastSuccessfulSyncAt ||
          Date.now() - Date.parse(s.lastSuccessfulSyncAt) >
            s.maxAgeHours * 3600000,
      };
    }),
    nextCursor: found.length > args.limit ? found[args.limit - 1].id : null,
  };
}
const reads = [
  readOperation({
    ...shared,
    name: "knowledge_sources",
    description:
      "List native knowledge sources and their rights, sync and freshness state; does not expose document contents.",
    permission: PROJECT_READ,
    input: page,
    run: sources,
  }),
  readOperation({
    ...shared,
    name: "knowledge_facts",
    description:
      "List verified model-usable facts from active model-usable sources. Candidates and withdrawn facts are not facts. search/fetch provide compatible citations.",
    permission: PROJECT_READ,
    input: page,
    async run(tx, scope, args) {
      const rows = await tx.entity.findMany({
        where: {
          projectId: scope.projectId,
          kind: "facts",
          ...(args.cursor ? { id: { gt: args.cursor } } : {}),
          AND: [
            { data: { path: ["modelUse"], equals: true } },
            { data: { path: ["status"], equals: "verified" } },
          ],
        },
        orderBy: { id: "asc" },
        take: args.limit + 1,
      });
      const usable = await modelFacts(
        tx,
        scope,
        rows.slice(0, args.limit).map((r) => r.id),
      );
      return {
        items: [...usable.values()].map((r) => ({
          id: r.id,
          version: r.version,
          ...data(r),
        })),
        nextCursor: rows.length > args.limit ? rows[args.limit - 1]!.id : null,
      };
    },
  }),
];
const writes = [
  approvedOperation({
    ...shared,
    name: "knowledge_add_source",
    description:
      "Propose a knowledge source with explicit public/model rights. The owner verifies rights before approval.",
    permission: PROJECT_OWN,
    input: z
      .object({
        name: z.string().min(1).max(200),
        type: z.enum(["manual", "file", "website", "gitbook"]),
        publicUse: z.boolean(),
        modelUse: z.boolean(),
        authority: z.enum(["official", "website", "research", "generated"]),
        allowedOrigins: z.array(z.url()).max(20),
        allowedPaths: z.array(z.string().max(400)).max(20),
      })
      .strict(),
    run: (tx, scope, args) =>
      create(tx, scope, "sources", sourceSchema.parse(args)),
  }),
  approvedOperation({
    ...shared,
    name: "knowledge_add_document",
    description:
      "Add or update a text/Markdown document through native ingestion. Reuse externalId to version an existing document. No embeddings are purchased by this action.",
    permission: PROJECT_WRITE,
    input: z
      .object({
        sourceId: z.uuid(),
        externalId: z.string().min(1).max(300),
        title: z.string().min(1).max(300),
        text: z.string().min(1).max(24000),
        language: z.enum(["en", "de"]),
        mimeType: z.enum(["text/plain", "text/markdown"]),
      })
      .strict(),
    async run(tx, scope, args) {
      const s = await entity(tx, scope, "sources", args.sourceId);
      return ingest(tx, scope, {
        ...args,
        expectedGeneration: data(s).generation,
      });
    },
  }),
  approvedOperation({
    ...shared,
    name: "knowledge_import_url",
    description:
      "Queue the existing allowlisted website/GitBook ingestion. Native origin/path restrictions and source status remain mandatory.",
    permission: PROJECT_WRITE,
    input: z
      .object({
        sourceId: z.uuid(),
        url: z.url(),
        language: z.enum(["en", "de"]),
      })
      .strict(),
    async run(tx, scope, args) {
      const s = await entity(tx, scope, "sources", args.sourceId);
      const request = await create(tx, scope, "sync_requests", {
        ...args,
        expectedGeneration: data(s).generation,
      });
      const job = await enqueue(
        tx,
        scope,
        "ingestion",
        request.id,
        `sync:${request.id}`,
      );
      return { jobId: job.id, status: "queued" };
    },
  }),
  approvedOperation({
    ...shared,
    name: "knowledge_propose_fact",
    description:
      "Record a candidate fact through the native engine. Candidate status never becomes verified merely because an agent proposed it.",
    permission: PROJECT_OWN,
    input: factInput,
    run: (tx, scope, args) =>
      setFact(tx, scope, { ...args, status: "candidate" }),
  }),
  approvedOperation({
    ...shared,
    name: "knowledge_verify_fact",
    description:
      "Submit exact fact values for owner verification. Only the owner's approval records a verified fact; native source-rights/conflict and downstream invalidation rules apply.",
    permission: PROJECT_OWN,
    input: factInput,
    run: (tx, scope, args) =>
      setFact(tx, scope, { ...args, status: "verified" }),
  }),
  approvedOperation({
    ...shared,
    name: "knowledge_withdraw_fact",
    description:
      "Withdraw an exact fact version and invalidate dependent evidence/content through native impact handlers.",
    permission: PROJECT_OWN,
    input: z
      .object({ factId: z.uuid(), version: z.number().int().positive() })
      .strict(),
    run: (tx, scope, args) =>
      withdrawFact(tx, scope, args.factId, args.version),
  }),
];
export const knowledgeMcpTools = [...reads, ...writes.map((w) => w.tool)];
export const knowledgeMcpActions = Object.fromEntries(
  writes.map((w) => [w.actionType, w.action]),
);
