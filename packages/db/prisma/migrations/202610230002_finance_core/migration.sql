-- Finance module core (docs/superpowers/specs/2026-10-23-finance-module-design.md §4).
-- Seventeen project tables like Support's: the business role reads and writes
-- them within the project scope (FORCE RLS). Foreign key checks bypass RLS,
-- so every reference between finance rows (and to "File" and "Entity") is a
-- composite ("projectId", id) key: a row can only point at rows of its own
-- project. Amounts are BIGINT micros (10^-6 of the currency unit), rates
-- NUMERIC(24,12). The journal is append-only in the database: lines never
-- change and are added only in their entry's transaction, an entry changes
-- only to record its reversal once, and every entry
-- balances in the base currency at commit. orbit_app gets no DELETE on the
-- journal, documents, invoices, payments and exports (scripts/db-deploy.ts);
-- project deletion still cascades through the foreign keys. References
-- between those tables use NO ACTION (checked at the end of the statement),
-- never SET NULL, so a project cascade never updates a posted row. Additive;
-- nothing existing changes.

-- Chart of accounts.
CREATE TABLE "FinanceAccount" (
  "id" UUID NOT NULL,
  "workspaceId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "code" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  -- A system role the posting rules look up (payables, receivables, ...).
  "role" TEXT,
  -- A bank, card or wallet account usable for payments.
  "paymentAccount" BOOLEAN NOT NULL DEFAULT false,
  "currency" TEXT,
  -- A later DATEV/SKR mapping.
  "externalCode" TEXT,
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "archivedAt" TIMESTAMPTZ(3),
  CONSTRAINT "FinanceAccount_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "FinanceAccount_project_fkey" FOREIGN KEY ("workspaceId", "projectId") REFERENCES "Project"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "FinanceAccount_projectId_id_key" UNIQUE ("projectId", "id"),
  CONSTRAINT "FinanceAccount_projectId_code_key" UNIQUE ("projectId", "code"),
  CONSTRAINT "FinanceAccount_type_check" CHECK ("type" IN ('asset','liability','equity','income','expense')),
  CONSTRAINT "FinanceAccount_role_check" CHECK ("role" IS NULL OR "role" IN ('payables','receivables','owner_contributions','owner_draws','fx_gain_loss','rounding'))
);
-- One live account per system role.
CREATE UNIQUE INDEX "FinanceAccount_projectId_role_key" ON "FinanceAccount"("projectId", "role") WHERE "role" IS NOT NULL AND "archivedAt" IS NULL;

CREATE TABLE "FinanceCategory" (
  "id" UUID NOT NULL,
  "workspaceId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "parentId" UUID,
  -- The income or expense account the category posts to.
  "accountId" UUID NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "archivedAt" TIMESTAMPTZ(3),
  CONSTRAINT "FinanceCategory_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "FinanceCategory_project_fkey" FOREIGN KEY ("workspaceId", "projectId") REFERENCES "Project"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "FinanceCategory_projectId_id_key" UNIQUE ("projectId", "id"),
  CONSTRAINT "FinanceCategory_parent_fkey" FOREIGN KEY ("projectId", "parentId") REFERENCES "FinanceCategory"("projectId", "id"),
  CONSTRAINT "FinanceCategory_account_fkey" FOREIGN KEY ("projectId", "accountId") REFERENCES "FinanceAccount"("projectId", "id"),
  CONSTRAINT "FinanceCategory_kind_check" CHECK ("kind" IN ('income','expense'))
);

CREATE TABLE "FinanceCostCenter" (
  "id" UUID NOT NULL,
  "workspaceId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "code" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  -- An Orbit project of the same workspace as a label; not a data link.
  "orbitProjectId" UUID,
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "archivedAt" TIMESTAMPTZ(3),
  CONSTRAINT "FinanceCostCenter_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "FinanceCostCenter_project_fkey" FOREIGN KEY ("workspaceId", "projectId") REFERENCES "Project"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "FinanceCostCenter_projectId_id_key" UNIQUE ("projectId", "id"),
  CONSTRAINT "FinanceCostCenter_projectId_code_key" UNIQUE ("projectId", "code")
);

CREATE TABLE "FinanceCounterparty" (
  "id" UUID NOT NULL,
  "workspaceId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "normalizedName" TEXT NOT NULL,
  "taxId" TEXT,
  "emailDomains" TEXT[] NOT NULL DEFAULT '{}',
  "defaultCategoryId" UUID,
  -- Cost center basis points, summing to 10000.
  "defaultAllocation" JSONB,
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FinanceCounterparty_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "FinanceCounterparty_project_fkey" FOREIGN KEY ("workspaceId", "projectId") REFERENCES "Project"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "FinanceCounterparty_projectId_id_key" UNIQUE ("projectId", "id"),
  CONSTRAINT "FinanceCounterparty_category_fkey" FOREIGN KEY ("projectId", "defaultCategoryId") REFERENCES "FinanceCategory"("projectId", "id") ON DELETE SET NULL ("defaultCategoryId")
);
CREATE INDEX "FinanceCounterparty_projectId_normalizedName_idx" ON "FinanceCounterparty"("projectId", "normalizedName");

-- An e-mail connection (a `connectors` entity) bound to finance.
CREATE TABLE "FinanceMailbox" (
  "id" UUID NOT NULL,
  "workspaceId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "emailConnectionId" UUID NOT NULL,
  "archiveFolder" TEXT NOT NULL DEFAULT 'Orbit/Processed',
  "active" BOOLEAN NOT NULL DEFAULT true,
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FinanceMailbox_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "FinanceMailbox_project_fkey" FOREIGN KEY ("workspaceId", "projectId") REFERENCES "Project"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "FinanceMailbox_projectId_id_key" UNIQUE ("projectId", "id"),
  CONSTRAINT "FinanceMailbox_emailConnection_fkey" FOREIGN KEY ("projectId", "emailConnectionId") REFERENCES "Entity"("projectId", "id"),
  CONSTRAINT "FinanceMailbox_emailConnection_key" UNIQUE ("projectId", "emailConnectionId")
);

-- One original (an attachment, a mail body or an upload).
CREATE TABLE "FinanceDocument" (
  "id" UUID NOT NULL,
  "workspaceId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  -- A finance-owned, retention-locked platform file.
  "fileId" UUID NOT NULL,
  "sha256" TEXT NOT NULL,
  "source" TEXT NOT NULL,
  "mailboxId" UUID,
  -- The platform's inbound e-mail row (an `inbound_emails` entity).
  "inboundEmailId" UUID,
  "messageId" TEXT,
  -- The copy of the whole .eml.
  "emailFileId" UUID,
  "originalName" TEXT,
  "mimeType" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'received',
  "docType" TEXT NOT NULL DEFAULT 'unknown',
  -- Schema-versioned extraction result; validated data, never instructions.
  "extraction" JSONB,
  "confidence" DOUBLE PRECISION,
  "flags" TEXT[] NOT NULL DEFAULT '{}',
  "duplicateOfId" UUID,
  "agentRunId" UUID,
  -- Why a person rejected the document (kept out of the audit trail).
  "rejectionReason" TEXT,
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FinanceDocument_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "FinanceDocument_project_fkey" FOREIGN KEY ("workspaceId", "projectId") REFERENCES "Project"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "FinanceDocument_projectId_id_key" UNIQUE ("projectId", "id"),
  CONSTRAINT "FinanceDocument_file_fkey" FOREIGN KEY ("projectId", "fileId") REFERENCES "File"("projectId", "id"),
  CONSTRAINT "FinanceDocument_emailFile_fkey" FOREIGN KEY ("projectId", "emailFileId") REFERENCES "File"("projectId", "id"),
  CONSTRAINT "FinanceDocument_mailbox_fkey" FOREIGN KEY ("projectId", "mailboxId") REFERENCES "FinanceMailbox"("projectId", "id") ON DELETE SET NULL ("mailboxId"),
  -- Raw mail retention may remove the inbound row; the document stays.
  CONSTRAINT "FinanceDocument_inboundEmail_fkey" FOREIGN KEY ("projectId", "inboundEmailId") REFERENCES "Entity"("projectId", "id") ON DELETE SET NULL ("inboundEmailId"),
  CONSTRAINT "FinanceDocument_duplicateOf_fkey" FOREIGN KEY ("projectId", "duplicateOfId") REFERENCES "FinanceDocument"("projectId", "id"),
  CONSTRAINT "FinanceDocument_sha256_check" CHECK ("sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "FinanceDocument_source_check" CHECK ("source" IN ('email','upload')),
  CONSTRAINT "FinanceDocument_status_check" CHECK ("status" IN ('received','extracting','needs_review','booked','rejected','duplicate','failed')),
  CONSTRAINT "FinanceDocument_docType_check" CHECK ("docType" IN ('invoice','receipt','credit_note','other','unknown')),
  CONSTRAINT "FinanceDocument_confidence_check" CHECK ("confidence" IS NULL OR ("confidence" >= 0 AND "confidence" <= 1))
);
-- One live original per content hash; rejected and duplicate rows keep theirs.
CREATE UNIQUE INDEX "FinanceDocument_projectId_sha256_live_key" ON "FinanceDocument"("projectId", "sha256") WHERE "status" NOT IN ('rejected','duplicate');
CREATE INDEX "FinanceDocument_projectId_status_idx" ON "FinanceDocument"("projectId", "status");
CREATE INDEX "FinanceDocument_projectId_messageId_idx" ON "FinanceDocument"("projectId", "messageId");

-- Draft changes before booking: field names with before/after values.
CREATE TABLE "FinanceDocumentRevision" (
  "id" UUID NOT NULL,
  "workspaceId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "documentId" UUID NOT NULL,
  "version" INTEGER NOT NULL,
  "actorUserId" TEXT,
  "changes" JSONB NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FinanceDocumentRevision_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "FinanceDocumentRevision_project_fkey" FOREIGN KEY ("workspaceId", "projectId") REFERENCES "Project"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "FinanceDocumentRevision_projectId_id_key" UNIQUE ("projectId", "id"),
  CONSTRAINT "FinanceDocumentRevision_document_fkey" FOREIGN KEY ("projectId", "documentId") REFERENCES "FinanceDocument"("projectId", "id") ON DELETE CASCADE,
  CONSTRAINT "FinanceDocumentRevision_version_key" UNIQUE ("projectId", "documentId", "version")
);

-- Gap-free journal numbers per project and year, under the project lock.
CREATE TABLE "FinanceEntryCounter" (
  "workspaceId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "year" INTEGER NOT NULL,
  "next" INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT "FinanceEntryCounter_pkey" PRIMARY KEY ("projectId", "year"),
  CONSTRAINT "FinanceEntryCounter_project_fkey" FOREIGN KEY ("workspaceId", "projectId") REFERENCES "Project"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "FinanceEntryCounter_year_check" CHECK ("year" BETWEEN 1900 AND 9999),
  CONSTRAINT "FinanceEntryCounter_next_check" CHECK ("next" >= 1)
);

-- Posted journal entries; drafts live on documents, not here.
CREATE TABLE "FinanceJournalEntry" (
  "id" UUID NOT NULL,
  "workspaceId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  -- YYYY-000123, from "FinanceEntryCounter".
  "number" TEXT NOT NULL,
  "entryDate" DATE NOT NULL,
  "kind" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'posted',
  "memo" TEXT,
  "documentId" UUID,
  "sourceType" TEXT,
  "sourceId" UUID,
  "reversalOfId" UUID,
  "reversedById" UUID,
  "postedBy" TEXT NOT NULL,
  "postedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FinanceJournalEntry_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "FinanceJournalEntry_project_fkey" FOREIGN KEY ("workspaceId", "projectId") REFERENCES "Project"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "FinanceJournalEntry_projectId_id_key" UNIQUE ("projectId", "id"),
  CONSTRAINT "FinanceJournalEntry_projectId_number_key" UNIQUE ("projectId", "number"),
  -- An entry is reversed at most once.
  CONSTRAINT "FinanceJournalEntry_reversalOf_key" UNIQUE ("projectId", "reversalOfId"),
  CONSTRAINT "FinanceJournalEntry_document_fkey" FOREIGN KEY ("projectId", "documentId") REFERENCES "FinanceDocument"("projectId", "id"),
  CONSTRAINT "FinanceJournalEntry_reversalOf_fkey" FOREIGN KEY ("projectId", "reversalOfId") REFERENCES "FinanceJournalEntry"("projectId", "id"),
  CONSTRAINT "FinanceJournalEntry_reversedBy_fkey" FOREIGN KEY ("projectId", "reversedById") REFERENCES "FinanceJournalEntry"("projectId", "id"),
  CONSTRAINT "FinanceJournalEntry_number_check" CHECK ("number" ~ '^[0-9]{4}-[0-9]{6}$'),
  CONSTRAINT "FinanceJournalEntry_kind_check" CHECK ("kind" IN ('invoice','credit_note','receipt','payment','income','expense','contribution','withdrawal','transfer','adjustment','reversal')),
  CONSTRAINT "FinanceJournalEntry_status_check" CHECK ("status" IN ('posted')),
  -- Exactly the reversal entries point at the entry they reverse.
  CONSTRAINT "FinanceJournalEntry_reversal_check" CHECK (("kind" = 'reversal') = ("reversalOfId" IS NOT NULL)),
  CONSTRAINT "FinanceJournalEntry_reversedBy_check" CHECK ("reversedById" IS DISTINCT FROM "id")
);
CREATE INDEX "FinanceJournalEntry_projectId_entryDate_idx" ON "FinanceJournalEntry"("projectId", "entryDate");
CREATE INDEX "FinanceJournalEntry_projectId_documentId_idx" ON "FinanceJournalEntry"("projectId", "documentId");

-- One side of an entry in one account; the sign is the side.
CREATE TABLE "FinanceJournalLine" (
  "id" UUID NOT NULL,
  "workspaceId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "entryId" UUID NOT NULL,
  "accountId" UUID NOT NULL,
  "side" TEXT NOT NULL,
  "currency" TEXT NOT NULL,
  -- The original amount in "currency".
  "amountMicros" BIGINT NOT NULL,
  -- Base currency per unit of "currency", with its date and source.
  "fxRate" NUMERIC(24,12) NOT NULL,
  "rateDate" DATE NOT NULL,
  "rateSource" TEXT NOT NULL,
  "baseAmountMicros" BIGINT NOT NULL,
  "categoryId" UUID,
  "costCenterId" UUID,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FinanceJournalLine_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "FinanceJournalLine_project_fkey" FOREIGN KEY ("workspaceId", "projectId") REFERENCES "Project"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "FinanceJournalLine_projectId_id_key" UNIQUE ("projectId", "id"),
  CONSTRAINT "FinanceJournalLine_entry_fkey" FOREIGN KEY ("projectId", "entryId") REFERENCES "FinanceJournalEntry"("projectId", "id") ON DELETE CASCADE,
  CONSTRAINT "FinanceJournalLine_account_fkey" FOREIGN KEY ("projectId", "accountId") REFERENCES "FinanceAccount"("projectId", "id"),
  CONSTRAINT "FinanceJournalLine_category_fkey" FOREIGN KEY ("projectId", "categoryId") REFERENCES "FinanceCategory"("projectId", "id"),
  CONSTRAINT "FinanceJournalLine_costCenter_fkey" FOREIGN KEY ("projectId", "costCenterId") REFERENCES "FinanceCostCenter"("projectId", "id"),
  CONSTRAINT "FinanceJournalLine_side_check" CHECK ("side" IN ('debit','credit')),
  CONSTRAINT "FinanceJournalLine_amount_check" CHECK ("amountMicros" > 0 AND "baseAmountMicros" > 0),
  CONSTRAINT "FinanceJournalLine_fxRate_check" CHECK ("fxRate" > 0),
  CONSTRAINT "FinanceJournalLine_rateSource_check" CHECK ("rateSource" IN ('ecb','manual','document','peg','identity'))
);
CREATE INDEX "FinanceJournalLine_projectId_entryId_idx" ON "FinanceJournalLine"("projectId", "entryId");
CREATE INDEX "FinanceJournalLine_projectId_accountId_idx" ON "FinanceJournalLine"("projectId", "accountId");

CREATE TABLE "FinanceRecurring" (
  "id" UUID NOT NULL,
  "workspaceId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "counterpartyId" UUID,
  "categoryId" UUID,
  "allocation" JSONB,
  "interval" TEXT NOT NULL,
  "expectedAmountMicros" BIGINT NOT NULL,
  "currency" TEXT NOT NULL,
  "nextDueDate" DATE NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT true,
  -- Matching rules, such as the amount tolerance in basis points.
  "match" JSONB,
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FinanceRecurring_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "FinanceRecurring_project_fkey" FOREIGN KEY ("workspaceId", "projectId") REFERENCES "Project"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "FinanceRecurring_projectId_id_key" UNIQUE ("projectId", "id"),
  CONSTRAINT "FinanceRecurring_counterparty_fkey" FOREIGN KEY ("projectId", "counterpartyId") REFERENCES "FinanceCounterparty"("projectId", "id"),
  CONSTRAINT "FinanceRecurring_category_fkey" FOREIGN KEY ("projectId", "categoryId") REFERENCES "FinanceCategory"("projectId", "id"),
  CONSTRAINT "FinanceRecurring_interval_check" CHECK ("interval" IN ('monthly','quarterly','yearly')),
  CONSTRAINT "FinanceRecurring_amount_check" CHECK ("expectedAmountMicros" >= 0)
);

-- A business transaction (invoice, credit note or receipt).
CREATE TABLE "FinanceInvoice" (
  "id" UUID NOT NULL,
  "workspaceId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "kind" TEXT NOT NULL,
  "direction" TEXT NOT NULL,
  "counterpartyId" UUID,
  "number" TEXT,
  "issueDate" DATE NOT NULL,
  "dueDate" DATE,
  "currency" TEXT NOT NULL,
  "netMicros" BIGINT NOT NULL,
  "taxMicros" BIGINT NOT NULL,
  "totalMicros" BIGINT NOT NULL,
  -- Overdue is derived at read time, never stored.
  "status" TEXT NOT NULL DEFAULT 'open',
  "documentId" UUID,
  "creditsInvoiceId" UUID,
  "recurringId" UUID,
  -- The posting.
  "entryId" UUID,
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FinanceInvoice_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "FinanceInvoice_project_fkey" FOREIGN KEY ("workspaceId", "projectId") REFERENCES "Project"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "FinanceInvoice_projectId_id_key" UNIQUE ("projectId", "id"),
  CONSTRAINT "FinanceInvoice_counterparty_fkey" FOREIGN KEY ("projectId", "counterpartyId") REFERENCES "FinanceCounterparty"("projectId", "id"),
  CONSTRAINT "FinanceInvoice_document_fkey" FOREIGN KEY ("projectId", "documentId") REFERENCES "FinanceDocument"("projectId", "id"),
  CONSTRAINT "FinanceInvoice_credits_fkey" FOREIGN KEY ("projectId", "creditsInvoiceId") REFERENCES "FinanceInvoice"("projectId", "id"),
  CONSTRAINT "FinanceInvoice_recurring_fkey" FOREIGN KEY ("projectId", "recurringId") REFERENCES "FinanceRecurring"("projectId", "id") ON DELETE SET NULL ("recurringId"),
  CONSTRAINT "FinanceInvoice_entry_fkey" FOREIGN KEY ("projectId", "entryId") REFERENCES "FinanceJournalEntry"("projectId", "id"),
  CONSTRAINT "FinanceInvoice_kind_check" CHECK ("kind" IN ('invoice','credit_note','receipt')),
  CONSTRAINT "FinanceInvoice_direction_check" CHECK ("direction" IN ('payable','receivable')),
  CONSTRAINT "FinanceInvoice_status_check" CHECK ("status" IN ('open','partially_paid','paid','void')),
  CONSTRAINT "FinanceInvoice_total_check" CHECK ("totalMicros" >= 0)
);
CREATE INDEX "FinanceInvoice_projectId_counterpartyId_number_idx" ON "FinanceInvoice"("projectId", "counterpartyId", "number");
CREATE INDEX "FinanceInvoice_projectId_status_dueDate_idx" ON "FinanceInvoice"("projectId", "status", "dueDate");

CREATE TABLE "FinanceInvoiceLine" (
  "id" UUID NOT NULL,
  "workspaceId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "invoiceId" UUID NOT NULL,
  -- Display order within the invoice.
  "position" INTEGER NOT NULL DEFAULT 0,
  "description" TEXT NOT NULL,
  "quantity" NUMERIC(24,12) NOT NULL DEFAULT 1,
  "amountMicros" BIGINT NOT NULL,
  "taxMicros" BIGINT NOT NULL DEFAULT 0,
  "categoryId" UUID,
  -- Cost center basis points, summing to 10000.
  "allocation" JSONB,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FinanceInvoiceLine_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "FinanceInvoiceLine_project_fkey" FOREIGN KEY ("workspaceId", "projectId") REFERENCES "Project"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "FinanceInvoiceLine_projectId_id_key" UNIQUE ("projectId", "id"),
  CONSTRAINT "FinanceInvoiceLine_invoice_fkey" FOREIGN KEY ("projectId", "invoiceId") REFERENCES "FinanceInvoice"("projectId", "id") ON DELETE CASCADE,
  CONSTRAINT "FinanceInvoiceLine_category_fkey" FOREIGN KEY ("projectId", "categoryId") REFERENCES "FinanceCategory"("projectId", "id")
);
CREATE INDEX "FinanceInvoiceLine_projectId_invoiceId_idx" ON "FinanceInvoiceLine"("projectId", "invoiceId");

CREATE TABLE "FinancePayment" (
  "id" UUID NOT NULL,
  "workspaceId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "date" DATE NOT NULL,
  "direction" TEXT NOT NULL,
  -- A payment account (bank, card or wallet).
  "accountId" UUID NOT NULL,
  "currency" TEXT NOT NULL,
  "amountMicros" BIGINT NOT NULL,
  "reference" TEXT,
  "counterpartyId" UUID,
  "entryId" UUID,
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FinancePayment_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "FinancePayment_project_fkey" FOREIGN KEY ("workspaceId", "projectId") REFERENCES "Project"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "FinancePayment_projectId_id_key" UNIQUE ("projectId", "id"),
  CONSTRAINT "FinancePayment_account_fkey" FOREIGN KEY ("projectId", "accountId") REFERENCES "FinanceAccount"("projectId", "id"),
  CONSTRAINT "FinancePayment_counterparty_fkey" FOREIGN KEY ("projectId", "counterpartyId") REFERENCES "FinanceCounterparty"("projectId", "id"),
  CONSTRAINT "FinancePayment_entry_fkey" FOREIGN KEY ("projectId", "entryId") REFERENCES "FinanceJournalEntry"("projectId", "id"),
  CONSTRAINT "FinancePayment_direction_check" CHECK ("direction" IN ('outgoing','incoming')),
  CONSTRAINT "FinancePayment_amount_check" CHECK ("amountMicros" > 0)
);
CREATE INDEX "FinancePayment_projectId_date_idx" ON "FinancePayment"("projectId", "date");

-- The part of a payment that settles an invoice, in the invoice currency.
CREATE TABLE "FinancePaymentAllocation" (
  "id" UUID NOT NULL,
  "workspaceId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "paymentId" UUID NOT NULL,
  "invoiceId" UUID NOT NULL,
  "amountMicros" BIGINT NOT NULL,
  -- The part of the invoice's posted base this allocation settled, so the
  -- next payment knows the open base (the last one settles it to zero).
  "baseMicros" BIGINT NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FinancePaymentAllocation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "FinancePaymentAllocation_project_fkey" FOREIGN KEY ("workspaceId", "projectId") REFERENCES "Project"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "FinancePaymentAllocation_projectId_id_key" UNIQUE ("projectId", "id"),
  CONSTRAINT "FinancePaymentAllocation_payment_fkey" FOREIGN KEY ("projectId", "paymentId") REFERENCES "FinancePayment"("projectId", "id") ON DELETE CASCADE,
  CONSTRAINT "FinancePaymentAllocation_invoice_fkey" FOREIGN KEY ("projectId", "invoiceId") REFERENCES "FinanceInvoice"("projectId", "id"),
  CONSTRAINT "FinancePaymentAllocation_payment_invoice_key" UNIQUE ("projectId", "paymentId", "invoiceId"),
  CONSTRAINT "FinancePaymentAllocation_amount_check" CHECK ("amountMicros" > 0),
  CONSTRAINT "FinancePaymentAllocation_base_check" CHECK ("baseMicros" >= 0)
);
CREATE INDEX "FinancePaymentAllocation_projectId_invoiceId_idx" ON "FinancePaymentAllocation"("projectId", "invoiceId");

-- Exchange rates per EUR, stored per project (simple RLS; small volume).
CREATE TABLE "FinanceFxRate" (
  "id" UUID NOT NULL,
  "workspaceId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "date" DATE NOT NULL,
  "currency" TEXT NOT NULL,
  "perEur" NUMERIC(24,12) NOT NULL,
  "source" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FinanceFxRate_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "FinanceFxRate_project_fkey" FOREIGN KEY ("workspaceId", "projectId") REFERENCES "Project"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "FinanceFxRate_projectId_id_key" UNIQUE ("projectId", "id"),
  CONSTRAINT "FinanceFxRate_date_currency_source_key" UNIQUE ("projectId", "date", "currency", "source"),
  CONSTRAINT "FinanceFxRate_perEur_check" CHECK ("perEur" > 0),
  CONSTRAINT "FinanceFxRate_source_check" CHECK ("source" IN ('ecb','manual'))
);

CREATE TABLE "FinanceExport" (
  "id" UUID NOT NULL,
  "workspaceId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "kind" TEXT NOT NULL,
  "periodStart" DATE NOT NULL,
  "periodEnd" DATE NOT NULL,
  "fileId" UUID NOT NULL,
  "sha256" TEXT NOT NULL,
  "rowCount" INTEGER NOT NULL,
  "createdBy" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FinanceExport_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "FinanceExport_project_fkey" FOREIGN KEY ("workspaceId", "projectId") REFERENCES "Project"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "FinanceExport_projectId_id_key" UNIQUE ("projectId", "id"),
  CONSTRAINT "FinanceExport_file_fkey" FOREIGN KEY ("projectId", "fileId") REFERENCES "File"("projectId", "id"),
  CONSTRAINT "FinanceExport_kind_check" CHECK ("kind" IN ('journal_csv','documents_zip','year_overview')),
  CONSTRAINT "FinanceExport_period_check" CHECK ("periodEnd" >= "periodStart"),
  CONSTRAINT "FinanceExport_rowCount_check" CHECK ("rowCount" >= 0)
);

-- Posted lines never change.
CREATE FUNCTION finance_line_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'FINANCE_POSTED_IMMUTABLE: posted journal lines cannot be changed'
    USING ERRCODE = 'check_violation';
END $$;
CREATE TRIGGER finance_line_immutable BEFORE UPDATE ON "FinanceJournalLine"
  FOR EACH ROW EXECUTE FUNCTION finance_line_immutable();

-- Lines can be added only to an entry inserted in the same transaction, so
-- a balanced pair can never be appended to a posted entry later. The entry
-- insert records its id in a transaction-local setting; a line's entry must
-- be listed there. Chosen over comparing the entry's xmin with the current
-- transaction id: xmin is the subtransaction's id inside a savepoint, and
-- it changes when the entry row is updated (recording a reversal), which
-- would reopen an old entry. Local settings follow savepoints exactly: a
-- rolled back savepoint drops its entries, a released one keeps them, and
-- everything is gone at commit or rollback. The setting is as trusted as
-- the app.* scope settings the business role sets itself.
CREATE FUNCTION finance_entry_opened() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('finance.open_entries',
    coalesce(nullif(current_setting('finance.open_entries', true), '') || ',', '') || NEW."id"::text,
    true);
  RETURN NULL;
END $$;
CREATE TRIGGER finance_entry_opened AFTER INSERT ON "FinanceJournalEntry"
  FOR EACH ROW EXECUTE FUNCTION finance_entry_opened();

CREATE FUNCTION finance_line_open_entry() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."entryId"::text = ANY (string_to_array(coalesce(current_setting('finance.open_entries', true), ''), ',')) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'FINANCE_POSTED_IMMUTABLE: lines can only be added to an entry posted in the same transaction'
    USING ERRCODE = 'check_violation';
END $$;
CREATE TRIGGER finance_line_open_entry BEFORE INSERT ON "FinanceJournalLine"
  FOR EACH ROW EXECUTE FUNCTION finance_line_open_entry();

-- A posted entry changes only to record its reversal, once: "reversedById"
-- goes from NULL to the entry that reverses it (whose "reversalOfId" is
-- this entry) and every other column stays as it was.
CREATE FUNCTION finance_entry_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."reversedById" IS NULL AND NEW."reversedById" IS NOT NULL
     AND (to_jsonb(NEW) - 'reversedById') = (to_jsonb(OLD) - 'reversedById')
     AND EXISTS (SELECT 1 FROM "FinanceJournalEntry"
                  WHERE "projectId" = OLD."projectId" AND "id" = NEW."reversedById"
                    AND "reversalOfId" = OLD."id") THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'FINANCE_POSTED_IMMUTABLE: posted journal entries cannot be changed'
    USING ERRCODE = 'check_violation';
END $$;
CREATE TRIGGER finance_entry_guard BEFORE UPDATE ON "FinanceJournalEntry"
  FOR EACH ROW EXECUTE FUNCTION finance_entry_guard();

-- At commit, every entry that got an entry row or a line in the transaction
-- has at least two lines whose base-currency debits equal its credits.
-- Deferred, so the lines may follow the entry in later statements. It runs
-- as the business role under the project scope; when the entry is not
-- visible it must have been deleted with its project under the same
-- workspace and project scope, anything else fails closed.
CREATE FUNCTION finance_entry_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  entry_id UUID;
  lines INTEGER;
  debits NUMERIC;
  credits NUMERIC;
BEGIN
  IF TG_TABLE_NAME = 'FinanceJournalEntry' THEN
    entry_id := NEW."id";
  ELSE
    entry_id := NEW."entryId";
  END IF;
  SELECT count(*),
         coalesce(sum("baseAmountMicros") FILTER (WHERE "side" = 'debit'), 0),
         coalesce(sum("baseAmountMicros") FILTER (WHERE "side" = 'credit'), 0)
    INTO lines, debits, credits
    FROM "FinanceJournalLine"
   WHERE "projectId" = NEW."projectId" AND "entryId" = entry_id;
  IF lines = 0
     AND nullif(current_setting('app.workspace_id', true), '')::uuid IS NOT DISTINCT FROM NEW."workspaceId"
     AND nullif(current_setting('app.project_id', true), '')::uuid IS NOT DISTINCT FROM NEW."projectId"
     AND NOT EXISTS (SELECT 1 FROM "FinanceJournalEntry" WHERE "projectId" = NEW."projectId" AND "id" = entry_id) THEN
    RETURN NULL;
  END IF;
  IF lines < 2 OR debits <> credits THEN
    -- Ids and counts only: no amounts in an error that may be logged.
    RAISE EXCEPTION 'FINANCE_ENTRY_UNBALANCED: entry % (% lines) does not balance', entry_id, lines
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER finance_entry_balanced AFTER INSERT ON "FinanceJournalLine"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION finance_entry_balanced();
CREATE CONSTRAINT TRIGGER finance_entry_has_lines AFTER INSERT ON "FinanceJournalEntry"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION finance_entry_balanced();

ALTER TABLE "FinanceAccount" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "FinanceAccount" FORCE ROW LEVEL SECURITY;
CREATE POLICY project_scope ON "FinanceAccount"
  USING ("workspaceId"=nullif(current_setting('app.workspace_id',true),'')::uuid AND "projectId"=nullif(current_setting('app.project_id',true),'')::uuid)
  WITH CHECK ("workspaceId"=nullif(current_setting('app.workspace_id',true),'')::uuid AND "projectId"=nullif(current_setting('app.project_id',true),'')::uuid);

ALTER TABLE "FinanceCategory" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "FinanceCategory" FORCE ROW LEVEL SECURITY;
CREATE POLICY project_scope ON "FinanceCategory"
  USING ("workspaceId"=nullif(current_setting('app.workspace_id',true),'')::uuid AND "projectId"=nullif(current_setting('app.project_id',true),'')::uuid)
  WITH CHECK ("workspaceId"=nullif(current_setting('app.workspace_id',true),'')::uuid AND "projectId"=nullif(current_setting('app.project_id',true),'')::uuid);

ALTER TABLE "FinanceCostCenter" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "FinanceCostCenter" FORCE ROW LEVEL SECURITY;
CREATE POLICY project_scope ON "FinanceCostCenter"
  USING ("workspaceId"=nullif(current_setting('app.workspace_id',true),'')::uuid AND "projectId"=nullif(current_setting('app.project_id',true),'')::uuid)
  WITH CHECK ("workspaceId"=nullif(current_setting('app.workspace_id',true),'')::uuid AND "projectId"=nullif(current_setting('app.project_id',true),'')::uuid);

ALTER TABLE "FinanceCounterparty" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "FinanceCounterparty" FORCE ROW LEVEL SECURITY;
CREATE POLICY project_scope ON "FinanceCounterparty"
  USING ("workspaceId"=nullif(current_setting('app.workspace_id',true),'')::uuid AND "projectId"=nullif(current_setting('app.project_id',true),'')::uuid)
  WITH CHECK ("workspaceId"=nullif(current_setting('app.workspace_id',true),'')::uuid AND "projectId"=nullif(current_setting('app.project_id',true),'')::uuid);

ALTER TABLE "FinanceMailbox" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "FinanceMailbox" FORCE ROW LEVEL SECURITY;
CREATE POLICY project_scope ON "FinanceMailbox"
  USING ("workspaceId"=nullif(current_setting('app.workspace_id',true),'')::uuid AND "projectId"=nullif(current_setting('app.project_id',true),'')::uuid)
  WITH CHECK ("workspaceId"=nullif(current_setting('app.workspace_id',true),'')::uuid AND "projectId"=nullif(current_setting('app.project_id',true),'')::uuid);

ALTER TABLE "FinanceDocument" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "FinanceDocument" FORCE ROW LEVEL SECURITY;
CREATE POLICY project_scope ON "FinanceDocument"
  USING ("workspaceId"=nullif(current_setting('app.workspace_id',true),'')::uuid AND "projectId"=nullif(current_setting('app.project_id',true),'')::uuid)
  WITH CHECK ("workspaceId"=nullif(current_setting('app.workspace_id',true),'')::uuid AND "projectId"=nullif(current_setting('app.project_id',true),'')::uuid);

ALTER TABLE "FinanceDocumentRevision" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "FinanceDocumentRevision" FORCE ROW LEVEL SECURITY;
CREATE POLICY project_scope ON "FinanceDocumentRevision"
  USING ("workspaceId"=nullif(current_setting('app.workspace_id',true),'')::uuid AND "projectId"=nullif(current_setting('app.project_id',true),'')::uuid)
  WITH CHECK ("workspaceId"=nullif(current_setting('app.workspace_id',true),'')::uuid AND "projectId"=nullif(current_setting('app.project_id',true),'')::uuid);

ALTER TABLE "FinanceEntryCounter" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "FinanceEntryCounter" FORCE ROW LEVEL SECURITY;
CREATE POLICY project_scope ON "FinanceEntryCounter"
  USING ("workspaceId"=nullif(current_setting('app.workspace_id',true),'')::uuid AND "projectId"=nullif(current_setting('app.project_id',true),'')::uuid)
  WITH CHECK ("workspaceId"=nullif(current_setting('app.workspace_id',true),'')::uuid AND "projectId"=nullif(current_setting('app.project_id',true),'')::uuid);

ALTER TABLE "FinanceJournalEntry" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "FinanceJournalEntry" FORCE ROW LEVEL SECURITY;
CREATE POLICY project_scope ON "FinanceJournalEntry"
  USING ("workspaceId"=nullif(current_setting('app.workspace_id',true),'')::uuid AND "projectId"=nullif(current_setting('app.project_id',true),'')::uuid)
  WITH CHECK ("workspaceId"=nullif(current_setting('app.workspace_id',true),'')::uuid AND "projectId"=nullif(current_setting('app.project_id',true),'')::uuid);

ALTER TABLE "FinanceJournalLine" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "FinanceJournalLine" FORCE ROW LEVEL SECURITY;
CREATE POLICY project_scope ON "FinanceJournalLine"
  USING ("workspaceId"=nullif(current_setting('app.workspace_id',true),'')::uuid AND "projectId"=nullif(current_setting('app.project_id',true),'')::uuid)
  WITH CHECK ("workspaceId"=nullif(current_setting('app.workspace_id',true),'')::uuid AND "projectId"=nullif(current_setting('app.project_id',true),'')::uuid);

ALTER TABLE "FinanceRecurring" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "FinanceRecurring" FORCE ROW LEVEL SECURITY;
CREATE POLICY project_scope ON "FinanceRecurring"
  USING ("workspaceId"=nullif(current_setting('app.workspace_id',true),'')::uuid AND "projectId"=nullif(current_setting('app.project_id',true),'')::uuid)
  WITH CHECK ("workspaceId"=nullif(current_setting('app.workspace_id',true),'')::uuid AND "projectId"=nullif(current_setting('app.project_id',true),'')::uuid);

ALTER TABLE "FinanceInvoice" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "FinanceInvoice" FORCE ROW LEVEL SECURITY;
CREATE POLICY project_scope ON "FinanceInvoice"
  USING ("workspaceId"=nullif(current_setting('app.workspace_id',true),'')::uuid AND "projectId"=nullif(current_setting('app.project_id',true),'')::uuid)
  WITH CHECK ("workspaceId"=nullif(current_setting('app.workspace_id',true),'')::uuid AND "projectId"=nullif(current_setting('app.project_id',true),'')::uuid);

ALTER TABLE "FinanceInvoiceLine" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "FinanceInvoiceLine" FORCE ROW LEVEL SECURITY;
CREATE POLICY project_scope ON "FinanceInvoiceLine"
  USING ("workspaceId"=nullif(current_setting('app.workspace_id',true),'')::uuid AND "projectId"=nullif(current_setting('app.project_id',true),'')::uuid)
  WITH CHECK ("workspaceId"=nullif(current_setting('app.workspace_id',true),'')::uuid AND "projectId"=nullif(current_setting('app.project_id',true),'')::uuid);

ALTER TABLE "FinancePayment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "FinancePayment" FORCE ROW LEVEL SECURITY;
CREATE POLICY project_scope ON "FinancePayment"
  USING ("workspaceId"=nullif(current_setting('app.workspace_id',true),'')::uuid AND "projectId"=nullif(current_setting('app.project_id',true),'')::uuid)
  WITH CHECK ("workspaceId"=nullif(current_setting('app.workspace_id',true),'')::uuid AND "projectId"=nullif(current_setting('app.project_id',true),'')::uuid);

ALTER TABLE "FinancePaymentAllocation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "FinancePaymentAllocation" FORCE ROW LEVEL SECURITY;
CREATE POLICY project_scope ON "FinancePaymentAllocation"
  USING ("workspaceId"=nullif(current_setting('app.workspace_id',true),'')::uuid AND "projectId"=nullif(current_setting('app.project_id',true),'')::uuid)
  WITH CHECK ("workspaceId"=nullif(current_setting('app.workspace_id',true),'')::uuid AND "projectId"=nullif(current_setting('app.project_id',true),'')::uuid);

ALTER TABLE "FinanceFxRate" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "FinanceFxRate" FORCE ROW LEVEL SECURITY;
CREATE POLICY project_scope ON "FinanceFxRate"
  USING ("workspaceId"=nullif(current_setting('app.workspace_id',true),'')::uuid AND "projectId"=nullif(current_setting('app.project_id',true),'')::uuid)
  WITH CHECK ("workspaceId"=nullif(current_setting('app.workspace_id',true),'')::uuid AND "projectId"=nullif(current_setting('app.project_id',true),'')::uuid);

ALTER TABLE "FinanceExport" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "FinanceExport" FORCE ROW LEVEL SECURITY;
CREATE POLICY project_scope ON "FinanceExport"
  USING ("workspaceId"=nullif(current_setting('app.workspace_id',true),'')::uuid AND "projectId"=nullif(current_setting('app.project_id',true),'')::uuid)
  WITH CHECK ("workspaceId"=nullif(current_setting('app.workspace_id',true),'')::uuid AND "projectId"=nullif(current_setting('app.project_id',true),'')::uuid);
