/**
 * Dry run for AI key rule v2 (plan decision E-1b, ORBIT_AI_KEY_RULE_V2):
 * per project, the key sources today and after the switch, the keys it
 * would lose and whether chat and drafting would still run. Read-only;
 * never prints a key. Run inside the api container before setting the flag.
 *
 *   tsx scripts/ai-key-rule-report.ts [--workspace <id>]
 */
import { closeDatabase } from "../packages/db/src/index.ts";
import { registerModules } from "../apps/api/src/modules/registry.ts";
import { keyRuleReport } from "../apps/api/src/platform/ai/key-rule-report.ts";

const args = process.argv.slice(2);
const at = args.indexOf("--workspace");

try {
  registerModules();
  const rows = await keyRuleReport({
    workspaceId: at < 0 ? undefined : args[at + 1],
  });
  console.log(JSON.stringify({ projects: rows }, null, 2));
} catch (error) {
  const code = (error as { code?: string })?.code;
  console.error(`Failed: ${typeof code === "string" ? code : "UNKNOWN"}`);
  process.exitCode = 1;
} finally {
  await closeDatabase();
}
