import type { DbTx } from "../../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import { data } from "../../../shared.ts";

/** Lookups of what already left an assignment draft: shared by the owner release and the run retry. */
const INACTIVE = ["canceled", "failed", "blocked_dependency"];

/** The owner-released publication of a content that is still active, if any. */
export async function releasedPublication(
  tx: DbTx,
  scope: Scope,
  contentId: string,
) {
  const rows = await tx.entity.findMany({
    where: {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      kind: "publications",
      data: { path: ["contentId"], equals: contentId },
    },
    orderBy: { createdAt: "asc" },
  });
  return rows.find((row) => !INACTIVE.includes(data(row).status)) ?? null;
}

/** The assignment's Postiz draft handoff of a content that still delivers (R73), if any. */
export async function bookedDraft(tx: DbTx, scope: Scope, contentId: string) {
  const rows = await tx.entity.findMany({
    where: {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      kind: "postiz_drafts",
      data: { path: ["contentId"], equals: contentId },
    },
    orderBy: { createdAt: "asc" },
  });
  return (
    rows.find(
      (row) =>
        data(row).source === "assignment" &&
        !["failed", "canceled"].includes(data(row).status),
    ) ?? null
  );
}
