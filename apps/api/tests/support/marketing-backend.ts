import type { DbTx } from "../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../packages/schemas/src/index.ts";
import { writeModuleSettings } from "../../src/platform/modules/settings.ts";
import { marketingSettingsSchema, readMarketingSettings, type PublishingBackend } from "../../src/modules/marketing/publishing/backend.ts";

/**
 * Sets Marketing's publishing backend directly, past the switch's readiness
 * checks (S10): for tests about behaviour on a backend, not about switching.
 */
export async function forcePublishingBackend(tx: DbTx, scope: Scope, publishingBackend: PublishingBackend) {
  const current = await readMarketingSettings(tx, scope);
  await writeModuleSettings(tx, scope, "marketing", marketingSettingsSchema, { publishingBackend }, current.version);
}
