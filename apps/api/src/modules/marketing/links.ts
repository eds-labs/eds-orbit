import type { LinkTypeDef } from "../../platform/links/types.ts";
import type { DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import { PROJECT_READ } from "../../platform/tenancy/permissions.ts";

// Missions and assignments as link targets of other modules (ADR 0016),
// such as a task that relates to a campaign. Read-only: linking never
// changes the marketing records.

const entityType = (
  kind: "missions" | "assignments",
  label: { en: string; de: string },
  titleField: "title" | "name",
  path: string,
): LinkTypeDef => ({
  label,
  linkPermission: PROJECT_READ,
  async resolve(tx: DbTx, scope: Scope, ids) {
    const rows = await tx.entity.findMany({
      where: { projectId: scope.projectId, kind, id: { in: [...ids] } },
      select: { id: true, data: true },
    });
    return new Map(
      rows.map((r) => {
        const d = (r.data ?? {}) as Record<string, unknown>;
        return [
          r.id,
          {
            title: String(d[titleField] ?? kind),
            status: typeof d.status === "string" ? d.status : undefined,
            href: `/p/${scope.projectId}/marketing/${path}`,
          },
        ];
      }),
    );
  },
  async search(tx, scope, query, limit) {
    const rows = await tx.entity.findMany({
      where: {
        projectId: scope.projectId,
        kind,
        data: { path: [titleField], string_contains: query.slice(0, 100) },
      },
      select: { id: true, data: true },
      orderBy: { updatedAt: "desc" },
      take: limit,
    });
    return rows.map((r) => ({
      id: r.id,
      title: String(((r.data ?? {}) as Record<string, unknown>)[titleField] ?? kind),
    }));
  },
});

export const marketingLinkTypes = {
  mission: entityType("missions", { en: "Campaign", de: "Kampagne" }, "title", "missions"),
  assignment: entityType("assignments", { en: "Assignment", de: "Auftrag" }, "name", "assignments"),
};
