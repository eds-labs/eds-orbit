import type { ServerModule } from "../../../../../packages/module-contracts/src/index.ts";
import { financePermissions } from "./permissions.ts";

/**
 * The finance module (docs/superpowers/specs/2026-10-23-finance-module-design.md):
 * documents, a double-entry journal, invoices and payments. Off for every
 * project until an owner enables it, and unreachable while ORBIT_FINANCE is
 * off.
 */
export const financeModule: ServerModule = {
  id: "finance",
  version: "1.0.0",
  displayName: { en: "Finance", de: "Finanzen" },
  dependsOn: [],
  defaultEnabled: false,
  entityKinds: [],
  tables: [
    "FinanceAccount",
    "FinanceCategory",
    "FinanceCostCenter",
    "FinanceCounterparty",
    "FinanceMailbox",
    "FinanceDocument",
    "FinanceDocumentRevision",
    "FinanceInvoice",
    "FinanceInvoiceLine",
    "FinancePayment",
    "FinancePaymentAllocation",
    "FinanceJournalEntry",
    "FinanceJournalLine",
    "FinanceEntryCounter",
    "FinanceRecurring",
    "FinanceFxRate",
    "FinanceExport",
  ],
  permissions: financePermissions,
};
