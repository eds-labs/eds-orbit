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
/** Individual items per source kind; the rest become one "more" item (R18). */
const SOURCE_ITEMS = 3;

type Expiring = { id: string; name: string; expiresAt: Date | null };

/** Never synced first, then the earliest expiry: the most urgent first. */
const byExpiry = (a: Expiring, b: Expiring) =>
  (a.expiresAt?.getTime() ?? -Infinity) -
    (b.expiresAt?.getTime() ?? -Infinity) ||
  (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * The SOURCE_ITEMS most urgent sources of one kind as items of their own,
 * the rest as one aggregated item (`count`, the earliest remaining time).
 */
function capped(
  sources: Expiring[],
  kind: "knowledge_source_stale" | "knowledge_source_expiring",
): AttentionItem[] {
  const stale = kind === "knowledge_source_stale";
  const base = {
    moduleId: "knowledge",
    kind,
    severity: stale ? "critical" : "warning",
    ...SOURCES,
  } as const;
  // Stale since it expired (a never synced source has no such time);
  // expiring until it expires.
  const time = (at: Date | null) =>
    at ? { [stale ? "since" : "dueAt"]: at.toISOString() } : {};
  const sorted = [...sources].sort(byExpiry);
  const items: AttentionItem[] = sorted
    .slice(0, SOURCE_ITEMS)
    .map((source) => ({
      ...base,
      id: `knowledge:${stale ? "source-stale" : "source-expiring"}:${source.id}`,
      ...time(source.expiresAt),
      params: { name: source.name },
    }));
  const rest = sorted.slice(SOURCE_ITEMS);
  if (rest.length)
    items.push({
      ...base,
      id: `knowledge:${stale ? "source_stale" : "source_expiring"}:more`,
      count: rest.length,
      ...time(rest.find((source) => source.expiresAt)?.expiresAt ?? null),
      params: {},
    });
  return items;
}

/** Stale and expiring sources; revoked sources never sync again. */
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
  const stale: Expiring[] = [];
  const expiring: Expiring[] = [];
  for (const row of rows) {
    const source = data(row);
    if (!tracksFreshness(source)) continue;
    const { state, expiresAt } = sourceExpiry(source, now.getTime());
    if (state === "fresh") continue;
    (state === "stale" ? stale : expiring).push({
      id: row.id,
      name: String(source.name ?? ""),
      expiresAt,
    });
  }
  return [
    ...capped(stale, "knowledge_source_stale"),
    ...capped(expiring, "knowledge_source_expiring"),
  ];
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
