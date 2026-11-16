import { z } from "zod";
import type { DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import {
  readModuleSettings,
  writeModuleSettings,
} from "../../platform/modules/settings.ts";
import { CMS_MODULE_ID } from "./manifest.ts";

// The content module's project settings (ADR 0029). The platform stores and
// versions them in the module's ProjectModule row. Later steps add fields
// with defaults, so settings stored earlier still parse.

const timeZone = z
  .string()
  .min(1)
  .max(64)
  .refine((zone) => {
    try {
      new Intl.DateTimeFormat("en", { timeZone: zone });
      return true;
    } catch {
      return false;
    }
  }, "unknown time zone");

export const cmsSettingsSchema = z
  .object({
    /**
     * Who may decide a publication (decision E-4, 2026-11-14): the owner, or
     * the owner and members with the editor role in the module.
     */
    publishApprovers: z.enum(["owner", "owner_or_editor"]),
    /** The member who asked for a publication may not decide it. */
    fourEyes: z.boolean(),
    /** Time zone for scheduling; null uses the project's time zone. */
    timeZone: timeZone.nullable(),
    /** A scheduled publication more than this many hours late waits for a person. */
    lateWindowHours: z.int().min(1).max(168),
  })
  .strict();
export type CmsSettings = z.infer<typeof cmsSettingsSchema>;

/** Defaults from ADR 0029 and decision E-4. */
export const defaultCmsSettings = (): CmsSettings => ({
  publishApprovers: "owner_or_editor",
  fourEyes: false,
  timeZone: null,
  lateWindowHours: 24,
});

export function readCmsSettings(tx: DbTx, scope: Scope) {
  return readModuleSettings(tx, scope, CMS_MODULE_ID, cmsSettingsSchema, defaultCmsSettings);
}

export function saveCmsSettings(tx: DbTx, scope: Scope, raw: unknown, version: number) {
  return writeModuleSettings(tx, scope, CMS_MODULE_ID, cmsSettingsSchema, raw, version);
}
