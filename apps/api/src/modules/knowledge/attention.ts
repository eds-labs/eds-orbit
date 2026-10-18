import type { DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import {
  sourceExpiry,
  tracksFreshness,
} from "../../../../../packages/knowledge/src/index.ts";
import type {
  AttentionContribution,
  AttentionItem,
} from "../../platform/attention/types.ts";
import { data } from "../../shared.ts";

// The knowledge module's attention items (UI restructure §4.2): sources that
// are stale or about to be, conflicting facts and failed imports, by the
// rules of /knowledge-health. Params carry source names only.

const SOURCES = {
  navKey: "knowledge-sources",
  link: "/knowledge/sources",
} as const;

/** Sources read per request; a project has a handful. */
const SOURCE_LIMIT = 200;

/** One item per stale or expiring source; revoked sources never sync again. */
async function sourceItems(
  tx: DbTx,
  scope: Scope,
  now: Date,
): Promise<AttentionItem[]> {
  const rows = await tx.entity.findMany({
    where: {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      kind: "sources",
    },
    select: { id: true, data: true },
    orderBy: { createdAt: "desc" },
    take: SOURCE_LIMIT,
  });
  const items: AttentionItem[] = [];
  for (const row of rows) {
    const source = data(row);
    if (!tracksFreshness(source)) continue;
    const { state, expiresAt } = sourceExpiry(source, now.getTime());
    const params = { name: String(source.name ?? "") };
    if (state === "stale")
      items.push({
        id: `knowledge:source-stale:${row.id}`,
        moduleId: "knowledge",
        kind: "knowledge_source_stale",
        severity: "critical",
        // Stale since it expired; a never synced source has no such time.
        ...(expiresAt ? { since: expiresAt.toISOString() } : {}),
        params,
        ...SOURCES,
      });
    else if (state === "expiring")
      items.push({
        id: `knowledge:source-expiring:${row.id}`,
        moduleId: "knowledge",
        kind: "knowledge_source_expiring",
        severity: "warning",
        dueAt: expiresAt!.toISOString(),
        params,
        ...SOURCES,
      });
  }
  return items;
}

/**
 * Entities of `kind` matching every `match` field, as one aggregated item
 * waiting since the oldest one last changed.
 */
async function aggregated(
  tx: DbTx,
  scope: Scope,
  kind: string,
  match: Record<string, string>,
  item: Pick<AttentionItem, "id" | "kind" | "navKey" | "link">,
): Promise<AttentionItem[]> {
  const found = await tx.entity.aggregate({
    where: {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      kind,
      AND: Object.entries(match).map(([key, value]) => ({
        data: { path: [key], equals: value },
      })),
    },
    _count: { _all: true },
    _min: { updatedAt: true },
  });
  if (!found._count._all) return [];
  return [
    {
      ...item,
      moduleId: "knowledge",
      severity: "warning",
      count: found._count._all,
      ...(found._min.updatedAt
        ? { since: found._min.updatedAt.toISOString() }
        : {}),
      params: {},
    },
  ];
}

export const knowledgeAttention: AttentionContribution = async (
  tx,
  scope,
  now,
) => [
  ...(await sourceItems(tx, scope, now)),
  ...(await aggregated(
    tx,
    scope,
    "facts",
    { status: "conflicting" },
    {
      id: "knowledge:conflicts",
      kind: "knowledge_conflicts",
      navKey: "knowledge-conflicts",
      link: "/knowledge/conflicts",
    },
  )),
  ...(await aggregated(
    tx,
    scope,
    "jobs",
    { topic: "ingestion", status: "failed" },
    {
      id: "knowledge:import-failed",
      kind: "knowledge_import_failed",
      navKey: "knowledge-import",
      link: "/knowledge/import",
    },
  )),
];
