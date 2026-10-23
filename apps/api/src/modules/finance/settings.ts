import { z } from "zod";
import type { DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import {
  readModuleSettings,
  writeModuleSettings,
} from "../../platform/modules/settings.ts";
import { isCurrency, type Currency } from "./money.ts";

const currency = z.string().refine(isCurrency, "Unknown currency");

/**
 * The finance module's project settings, stored in ProjectModule.settings
 * (spec §4). Every key has a default, so `{}` parses to the defaults. AI
 * extraction stays off until the owner turns it on (a recorded consent).
 */
export const financeSettingsSchema = z
  .object({
    baseCurrency: currency.default("USD"),
    currencies: z
      .array(currency)
      .min(1)
      .max(20)
      .refine(
        (items) => new Set(items).size === items.length,
        "Currencies must be unique",
      )
      .default((): Currency[] => ["USD", "EUR", "USDC"]),
    // USDC per USD as a decimal string; fits NUMERIC(24,12).
    usdcPeg: z
      .string()
      .regex(/^\d{1,12}\.\d{1,12}$/)
      .default("1.000000"),
    fxSource: z.enum(["ecb", "manual"]).default("ecb"),
    aiExtraction: z.enum(["off", "on"]).default("off"),
    aiDailyCeilingMicros: z
      .number()
      .int()
      .min(0)
      .max(1_000_000_000)
      .default(2_000_000),
    archiveAfter: z.enum(["extracted", "booked"]).default("extracted"),
    retentionYears: z.number().int().min(1).max(30).default(10),
    duplicateWindowDays: z.number().int().min(0).max(90).default(3),
    // Below this extraction confidence a document gets the low_confidence flag.
    reviewConfidence: z.number().min(0).max(1).default(0.85),
  })
  .strict()
  .refine((s) => s.currencies.includes(s.baseCurrency), {
    message: "The base currency must be one of the currencies",
    path: ["baseCurrency"],
  });

export type FinanceSettings = z.infer<typeof financeSettingsSchema>;

export const financeSettingsDefaults = (): FinanceSettings =>
  financeSettingsSchema.parse({});

/** The project's finance settings and their version, defaults where none are saved. */
export const readFinanceSettings = (tx: DbTx, scope: Scope) =>
  readModuleSettings(
    tx,
    scope,
    "finance",
    financeSettingsSchema,
    financeSettingsDefaults,
  );

/**
 * Applies `patch` over the stored settings when `version` is current
 * (otherwise 409 SETTINGS_VERSION_CONFLICT). Unknown keys are rejected.
 */
export async function writeFinanceSettings(
  tx: DbTx,
  scope: Scope,
  version: number,
  patch: Partial<FinanceSettings>,
) {
  const { settings } = await readFinanceSettings(tx, scope);
  return writeModuleSettings(
    tx,
    scope,
    "finance",
    financeSettingsSchema,
    { ...settings, ...patch },
    version,
  );
}
