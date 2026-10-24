/**
 * Copies each project's active Marketing policy budget into a platform AI
 * spending authority (ADR 0015). Run inside the api container by an
 * operator; it only reports what it would do unless `--apply` is given.
 * Projects that already have a platform record are skipped, so it can run
 * again safely. Marketing policies are never changed.
 *
 *   tsx scripts/ai-spend-policy-backfill.ts [--workspace <id>]
 *   tsx scripts/ai-spend-policy-backfill.ts [--workspace <id>] --apply
 */
import { closeDatabase } from "../packages/db/src/index.ts";
import { registerModules } from "../apps/api/src/modules/registry.ts";
import { backfillSpendPolicies } from "../apps/api/src/platform/ai/spend-policy-backfill.ts";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const at = args.indexOf(`--${name}`);
  return at < 0 ? undefined : (args[at + 1] ?? "true");
};

try {
  registerModules();
  const apply = args.includes("--apply");
  const rows = await backfillSpendPolicies({
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
