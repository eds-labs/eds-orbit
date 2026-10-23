# Finance module (Phase 1) — design

**Status:** Draft for Mario's review (2026-10-23). Nothing implemented yet.
**Branch:** `claude/eds-orbit-finanzmodul-2426af` (base `origin/main` 1d6f52f).
**Risk:** high (financial data, documents sent to an AI provider, platform e-mail and file changes, new migration). Environment: local only; no production action without separate approval.
**App profiles:** primary `fullstack-saas` (tenants, roles, sensitive data); supplementary `ai-agent-app` (extraction, assistant tools) and `data-pipeline` (mail intake, FX sync).
**Workflows:** `.agentic/workflows/feature.md` and `migration.md`.

## 1. Goal and non-goals

A lean, largely AI-automated income and expense management for one Orbit project, first used for EDS Digital Labs LLC and later for any Orbit SaaS tenant.

In scope for Phase 1: receipt intake by mailbox and upload, AI extraction and suggestions, a human review and booking step, a double-entry journal with invoices, credit notes, payments, contributions and withdrawals, multiple currencies with historical rates, categories and cost centers with splits, recurring costs, a dashboard, management lists, CSV and receipt exports, a year overview for the tax advisor, read-only Orbit Assistant tools, documentation.

Not in scope: full bookkeeping (no VAT returns, depreciation, balance sheet closing, payroll), bank/card/wallet sync, uLiquid Desk revenue import, automatic monthly reports, a DATEV file writer. The design leaves extension points for each (section 11).

### Decisions (Mario, 2026-10-23)

| # | Decision |
|---|---|
| F-D1 | Scope: a dedicated Orbit project (for example "EDS Labs Finance") with the module enabled. Business "projects" are finance-internal **cost centers**, optionally labelled with an Orbit project of the same workspace. No workspace-level tenancy. |
| F-D2 | The AI reads receipts as files: `packages/ai` adapters gain PDF and image input (OpenAI Responses and Anthropic), no new dependency. |
| F-D3 | Historical exchange rates come from the ECB daily reference rates (free, keyless), stored per date, with a manual override per booking. |
| F-D4 | Every AI result stays a draft until an owner or editor confirms it. Posted entries are immutable; corrections are reversals. |

Assumptions (correct me if wrong): reporting (base) currency is per-project configurable, default **USD**; **USDC** is its own currency with a configurable USD peg (default 1.000000); accrual basis (income and expense by document date); default retention 10 years.

## 2. Reuse of existing Orbit infrastructure

| Need | Reused | Gap closed in this work |
|---|---|---|
| Module, activation, roles | `ServerModule` manifest, `ModuleContributions`, `ProjectModule`, `ORBIT_MODULES`, `ORBIT_MODULE_ROLES`, `scopeFor` | New flag `ORBIT_FINANCE` (default off), opt-in module |
| Tenancy | `workspaceId`/`projectId` columns, composite FKs, FORCE RLS `project_scope`, `scoped()` | — |
| Mailbox | `email` connection (IMAP via imapflow, encrypted credentials), `emailInbound` periodic fetch, `inbound_emails` rows, raw `.eml` in platform files | Mailbox owner routing, IMAP archive (move) after acknowledgement (section 5) |
| Files | `storeFile`/`readFile` (AES-256-GCM, SHA-256, project-scoped, download route with nosniff/CSP) | Retention lock (`retainUntil`), `application/xml` type |
| AI | `startRun`/`planCall`/`reserve`/`respond`/`settle`, spend mandate, routes per task class, zod structured output | File/image input, task class `finance_extraction`, run kind `finance` |
| Approval | Human confirmation in the module UI; ActionRequests stay the path for later agent/MCP mutations | — |
| Assistant | `defineTool` (`R0_read`), registry contribution, role filtering | Four read tools |
| Attention, notifications | `AttentionContribution`, `notifyMembers` | Review-queue items |
| Audit | `audit()` (append-only `AuditEvent`, content-free) | — |
| Jobs | `enqueue` (outbox), `JobDef`, `PeriodicTask` | Three job classes, two periodic tasks |
| UI | Shell, `WebModule`, `HomeCard`, `Metric`, primitives, grouped settings, design tokens | Small SVG chart components (no chart library) |
| Money | Integer micros convention (AI budgets) | Currency-aware micros + FX helpers |

The n8n integration layer is not used.

## 3. Architecture

```
apps/api/src/modules/finance/
  manifest.ts permissions.ts gate.ts settings.ts contributions.ts
  money.ts            # micros, rounding, currency table, formatting helpers
  fx.ts fx-ecb.ts     # rate lookup, ECB fetch/parse
  ledger/             # accounts.ts posting.ts invariants.ts reversal.ts  (pure + tx functions)
  intake/             # mail.ts upload.ts documents.ts duplicates.ts
  extraction/         # schema.ts prompt.ts extract.ts validate.ts suggest.ts
  invoices.ts payments.ts recurring.ts categories.ts cost-centers.ts counterparties.ts
  reports.ts exports/ (csv.ts zip.ts year.ts exporter.ts)
  routes.ts tools.ts attention.ts
apps/web/src/modules/finance/
  manifest.tsx api.ts overview.tsx review.tsx document.tsx entries.tsx invoices.tsx
  recurring.tsx reports.tsx settings.tsx charts.tsx money.ts
```

- Boundaries: new zones `module:finance` and `web-module:finance` in `scripts/boundaries.json`. Finance imports only platform code and `packages/*`; nothing imports finance except the registries. No baseline exceptions.
- Generic core: no EDS-specific rules in code. The default chart of accounts and categories are a neutral template applied when the module is first enabled; everything is editable per project.

## 4. Data model

All tables: `workspaceId`, `projectId`, `@@unique([projectId, id])`, FK to `Project(workspaceId,id) ON DELETE CASCADE`, composite FKs between rows, ENABLE + FORCE RLS `project_scope`, grants in `scripts/db-deploy.ts`. One migration `2026102300xx_finance_core` (plus the platform migration in section 5). Prisma models without relations, like Support.

**Money:** amounts are `BigInt` **micros** (10⁻⁶ of the currency unit), which covers EUR/USD (2 decimals) and USDC (6). Each currency has `decimals` for display and input validation (EUR/USD reject sub-cent input). Exchange rates are `NUMERIC(24,12)` (Prisma `Decimal`; no new dependency). Base conversion rounds half-even to the base currency's decimals.

| Table | Purpose and key columns |
|---|---|
| `FinanceAccount` | Chart of accounts. `code`, `name`, `type` (`asset`, `liability`, `equity`, `income`, `expense`), `role` (nullable system role: `payables`, `receivables`, `owner_contributions`, `owner_draws`, `fx_gain_loss`, `rounding`), `paymentAccount` (bank/card/wallet usable for payments), `currency` (nullable), `externalCode` (later DATEV/SKR mapping), `archivedAt`. Unique `(projectId, code)`. |
| `FinanceCategory` | `name`, `kind` (`income`, `expense`), `parentId`, `accountId` (income/expense account the category posts to), `archivedAt`. |
| `FinanceCostCenter` | `code`, `name`, `orbitProjectId` (nullable label, same workspace, not a data link), `archivedAt`. |
| `FinanceCounterparty` | `name`, `normalizedName`, `taxId`, `emailDomains[]`, `defaultCategoryId`, `defaultAllocation` (JSON, cost center basis points). |
| `FinanceMailbox` | Binding of an `email` connection: `emailConnectionId` (composite FK to `Entity`), `archiveFolder` (default `Orbit/Processed`), `active`. |
| `FinanceDocument` | One original. `fileId` (finance-owned file, retention-locked), `sha256`, `source` (`email`, `upload`), `mailboxId`, `inboundEmailId`, `messageId`, `emailFileId` (copy of the `.eml`), `originalName`, `mimeType`, `status` (`received`, `extracting`, `needs_review`, `booked`, `rejected`, `duplicate`, `failed`), `docType` (`invoice`, `receipt`, `credit_note`, `other`, `unknown`), `extraction` (JSON, schema-versioned), `confidence` (0–1), `flags[]` (for example `total_mismatch`, `possible_duplicate`, `unknown_currency`, `low_confidence`), `duplicateOfId`, `agentRunId`, `version`. Unique `(projectId, sha256)` among non-rejected originals is enforced in code with a lock (rejected or duplicate rows keep the hash). |
| `FinanceDocumentRevision` | Change history of a draft before booking: `documentId`, `version`, `actorUserId`, `changes` (JSON field → before/after), `createdAt`. |
| `FinanceInvoice` | A business transaction: `kind` (`invoice`, `credit_note`, `receipt`), `direction` (`payable`, `receivable`), `counterpartyId`, `number`, `issueDate`, `dueDate`, `currency`, `netMicros`, `taxMicros`, `totalMicros`, `status` (`open`, `partially_paid`, `paid`, `void`); overdue is derived (`open`/`partially_paid` and `dueDate < today`), `documentId`, `creditsInvoiceId`, `recurringId`, `entryId` (posting). |
| `FinanceInvoiceLine` | `invoiceId`, `description`, `quantity`, `amountMicros`, `taxMicros`, `categoryId`, `allocation` (JSON basis points over cost centers, sums to 10000). |
| `FinancePayment` | `date`, `direction` (`outgoing`, `incoming`), `accountId` (payment account), `currency`, `amountMicros`, `reference`, `counterpartyId`, `entryId`. |
| `FinancePaymentAllocation` | `paymentId`, `invoiceId`, `amountMicros` (invoice currency). |
| `FinanceJournalEntry` | `entryDate`, `kind` (`invoice`, `credit_note`, `receipt`, `payment`, `income`, `expense`, `contribution`, `withdrawal`, `transfer`, `adjustment`, `reversal`), `status` (`posted`; drafts live on documents, not in the journal), `memo`, `documentId`, `sourceType`/`sourceId`, `reversalOfId`, `reversedById`, `postedBy`, `postedAt`, `number` (gap-free per project and year, `YYYY-000123`). |
| `FinanceJournalLine` | `entryId`, `accountId`, `side` (`debit`, `credit`), `currency`, `amountMicros` (original), `fxRate`, `rateDate`, `rateSource` (`ecb`, `manual`, `document`, `peg`, `identity`), `baseAmountMicros`, `categoryId`, `costCenterId`. A split over cost centers produces one line per cost center. |
| `FinanceRecurring` | `name`, `counterpartyId`, `categoryId`, `allocation`, `interval` (`monthly`, `quarterly`, `yearly`), `expectedAmountMicros`, `currency`, `nextDueDate`, `active`, `match` (amount tolerance in basis points). |
| `FinanceFxRate` | `date`, `currency`, `perEur` (`NUMERIC`), `source`. Unique `(projectId, date, currency, source)`. ECB rates are stored per project (simple RLS; small volume). |
| `FinanceExport` | `kind` (`journal_csv`, `documents_zip`, `year_overview`), `periodStart`, `periodEnd`, `fileId`, `sha256`, `rowCount`, `createdBy`. |

Settings (zod, in `ProjectModule.settings`, version-checked): `baseCurrency`, `currencies[]`, `usdcPeg`, `fxSource` (`ecb`, `manual`), `aiExtraction` (`off` by default; the owner turns it on as a recorded consent), `aiDailyCeilingMicros`, `archiveAfter` (`extracted` default, or `booked`), `retentionYears` (10), `duplicateWindowDays` (3), `reviewConfidence` (0.85; below → `low_confidence` flag).

### Integrity rules (database, not only code)

- `orbit_app` gets `SELECT, INSERT, UPDATE` on journal entries and lines, no `DELETE` (project deletion still cascades through foreign keys). A trigger rejects any `UPDATE` on lines and any `UPDATE` on entries except setting `reversedById` once.
- A deferred constraint trigger checks, per entry, that the base-currency debits equal the credits and that each entry has at least two lines.
- Documents linked to a posted entry cannot be deleted (same grant rule); files carry `retainUntil`.

## 5. Platform changes (small, generic, tested)

1. **Mailbox owner routing.** An `email` connection gets an optional `ownerModule`. `fetchMailbox` enqueues only to the owner when it is set, and to all `emailInbound` modules (today's behaviour) when it is not. Binding a mailbox to finance sets the owner; finance refuses a mailbox Support uses, and Support refuses one finance owns (`mailboxUse`). Support's contact erasure is scoped to its own inbox connections, so it can never delete finance mail.
2. **IMAP archive after acknowledgement.** `MailboxReader` gains `move(uidValidity, uid, folder)` (read-write open, creates the folder if missing). The platform function `requestInboundArchive(tx, scope, inboundEmailId, folder)` enqueues the platform job `email_archive`; the worker moves the message and records `archivedAt` or `archiveError` on the inbound row. A UID-validity change or a missing message is recorded, never retried endlessly. Only owners of a mailbox can request archiving (a module may archive only mail it owns).
3. **File retention lock.** `File.retainUntil` (nullable). `deleteFile` refuses with `409 FILE_RETAINED`; retention cleanup skips it. `application/xml` (signature `<?xml`) is allowed for storage and download only.
4. **AI file input.** `respond()` accepts input parts `{type: "file", mimeType, data}` (PDF) and `{type: "image", mimeType, data}`; OpenAI maps them to `input_file`/`input_image`, Anthropic to `document`/`image` blocks. `estimateCost` gets a conservative per-page/per-image estimate. A model without the capability rejects before transmission (`AI_INPUT_UNSUPPORTED`). New task class `finance_extraction`, run kind `finance` (migration widens `AgentRun_kind_check`), route defaults in the provider catalogue and the AI settings form.

## 6. Intake and extraction flow

```
mailbox (owner=finance) ─▶ platform emailInbound ─▶ finance_mail_receipt job
upload (POST /finance/documents) ───────────────────────────┐
                                                            ▼
                   store original (finance file, retainUntil, sha256)
                   exact duplicate? ── yes ─▶ status duplicate (no AI cost)
                                                            ▼
                   finance_extract job (only if aiExtraction=on, else needs_review)
                   ├ model call with the file, strict zod schema, no tools
                   ├ deterministic validation (line sum, tax, dates, currency)
                   ├ counterparty match, category/cost center suggestion
                   │   (history of confirmed bookings first, AI suggestion second)
                   ├ semantic duplicate check
                   └ status needs_review + flags + confidence
                                                            ▼
                   request IMAP archive (archiveAfter=extracted) ─▶ email_archive
                                                            ▼
                   human review ─▶ book ─▶ invoice/payment + posted journal entry
                                                            (archiveAfter=booked)
```

- **Mail job:** it ignores mail of unbound connections, deduplicates by `messageId` (fallback: UID and UID validity), parses the raw `.eml` with `postal-mime`, keeps attachments of the types PDF, PNG, JPEG, WebP and XML, and copies the `.eml` into a finance file. A mail without an attachment becomes one document from its body (for example a provider's HTML receipt), stored as the `.eml`. Bounces and automatic replies are already filtered by the platform.
- **Duplicates:** (1) exact: the same SHA-256 in the project; (2) the same counterparty and invoice number; (3) the same counterparty, total and currency within `duplicateWindowDays` without a number → `possible_duplicate` flag, which needs an explicit "not a duplicate" decision. A duplicate links to the original it duplicates.
- **AI safety:** the document is untrusted input. The model has no tools, its output is validated data, and the prompt states that instructions inside documents are content. Spend mandate, reservation and settlement as in Support, plus the finance daily ceiling. An unknown outcome is settled as null and never retried automatically. `store: false`. Extraction stays off until the owner turns it on.
- **Failures:** a failed extraction or failed validation leaves the document in `needs_review` (or `failed` with a retry button). Its mail is not archived until extraction has finished.

## 7. Booking logic

Posting rules (`ledger/posting.ts`, pure functions → lines; `ledger/invariants.ts` checks balance before insert):

| Transaction | Debit | Credit |
|---|---|---|
| Payable invoice | expense (per line category account, split per cost center) | payables |
| Receivable invoice | receivables | income (per line) |
| Credit note | the inverse of the invoice it credits | |
| Receipt (already paid) | expense | chosen payment account |
| Outgoing payment | payables | payment account |
| Incoming payment | payment account | receivables |
| Contribution (Einlage) | payment account | owner contributions |
| Withdrawal (Entnahme) | owner draws | payment account |
| Transfer | target payment account | source payment account |

- **FX:** every line stores the original amount, the rate, its date and source, and the base amount. The rate is the one of the entry date; ECB has no weekend rates, so the last earlier business day is used and recorded. The difference between an invoice's base amount and its payment's base amount is posted to `fx_gain_loss`. USDC uses the peg against USD and USD's ECB rate. Rounding differences from splits go to the largest line; a residue from a split over cost centers goes to the `rounding` account only if it cannot be absorbed.
- **Corrections:** a posted entry is reversed by a new entry with swapped sides (`reversalOfId`), then a corrected entry is posted. Void invoices reverse their posting.
- **Status:** invoice payment status follows its allocations; overdue is derived at read time.
- **Concurrency:** booking uses the document `version` (409 on conflict) and inside `scoped()` (project advisory lock), so a document is booked at most once.

## 8. API (all under `/api/projects/:projectId/finance`, guarded by `scopeFor` + module enabled + `requireFinance`)

| Area | Routes |
|---|---|
| Overview | `GET summary?from&to` (monthly income/expense/result, open/overdue totals, recurring monthly equivalent, per cost center, per category, review count) |
| Documents | `GET documents?status&…`, `POST documents` (upload, raw bytes like platform files), `GET documents/:id`, `PATCH documents/:id` (draft edit, version, revision row), `POST documents/:id/book`, `POST documents/:id/reject`, `POST documents/:id/not-duplicate`, `POST documents/:id/retry`, `GET documents/:id/file` (download through the platform file read) |
| Journal | `GET entries?from&to&account&category&costCenter&kind&q`, `GET entries/:id`, `POST entries` (manual: contribution, withdrawal, transfer, adjustment), `POST entries/:id/reverse` |
| Invoices, payments | `GET invoices?direction&status&overdue`, `POST payments` (with allocations), `POST invoices/:id/void` |
| Master data | CRUD for `accounts`, `categories`, `cost-centers`, `counterparties`, `recurring`, `mailboxes` (archive instead of delete when referenced) |
| FX | `GET fx-rates?date`, `POST fx-rates` (manual rate) |
| Exports | `POST exports` (`journal_csv`, `documents_zip`, `year_overview` for a period) → stored file + `FinanceExport` row; `GET exports` |

Permissions (`finance.*`, all `sensitive`): `finance.read` (owner, editor), `finance.write` (review, book, master data; owner, editor), `finance.export` (owner, editor), `finance.settings` (mailboxes, AI consent, accounts template, currencies; owner). Viewers get no finance access by default; module roles can narrow further. Every mutation writes a content-free audit event (`finance.document.booked`, ids and counts only). OpenAPI and the client are regenerated; the access matrix gains reviewed rows.

## 9. Web UI (Orbit design system, `docs/DESIGN_SYSTEM.md`)

- **Navigation:** module "Finance" (opt-in) with views Overview, Review, Bookings, Invoices, Recurring, Reports, and settings sections under grouped settings (Mailboxes, Accounts & categories, Cost centers, Currencies & FX, AI extraction).
- **Overview:** module eyebrow, metrics strip (income, expenses, result for the current month, open, overdue, monthly running costs, unreviewed receipts), a 12-month income/expense bar chart with a result line, cost by cost center, cost trend by category, and the list of unreviewed receipts. Charts are small accessible SVG components (`charts.tsx`) with design tokens, table fallbacks and "—" for unknown values.
- **Review:** queue sorted by flags and age; detail with the original (PDF/image preview through the download route), the editable extraction, line splits over cost centers, duplicate comparison, and the buttons Book, Reject and Not a duplicate.
- **Bookings / Invoices / Recurring:** filterable lists (URL search params), entry detail with lines, original amounts, rates and the linked original; reversal; payment recording.
- **Reports:** year overview (income and expense per category and month, per cost center, open items at year end, list of originals) with print layout and exports.
- **Home card and attention:** "N receipts to review", "N overdue invoices".

## 10. Orbit Assistant tools

Read-only (`R0_read`), `permission: finance.read`, `exposure: { assistant: true, mcp: false }` in Phase 1 (an MCP scope `orbit:finance` is a follow-up with its own review). Amounts are returned in base currency with the period they cover; no document content goes back into the model.

| Tool | Answers |
|---|---|
| `finance_report` (`period`, `groupBy` month/category/costCenter, filters category/costCenter by name, `kind` income/expense) | "Ausgaben letzten Monat", "Was kostet uLiquid monatlich?" (cost center, monthly average), "gesamte KI-Kosten" (category tree match) |
| `finance_open_invoices` (`direction`, `overdueOnly`) | "Welche Rechnungen sind offen?" |
| `finance_review_queue` | "Welche Belege müssen geprüft werden?" |
| `finance_recurring` | running costs and subscriptions, monthly equivalent |

## 11. Extension points (prepared, not built)

- **Bank, card, wallet sync:** payment accounts have a type and currency; `FinancePayment` plus allocations are the matching target; a later `finance.bankImport` source adds statement lines and a matcher.
- **On-chain USDC:** USDC as a currency, wallet payment accounts, `rateSource: peg`; a later wallet connection adds incoming payments.
- **uLiquid Desk income:** receivable invoices and incoming payments are the target; an import job can write them through the same posting functions.
- **Monthly reports:** `reports.ts` produces period summaries that a scheduler contribution can send.
- **Accounting exports:** `exports/exporter.ts` defines `FinanceExporter { id, formats, build(period) }`; `journal_csv` is the first implementation; DATEV EXTF needs the `externalCode` mapping and a consultant/client number (follow-up).
- **XRechnung/ZUGFeRD:** XML originals are stored now; structured parsing later.

## 12. Security, privacy, operations

- Finance data and originals stay in the project's RLS scope; files are encrypted at rest. Downloads use the existing nosniff/CSP attachment route.
- AI: off by default, owner consent recorded; only the original document and the project's category and cost center names are sent; OpenAI `store: false`; spend mandate and ceilings; no tool access for the extraction model.
- Prompt injection: document content never reaches the assistant's context as instructions; assistant tools return aggregates.
- Retention: originals, the `.eml` and posted entries are retained for `retentionYears`; deletion is blocked by grants and `retainUntil`. Project deletion remains an owner action outside the module.
- Logging: no amounts, names or document text in logs or audit metadata.
- Kill switch: `ORBIT_FINANCE=false`; per project: disable the module; AI: setting `aiExtraction=off`.

## 13. Testing

- Unit (TDD): money and rounding, FX lookup and cross rates, ECB XML parsing, posting rules per transaction type, balance invariant, reversal, FX difference, split rounding, duplicate rules, extraction validation, ZIP writer, CSV escaping.
- Integration (worktree database): mail intake (fixture `.eml` with a PDF, without an attachment, duplicate Message-ID), owner routing (Support does not receive finance mail, and the reverse), archive job (fake IMAP), upload, extraction with a stubbed provider (valid, invalid JSON, injection text in the document), booking concurrency (two bookings of one document), immutability triggers and grants, permission and role negatives, module disabled, cross-project isolation (RLS matrix seeds every finance table), assistant tool output and role filtering, exports.
- Safety nets: `rls-matrix`, `access-matrix` (reviewed additions), `queue-dispatch` (new queue classes), module registry tests, prompt snapshot (unchanged while finance is disabled).
- Web: component tests for the overview, review form and charts; Playwright scenario upload → review → book → overview.
- Commands: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm api:generate`, `pnpm test:e2e` (finance flow), `pnpm test:coolify-compose`. No paid provider call in tests.

## 14. Delivery

Work packages, each committed separately on this branch with its tests:

1. Platform: mailbox owner routing, IMAP archive, file retention lock and XML, AI file input, task class and run kind.
2. Finance schema, migration, manifest, permissions, settings, flag, RLS/access/queue registrations.
3. Ledger core: money, FX, posting, invariants, reversal.
4. Intake: mail job, upload, duplicates, extraction, ECB sync.
5. API routes, exports, OpenAPI/client.
6. Web UI.
7. Assistant tools, attention, notifications.
8. Documentation: `docs/FINANCE.md` (behaviour and configuration), ADR 0012, `IMPLEMENTATION_STATUS.md`, `REQUIREMENTS_TRACEABILITY.md`, `.env.example`, compose.

Pushing to `main` deploys production, including the migration. That push needs Mario's explicit approval; until then everything stays on the branch. Production activation (flag, mailbox `payment@eds-labs.io`, AI consent) is a separate, approved runbook step.

**Rollback:** set `ORBIT_FINANCE=false`, or disable the module per project; the migration is additive (new tables, a nullable file column, a widened check, a connection data field), so reverting the code leaves no broken state.

## 15. Open questions and manual setup (for later, not blocking Phase 1)

- IMAP credentials for `payment@eds-labs.io` (host, port, user, app password) entered by Mario in Orbit; the mailbox needs permission to create and move into the archive folder.
- Confirmation of base currency USD and the 10-year retention.
- Default categories and cost centers for EDS Digital Labs (uLiquid, FamilyPlan, EDS Orbit, General), entered as data, not code.
- AI consent and daily ceiling for the finance project; the policy's spend mandate must cover it.
- DATEV specifics (consultant number, chart SKR03/04) once the export is wanted.
