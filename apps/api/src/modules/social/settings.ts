import { z } from "zod";
import type { DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import {
  readModuleSettings,
  writeModuleSettings,
} from "../../platform/modules/settings.ts";
import { DomainError } from "../../shared.ts";

// The social module's project settings (ADR 0020, S-D9). The platform
// stores and versions them in the module's ProjectModule row.

export const socialSettingsSchema = z
  .object({
    /** Who decides a publication: the owner, or also editors with social.approve. */
    approval: z.enum(["owner_each", "editor_each"]),
    /** An owner's direct MCP call may publish without a separate request. */
    mcpOwnerPublishWithoutApproval: z.boolean(),
    /** X bills every read: its post figures only when the owner allows them (S8). */
    xMetrics: z.boolean(),
  })
  .strict();
export type SocialSettings = z.infer<typeof socialSettingsSchema>;

/** Mario's defaults of 2026-11-02 (S-D9). */
export const defaultSocialSettings = (): SocialSettings => ({
  approval: "owner_each",
  mcpOwnerPublishWithoutApproval: false,
  xMetrics: false,
});

export function readSocialSettings(tx: DbTx, scope: Scope) {
  return readModuleSettings(tx, scope, "social", socialSettingsSchema, defaultSocialSettings);
}

/**
 * Saves the settings when `version` is the stored one. `editor_each` is
 * refused for now: who may decide an approval is fixed per action type, and
 * the platform has no per-project hook to let editors decide (S4 ruling).
 * Direct MCP publishing is refused too: the platform's direct-effect hook
 * is shaped for support inboxes (S7 ruling).
 */
export function saveSocialSettings(tx: DbTx, scope: Scope, raw: unknown, version: number) {
  const settings = socialSettingsSchema.parse(raw);
  if (settings.approval === "editor_each" || settings.mcpOwnerPublishWithoutApproval)
    throw new DomainError("SOCIAL_SETTING_NOT_AVAILABLE", 409);
  return writeModuleSettings(tx, scope, "social", socialSettingsSchema, raw, version);
}
