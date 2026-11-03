import { z } from "zod";
import type { DbTx } from "../../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import { readModuleSettings, writeModuleSettings } from "../../../platform/modules/settings.ts";
import { authorize, PROJECT_OWN } from "../../../platform/tenancy/permissions.ts";
import { audit, DomainError } from "../../../shared.ts";
import { socialPublishingAvailable } from "../../social/contract.ts";

// Marketing's publishing backend (ADR 0020, S9): Postiz unless the owner
// switches the project to Social. Under Social, Marketing keeps its whole
// pipeline (reviews, approvals, package hash, veto window, preflight) and
// hands a post to Social at its slot instead of to Postiz; assignment
// drafts become Social drafts. Stored in Marketing's ProjectModule row.

export const marketingSettingsSchema = z
  .object({
    /**
     * Where approved posts and assignment drafts go. `postiz_draining`
     * (S10): Postiz finishes what it has, nothing new is handed to it.
     */
    publishingBackend: z.enum(["postiz", "postiz_draining", "social"]),
  })
  .strict();
export type MarketingSettings = z.infer<typeof marketingSettingsSchema>;
export type PublishingBackend = MarketingSettings["publishingBackend"];

export const defaultMarketingSettings = (): MarketingSettings => ({ publishingBackend: "postiz" });

export function readMarketingSettings(tx: DbTx, scope: Scope) {
  return readModuleSettings(tx, scope, "marketing", marketingSettingsSchema, defaultMarketingSettings);
}

/** The project's backend; a project on Social never falls back to Postiz by itself. */
export async function publishingBackend(tx: DbTx, scope: Scope): Promise<PublishingBackend> {
  return (await readMarketingSettings(tx, scope)).settings.publishingBackend;
}

/** The owner's change; Social needs the social module on for the project. */
export async function saveMarketingSettings(tx: DbTx, scope: Scope, raw: unknown, version: number) {
  authorize(scope, PROJECT_OWN, "OWNER_REQUIRED");
  const next = marketingSettingsSchema.parse(raw);
  const before = await publishingBackend(tx, scope);
  if (next.publishingBackend === "social" && !(await socialPublishingAvailable(tx, scope)))
    throw new DomainError("SOCIAL_DISABLED", 409);
  // The move needs every channel mapped and Postiz settled (S10, §9.6).
  if (next.publishingBackend === "social" && before !== "social") {
    const { switchBlockers } = await import("./social-migration.ts");
    const reasons = await switchBlockers(tx, scope);
    if (reasons.length) throw new DomainError("PUBLISHING_BACKEND_NOT_READY", 409);
  }
  const saved = await writeModuleSettings(tx, scope, "marketing", marketingSettingsSchema, next, version);
  if (before !== next.publishingBackend)
    await audit(tx, scope, "marketing.publishing_backend_changed", scope.projectId, { from: before, to: next.publishingBackend });
  return saved;
}

/** Refuses new work for Postiz while the project drains it (S10). */
export async function refuseWhileDraining(tx: DbTx, scope: Scope): Promise<void> {
  if ((await publishingBackend(tx, scope)) === "postiz_draining")
    throw new DomainError("PUBLISHING_BACKEND_DRAINING", 409);
}
