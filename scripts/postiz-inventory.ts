/**
 * What every project still has with Postiz before it moves to Social (ADR
 * 0020, S10, spec §9.2). Read-only; run inside the api container by an
 * operator. Prints counts per project as JSON: no texts, no tokens, no names
 * of people.
 *
 *   tsx scripts/postiz-inventory.ts [--project <id>]
 */
import { authDb, closeDatabase, scoped } from "../packages/db/src/index.ts";
import { registerModules } from "../apps/api/src/modules/registry.ts";
import { postizInventory } from "../apps/api/src/modules/marketing/publishing/social-migration.ts";

registerModules();
const only = process.argv.indexOf("--project") >= 0 ? process.argv[process.argv.indexOf("--project") + 1] : undefined;
const projects = await authDb.project.findMany({
  where: only ? { id: only } : {},
  select: { id: true, workspaceId: true, name: true },
  orderBy: { createdAt: "asc" },
});
const report = [];
for (const project of projects) {
  const scope = { workspaceId: project.workspaceId, projectId: project.id, userId: "postiz-inventory", role: "owner" as const };
  report.push({
    projectId: project.id,
    project: project.name,
    ...(await scoped(project.workspaceId, project.id, (tx) => postizInventory(tx, scope))),
  });
}
console.log(JSON.stringify({ generatedAt: new Date().toISOString(), projects: report }, null, 2));
await closeDatabase();
