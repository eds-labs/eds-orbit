import { z } from "zod";
import { DomainError } from "../../shared.ts";

// Small helpers the master-data services share.

/** `YYYY-MM-DD` calendar date. */
export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** The row's version the caller read; a mismatch is a conflict. */
export const versionField = z.number().int().min(1);

/** Cost center split in basis points; the parts sum to 10000. */
export const allocationSchema = z
  .array(
    z
      .object({ costCenterId: z.uuid(), bp: z.number().int().min(0).max(10_000) })
      .strict(),
  )
  .min(1)
  .max(50)
  .refine(
    (parts) => parts.reduce((sum, part) => sum + part.bp, 0) === 10_000,
    "Allocation must sum to 10000 basis points",
  )
  .refine(
    (parts) => new Set(parts.map((p) => p.costCenterId)).size === parts.length,
    "Cost centers must be unique",
  );

/** Version-checked updates: zero rows changed means someone else saved first. */
export function assertUpdated(count: number) {
  if (count !== 1) throw new DomainError("VERSION_CONFLICT", 409);
}

/** Refuses a hard delete while anything references the row. */
export function assertUnreferenced(counts: number[]) {
  if (counts.some((count) => count > 0))
    throw new DomainError("FINANCE_IN_USE", 409);
}
