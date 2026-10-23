import { z } from "zod";
import {
  authDb,
  scoped,
  type DbTx,
} from "../../../../../packages/db/src/index.ts";
import { loadConfig } from "../../../../../packages/config/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import {
  retrieve,
  validateEvidence,
  type RetrieveInput,
} from "../../../../../packages/knowledge/src/index.ts";
import { data, DomainError } from "../shared.ts";
import { systemAudit } from "../administration/audit.ts";

// Organization knowledge (ADR 0013, E1): a library project holds the shared
// sources with the usual tables, rights, indexes and evaluation; a
// KnowledgeShare lets one consumer project search selected sources of it.
// The library is searched in its own project transaction, so row-level
// security never changes and a project without a share sees nothing.
// Shared results carry their origin and are validated in the library
// together with the share (active, same generation) before use.
//
// Shared results serve the modules that validate knowledge when they use
// it (support drafts, assistant answers). Marketing keeps content derived
// from knowledge, which needs an invalidation fan-out into the consumer
// project first; it does not receive shared results yet, and neither does
// the MCP search.

export const sharesEnabled = () =>
  loadConfig().ORBIT_KNOWLEDGE_SHARES === "true";

/** Modules shared results may serve; see above. */
export const SHAREABLE_MODULES = ["support", "assistant"] as const;
const MAX_SHARES_PER_QUERY = 3;

export const shareInput = z
  .object({
    libraryProjectId: z.uuid(),
    consumerProjectId: z.uuid(),
    sourceIds: z.array(z.uuid()).max(100).default([]),
    modules: z.array(z.enum(SHAREABLE_MODULES)).max(2).default([]),
  })
  .strict();
export const shareUpdate = z
  .object({
    sourceIds: z.array(z.uuid()).max(100).optional(),
    modules: z.array(z.enum(SHAREABLE_MODULES)).max(2).optional(),
  })
  .strict();

type Actor = { userId: string; workspaceId: string };

/** Creates an organization's knowledge library (a project of kind library). */
export async function createLibrary(actor: Actor, raw: unknown) {
  const { name } = z
    .object({ name: z.string().trim().min(1).max(100) })
    .strict()
    .parse(raw);
  return authDb.$transaction(async (tx) => {
    const library = await tx.project.create({
      data: { workspaceId: actor.workspaceId, name, kind: "library" },
    });
    await systemAudit(
      {
        actorId: actor.userId,
        action: "knowledge_library.created",
        targetType: "project",
        targetId: library.id,
        workspaceId: actor.workspaceId,
        projectId: library.id,
      },
      tx,
    );
    return { id: library.id, name: library.name, kind: library.kind };
  });
}

/** The organization's libraries and shares, metadata only. */
export async function listShares(workspaceId: string) {
  const [libraries, shares] = await Promise.all([
    authDb.project.findMany({
      where: { workspaceId, kind: "library" },
      select: { id: true, name: true, createdAt: true },
      orderBy: { createdAt: "asc" },
    }),
    authDb.knowledgeShare.findMany({
      where: { workspaceId, revokedAt: null },
      include: {
        library: { select: { name: true } },
        consumer: { select: { name: true } },
      },
      orderBy: { createdAt: "asc" },
    }),
  ]);
  return {
    libraries,
    shares: shares.map((s) => ({
      id: s.id,
      libraryProjectId: s.libraryProjectId,
      libraryName: s.library.name,
      consumerProjectId: s.consumerProjectId,
      consumerName: s.consumer.name,
      sourceIds: s.sourceIds,
      modules: s.modules,
      generation: s.generation,
      createdAt: s.createdAt,
    })),
  };
}

/** The library sources a share may name (read in the library's own scope). */
async function assertLibrarySources(
  workspaceId: string,
  libraryProjectId: string,
  sourceIds: string[],
) {
  if (!sourceIds.length) return;
  const found = await scoped(workspaceId, libraryProjectId, (tx) =>
    tx.entity.count({
      where: {
        workspaceId,
        projectId: libraryProjectId,
        kind: "sources",
        id: { in: sourceIds },
      },
    }),
  );
  if (found !== new Set(sourceIds).size)
    throw new DomainError("SOURCE_NOT_FOUND", 404);
}

export async function createShare(actor: Actor, raw: unknown) {
  const input = shareInput.parse(raw);
  const projects = await authDb.project.findMany({
    where: {
      workspaceId: actor.workspaceId,
      id: { in: [input.libraryProjectId, input.consumerProjectId] },
    },
    select: { id: true, kind: true },
  });
  const library = projects.find((p) => p.id === input.libraryProjectId);
  const consumer = projects.find((p) => p.id === input.consumerProjectId);
  if (!library || !consumer) throw new DomainError("NOT_FOUND", 404);
  if (library.kind !== "library" || consumer.kind !== "project")
    throw new DomainError("LIBRARY_REQUIRED", 409);
  await assertLibrarySources(
    actor.workspaceId,
    library.id,
    input.sourceIds,
  );
  return authDb.$transaction(async (tx) => {
    // A newer share for the same pair replaces the old one.
    await tx.knowledgeShare.updateMany({
      where: {
        libraryProjectId: library.id,
        consumerProjectId: consumer.id,
        revokedAt: null,
      },
      data: { revokedAt: new Date() },
    });
    const share = await tx.knowledgeShare.create({
      data: {
        workspaceId: actor.workspaceId,
        libraryProjectId: library.id,
        consumerProjectId: consumer.id,
        sourceIds: input.sourceIds,
        modules: input.modules,
        createdBy: actor.userId,
      },
    });
    await systemAudit(
      {
        actorId: actor.userId,
        action: "knowledge_share.created",
        targetType: "knowledge_share",
        targetId: share.id,
        workspaceId: actor.workspaceId,
        projectId: consumer.id,
        metadata: {
          libraryProjectId: library.id,
          sources: input.sourceIds.length,
          modules: input.modules,
        },
      },
      tx,
    );
    return share;
  });
}

/**
 * Changes a share's sources or modules. Any change bumps its generation:
 * results validated against the old generation stop being valid.
 */
export async function updateShare(actor: Actor, shareId: string, raw: unknown) {
  const input = shareUpdate.parse(raw);
  const share = await authDb.knowledgeShare.findFirst({
    where: {
      id: z.uuid().parse(shareId),
      workspaceId: actor.workspaceId,
      revokedAt: null,
    },
  });
  if (!share) throw new DomainError("NOT_FOUND", 404);
  if (input.sourceIds)
    await assertLibrarySources(
      actor.workspaceId,
      share.libraryProjectId,
      input.sourceIds,
    );
  return authDb.$transaction(async (tx) => {
    const updated = await tx.knowledgeShare.update({
      where: { id: share.id },
      data: {
        ...(input.sourceIds ? { sourceIds: input.sourceIds } : {}),
        ...(input.modules ? { modules: input.modules } : {}),
        generation: { increment: 1 },
      },
    });
    await systemAudit(
      {
        actorId: actor.userId,
        action: "knowledge_share.updated",
        targetType: "knowledge_share",
        targetId: share.id,
        workspaceId: actor.workspaceId,
        projectId: share.consumerProjectId,
        metadata: { generation: updated.generation, fields: Object.keys(input) },
      },
      tx,
    );
    return updated;
  });
}

export async function revokeShare(actor: Actor, shareId: string) {
  await authDb.$transaction(async (tx) => {
    const share = await tx.knowledgeShare.findFirst({
      where: {
        id: z.uuid().parse(shareId),
        workspaceId: actor.workspaceId,
        revokedAt: null,
      },
    });
    if (!share) throw new DomainError("NOT_FOUND", 404);
    await tx.knowledgeShare.update({
      where: { id: share.id },
      data: { revokedAt: new Date(), generation: { increment: 1 } },
    });
    await systemAudit(
      {
        actorId: actor.userId,
        action: "knowledge_share.revoked",
        targetType: "knowledge_share",
        targetId: share.id,
        workspaceId: actor.workspaceId,
        projectId: share.consumerProjectId,
      },
      tx,
    );
  });
  return { revoked: true };
}

/** A consumer project's active shares for one module. */
async function activeShares(tx: DbTx, scope: Scope, module: string) {
  if (!(SHAREABLE_MODULES as readonly string[]).includes(module)) return [];
  // Only libraries can be shared (checked on creation; a kind never changes).
  const shares = await tx.knowledgeShare.findMany({
    where: {
      workspaceId: scope.workspaceId,
      consumerProjectId: scope.projectId,
      revokedAt: null,
    },
    orderBy: { createdAt: "asc" },
  });
  return shares.filter((s) => !s.modules.length || s.modules.includes(module));
}

/** One shared result set: where it came from and how to re-check it. */
export type SharedOrigin = {
  shareId: string;
  generation: number;
  libraryProjectId: string;
  libraryName: string;
  evidenceId: string;
};

/**
 * Searches the libraries shared with the consumer project, lexically, each
 * in its own project transaction, and returns their valid facts and
 * passages with origin. The consumer pays nothing for it.
 */
export async function sharedSearch(
  scope: Scope,
  request: RetrieveInput,
  module: string,
) {
  if (!sharesEnabled()) return [];
  const shares = await scoped(scope.workspaceId, scope.projectId, (tx) =>
    activeShares(tx, scope, module),
  );
  const out: Array<{
    origin: SharedOrigin;
    facts: any[];
    items: any[];
    sources: Map<string, string>;
  }> = [];
  for (const share of shares.slice(0, MAX_SHARES_PER_QUERY)) {
    const library: Scope = {
      workspaceId: scope.workspaceId,
      projectId: share.libraryProjectId,
      userId: scope.userId,
      role: "viewer",
    };
    const found = await scoped(
      library.workspaceId,
      library.projectId,
      async (tx) => {
        const evidence = await retrieve(tx, library, {
          ...request,
          queryVector: undefined,
          profile: undefined,
          ...(share.sourceIds.length ? { sourceIds: share.sourceIds } : {}),
          consumer: module,
        } as RetrieveInput);
        const value = data(evidence);
        if (value.status !== "ready") return null;
        // The library's own row is visible only in its own transaction.
        const project = await tx.project.findUniqueOrThrow({
          where: { id: library.projectId },
          select: { name: true },
        });
        const check = await validateEvidence(tx, library, evidence.id);
        if (!check.valid) return null;
        const facts = (value.facts ?? []) as any[];
        const items = (value.items ?? []) as any[];
        const sourceIds = [
          ...new Set([...facts, ...items].map((x) => x.sourceId).filter(Boolean)),
        ];
        const sources = await tx.entity.findMany({
          where: {
            workspaceId: library.workspaceId,
            projectId: library.projectId,
            kind: "sources",
            id: { in: sourceIds },
          },
        });
        return {
          evidenceId: evidence.id,
          libraryName: project.name,
          facts,
          items,
          sources: new Map(
            sources.map((s) => [s.id, String(data(s).name ?? "")]),
          ),
        };
      },
    );
    if (!found) continue;
    out.push({
      origin: {
        shareId: share.id,
        generation: share.generation,
        libraryProjectId: share.libraryProjectId,
        libraryName: found.libraryName,
        evidenceId: found.evidenceId,
      },
      facts: found.facts,
      items: found.items,
      sources: found.sources,
    });
  }
  return out;
}

/**
 * Whether shared results may still be used: each share is active with the
 * generation it had, and its evidence is still valid in the library.
 */
export async function validateShared(scope: Scope, origins: SharedOrigin[]) {
  for (const origin of origins) {
    const share = await scoped(scope.workspaceId, scope.projectId, (tx) =>
      tx.knowledgeShare.findFirst({
        where: {
          id: origin.shareId,
          consumerProjectId: scope.projectId,
          revokedAt: null,
        },
      }),
    );
    if (!share || share.generation !== origin.generation) return false;
    const library: Scope = {
      ...scope,
      projectId: origin.libraryProjectId,
      role: "viewer",
    };
    const check = await scoped(scope.workspaceId, origin.libraryProjectId, (tx) =>
      validateEvidence(tx, library, origin.evidenceId),
    );
    if (!check.valid) return false;
  }
  return true;
}
