import { z } from "zod";

// Per-account settings the owner edits (ADR 0025): the Digital Services Act
// beneficiary and payor that EU ad delivery asks for.

const dsaName = z.string().min(1).max(200).nullable();

export const adAccountSettingsSchema = z
  .object({
    dsaBeneficiary: dsaName.default(null),
    dsaPayor: dsaName.default(null),
  })
  .strict();
export type AdAccountSettings = z.infer<typeof adAccountSettingsSchema>;

/** A change names only the fields it sets; the others keep their value. */
export const adAccountSettingsPatchSchema = z
  .object({ dsaBeneficiary: dsaName.optional(), dsaPayor: dsaName.optional() })
  .strict();

/** Stored settings read back with defaults; a malformed row reads as empty. */
export function readAdAccountSettings(stored: unknown): AdAccountSettings {
  const parsed = adAccountSettingsSchema.safeParse(stored ?? {});
  return parsed.success ? parsed.data : adAccountSettingsSchema.parse({});
}
