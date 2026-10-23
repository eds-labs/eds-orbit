/**
 * Moves project connections to central connections (ADR 0014, WP3.5). Run
 * inside the api container by an operator; nothing changes without
 * `apply --yes`. Keys are never printed, only keyed fingerprints.
 *
 *   tsx scripts/connections-migrate.ts inventory [--workspace <id>]
 *   tsx scripts/connections-migrate.ts plan --workspace <id> --provider postiz --source <connectorId> [--projects <id,id>]
 *   tsx scripts/connections-migrate.ts apply --workspace <id> --provider postiz --source <connectorId> [--projects <id,id>] --label "Company Postiz" --yes
 *   tsx scripts/connections-migrate.ts rollback --connection <id> --yes
 */
import { closeDatabase } from "../packages/db/src/index.ts";
import { registerModules } from "../apps/api/src/modules/registry.ts";
import {
  applyConsolidation,
  connectionInventory,
  planConsolidation,
  rollbackConsolidation,
} from "../apps/api/src/platform/connections/migration.ts";

const [command, ...rest] = process.argv.slice(2);
const flags = new Map<string, string>();
for (let i = 0; i < rest.length; i++)
  if (rest[i]!.startsWith("--"))
    flags.set(
      rest[i]!.slice(2),
      rest[i + 1] && !rest[i + 1]!.startsWith("--") ? rest[++i]! : "true",
    );
const need = (name: string) => {
  const value = flags.get(name);
  if (!value) throw Object.assign(new Error(`--${name} is required`), { code: "USAGE" });
  return value;
};
const print = (value: unknown) => console.log(JSON.stringify(value, null, 2));

try {
  registerModules();
  if (command === "inventory")
    print(await connectionInventory({ workspaceId: flags.get("workspace") }));
  else if (command === "plan" || command === "apply") {
    const plan = await planConsolidation({
      workspaceId: need("workspace"),
      provider: need("provider"),
      sourceConnectorId: need("source"),
      projectIds: flags.get("projects")?.split(","),
    });
    if (command === "plan" || flags.get("yes") !== "true") {
      print({ dryRun: true, plan });
    } else print(await applyConsolidation(plan, need("label")));
  } else if (command === "rollback") {
    if (flags.get("yes") !== "true") print({ dryRun: true, connection: need("connection") });
    else print(await rollbackConsolidation(need("connection")));
  } else {
    console.error("Usage: connections-migrate.ts inventory | plan | apply | rollback (see header)");
    process.exitCode = 2;
  }
} catch (error) {
  const code = (error as { code?: string })?.code;
  console.error(`Failed: ${typeof code === "string" ? code : "UNKNOWN"}${code === "USAGE" ? ` (${(error as Error).message})` : ""}`);
  process.exitCode = 1;
} finally {
  await closeDatabase();
}
