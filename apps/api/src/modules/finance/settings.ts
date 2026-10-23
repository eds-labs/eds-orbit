import { z } from "zod";
import type { DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import {
  readModuleSettings,
  writeModuleSettings,
} from "../../platform/modules/settings.ts";
import { DomainError } from "../../shared.ts";
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
 * Refuses settings changes that would rewrite the meaning of what is
 * already recorded: the base currency is fixed once anything is posted
 * (409 FINANCE_BASE_CURRENCY_LOCKED), and a currency stays while an open
 * invoice, a live payment account or an active recurring item uses it
 * (409 FINANCE_CURRENCY_IN_USE).
 */
async function assertCurrencyChangeAllowed(
  tx: DbTx,
  scope: Scope,
  current: FinanceSettings,
  patch: Partial<FinanceSettings>,
) {
  if (
    patch.baseCurrency !== undefined &&
    patch.baseCurrency !== current.baseCurrency &&
    (await tx.financeJournalEntry.count({
      where: { projectId: scope.projectId },
    })) > 0
  )
    throw new DomainError("FINANCE_BASE_CURRENCY_LOCKED", 409);
  if (patch.currencies === undefined) return;
  const removed = current.currencies.filter(
    (c) => !patch.currencies!.includes(c),
  );
  if (!removed.length) return;
  const where = { projectId: scope.projectId, currency: { in: removed } };
  const [invoices, accounts, recurring] = await Promise.all([
    tx.financeInvoice.count({
      where: { ...where, status: { in: ["open", "partially_paid"] } },
    }),
    tx.financeAccount.count({
      where: { ...where, paymentAccount: true, archivedAt: null },
    }),
    tx.financeRecurring.count({ where: { ...where, active: true } }),
  ]);
  if (invoices + accounts + recurring > 0)
    throw new DomainError("FINANCE_CURRENCY_IN_USE", 409);
}

/**
 * Applies `patch` over the stored settings when `version` is current
 * (otherwise 409 SETTINGS_VERSION_CONFLICT). Unknown keys are rejected;
 * currency changes are checked against what is recorded.
 */
export async function writeFinanceSettings(
  tx: DbTx,
  scope: Scope,
  version: number,
  patch: Partial<FinanceSettings>,
) {
  const { settings } = await readFinanceSettings(tx, scope);
  await assertCurrencyChangeAllowed(tx, scope, settings, patch);
  return writeModuleSettings(
    tx,
    scope,
    "finance",
    financeSettingsSchema,
    { ...settings, ...patch },
    version,
  );
}
