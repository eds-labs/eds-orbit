import { authDb, scoped } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import {
  effectiveAiStatus,
  routesWithoutKey,
  textModelReady,
} from "./openai-configuration.ts";

// The dry run before key rule v2 (plan decision E-1b): per project, where
// each key comes from today and after the switch, and what stops working.
// Read-only; keys are read and dropped, never returned.

type Status = Awaited<ReturnType<typeof effectiveAiStatus>>;
const view = (s: Status) => ({
  keySources: s.keySources,
  textModelReady: textModelReady(s),
  routesWithoutKey: routesWithoutKey(s),
});

export async function keyRuleReport(filter: { workspaceId?: string } = {}) {
  const projects = await authDb.project.findMany({
    where: filter.workspaceId ? { workspaceId: filter.workspaceId } : {},
    select: { id: true, name: true, workspaceId: true },
    orderBy: { createdAt: "asc" },
  });
  const rows = [];
  for (const project of projects) {
    const scope = {
      workspaceId: project.workspaceId,
      projectId: project.id,
    } as Scope;
    rows.push(
      await scoped(project.workspaceId, project.id, async (tx) => {
        const base = { projectId: project.id, name: project.name };
        try {
          const now = await effectiveAiStatus(tx, scope, false);
          const next = await effectiveAiStatus(tx, scope, true);
          const lost = (["openai", "image", "anthropic"] as const).filter(
            (k) =>
              now.keySources[k] !== "none" && next.keySources[k] === "none",
          );
          return {
            ...base,
            saved: next.routeVersion !== null,
            now: view(now),
            v2: view(next),
            lostKeys: lost,
            // A project that keeps working needs nothing before the switch.
            actionRequired: lost.length > 0,
          };
        } catch (error) {
          return {
            ...base,
            code: (error as { code?: string }).code ?? "STATUS_UNAVAILABLE",
          };
        }
      }),
    );
  }
  return rows;
}
