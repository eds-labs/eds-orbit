import { z } from "zod";

/**
 * The budget of one provider's prepaid credit as the owner configures it:
 * the amount of the credit per billing period, two warning thresholds and
 * the internal stop below which Orbit refuses further paid calls. Amounts
 * are USD micros. The period is monthly and starts on `anchorDay` (UTC),
 * because a credit renews on the subscription date, not on the first.
 */
const micros = z.number().int().min(0).max(100_000_000_000);
export const providerBudgetSchema = z
  .object({
    monthlyMicros: micros,
    warnMicros: micros,
    warn2Micros: micros,
    stopMicros: micros,
    anchorDay: z.number().int().min(1).max(28).default(1),
    /**
     * The credit balance as the owner last read it at the provider. Orbit
     * cannot read it live; it is shown as a manually verified value next to
     * Orbit's own calculated spend.
     */
    credit: z
      .object({
        amountMicros: micros,
        verifiedAt: z.iso.datetime(),
        note: z.string().trim().max(200).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      !(
        value.warnMicros <= value.warn2Micros &&
        value.warn2Micros <= value.stopMicros &&
        value.stopMicros <= value.monthlyMicros
      )
    )
      context.addIssue({
        code: "custom",
        message: "PROVIDER_BUDGET_THRESHOLDS_INVALID",
      });
  });
export type ProviderBudget = z.infer<typeof providerBudgetSchema>;

/** The request's start configuration: 100 USD credit, warnings at 75 and 90, stop at 95. */
export const DEFAULT_ANTHROPIC_BUDGET: ProviderBudget = {
  monthlyMicros: 100_000_000,
  warnMicros: 75_000_000,
  warn2Micros: 90_000_000,
  stopMicros: 95_000_000,
  anchorDay: 1,
};

/**
 * Start of the billing period that contains `at`: `anchorDay` of this UTC
 * month when that day has been reached, otherwise `anchorDay` of the
 * previous month. The end is the same day of the following month.
 */
export function providerPeriod(anchorDay: number, at: Date) {
  const year = at.getUTCFullYear();
  const month = at.getUTCMonth();
  const start =
    at.getUTCDate() >= anchorDay
      ? new Date(Date.UTC(year, month, anchorDay))
      : new Date(Date.UTC(year, month - 1, anchorDay));
  const end = new Date(
    Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, anchorDay),
  );
  return { start, end };
}

export type ProviderBudgetLevel = "ok" | "warn" | "warn2" | "stopped";

/** Where `spentMicros` stands against the thresholds. */
export function providerBudgetLevel(
  budget: Pick<ProviderBudget, "warnMicros" | "warn2Micros" | "stopMicros">,
  spentMicros: number,
): ProviderBudgetLevel {
  if (spentMicros >= budget.stopMicros) return "stopped";
  if (spentMicros >= budget.warn2Micros) return "warn2";
  if (spentMicros >= budget.warnMicros) return "warn";
  return "ok";
}
