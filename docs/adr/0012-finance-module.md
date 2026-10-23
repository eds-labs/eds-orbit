# ADR 0012: Finance module

## Status

Decisions F-D1 to F-D4 accepted by Mario, 2026-10-23. The design is `docs/superpowers/specs/2026-10-23-finance-module-design.md`, the guide `docs/FINANCE.md`. Implemented on the branch `claude/eds-orbit-finanzmodul-2426af`; not merged, not deployed, `ORBIT_FINANCE` off. The assumptions listed below are **not yet confirmed**.

## Context

EDS Digital Labs LLC needs a lean income and expense management that is largely automated: receipts arrive in a mailbox (`payment@eds-labs.io`) or are uploaded, an AI reads them, a person confirms, and the books stay correct and exportable for the tax advisor. Later the same module should serve any Orbit SaaS tenant.

Constraints:

- **Financial data is high risk.** Posted records must be immutable, balanced and retained; nothing financial may reach logs, audit trails or a model's instructions.
- **Documents are untrusted.** A receipt can contain instructions aimed at the model.
- **Paid AI** must keep the platform's mandate, reservation and settlement path.
- **Orbit is modular.** Finance is a product module like Marketing, Knowledge and Support: opt-in, its own permissions, no cross-module imports, no baseline exceptions.
- **No new production dependency** without approval.
- **No bank sync, VAT or payroll** in Phase 1. This is not a certified accounting system.

Reusable mechanisms: the module manifest and contributions, `ProjectModule` activation, project-scoped RLS with composite foreign keys, the e-mail connection with IMAP receiving, platform files, the AI run/reserve/settle path, the tool registry, attention items, member notifications and the content-free audit.

## Decisions

### Product decisions (Mario, 2026-10-23)

| # | Decision |
|---|---|
| F-D1 | Scope: a dedicated Orbit project (for example "EDS Labs Finance") with the module enabled. Business "projects" are finance-internal **cost centers**, optionally labelled with an Orbit project of the same workspace. No workspace-level tenancy. |
| F-D2 | The AI reads receipts as files: `packages/ai` gains PDF and image input for OpenAI and Anthropic, with no new dependency. |
| F-D3 | Historical exchange rates come from the ECB daily reference rates (free, keyless), stored per date, with a manual override per booking. |
| F-D4 | Every AI result stays a draft until an owner or editor confirms it. Posted entries are immutable; corrections are reversals. |

### Assumptions (to confirm with Mario)

- The reporting (base) currency is per project, default **USD**.
- **USDC** is its own currency with a configurable peg to USD, default 1.000000.
- **Accrual basis**: income and expense by document date.
- Default **retention 10 years**.

These are settings with defaults (`baseCurrency`, `usdcPeg`, `retentionYears`), so a different answer changes data, not code, as long as it is given before the first booking. Changing the base currency after bookings would need a migration of the stored base amounts.

### Architecture decisions taken during implementation

1. **Mailbox owner routing.** An e-mail connection may name one `ownerModule` (a field of its JSON data, no migration). The platform delivers an owned mailbox's mail only to that module's `emailInbound` consumer; an unowned mailbox keeps broadcasting. Binding finance sets the owner; finance and Support refuse each other's mailboxes (409 `EMAIL_MAILBOX_OWNED`). Reason: a receipt mailbox must never be read by Support, and Support's contact erasure must never reach finance mail. The owner is a module id string that is not validated against the registry, so a module that is switched off keeps its claim.
2. **IMAP archive after acknowledgement.** Orbit never moves mail on its own. The owning module calls `requestInboundArchive` once it is done; the platform job `email_archive` moves the message and records `archivedAt` or `archiveError` on the inbound row. Only the owner may ask. Finance asks when its documents of that message have left extraction (or, with `archiveAfter = booked`, review) and no accepted attachment failed. Lost messages and UID-validity changes are recorded, not retried. This keeps the "read-only mailbox" promise of the platform for every other module.
3. **Storage-only file types.** `application/xml` (XML e-invoices) and `application/zip` (exports) are stored and downloaded through platform files but are **not** added to Support's inbound attachment allow-list, so Support behaviour is unchanged. They are a separate platform set (`STORAGE_ONLY_TYPES`).
4. **File retention lock.** `File.retainUntil` makes `deleteFile` fail with 409 `FILE_RETAINED` for everyone, including Support's erasure; only finance sets it. A legal erasure request on finance originals would need an owner-level override later.
5. **Money as bigint micros, rates as NUMERIC.** Amounts are `bigint` micros (10⁻⁶), which covers 2-decimal currencies and USDC's 6; rates are `NUMERIC(24,12)` handled as decimal strings with bigint arithmetic. `number` is never used for money. Base conversion rounds half-even. Alternative rejected: `Decimal` JavaScript libraries (new dependency) and float amounts (rounding errors).
6. **Ledger integrity in the database.** The role `orbit_app` has no DELETE on the journal, documents, invoices, payments and exports. Triggers reject UPDATE of lines, allow an entry to change only once to record its reversal, allow lines only for an entry created in the same transaction, and check at commit that every entry has at least two lines and balances in the base currency. References among these tables use NO ACTION so a project cascade never updates a posted row. Reason: the immutability promise must hold against bugs in application code.
7. **Human-confirmed booking, no ActionRequests in Phase 1.** The review step in the module UI is the approval (F-D4); booking checks the document `version` and runs under the project lock. ActionRequests stay the path for later agent or MCP mutations. The AI never books.
8. **Corrections create entries; voids reopen documents.** Void invoice and void payment reverse their entries (void payment also recomputes invoice status); voiding a document-backed invoice returns the document to `needs_review` for a corrected booking. A credit note that names its invoice reduces the open amount; a base residue after closing is posted to `fx_gain_loss`. Decided in review of Task 13 because the spec was silent on how a paid or booked receipt is corrected and on credit settlement.
9. **MCP exposure off.** The four assistant tools are read-only (`R0_read`) with `exposure.mcp = false`. An `orbit:finance` MCP scope needs its own review. Tool output carries aggregates only, never document text.
10. **Extraction through the platform AI path.** The new task class `finance_extraction` and run kind `finance` reuse `startRun/planCall/reserve/respond/settle` with the spend mandate, plus a finance-specific daily ceiling. The model has no tools, `store: false`, a strict schema, and deterministic validation; an unknown outcome is never retried.
11. **Neutral shared CSS names for settings forms** (`settings-form`, `settings-row`, …) as aliases of Support's rules, so a Support restyle cannot silently change Finance.
12. **Amount input.** A lone comma followed by exactly three digits is ambiguous for currencies with more than two decimals and is rejected on web and server, so "1,000" USDC cannot become 1.000 or 1000 silently.
13. **CSV export** guards text cells against spreadsheet formulas, but leaves plain system-produced decimals numeric so negative credit amounts stay usable.

## Consequences

- One migration pair (`202610230001_platform_finance_prerequisites`, `202610230002_finance_core`), additive. Seventeen new tables with FORCE RLS; `scripts/db-deploy.ts`, the RLS matrix, the access matrix and the queue-dispatch test are extended. Pushing to `main` deploys production including both migrations and needs Mario's approval.
- Platform gains generic capabilities that other modules may use: mailbox ownership, archive-after-acknowledgement, file retention, XML/ZIP storage types and file/image input for AI calls.
- The retention lock and the missing DELETE grants mean mistakes in finance data cannot be deleted by the application; they are corrected by reversal. Cleaning test data in production needs a deliberate, approved database action.
- A hostile document can at most produce a wrong draft that a person reviews.
- Cost: AI extraction spends against the project's spend mandate (default finance ceiling USD 2 per day). It is off until the owner consents.
- Known limitations are listed in `docs/FINANCE.md` (partial credit at very different rates, export size, sandboxed PDF preview, queue cap, DATEV not available).
- The platform changes touch Support's neighbours (email receive, files) and have regression tests; with finance off, behaviour is unchanged.

## Alternatives considered

- **Workspace-level finance** (one ledger across projects): rejected by F-D1; an Orbit project per company keeps RLS, roles and deletion simple.
- **Buying or integrating an accounting package** (DATEV, Lexoffice, an ERP): out of scope for a lean first version and would add providers and cost; the journal CSV and the year overview feed an advisor, and the exporter interface leaves room for DATEV.
- **Extracting text with OCR before the model:** a new dependency and worse results than document input; rejected by F-D2.
- **Let the AI book automatically above a confidence threshold:** rejected by F-D4; confidence is advisory.
- **Archive mail immediately on arrival or never:** immediate archiving can hide a mail that finance failed to process; never archiving leaves the inbox cluttered. Archive after acknowledgement is the compromise, configurable per project.
- **Share the mailbox with Support and filter by sender:** fragile and leaks finance mail into Support's contact erasure; owner routing is explicit.
- **Mutable drafts in the journal** (status `draft` entries): drafts live on documents instead, so the journal contains only posted, immutable entries.
- **A database `DELETE` with soft-delete flags:** rejected; no DELETE grant is a stronger guarantee than a convention.
- **Float or `Decimal` amounts, JavaScript `number` rates:** rejected for rounding risk (see decision 5).
- **ECB rates in a platform table shared by all projects:** rejected for Phase 1; per-project storage keeps RLS simple at small volume.
