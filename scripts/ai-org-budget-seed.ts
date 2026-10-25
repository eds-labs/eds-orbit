/**
 * Adds this month's AI reservations made before ORBIT_AI_ORG_BUDGET was
 * turned on to the organization spend counters (plans/
 * ai-central-management.md, phase C). Run inside the api container by an
 * operator right after turning the switch on; it only reports what it would
 * add unless `--apply` is given. Counted reservations are marked, so it can
 * run again safely.
 *
 *   tsx scripts/ai-org-budget-seed.ts [--workspace <id>]
 *   tsx scripts/ai-org-budget-seed.ts [--workspace <id>] --apply
 */
import { closeDatabase } from "../packages/db/src/index.ts";
import { registerModules } from "../apps/api/src/modules/registry.ts";
import { seedOrganizationCounters } from "../apps/api/src/platform/ai/org-budget-seed.ts";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const at = args.indexOf(`--${name}`);
  return at < 0 ? undefined : (args[at + 1] ?? "true");
};

try {
  registerModules();
  const apply = args.includes("--apply");
  const rows = await seedOrganizationCounters({
    workspaceId: flag("workspace"),
    apply,
  });
  console.log(JSON.stringify({ dryRun: !apply, projects: rows }, null, 2));
} catch (error) {
  const code = (error as { code?: string })?.code;
  console.error(`Failed: ${typeof code === "string" ? code : "UNKNOWN"}`);
  process.exitCode = 1;
} finally {
  await closeDatabase();
}
