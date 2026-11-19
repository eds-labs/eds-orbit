import type { DbTx } from "../../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import { data } from "../../../shared.ts";

// The open publication request of an entry. The entry's status keeps its
// live state (draft, scheduled, published, archived); whether a request is
// waiting is read from the request itself, so a rejected or expired request
// never leaves a stale "in review" behind (requests have no rejection hook).

export const PUBLISH_ACTION = "cms.entry.publish";
export const UNPUBLISH_ACTION = "cms.entry.unpublish";

export interface PendingRequest {
  id: string;
  actionType: typeof PUBLISH_ACTION | typeof UNPUBLISH_ACTION;
  requesterId: string;
  revisionId: string | null;
  expiresAt: string;
  createdAt: string;
}

const pendingWhere = (scope: Pick<Scope, "workspaceId" | "projectId">) => ({
  workspaceId: scope.workspaceId,
  projectId: scope.projectId,
  kind: "action_requests",
  AND: [
    { data: { path: ["status"], equals: "pending" } },
    { OR: [{ data: { path: ["actionType"], equals: PUBLISH_ACTION } }, { data: { path: ["actionType"], equals: UNPUBLISH_ACTION } }] },
  ],
});

const view = (row: { id: string; createdAt: Date; data: unknown }): PendingRequest | null => {
  const d = data(row);
  if (!(Date.parse(d.expiresAt) > Date.now())) return null;
  return {
    id: row.id,
    actionType: d.actionType,
    requesterId: String(d.payload?.requesterId ?? ""),
    revisionId: d.payload?.revisionId ?? null,
    expiresAt: d.expiresAt,
    createdAt: row.createdAt.toISOString(),
  };
};

/** The entry's open (pending, unexpired) publication request, or null. */
export async function pendingRequestFor(tx: DbTx, scope: Pick<Scope, "workspaceId" | "projectId">, entryId: string) {
  const rows = await tx.entity.findMany({
    where: { ...pendingWhere(scope), AND: [...pendingWhere(scope).AND, { data: { path: ["payload", "entryId"], equals: entryId } }] },
    orderBy: { createdAt: "desc" },
    take: 5,
  });
  for (const row of rows) {
    const found = view(row);
    if (found) return found;
  }
  return null;
}

/** Open requests by entry for a list page (the newest 200 of the project). */
export async function pendingRequestsByEntry(tx: DbTx, scope: Pick<Scope, "workspaceId" | "projectId">) {
  const rows = await tx.entity.findMany({ where: pendingWhere(scope), orderBy: { createdAt: "desc" }, take: 200 });
  const byEntry = new Map<string, PendingRequest>();
  for (const row of rows) {
    const entryId = data(row).payload?.entryId;
    const found = view(row);
    if (typeof entryId === "string" && found && !byEntry.has(entryId)) byEntry.set(entryId, found);
  }
  return byEntry;
}
