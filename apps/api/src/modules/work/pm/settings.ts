import type { DbTx } from "../../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import { writeModuleSettings } from "../../../platform/modules/settings.ts";
import { audit, DomainError } from "../../../shared.ts";
import { readWorkSettings, workSettingsSchema } from "../settings.ts";
import { pmSettingsSchema } from "./settings-schema.ts";

/** The PM's project settings (budget, autonomy, coding repositories). */
export async function readPmSettings(tx: DbTx, scope: Scope) {
  const { settings, version } = await readWorkSettings(tx, scope);
  return { settings: settings.pm, version };
}

/**
 * Saves the PM part of the work settings when `version` is the stored one.
 * An automation dispatch must name a binding of the project's workflows.
 */
export async function savePmSettings(
  tx: DbTx,
  scope: Scope,
  raw: unknown,
  version: number,
) {
  const pm = pmSettingsSchema.parse(raw);
  const current = (await readWorkSettings(tx, scope)).settings;
  for (const repository of pm.repositories) {
    if (repository.dispatch.kind !== "automation") continue;
    const binding = await tx.workflowBinding.findFirst({
      where: { id: repository.dispatch.bindingId, revokedAt: null },
      select: { id: true },
    });
    if (!binding) throw new DomainError("WORK_PM_BINDING_UNKNOWN", 422);
  }
  const saved = await writeModuleSettings(
    tx,
    scope,
    "work",
    workSettingsSchema,
    { ...current, pm },
    version,
  );
  await audit(tx, scope, "work.pm.settings_saved", scope.projectId, {
    autonomy: pm.autonomy,
    repositories: pm.repositories.length,
  });
  return { settings: saved.settings.pm, version: saved.version };
}
