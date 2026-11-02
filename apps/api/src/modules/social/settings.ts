import { z } from "zod";
import type { DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import {
  readModuleSettings,
  writeModuleSettings,
} from "../../platform/modules/settings.ts";

// The social module's project settings (ADR 0020, S-D9). The platform
// stores and versions them in the module's ProjectModule row.

export const socialSettingsSchema = z
  .object({
    /** Who decides a publication: the owner, or also editors with social.approve. */
    approval: z.enum(["owner_each", "editor_each"]),
    /** An owner's direct MCP call may publish without a separate request. */
    mcpOwnerPublishWithoutApproval: z.boolean(),
  })
  .strict();
export type SocialSettings = z.infer<typeof socialSettingsSchema>;

/** Mario's defaults of 2026-11-02 (S-D9). */
export const defaultSocialSettings = (): SocialSettings => ({
  approval: "owner_each",
  mcpOwnerPublishWithoutApproval: false,
});

export function readSocialSettings(tx: DbTx, scope: Scope) {
  return readModuleSettings(tx, scope, "social", socialSettingsSchema, defaultSocialSettings);
}

/** Saves the settings when `version` is the stored one. */
export function saveSocialSettings(tx: DbTx, scope: Scope, raw: unknown, version: number) {
  return writeModuleSettings(tx, scope, "social", socialSettingsSchema, raw, version);
}
