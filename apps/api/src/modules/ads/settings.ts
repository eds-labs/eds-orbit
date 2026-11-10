import { z } from "zod";
import type { DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import { readModuleSettings } from "../../platform/modules/settings.ts";
import { ADS_MODULE_ID } from "./manifest.ts";

// The ads module's project settings (ADR 0025). The platform stores and
// versions them in the module's ProjectModule row. Later steps add fields
// with defaults, so settings stored earlier still parse.

export const adsSettingsSchema = z
  .object({
    /** Who decides an ad action: always the owner. */
    decider: z.literal("owner"),
    /** Pause campaigns automatically when a budget limit is reached. */
    autoPauseAtLimit: z.boolean(),
    /** UTM template appended to ad links, or none. */
    utmTemplate: z.string().min(1).max(500).nullable(),
    /** Day of the weekly report. */
    reportDay: z.enum([
      "monday",
      "tuesday",
      "wednesday",
      "thursday",
      "friday",
      "saturday",
      "sunday",
    ]),
    /** How many days of history the first sync loads. */
    backfillDays: z.int().min(1).max(1125),
    /** How long insights are kept. */
    insightsRetentionMonths: z.int().min(13).max(60),
  })
  .strict();
export type AdsSettings = z.infer<typeof adsSettingsSchema>;

export const defaultAdsSettings = (): AdsSettings => ({
  decider: "owner",
  autoPauseAtLimit: false,
  utmTemplate: null,
  reportDay: "monday",
  backfillDays: 90,
  insightsRetentionMonths: 25,
});

export function readAdsSettings(tx: DbTx, scope: Scope) {
  return readModuleSettings(tx, scope, ADS_MODULE_ID, adsSettingsSchema, defaultAdsSettings);
}
