# Finance Module (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the opt-in Orbit module `finance`: receipt intake by mailbox and upload, AI extraction with human-confirmed booking into a double-entry journal, multi-currency with ECB rates, dashboard, management, exports and read-only assistant tools.

**Architecture:** A new server module `apps/api/src/modules/finance/` and web module `apps/web/src/modules/finance/`, registered like Support, with its own RLS-protected tables. Four small generic platform extensions come first: mailbox owner routing, IMAP archive, file retention lock, and AI file input. The ledger core is pure functions behind one posting entry point; everything that writes the journal goes through it.

**Tech Stack:** TypeScript, Fastify, Prisma/PostgreSQL (raw SQL migrations, FORCE RLS), BullMQ via the outbox, imapflow, postal-mime, zod, `packages/ai` (OpenAI Responses, Anthropic), Next.js, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-23-finance-module-design.md` (approved 2026-10-23). Read it before any task; section numbers below refer to it.

## Global Constraints

- Flag `ORBIT_FINANCE` (`"false"` default). The module has `defaultEnabled: false` and is unreachable unless the flag is on **and** the project has an explicit enabled `ProjectModule` row (`requireFinance`, 404 `FINANCE_DISABLED`).
- No new production dependency. ZIP, CSV, ECB XML parsing and charts are written in the repo.
- Amounts are `bigint` micros (10⁻⁶ of the currency unit). Rates are `NUMERIC(24,12)`, handled as decimal strings, with bigint math only (never `number` for money). Base conversion rounds half-even to the base currency's decimals.
- Currency decimals: `EUR 2, USD 2, GBP 2, CHF 2, USDC 6`. Settings defaults: `baseCurrency "USD"`, `currencies ["USD","EUR","USDC"]`, `usdcPeg "1.000000"`, `fxSource "ecb"`, `aiExtraction "off"`, `aiDailyCeilingMicros 2_000_000`, `archiveAfter "extracted"`, `retentionYears 10`, `duplicateWindowDays 3`, `reviewConfidence 0.85`.
- Permissions, all `sensitive: true`:
  - `finance.read`: owner, editor
  - `finance.write`: owner, editor
  - `finance.export`: owner, editor
  - `finance.settings`: owner
- Every table follows the Support migration pattern (`packages/db/prisma/migrations/202610180001_support_core/migration.sql`):
  - `workspaceId`/`projectId`, `@@unique([projectId, id])`, a project FK with cascade, composite row FKs
  - ENABLE + FORCE RLS `project_scope`
  - grants in `scripts/db-deploy.ts`
  - Prisma models without relations
- Journal entries/lines, documents, invoices and payments: `orbit_app` has no `DELETE`. Posted lines are never updated.
- Audit metadata is content-free: ids, counts and field names only, never amounts, names or document text. Nothing financial goes into logs.
- Boundaries: zones `module:finance` → `apps/api/src/modules/finance/`, `web-module:finance` → `apps/web/src/modules/finance/`. No baseline exceptions.
- Documentation and comments are in English; UI strings come from `@/lib/i18n` (en + de).
- Paid AI only through `startRun`/`planCall`/`reserve`/`respond`/`settle`. An unknown outcome settles as `null` and is never retried. `store: false`. Tests never call a provider.
- Integration tests need the worktree database: run `node scripts/test-db-for-worktree.ts` once, and again after each migration task. They are run with `pnpm exec vitest run <file>` (env loading per README "Parallel worktrees").
- Delivery: commit per task on `claude/eds-orbit-finanzmodul-2426af`. **No push** (a push to `main` deploys production); pushing needs Mario's explicit approval.

## Review Focus

1. **Mails with inline images.** A receipt mail carries a logo or signature PNG as an inline `cid:` part next to the real PDF. Only the PDF becomes a document; inline parts under 32 KB with `Content-ID` are ignored. Test: Task 11.
2. **The same invoice by two routes.** It arrives by mail and is later uploaded as a re-saved PDF (different bytes, same counterparty and number). It is flagged as a duplicate of the first, not booked twice. Test: Task 13.
3. **Credit notes with negative numbers.** The model returns `total: -50.00` for a credit note. Amounts are normalized to positive with `docType: "credit_note"`, and a positive total on a document marked as a credit note is not doubled into a negative. Test: Task 13.
4. **A rate date without an ECB rate.** A booking on a weekend or holiday uses the last earlier business day and records `rateDate`. A date after the newest stored rate, or more than 7 days without one, fails with `FX_RATE_MISSING` and asks for a manual rate; it never silently uses 1.0. Test: Task 9.
5. **Archiving fails.** The mailbox password changed or the IMAP account may not create folders. The document stays booked or in review, the mail stays in INBOX, `archiveError` is recorded and shown in the mailbox settings, and no endless retry loop runs. Test: Task 2.

---

## Part A — Platform prerequisites (spec §5)

### Task 1: Mailbox owner routing

**Files:**
- Create: `apps/api/src/platform/email/ownership.ts`
- Modify: `apps/api/src/platform/email/inbound.ts:405-418` (enqueue loop)
- Modify: `apps/api/src/modules/support/inboxes.ts` (refuse owned mailbox)
- Modify: `apps/api/src/modules/support/privacy.ts` (erasure scoped to Support inbox connections)
- Test: `apps/api/tests/email-ownership.integration.test.ts`

**Interfaces:**
- Produces:
  - `mailboxOwner(connectionData: Record<string, unknown>): string | null`, which reads `data.ownerModule`
  - `setMailboxOwner(tx: DbTx, scope: Scope, connectionId: string, moduleId: string | null): Promise<void>`, which throws `409 EMAIL_MAILBOX_OWNED` when another module owns it and audits `email.mailbox.owner_set`
  - `assertMailboxUnowned(tx, scope, connectionId, moduleId)`

- [ ] **Step 1: Write the failing tests**
  - `routes owned mail only to its owner`: register the test fixture module as an `emailInbound` consumer, set the owner to `support` on mailbox A, and fetch one message. Exactly one job, with queue class `support_email_inbound`.
  - `broadcasts mail of unowned mailboxes as before`: two consumers, two jobs.
  - `refuses a second owner` → `EMAIL_MAILBOX_OWNED`.
  - `support refuses to bind a mailbox another module owns` → `createInbox` rejects with `EMAIL_MAILBOX_OWNED`.
  - `support erasure leaves other mailboxes' inbound mail`: an inbound row on a mailbox owned by `finance-fixture` from the erased address survives `eraseContact`.
- [ ] **Step 2:** `pnpm exec vitest run apps/api/tests/email-ownership.integration.test.ts`. Expected: FAIL (module not found).
- [ ] **Step 3:** Implement `ownership.ts`. In `fetchMailbox`, read the owner once per mailbox; when it is set, enqueue only to `registeredEmailInbound()` entries whose `owner` matches. In Support, call `assertMailboxUnowned(…, "support")` when binding, and filter erasure to `connectionId ∈` Support inbox connections.
- [ ] **Step 4:** Rerun the test (PASS), then `pnpm exec vitest run apps/api/tests/support-email.integration.test.ts apps/api/tests/support-privacy.integration.test.ts apps/api/tests/email.integration.test.ts` (PASS, unchanged).
- [ ] **Step 5:** Commit `feat(email): route mailbox messages to their owner module`.

### Task 2: IMAP archive after acknowledgement

**Files:**
- Modify: `apps/api/src/platform/email/transport.ts:61-83` (interface) and the real reader near l.300-360
- Create: `apps/api/src/platform/email/archive.ts`
- Modify: `apps/api/src/modules/platform-contributions.ts` (job `email_archive`)
- Modify: `apps/api/tests/module-contributions.test.ts` (queue class list), `apps/worker/tests/queue-dispatch.integration.test.ts` (`QUEUES`)
- Test: `apps/api/tests/email-archive.integration.test.ts`

**Interfaces:**
- Consumes: `mailboxOwner` (Task 1).
- Produces:
  - `MailboxReader.move(state: { uidValidity: string; uid: number }, folder: string): Promise<"moved" | "missing" | "uid_validity_changed">`. Read-write open; it creates the folder if missing and uses `messageMove` by UID.
  - `requestInboundArchive(tx: DbTx, scope: Scope, inboundEmailId: string, folder: string, moduleId: string): Promise<void>`. It throws `403 EMAIL_ARCHIVE_NOT_OWNER` unless `moduleId` owns the mailbox, and enqueues `email_archive` with idempotency key `email-archive:<id>`.
  - Inbound row fields `archivedAt`, `archiveFolder`, `archiveError` (`IMAP_AUTH` | `IMAP_ERROR` | `MISSING` | `UID_VALIDITY_CHANGED`).
  - `archiveError` is also exposed as `lastArchiveError` in `GET /api/projects/:id/email`.

- [ ] **Step 1: Write failing tests** with `setMailFactoriesForTests` and a fake reader that records `move` calls:
  - `moves the message after the owner requests it` → `archivedAt` set, `move` called with folder `Orbit/Processed`
  - `refuses a module that does not own the mailbox`
  - `records a missing message without retrying` → job `done`, `archiveError: "MISSING"`
  - `records an auth failure as permanent` → the reader throws an auth error, the job ends `blocked_dependency`, and `archiveError: "IMAP_AUTH"` (Review Focus 5)
  - `is idempotent` → two requests, one move
- [ ] **Step 2:** Run. FAIL.
- [ ] **Step 3:** Implement. The handler error for auth uses a code matching the worker's permanent pattern (`EMAIL_ARCHIVE_AUTH_REQUIRED`); transient network errors are thrown as retryable. Add `email_archive` to the queue lists in both test files (handler throws `NOT_FOUND`-style error for a missing row).
- [ ] **Step 4:** Run the new test, `apps/api/tests/email-transport.test.ts`, `apps/api/tests/module-contributions.test.ts`, then `pnpm exec vitest run apps/worker/tests/queue-dispatch.integration.test.ts`. PASS.
- [ ] **Step 5:** Commit `feat(email): archive inbound messages on the owner's request`.

### Task 3: File retention lock and XML type

**Files:**
- Create: `packages/db/prisma/migrations/202610230001_platform_finance_prerequisites/migration.sql` (`ALTER TABLE "File" ADD COLUMN "retainUntil" timestamptz`; the `AgentRun_kind_check` widening from Task 4 goes into this file too)
- Modify: `packages/db/prisma/schema.prisma` (`File.retainUntil DateTime?`)
- Modify: `apps/api/src/platform/files/files.ts` (`TYPES`, `EXTENSIONS`, `storeFile` input, `deleteFile`, cleanup)
- Test: `apps/api/tests/files.integration.test.ts` (extend)

**Interfaces:**
- Produces: `storeFile(scope, { moduleId, bytes, mime, name?, retainUntil?: Date })`. `deleteFile` throws `409 FILE_RETAINED` while `retainUntil > now`. `application/xml` is allowed when the bytes start with `<?xml` (after an optional UTF-8 BOM), extension `.xml`. The `fileView` output gains `retainUntil`.

- [ ] **Step 1:** Add the failing tests:
  - `refuses to delete a retained file` → 409 `FILE_RETAINED`, and the file is still readable
  - `deletes after retention ends`
  - `stores xml with a declaration`
  - `refuses xml without a declaration` → 415
- [ ] **Step 2:** Run `node scripts/test-db-for-worktree.ts`, then the test. FAIL.
- [ ] **Step 3:** Implement. `fileCleanup` never purges a retained row.
- [ ] **Step 4:** Rerun the test. PASS.
- [ ] **Step 5:** Commit `feat(files): retention lock and xml originals`.

### Task 4: AI file input, finance task class and run kind

**Files:**
- Modify: `packages/ai/src/providers/anthropic.ts:171-231` (`toAnthropicMessages`)
- Modify: `packages/ai/src/cost.ts` (attachment estimate)
- Modify: `packages/ai/src/routing.ts` (`taskClasses`, `taskRoutesSchema`, `defaultOutputTokens`, `legacyTier`)
- Modify: `packages/ai/src/provider.ts` (start routes next to the support entries)
- Modify: `apps/web/src/components/ai-settings.tsx:~907` (task list, label "Finance extraction")
- Modify: `apps/api/src/platform/ai/telemetry.ts` (`RunKind` + `"finance"`) and the Task 3 migration (`AgentRun_kind_check` includes `'finance'`)
- Test: `packages/ai/src/providers/anthropic.test.ts`, `packages/ai/src/cost.test.ts`, `packages/ai/src/routing.test.ts`

**Interfaces:**
- Produces:
  - **Input format.** Callers pass the OpenAI Responses user message `{ role: "user", content: [{ type: "input_text", text }, { type: "input_file", filename, file_data: "data:application/pdf;base64,…" } | { type: "input_image", image_url: "data:image/png;base64,…" }] }`. OpenAI passes it through unchanged.
  - **Anthropic mapping.** `input_file` (PDF only) → `{ type: "document", source: { type: "base64", media_type: "application/pdf", data } }`, and `input_image` (png/jpeg/webp/gif) → `{ type: "image", source: { type: "base64", media_type, data } }`. Other file types throw `AI_INPUT_UNSUPPORTED`.
  - `attachmentInputTokens(parts: { kind: "pdf"; pages: number } | { kind: "image" }[]): number`, with 3000 tokens per PDF page and 1600 per image.
  - `pdfPageCount(bytes: Uint8Array): number`, which counts `/Type /Page` objects excluding `/Pages`, minimum 1.
  - Task class `"finance_extraction"`: `defaultOutputTokens 4000`, legacy tier as `support_triage`.

- [ ] **Step 1:** Add the failing tests:
  - `maps input_file pdf to a document block`
  - `maps input_image to an image block`
  - `rejects a non-pdf input_file` (`AI_INPUT_UNSUPPORTED`)
  - `estimates 3000 tokens per pdf page and 1600 per image`
  - `counts pdf pages`, with a 2-page fixture string `%PDF-1.4 … /Type /Pages … /Type /Page … /Type /Page`, which counts 2
  - `routes finance_extraction` (the strict schema accepts the key)
- [ ] **Step 2:** `pnpm exec vitest run packages/ai/src`. FAIL.
- [ ] **Step 3:** Implement. Keep text-only behaviour byte-identical; the existing anthropic tests must stay green.
- [ ] **Step 4:** `pnpm exec vitest run packages/ai/src`, then `pnpm exec vitest run apps/api/tests/prompt-snapshot*` (unchanged), and run `node scripts/test-db-for-worktree.ts` for the check widening. PASS.
- [ ] **Step 5:** Commit `feat(ai): pdf and image input, finance extraction route`.

---

## Part B — Module skeleton and schema (spec §3, §4)

### Task 5: Flag, gate, manifest, permissions, settings, registration

**Files:**
- Create: `apps/api/src/modules/finance/{manifest,permissions,gate,settings,contributions}.ts`
- Modify:
  - `apps/api/src/modules/registry.ts:23-27, 62-69`
  - `packages/config/src/index.ts:~139` (`ORBIT_FINANCE`)
  - `.env.example`, `docker-compose.yml`, `scripts/check-coolify-compose.mjs` (each list)
  - `scripts/boundaries.json` (zones)
  - `apps/api/tests/access-matrix.integration.test.ts:~29` (env)
  - `apps/api/tests/module-registry.test.ts`
- Test: `apps/api/tests/finance-module.test.ts`

**Interfaces:**
- Produces:
  - `financeModule: ServerModule`: `id "finance"`, `version "1.0.0"`, `displayName { en: "Finance", de: "Finanzen" }`, `dependsOn: []`, `defaultEnabled: false`, `tables`: every table from Task 6
  - `FINANCE_READ`, `FINANCE_WRITE`, `FINANCE_EXPORT`, `FINANCE_SETTINGS` (constraints above)
  - `financeSwitchedOn()`, `financeActive(tx, scope)`, `requireFinance(tx, scope)`, mirroring `support/gate.ts`
  - `financeSettingsSchema` (zod strict, with the defaults above) plus `readFinanceSettings(tx, scope)` and `writeFinanceSettings(tx, scope, version, patch)` over `readModuleSettings`/`writeModuleSettings`
  - `financeContributions: ModuleContributions`, initially `{ available: financeSwitchedOn }`; later tasks add to it

- [ ] **Step 1:** Write the failing tests:
  - `registers finance with sensitive permissions` (validateRegistry passes, all four permission keys are sensitive)
  - `is unavailable while ORBIT_FINANCE is off`
  - `settings defaults` (parse `{}` → the defaults above)
  - `rejects unknown currency in settings` (`"XYZ"` not in the currency table → error)
- [ ] **Step 2:** Run the test. FAIL.
- [ ] **Step 3:** Implement and wire it into the registry. Add the `ORBIT_FINANCE` flag in the same places as `ORBIT_SUPPORT`.
- [ ] **Step 4:** Run `pnpm exec vitest run apps/api/tests/finance-module.test.ts apps/api/tests/module-registry.test.ts`, then `pnpm test:coolify-compose` and `node scripts/source-check.mjs`. PASS. (The registry "every table owned" test fails until Task 6; it is acceptable to land Tasks 5 and 6 as one commit if it does.)
- [ ] **Step 5:** Commit `feat(finance): module skeleton behind ORBIT_FINANCE`.

### Task 6: Finance schema, migration, integrity triggers

**Files:**
- Create: `packages/db/prisma/migrations/202610230002_finance_core/migration.sql`
- Modify: `packages/db/prisma/schema.prisma` (models)
- Modify: `scripts/db-deploy.ts`, lines 159-201 (grants)
- Modify: `apps/api/tests/rls-matrix.integration.test.ts:25-52` and its seed (~l.340-440)
- Test: `apps/api/tests/finance-integrity.integration.test.ts`

**Interfaces:**
- Produces:
  - **Tables.** Exactly the spec §4 tables plus a per-year number counter:
    - `FinanceAccount`, `FinanceCategory`, `FinanceCostCenter`, `FinanceCounterparty`, `FinanceMailbox`
    - `FinanceDocument`, `FinanceDocumentRevision`
    - `FinanceInvoice`, `FinanceInvoiceLine`, `FinancePayment`, `FinancePaymentAllocation`
    - `FinanceJournalEntry`, `FinanceJournalLine`, `FinanceEntryCounter` (`year int`, `next int`)
    - `FinanceRecurring`, `FinanceFxRate`, `FinanceExport`
  - Enumerated columns are `text` with `CHECK` constraints (values from spec §4).
  - **Grants.**
    - `SELECT, INSERT, UPDATE`, without `DELETE`, on `FinanceJournalEntry`, `FinanceJournalLine`, `FinanceDocument`, `FinanceDocumentRevision`, `FinanceInvoice`, `FinanceInvoiceLine`, `FinancePayment`, `FinancePaymentAllocation`, `FinanceExport`.
    - Full CRUD on the rest.
  - **Triggers.**
    - `finance_line_immutable`: BEFORE UPDATE on lines → exception `FINANCE_POSTED_IMMUTABLE`.
    - `finance_entry_guard`: BEFORE UPDATE on entries, which allows only `reversedById` going from NULL to a value.
    - `finance_entry_balanced`: a DEFERRABLE INITIALLY DEFERRED constraint trigger AFTER INSERT on lines. It checks that the entry has at least two lines and that Σ debit `baseAmountMicros` = Σ credit; otherwise it raises `FINANCE_ENTRY_UNBALANCED`.
  - `FinanceDocument` partial unique index on `(projectId, sha256) WHERE status NOT IN ('rejected','duplicate')`.

- [ ] **Step 1:** Write the failing tests (as `orbit_app`, inside `scoped`):
  - `refuses to update a posted line`
  - `refuses to change a posted entry except reversedById once`
  - `refuses an unbalanced entry at commit`
  - `refuses a single-line entry`
  - `cannot delete journal rows`: `permission denied`
  - `project deletion still removes finance rows`
  - `refuses a second live document with the same hash`
- [ ] **Step 2:** Run `node scripts/test-db-for-worktree.ts`, then the test. FAIL.
- [ ] **Step 3:** Write the migration (header comment as in Support), the Prisma models, the grants and the RLS-matrix seed rows (one per table, both projects).
- [ ] **Step 4:** Run the deploy script again, then the new test and `pnpm exec vitest run apps/api/tests/rls-matrix.integration.test.ts apps/api/tests/module-registry.test.ts`. PASS.
- [ ] **Step 5:** Commit `feat(finance): schema with RLS and ledger integrity triggers`.

---

## Part C — Ledger core (spec §7)

### Task 7: Money

**Files:**
- Create: `apps/api/src/modules/finance/money.ts`
- Test: `apps/api/tests/finance-money.test.ts`

**Interfaces:**
- Produces:
  - `CURRENCY_DECIMALS: Record<string, number>`
  - `isCurrency(code): boolean`
  - `parseAmount(text: string, currency: string): bigint`: accepts `"1234.56"`, `"-50"`, `"1,234.56"` and `"1.234,56"` (decimal separator detected); throws `AMOUNT_INVALID` for more decimals than the currency allows
  - `formatMicros(micros: bigint, currency: string): string`
  - `roundHalfEven(micros: bigint, decimals: number): bigint`
  - `convert(micros: bigint, rate: string, toDecimals: number): bigint`: rate as a decimal string with up to 12 fraction digits; bigint math; half-even
  - `splitByBasisPoints(total: bigint, parts: { key: string; bp: number }[], decimals: number): { key: string; micros: bigint }[]`: largest remainder; the Σ equals the total; throws `ALLOCATION_INVALID` unless Σbp = 10000

- [ ] **Step 1:** Write the tests:
  - `parseAmount("12.345","EUR")` throws
  - `parseAmount("12.345678","USDC") === 12_345_678n`
  - `convert(100_000_000n, "1.085300000000", 2) === 108_530_000n`
  - half-even: `roundHalfEven(2_005_000n, 2) === 2_000_000n` and `roundHalfEven(2_015_000n, 2) === 2_020_000n`
  - a 3-way split of `100_000_000n` with bp `3333/3333/3334` sums exactly to the total
- [ ] **Step 2:** Run the tests. FAIL. **Step 3:** Implement. **Step 4:** Run the tests. PASS.
- [ ] **Step 5:** Commit `feat(finance): currency-aware money helpers`.

### Task 8: Ledger posting, invariants, numbering, reversal

**Files:**
- Create: `apps/api/src/modules/finance/ledger/{accounts,posting,invariants,post,reversal}.ts`
- Test: `apps/api/tests/finance-posting.test.ts` (pure), `apps/api/tests/finance-ledger.integration.test.ts`

**Interfaces:**
- Consumes: `money.ts` (Task 7); rates are passed in, and Task 9 supplies them.
- Produces:
  - `type DraftLine = { accountId; side: "debit"|"credit"; currency; amountMicros: bigint; fxRate: string; rateDate: string; rateSource; baseAmountMicros: bigint; categoryId?; costCenterId? }`
  - `type PostingInput`, a discriminated union on `kind`:
    - `invoice`, `credit_note` and `receipt`, with lines `{ amountMicros; taxMicros; categoryAccountId; categoryId; allocation }[]`, plus `paymentAccountId` for a receipt
    - `payment`, with allocations and `invoiceBase`
    - `contribution`, `withdrawal`, `transfer`
    - `adjustment`, with free lines
  - `postingLines(input: PostingInput, roles: SystemAccounts, rate: Rate, baseDecimals: number): DraftLine[]`: the debit/credit rules of spec §7. Splits use `splitByBasisPoints`. A residual base difference goes to the largest line, else to `rounding`. Payments post an `fx_gain_loss` line for the base difference against the allocated invoices.
  - `assertBalanced(lines: DraftLine[]): void`, which throws `FINANCE_ENTRY_UNBALANCED`
  - `systemAccounts(tx, scope): Promise<SystemAccounts>`, which throws `FINANCE_SETUP_REQUIRED` if a role is missing
  - `postEntry(tx, scope, { kind, entryDate, memo?, documentId?, sourceType?, sourceId?, lines }): Promise<{ id: string; number: string }>`. The number is `YYYY-000001`, gap-free via `FinanceEntryCounter` `UPDATE … RETURNING`. It audits `finance.entry.posted` with `{ kind, lines: n }`.
  - `reverseEntry(tx, scope, entryId: string, reason: string): Promise<{ id; number }>`. It swaps sides and sets `reversedById`; reversing twice throws `409 FINANCE_ALREADY_REVERSED`.

- [ ] **Step 1:** Write the pure tests, one table-driven case per row of spec §7, each asserting accounts, sides and balance:
  - `payable invoice split 60/40 over two cost centers`
  - `EUR invoice paid later at a different rate posts fx_gain_loss`
  - `credit note inverts its invoice`
  - `contribution` and `withdrawal` use the owner equity accounts
  - `USDC receipt uses the peg`
- [ ] **Step 2:** Write the integration tests:
  - `posts and numbers entries per year without gaps under concurrency`: 5 parallel `postEntry` → numbers 1..5
  - `reverses once`
  - `refuses posting before setup`
- [ ] **Step 3:** Run both. FAIL. **Step 4:** Implement. **Step 5:** Run both. PASS.
- [ ] **Step 6:** Commit `feat(finance): double-entry posting core`.

### Task 9: Exchange rates and ECB sync

**Files:**
- Create: `apps/api/src/modules/finance/fx.ts`, `apps/api/src/modules/finance/fx-ecb.ts`
- Modify: `apps/api/src/modules/finance/contributions.ts` (`periodic`)
- Test: `apps/api/tests/finance-fx.test.ts`, `apps/api/tests/finance-fx.integration.test.ts`, fixture `apps/api/tests/fixtures/finance/ecb-hist.xml` (3 days, including a Friday followed by a gap)

**Interfaces:**
- Produces:
  - `type Rate = { rate: string; rateDate: string; source: "ecb"|"manual"|"document"|"peg"|"identity" }`
  - `parseEcbXml(xml: string): { date: string; perEur: Record<string, string> }[]`, a regex parser over `<Cube time=…>` and `<Cube currency=… rate=…/>`. It rejects (`FX_FEED_INVALID`) a document without a single `time` cube.
  - `crossRate(perEur: Record<string,string>, from: string, to: string): string`, 12 fraction digits, with `EUR` = 1
  - `rateFor(tx, scope, from: string, to: string, date: string, override?: Rate): Promise<Rate>`:
    - identity when `from === to`
    - USDC through `usdcPeg` to USD, then ECB
    - looks back at most 7 calendar days, else `FX_RATE_MISSING` (422)
  - `financeFxSync: PeriodicTask`, name `finance-fx-sync`:
    - runs once a day per enabled project with `fxSource === "ecb"`
    - fetches `https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist-90d.xml` through the platform `boundedFetch` with a 10 s timeout and a 2 MB cap
    - upserts `FinanceFxRate` with source `ecb`
    - never throws into the scheduler and stores no status of its own; a stale feed shows up as the attention item `finance_fx_stale` (newest ECB rate older than 4 days, Task 17)
  - `setManualRate(tx, scope, { date, currency, perEur })`, source `manual`

- [ ] **Step 1:** Write the tests:
  - `parses the ecb feed`
  - `cross rate EUR→USD and USD→EUR are inverse within 1e-12`
  - `uses Friday's rate on Sunday` (Review Focus 4)
  - `fails with FX_RATE_MISSING after 7 days without a rate` (Review Focus 4)
  - `fails with FX_RATE_MISSING for a date after the newest rate when the gap exceeds 7 days`
  - `USDC→EUR goes through the USD peg`
  - integration: `sync stores rates from a stubbed fetch and survives a 500`
- [ ] **Step 2:** Run the tests. FAIL. **Step 3:** Implement. **Step 4:** Run the tests. PASS.
- [ ] **Step 5:** Commit `feat(finance): historical exchange rates from the ECB`.

---

## Part D — Master data, intake, extraction, booking (spec §6)

### Task 10: Setup template and master data

**Files:**
- Create: `apps/api/src/modules/finance/{setup,categories,cost-centers,counterparties,accounts,recurring,mailboxes}.ts`
- Modify: `apps/api/src/modules/finance/contributions.ts` (`emailInbound.mailboxUse`)
- Test: `apps/api/tests/finance-master-data.integration.test.ts`

**Interfaces:**
- Consumes: `setMailboxOwner`/`assertMailboxUnowned` (Task 1).
- Produces:
  - `applyFinanceTemplate(tx, scope): Promise<{ created: number }>`. It is idempotent and neutral. Accounts:
    - `1000 Bank` (payment), `1100 Card` (payment), `1200 Wallet` (payment)
    - `1400 Receivables` (receivables), `1600 Payables` (payables)
    - `2000 Owner contributions` (owner_contributions), `2100 Owner draws` (owner_draws)
    - `4000 Revenue` (income), `6000 Expenses` (expense)
    - `6900 FX gains and losses` (fx_gain_loss), `6990 Rounding` (rounding)
    
    Categories: income `Revenue`; expense `Software & SaaS`, `AI services`, `Hosting & infrastructure`, `Marketing`, `Services & contractors`, `Fees & banking`, `Office & other`.
  - CRUD functions `list*`, `create*`, `update*` (version-checked) and `archive*` for accounts, categories, cost centers, counterparties and recurring. Archiving a referenced record keeps it readable; hard delete is only allowed when unreferenced.
  - `normalizeCounterpartyName(name: string): string`: lowercases, strips legal suffixes (`inc`, `llc`, `ltd`, `gmbh`, `ag`, `bv`, `sa`), punctuation and whitespace.
  - `bindMailbox(tx, scope, { emailConnectionId, archiveFolder? })` and `unbindMailbox(tx, scope, id)`, which set and clear the owner `finance`.
  - `financeMailboxUse: MailboxUse`.
  - `monthlyEquivalent(r: FinanceRecurring): bigint` (quarterly ÷ 3, yearly ÷ 12, half-even).

- [ ] **Step 1:** Write the tests:
  - `template is idempotent`
  - `cost center can carry an orbitProjectId of the same workspace only` (another workspace's project → `422 ORBIT_PROJECT_INVALID`)
  - `binding a support mailbox is refused`
  - `unbinding releases ownership`
  - `normalizes "OpenAI, L.L.C." to "openai"`
  - `monthly equivalent of a yearly 120.00 USD is 10.00`
- [ ] **Step 2:** Run the tests. FAIL. **Step 3:** Implement. **Step 4:** Run the tests. PASS.
- [ ] **Step 5:** Commit `feat(finance): setup template and master data`.

### Task 11: Document intake (upload and mail)

**Files:**
- Create: `apps/api/src/modules/finance/intake/{documents,mail}.ts`
- Modify: `apps/api/src/modules/finance/contributions.ts` (`emailInbound.queueClass`, `jobs`)
- Modify: `apps/api/tests/module-contributions.test.ts`, `apps/worker/tests/queue-dispatch.integration.test.ts` (queue classes `finance_mail_receipt`, `finance_extract`)
- Test: `apps/api/tests/finance-intake.integration.test.ts`, fixtures in `apps/api/tests/fixtures/finance/` (`invoice.pdf` minimal valid PDF, `receipt-inline-logo.eml`, `receipt-body-only.eml`)

**Interfaces:**
- Consumes: `storeFile` with `retainUntil` (Task 3), `requestInboundArchive` (Task 2), settings (Task 5).
- Produces:
  - `FINANCE_MAIL_RECEIPT = "finance_mail_receipt"` and `FINANCE_EXTRACT = "finance_extract"`.
  - `ingestDocument(scope, input: { source: "email"|"upload"; bytes: Uint8Array; mime: string; name?: string; mailboxId?: string; inboundEmailId?: string; messageId?: string; emailFileId?: string }): Promise<{ id: string; status: string; duplicateOfId?: string }>`:
    1. Stores the file (`moduleId "finance"`, `retainUntil = now + retentionYears`).
    2. Exact-hash check under the project lock. A match yields status `duplicate` with `duplicateOfId`.
    3. Otherwise status `received`, then enqueue `finance_extract` (when `aiExtraction === "on"`) or set `needs_review` with flag `ai_off`.
    4. Audits `finance.document.received` with `{ source }`.
  - `handleMailReceipt(scope, inboundEmailId: string): Promise<void>`:
    - Ignores rows whose connection has no active `FinanceMailbox`, and deduplicates by `messageId` across `FinanceDocument`.
    - Parses with `postal-mime` and copies the `.eml` into a finance file.
    - Accepted attachments: `application/pdf`, `image/png`, `image/jpeg`, `image/webp`, `application/xml`. Inline parts with `Content-ID` under 32 KB are ignored (Review Focus 1). With no accepted part, the `.eml` itself is the document.
    - When `archiveAfter === "extracted"` and no document needs extraction (all duplicates or `ai_off`), it requests the archive at once. Otherwise the extraction job requests it (Task 12).

- [ ] **Step 1:** Write the tests:
  - `creates one document per accepted attachment and ignores the inline logo` (Review Focus 1)
  - `uses the eml as document when the mail has no attachment`
  - `does not process the same message twice`
  - `marks an identical file as duplicate without enqueuing extraction`
  - `ignores mail of unbound mailboxes`
  - `sets retainUntil ten years ahead`
  - `with aiExtraction off the document waits for review and the mail is archived`
- [ ] **Step 2:** Run the tests. FAIL. **Step 3:** Implement. **Step 4:** Run the tests and the queue-dispatch test. PASS.
- [ ] **Step 5:** Commit `feat(finance): receipt intake from mailbox and upload`.

### Task 12: AI extraction, validation, suggestions, duplicates

**Files:**
- Create: `apps/api/src/modules/finance/extraction/{schema,prompt,extract,validate,suggest}.ts`, `apps/api/src/modules/finance/intake/duplicates.ts`
- Test: `apps/api/tests/finance-extraction.test.ts` (pure), `apps/api/tests/finance-extraction.integration.test.ts` (provider stubbed as in `support-ai.integration.test.ts`)

**Interfaces:**
- Consumes: Task 4 (input parts, `pdfPageCount`, `attachmentInputTokens`, task class `finance_extraction`, run kind `finance`), Task 10 (counterparties, categories). Extraction stores the original currency only; rates are applied at booking (Task 13).
- Produces:
  - `extractionSchema` (zod, `schemaVersion: 1`):
    - `{ docType, direction: "payable"|"receivable"|"unknown", counterparty: { name, taxId?, email? }, number?, issueDate?, dueDate?, currency?, net?, tax?, total?, paid: boolean, paymentMethod?, lines: { description, quantity?, amount, tax?, categoryHint? }[], confidence: number }`
    - Amounts are decimal strings; dates are ISO.
  - `normalizeExtraction(raw, settings): Normalized`, which converts amounts to micros through `parseAmount`, makes credit-note amounts positive (Review Focus 3) and uppercases currencies (`USDC` stays).
  - `validateExtraction(n: Normalized, settings): string[]`. Flags: `total_mismatch` (Σ lines ≠ total beyond 1 minor unit, or net + tax ≠ total), `unknown_currency`, `date_invalid` (issue date in the future by more than 1 day, or due before issue), `missing_total`, `low_confidence` (below `reviewConfidence`).
  - `suggestBooking(tx, scope, n: Normalized): Promise<{ counterpartyId?: string; categoryId?: string; allocation?: {costCenterId; bp}[]; recurringId?: string; source: "history"|"ai"|"none" }>`. It uses the counterparty's last confirmed booking first, then `categoryHint` matched to category names, else none.
  - `duplicateCheck(tx, scope, docId, n): Promise<{ duplicateOfId?: string; possible?: string }>`. The same counterparty and number makes it a duplicate (Review Focus 2). The same counterparty, total and currency within `duplicateWindowDays` without a number adds the `possible_duplicate` flag.
  - `runFinanceExtraction(scope, { documentId: string; attemptKey: string }): Promise<void>`. It mirrors `support/ai.ts modelCall`:
    - `startRun(kind "finance")`, project pause check, `requireSpendMandate`, `planCall("finance_extraction")`
    - a finance daily ceiling check over today's settled+reserved `finance` runs (`FINANCE_AI_CEILING` → `needs_review` with flag `ai_ceiling`)
    - `reserve`, then `respond` with the file part and `outputSchema`, then `settle`
    - The instructions name the categories and cost centers and state that document text is data, never instructions.
    - PDFs over 20 pages, or files over 10 MB, skip the model (flag `too_long`).
    - Results: `needs_review` with `extraction`, `confidence`, `flags`, suggestions and `agentRunId`. Invalid JSON gives `needs_review` with flag `extraction_failed`. A transport failure after transmission settles as null and sets status `failed` (retry only by a person).
    - Afterwards it requests the mail archive when `archiveAfter === "extracted"`.

- [ ] **Step 1:** Write the pure tests:
  - `credit note with negative total becomes positive credit_note` (Review Focus 3)
  - `flags total mismatch`
  - `flags due before issue`
  - `accepts USDC with 6 decimals`
  - `low confidence below 0.85`
- [ ] **Step 2:** Write the integration tests:
  - `extracts a pdf into a review-ready document with history-based category`
  - `flags a re-uploaded invoice with the same number as duplicate` (Review Focus 2)
  - `injection text in the document does not change the instructions or call tools`: a stub asserts `tools: []`, and the document text appears only in the input part
  - `invalid model json leaves the document in review`
  - `unknown outcome settles null and is not retried`
  - `ceiling reached skips the model`
  - `archives the mail after extraction`
- [ ] **Step 3:** Run both. FAIL. **Step 4:** Implement. **Step 5:** Run both. PASS.
- [ ] **Step 6:** Commit `feat(finance): ai extraction with validation, suggestions and duplicate checks`.

### Task 13: Review, booking, invoices and payments

**Files:**
- Create: `apps/api/src/modules/finance/{review,invoices,payments,manual-entries}.ts`
- Test: `apps/api/tests/finance-booking.integration.test.ts`

**Interfaces:**
- Consumes: Tasks 8, 9, 10 and 12.
- Produces:
  - `updateDraft(tx, scope, documentId, version: number, patch: DraftPatch): Promise<DocumentView>`. It is only allowed in `needs_review`/`failed`, writes a `FinanceDocumentRevision` with field-level before/after, and bumps the version (409 `VERSION_CONFLICT`).
  - `bookDocument(tx, scope, documentId, { version, booking: BookingInput }): Promise<{ invoiceId; entryId; paymentId? }>`. `BookingInput` is `{ kind, direction, counterpartyId, number?, issueDate, dueDate?, currency, lines: { description; amountMicros; taxMicros; categoryId; allocation }[], paid?: { accountId; date }, rateOverride?: string }`.
    - It refuses unless the status is `needs_review` and the `possible_duplicate` flag has been cleared.
    - It uses `rateFor` at `issueDate`, `postingLines` and `postEntry`, and posts the payment when `paid` is set.
    - It sets status `booked`, audits `finance.document.booked`, and requests the archive when `archiveAfter === "booked"`.
  - `rejectDocument(…, reason)`, `markNotDuplicate(…)`, `retryExtraction(…)` (enqueues `finance_extract` with a new attempt key).
  - `recordPayment(tx, scope, { direction, accountId, date, currency, amountMicros, reference?, counterpartyId?, allocations: { invoiceId; amountMicros }[] })`. It refuses over-allocation (`422 PAYMENT_OVER_ALLOCATED`) and updates the invoice status `open → partially_paid → paid`.
  - `voidInvoice(…)`, which reverses the posting and refuses invoices with payments.
  - `postManualEntry(tx, scope, { kind: "contribution"|"withdrawal"|"transfer"|"adjustment", … })`.
  - `invoiceStatusView(row, today): "open"|"partially_paid"|"paid"|"void"|"overdue"`.

- [ ] **Step 1:** Write the tests:
  - `books a payable invoice and leaves it open`
  - `books a paid receipt with payment in one go`
  - `a document is booked at most once under concurrency` (two parallel `bookDocument`, one 409)
  - `refuses booking while possible_duplicate is set`
  - `draft edits are versioned with revision history`
  - `partial then full payment updates status and posts fx difference`
  - `overdue is derived from due date`
  - `void reverses the posting`
  - `withdrawal posts to owner draws`
  - `foreign currency on a date without rate needs a manual rate` (`FX_RATE_MISSING`, then success with `rateOverride`)
- [ ] **Step 2:** Run the tests. FAIL. **Step 3:** Implement. **Step 4:** Run the tests. PASS.
- [ ] **Step 5:** Commit `feat(finance): review, booking, invoices and payments`.

---

## Part E — Reports, exports, API (spec §8)

### Task 14: Reports

**Files:**
- Create: `apps/api/src/modules/finance/reports.ts`
- Test: `apps/api/tests/finance-reports.integration.test.ts`

**Interfaces:**
- Produces (all base-currency micros as strings in views):
  - `financeSummary(tx, scope, { from: string; to: string }): Promise<{ baseCurrency; months: { month; incomeMicros; expenseMicros; resultMicros }[]; open: { count; totalMicros }; overdue: { count; totalMicros }; recurringMonthlyMicros; byCostCenter: { id; name; expenseMicros }[]; byCategory: { id; name; months: { month; expenseMicros }[] }[]; reviewCount }>`. Income and expense are posted lines on income/expense accounts by `entryDate`, net of reversals.
  - `costReport(tx, scope, { from; to; groupBy: "month"|"category"|"costCenter"; category?: string; costCenter?: string; kind: "income"|"expense" })`. Category matching includes child categories, and names match case-insensitively by prefix.
  - `yearOverview(tx, scope, year: number)`: categories × months, cost centers, open items at 31 Dec, the document list (id, number, date, counterparty, total, entry number).

- [ ] **Step 1:** Write the tests:
  - `monthly income, expense and result`
  - `reversed entries net to zero`
  - `cost center split counts proportionally`
  - `category filter includes children`
  - `empty period returns zero months, not missing ones`
- [ ] **Step 2:** Run the tests. FAIL. **Step 3:** Implement with grouped SQL through `tx.$queryRaw` (parameterized only). **Step 4:** Run the tests. PASS.
- [ ] **Step 5:** Commit `feat(finance): reports`.

### Task 15: Exports

**Files:**
- Create: `apps/api/src/modules/finance/exports/{exporter,csv,zip,year}.ts`
- Test: `apps/api/tests/finance-exports.test.ts`, `apps/api/tests/finance-exports.integration.test.ts`

**Interfaces:**
- Produces:
  - `type FinanceExporter = { id: string; label: string; build(tx, scope, period): Promise<{ bytes: Uint8Array; mime: string; name: string; rowCount: number }> }`. `financeExporters` holds `journal_csv`, `documents_zip` and `year_overview` (CSV).
  - `csvRow(values: (string|number|null)[]): string`: RFC 4180 quoting, CRLF, UTF-8 BOM on the file; a cell starting with `= + - @ \t \r` is prefixed with `'`.
  - `storedZip(entries: { name: string; bytes: Uint8Array; date: Date }[]): Uint8Array`: ZIP with method 0 (stored), CRC via `zlib.crc32`, sanitized names, unique entry names, and ZIP64 not supported (`EXPORT_TOO_LARGE` over 4 GB or 65535 entries).
  - `createExport(scope, { kind, from, to }): Promise<{ id; fileId }>`: stores the file (`moduleId "finance"`, `retainUntil`) plus the `FinanceExport` row, and audits `finance.export.created` with `{ kind, rowCount }`.
  - Journal CSV columns: `entry_number,entry_date,kind,account_code,account_name,side,currency,amount,fx_rate,rate_date,rate_source,base_currency,base_amount,category,cost_center,counterparty,document_number,document_id,memo`.

- [ ] **Step 1:** Write the tests:
  - `csv escapes quotes, newlines and formula prefixes`
  - `zip opens with unzip -l` (write a temp file in the test temp dir, run `unzip -l`, expect both names), plus `crc matches`
  - integration: `journal csv for a month lists every line once with base amounts`, `documents zip contains originals named <date>_<counterparty>_<number>.<ext>`
- [ ] **Step 2:** Run the tests. FAIL. **Step 3:** Implement. **Step 4:** Run the tests. PASS.
- [ ] **Step 5:** Commit `feat(finance): csv, receipt zip and year exports`.

### Task 16: HTTP routes, OpenAPI, access matrix

**Files:**
- Create: `apps/api/src/modules/finance/routes.ts`
- Modify: `apps/api/src/modules/finance/contributions.ts` (`routes`)
- Modify: `apps/api/tests/fixtures/access-matrix.json` (regenerated, reviewed), `packages/schemas/openapi.json`, `packages/api-client/src/generated.ts` (`pnpm api:generate`)
- Test: `apps/api/tests/finance-routes.integration.test.ts`

**Interfaces:**
- Consumes: Tasks 5 and 10–15.
- Produces:
  - All routes of spec §8 under `BASE = "/api/projects/:projectId/finance"`, through an `inFinance(auth, req, permission, work)` helper identical in shape to Support's `inSupport`.
  - Mapping:
    - `GET` routes → `FINANCE_READ`
    - mutations → `FINANCE_WRITE`
    - `exports` → `FINANCE_EXPORT`
    - `setup`, `mailboxes`, `settings`, `accounts` writes, `fx-rates` POST → `FINANCE_SETTINGS`
  - Upload `POST documents` takes raw bytes with `x-file-type`/`x-file-name` like the platform file route, with a body limit of `FILES_MAX_BYTES`.
  - `GET documents/:id/file?disposition=inline|attachment`. Inline is allowed for PDF and images only, with `Content-Security-Policy: sandbox`, `X-Content-Type-Options: nosniff` and `Cache-Control: private, no-store`.
  - `GET/PUT settings` (version-checked).
  - `POST setup` runs `applyFinanceTemplate`.
  - Responses serialize bigint as decimal strings (`"12345678"`) with the currency alongside.

- [ ] **Step 1:** Write the tests:
  - `viewer gets 403 on finance reads by default`
  - `editor can book but not change mailboxes`
  - `module off returns 404 FINANCE_DISABLED`
  - `other project's document id returns 404`
  - `inline disposition refused for xml`
  - `upload over the size limit returns 413`
  - `bigint amounts serialize as strings`
- [ ] **Step 2:** Run the tests. FAIL. **Step 3:** Implement.
- [ ] **Step 4:** Run the tests (PASS). Then run `UPDATE_ACCESS_MATRIX=1 pnpm exec vitest run apps/api/tests/access-matrix.integration.test.ts`, review the diff (only new `/finance` rows, members `not_found:MODULE_DISABLED`), rerun without the variable (PASS), and run `pnpm api:generate` and review the diff.
- [ ] **Step 5:** Commit `feat(finance): http api`.

---

## Part F — Assistant, attention, notifications (spec §10)

### Task 17: Assistant tools, attention, notifications

**Files:**
- Create: `apps/api/src/modules/finance/{tools,attention,notifications}.ts`
- Modify: `apps/api/src/modules/finance/contributions.ts` (`tools`, `attention`, `userNotifications`)
- Test: `apps/api/tests/finance-tools.integration.test.ts`; check the existing prompt snapshot test stays unchanged

**Interfaces:**
- Consumes: `reports.ts` (Task 14), `invoiceStatusView` (Task 13), `monthlyEquivalent` (Task 10).
- Produces:
  - Tools via `defineTool`: `finance_report`, `finance_open_invoices`, `finance_review_queue`, `finance_recurring`.
    - Common fields: `namespace "finance"`, `risk "R0_read"`, `permission FINANCE_READ`, `exposure { assistant: true, mcp: false }`, strict `parameters` and `outputSchema`.
    - Each checks `financeActive` inside `execute`.
    - Outputs carry base-currency decimal strings, `baseCurrency`, the period, counterparty/category names and invoice numbers, never document text.
  - `finance_report` parameters: `{ period: "this_month"|"last_month"|"this_year"|"last_year"|"last_12_months"|"custom"; from?; to?; groupBy: "total"|"month"|"category"|"costCenter"; kind: "expense"|"income"|"result"; category?; costCenter? }`. Its output includes `monthlyAverage` when `groupBy` is `costCenter` or `category`.
  - Attention kinds:
    - `finance_review_pending` (warning, count, `navKey "finance.review"`, link `/finance/review`)
    - `finance_invoices_overdue` (warning, count, link `/finance/invoices?status=overdue`)
    - `finance_mail_archive_failed` (info)
    - `finance_fx_stale` (info, only with `fxSource "ecb"`)
  - User notification `finance_review_needed` (`emailDefault: false`), sent by `runFinanceExtraction` to editors and owners with `finance.write` once per document.

- [ ] **Step 1:** Write the tests:
  - `answers last month's expenses`
  - `monthly cost of a cost center averages over the period`
  - `AI costs include the category and its children`
  - `lists open and overdue invoices`
  - `review queue counts documents needing review`
  - `tools are not offered to viewers or when the module is off`
  - `tools are not exposed over MCP`
  - `attention counts review and overdue`, `attention reports a stale fx feed`
- [ ] **Step 2:** Run the tests. FAIL. **Step 3:** Implement. **Step 4:** Run the tests and `pnpm exec vitest run apps/api/tests/*prompt*` (snapshot unchanged with finance disabled). PASS.
- [ ] **Step 5:** Commit `feat(finance): assistant read tools and attention`.

---

## Part G — Web (spec §9)

Read `docs/DESIGN_SYSTEM.md` and `apps/web/src/modules/support/` first. Use the existing primitives (`components/ui/primitives.tsx`), `platform/ui/{metric,home-card,collection}.tsx`, `useResource`/`useMutation` from `apps/web/src/lib/api.ts`, and settings sections as in `support/settings.tsx`. Every view has loading, empty and error states; unknown values render as "—"; mobile layout applies at ≤ 760 px.

### Task 18: Web module skeleton, API client, money formatting, settings

**Files:**
- Create: `apps/web/src/modules/finance/{manifest.tsx,api.ts,money.ts,settings.tsx}`
- Modify: `apps/web/src/modules/registry.ts:~225`, `apps/web/src/lib/i18n*` (en/de strings)
- Test: `apps/web/src/modules/finance/money.test.ts`, `apps/web/src/modules/finance/settings.test.tsx`

**Interfaces:**
- Produces:
  - `financeWebModule: WebModule`: `id "finance"`, `optIn: true`. Views `overview`, `review`, `bookings`, `invoices`, `recurring`, `reports`, plus `home`, `attention`, `settings`.
  - Settings sections (group "Finance"):
    - Mailboxes: bind an existing e-mail connection; shows the archive folder and `lastArchiveError`.
    - Accounts & categories, Cost centers.
    - Currencies & FX: base currency, currencies, USDC peg, manual rate.
    - AI extraction: an on/off consent with explanatory text, and the daily ceiling.
  - A setup screen offers "Create default chart of accounts" when `GET setup` reports missing system accounts.
  - `formatMoney(micros: string, currency: string, locale: string): string`, using `Intl.NumberFormat` for ISO codes and `"<amount> USDC"` with 2–6 decimals for USDC.
  - Typed helpers in `api.ts` for every route of Task 16.

- [ ] **Step 1:** Write the tests:
  - `formats USDC with up to six decimals`
  - `formats EUR in de locale`
  - `settings shows AI consent off by default`
  - `mailbox section lists only e-mail connections`
- [ ] **Step 2:** Run `pnpm --filter web exec vitest run src/modules/finance`. FAIL. **Step 3:** Implement. **Step 4:** Run the tests. PASS.
- [ ] **Step 5:** Commit `feat(web): finance module skeleton and settings`.

### Task 19: Charts and overview dashboard

**Files:**
- Create: `apps/web/src/modules/finance/{charts.tsx,overview.tsx,home.tsx}`
- Test: `apps/web/src/modules/finance/charts.test.tsx`, `overview.test.tsx`

**Interfaces:**
- Consumes: `financeSummary` view (Task 14), `formatMoney` (Task 18).
- Produces:
  - `MonthlyBars({ months, currency })`: SVG income/expense bars with a result line; `role="img"`, an `aria-label` summary, and a visually hidden data table. Colors are design tokens only.
  - `RankedBars({ rows, currency })`: horizontal bars for cost centers and categories.
  - `Sparkline({ values })`.
  - Overview layout per spec §9: eyebrow, metrics strip (seven metrics), the 12-month chart, cost centers, category trend, and the unreviewed receipts list (max 10, link to review).
  - The home card is `HomeCard` with count tiles "to review" and "overdue".

- [ ] **Step 1:** Write the tests:
  - `bars scale to the largest value and render zero months`
  - `chart exposes a data table`
  - `overview shows — for unknown values`
  - `overview empty state when no bookings`
- [ ] **Step 2:** Run the tests. FAIL. **Step 3:** Implement. **Step 4:** Run the tests. PASS.
- [ ] **Step 5:** Commit `feat(web): finance dashboard`.

### Task 20: Review queue and document detail

**Files:**
- Create: `apps/web/src/modules/finance/{review.tsx,document.tsx,booking-form.tsx,allocation-editor.tsx}`
- Test: `apps/web/src/modules/finance/booking-form.test.tsx`, `allocation-editor.test.tsx`

**Interfaces:**
- Consumes: document routes (Task 16).
- Produces:
  - The queue is sorted by flag severity, then age, and shows flag badges with i18n text per flag.
  - The detail shows a split view: the original preview (`<iframe sandbox>` for PDF, `<img>` for images, both from `?disposition=inline`; a download link for XML/EML) and the booking form. Form fields: kind, direction, counterparty (select or create), number, dates, currency, lines with category, the allocation editor, "paid" with payment account, and a rate override when the API returns `FX_RATE_MISSING`.
  - Duplicate panel: links to the original, with the actions "Not a duplicate" and "Reject as duplicate".
  - Actions: Save draft (version), Book, Reject (reason), Retry extraction. A 409 shows "changed elsewhere, reload".
  - `AllocationEditor` edits percentages with two decimals → basis points. It blocks submit unless Σ = 100.00 %, with an "Even split" button.

- [ ] **Step 1:** Write the tests:
  - `allocation editor blocks submit until 100 %`
  - `even split of three gives 33.33/33.33/33.34`
  - `booking form asks for a manual rate after FX_RATE_MISSING`
  - `book is disabled while possible_duplicate is unresolved`
- [ ] **Step 2:** Run the tests. FAIL. **Step 3:** Implement. **Step 4:** Run the tests. PASS.
- [ ] **Step 5:** Commit `feat(web): finance review queue and booking form`.

### Task 21: Bookings, invoices, recurring and reports pages

**Files:**
- Create: `apps/web/src/modules/finance/{entries.tsx,entry-detail.tsx,invoices.tsx,payment-form.tsx,recurring.tsx,reports.tsx,manual-entry-form.tsx}`
- Test: `apps/web/src/modules/finance/entries.test.tsx`, `reports.test.tsx`

**Interfaces:**
- Consumes: routes (Task 16), `formatMoney`, charts.
- Produces:
  - **Entries:** filters (period, account, category, cost center, kind, search) in URL search params; detail with lines (original amount, rate, rate date and source, base amount) and the linked original; a "Reverse" action with a reason; a manual entry form (contribution, withdrawal, transfer, adjustment).
  - **Invoices:** filters by direction and status (including overdue); "Record payment" with allocations; "Void".
  - **Recurring:** a CRUD list with monthly equivalent and next due date.
  - **Reports:** the year overview with a print stylesheet (`@media print`) and buttons for the three exports; the export history list with downloads.

- [ ] **Step 1:** Write the tests:
  - `entries filters are reflected in the url`
  - `reverse asks for a reason`
  - `reports offers the three exports`
- [ ] **Step 2:** Run the tests. FAIL. **Step 3:** Implement. **Step 4:** Run the tests. PASS.
- [ ] **Step 5:** Commit `feat(web): finance management pages`.

### Task 22: End-to-end flow

**Files:**
- Create: `e2e/finance.spec.ts` (next to the existing Playwright specs; match their fixtures and seed helpers)

- [ ] **Step 1:** Write the scenario on desktop and mobile:
  1. The owner enables finance and creates the default chart.
  2. Upload `invoice.pdf` with AI off.
  3. The review queue shows it; fill in the form with a 50/50 split; book.
  4. The overview shows the expense and one open invoice.
  5. Record the payment; the invoice is paid.
  6. Export the journal CSV.
- [ ] **Step 2:** `pnpm test:e2e e2e/finance.spec.ts`. PASS.
- [ ] **Step 3:** Commit `test(e2e): finance upload to booking flow`.

---

## Part H — Documentation and final verification (spec §12–15)

### Task 23: Documentation

**Files:**
- Create: `docs/FINANCE.md` (behaviour, data model, booking rules, security and privacy, configuration guide for `payment@eds-labs.io`, manual setup steps, troubleshooting), `docs/adr/0012-finance-module.md` (decisions F-D1–F-D4 and the assumptions)
- Modify: `docs/IMPLEMENTATION_STATUS.md` (new top entry: local, flag off, not deployed), `docs/REQUIREMENTS_TRACEABILITY.md` (finance requirements → tests), `docs/EMAIL_AND_NOTIFICATIONS.md` (owner routing and archive), `docs/PLATFORM_FILES.md` (retention, XML), `docs/MODEL_ROUTING.md` (`finance_extraction`), `docs/MODULE_ACTIVATION.md` (finance row), `.env.example` comment

- [ ] **Step 1:** Write the docs. `docs/FINANCE.md` has a section "Open questions and manual setup" copied and updated from spec §15:
  - IMAP credentials and the folder-create permission
  - base currency and retention confirmation
  - EDS cost centers and categories as data
  - AI consent and ceiling plus the spend mandate
  - DATEV details later
  - production activation runbook: deploy approval, then flag, enable module, setup, bind mailbox, check login, AI consent
- [ ] **Step 2:** `git diff --check` and a reference check (every path named in the docs exists: `node scripts/source-check.mjs`, if it covers docs; otherwise `rg` each path).
- [ ] **Step 3:** Commit `docs(finance): module guide, ADR 0012 and status`.

### Task 24: Full verification and branch review

- [ ] **Step 1:** Run `node scripts/test-db-for-worktree.ts`, then `pnpm lint && pnpm typecheck && pnpm test && pnpm build`. Expected: all pass, except the known baseline failure I7b if it still reproduces on `origin/main` (verify it on the base commit and record it).
- [ ] **Step 2:** Run `pnpm test:e2e`, `pnpm test:coolify-compose` and `node scripts/source-check.mjs` (boundaries, secrets). PASS.
- [ ] **Step 3:** Review the diff against `.agentic/quality-gates/{definition-of-done,review-checklist,security-checklist,data-safety*}.md` and fix the findings.
- [ ] **Step 4:** Ask for one whole-branch review by a fresh reviewer (superpowers:requesting-code-review), then fix and re-verify.
- [ ] **Step 5:** Integrate the current `origin/main` (merge, resolve, re-run Step 1). **Do not push.** Report to Mario in the AGENTS.md closing format and ask for push/deploy approval.
