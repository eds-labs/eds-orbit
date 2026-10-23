import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";

// The structured answer the extraction model must give for one document.
// Strict output: every field is present, unknown values are null. Amounts
// are decimal strings and dates plain text; both are checked server-side
// (validate.ts), so a malformed value becomes a flag, not a failed document.

/** Version of the stored `FinanceDocument.extraction` JSON. */
export const EXTRACTION_SCHEMA_VERSION = 1;

const text = (max: number) => z.string().max(max);
const amount = z.string().max(40);
// Opaque keys such as "c1" or "k2" from the instructions, never database ids.
const hint = z.string().max(12).nullable();

export const extractionSchema = z
  .object({
    docType: z.enum(["invoice", "receipt", "credit_note", "other"]),
    direction: z.enum(["payable", "receivable", "unknown"]),
    counterparty: z
      .object({
        name: text(200),
        taxId: text(40).nullable(),
        email: text(254).nullable(),
      })
      .strict(),
    number: text(80).nullable(),
    issueDate: text(40).nullable(),
    dueDate: text(40).nullable(),
    currency: text(10).nullable(),
    net: amount.nullable(),
    tax: amount.nullable(),
    total: amount.nullable(),
    paid: z.boolean(),
    paymentMethod: text(60).nullable(),
    lines: z
      .array(
        z
          .object({
            description: text(500),
            quantity: text(40).nullable(),
            amount,
            tax: amount.nullable(),
            categoryHint: hint,
            costCenterHint: hint,
          })
          .strict(),
      )
      .max(100),
    confidence: z.number().min(0).max(1),
  })
  .strict();

export type Extraction = z.infer<typeof extractionSchema>;

/** The JSON schema sent as the strict output format (as Support does). */
export function extractionJsonSchema() {
  const { $schema: _schema, ...rest } = zodTextFormat(
    extractionSchema,
    "orbit_finance_extraction",
  ).schema as Record<string, unknown>;
  return rest;
}
