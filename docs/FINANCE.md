# Finance module

The finance module is a lean, largely AI-assisted income and expense management for one Orbit project. It is first meant for EDS Digital Labs LLC and works for any Orbit project. The design is `docs/superpowers/specs/2026-10-23-finance-module-design.md`, the decisions are in `docs/adr/0012-finance-module.md`, and the plan is `docs/superpowers/plans/2026-10-23-finance-module.md`.

**State (2026-10-23): implemented on the branch `claude/eds-orbit-finanzmodul-2426af` only.** Nothing is pushed, merged or deployed, and `ORBIT_FINANCE` is off everywhere. No production action, migration, mailbox connection or AI call has been made. Every step of "Configuration guide" below is still to do.

## Purpose and scope

In scope (Phase 1):

- receipt intake from a mailbox and by manual upload;
- AI extraction into a draft, always confirmed by a person;
- a double-entry journal with invoices, credit notes, receipts, payments, contributions, withdrawals and transfers;
- several currencies with historical rates;
- categories and cost centers with splits;
- recurring costs;
- an overview, management lists, CSV and receipt exports, a year overview for the tax advisor;
- read-only Orbit Assistant tools.

Not in scope: VAT returns, depreciation, balance sheet closing, payroll, bank/card/wallet sync, uLiquid Desk revenue import, automatic monthly reports and a DATEV file. The code leaves extension points for them (spec §11). This is not a certified accounting system; the tax advisor stays responsible for the books.

## Switching it on

Finance is opt-in twice, like Support:

1. **Installation:** `ORBIT_FINANCE=true`. The default is `false`.
2. **Project:** an owner enables the module in Settings → Modules, which writes an explicit `ProjectModule` row with `enabled = true`. Enabling modules needs `ORBIT_MODULES=true`.

While `ORBIT_FINANCE` is off the module is unavailable: no contribution counts, projects do not list it, owners cannot enable it, and every route answers 404. A project without the enabled row gets 404 `FINANCE_DISABLED` (or `MODULE_DISABLED` while module switching is on). See `docs/MODULE_ACTIVATION.md`.

Intake needs `ORBIT_EMAIL` (mailbox) and `ORBIT_FILES` with a files encryption key (originals). Extraction needs the AI settings of the project (`docs/MODEL_ROUTING.md`).

**Storage quota.** Finance files count against `FILES_PROJECT_QUOTA_BYTES`, which is installation-wide per project (default 100 MB). Originals and `.eml` copies are retention-locked for `retentionYears` (default 10) and cannot be deleted before then, so the quota only grows. Size it before enabling finance: for example 30 mails a month with a 300 KB PDF each (about 0.6 MB per mail with its `.eml` copy) is roughly 220 MB a year, or 2.2 GB over ten years. Exact duplicates are not stored again and exports carry no lock (see "Duplicates" and "Reports and exports"). A full project answers 413 `FILES_QUOTA_EXCEEDED`; a mail whose part fails that way stays in the inbox. With the database file backend every file is in every backup; raise the quota only as `docs/PLATFORM_FILES.md` allows for the backup.

## Concepts

| Concept | Meaning |
|---|---|
| Document | One original: an upload, a mail attachment, or a mail without attachment (kept as the `.eml`). It has a status (`received`, `extracting`, `needs_review`, `booked`, `rejected`, `duplicate`, `failed`), flags and a draft (the extraction JSON). The original is a retention-locked platform file. |
| Invoice | A business transaction: `kind` invoice, credit note or receipt; `direction` payable or receivable. Status `open`, `partially_paid`, `paid` or `void`. Overdue is derived at read time (open or partially paid and due before today). |
| Credit note | A negative invoice. It may name the invoice it credits and then reduces that invoice's open amount. |
| Payment | Money moving through a payment account (outgoing or incoming), allocated to one or more invoices of one counterparty. |
| Journal | The append-only double-entry ledger: entries with at least two lines, numbered `YYYY-000123` per project and year without gaps. |
| Account | A chart-of-accounts entry of type asset, liability, equity, income or expense. Payment accounts (bank, card, wallet) are flagged. Six **system roles** mark the accounts the posting rules need: `payables`, `receivables`, `owner_contributions`, `owner_draws`, `fx_gain_loss`, `rounding`. One live account per role. |
| Category | Income or expense category, optionally nested; it names the income or expense account it posts to. |
| Cost center | A business "project" (for example uLiquid) finance-internal. It may carry an Orbit project as a label; it is no data link. |
| Allocation | A split of a line over cost centers in basis points (sum 10000). One journal line per cost center. |
| Counterparty | A vendor or customer, matched by normalized name, with optional defaults for category and allocation. |
| Recurring cost | An expected subscription or retainer (interval, expected amount, next due date). It feeds the overview's monthly running costs and the assistant. Matching booked invoices to it automatically is not built. |
| FX rate | Units per EUR from the ECB daily reference rates, stored per project, or a manual rate. |

**Money.** Amounts are `bigint` micros (10⁻⁶ of the currency unit); rates are `NUMERIC(24,12)` handled as decimal strings with bigint arithmetic. Currencies and decimals: EUR, USD, GBP, CHF with 2, USDC with 6. Base conversion rounds half-even to the base currency's decimals. Input is parsed per currency: a EUR or USD amount rejects sub-cent input. A lone comma followed by exactly three digits is ambiguous for currencies with more than two decimals ("1,000" in USDC) and is rejected instead of guessed, in the web form and on the server; "1.000" or "1000" are accepted.

**FX.** Every journal line stores the original amount, the rate, its date and source (`ecb`, `manual`, `document`, `peg`, `identity`) and the base amount. The rate is the one of the entry date; weekends and holidays use the newest earlier ECB date within seven days (the used date is recorded). USDC converts through the project's USDC-per-USD peg (`usdcPeg`, default 1.000000) and needs no feed. A missing rate is 422 `FX_RATE_MISSING`; the booking form then asks for a manual rate for that booking. The ECB feed (`eurofxref-hist-90d.xml`, about 90 days, fetched through the SSRF-safe bounded fetch) is refreshed by a daily periodic task per project when `fxSource` is `ecb`. With `fxSource = manual` no request is made and the owner enters rates in Settings.

**Settings** (`ProjectModule.settings`, versioned; owner only to change):

| Key | Default | Meaning |
|---|---|---|
| `baseCurrency` | `USD` | Reporting currency; must be one of `currencies`. Fixed once any journal entry exists (409 `FINANCE_BASE_CURRENCY_LOCKED`). |
| `currencies` | `["USD","EUR","USDC"]` | Currencies a booking may use (1–20). A currency cannot be removed while open invoices, live payment accounts or active recurring items use it (409 `FINANCE_CURRENCY_IN_USE`). |
| `usdcPeg` | `1.000000` | USDC per USD. |
| `fxSource` | `ecb` | `ecb` or `manual`. |
| `aiExtraction` | `off` | `on` is the owner's recorded consent to send documents to the AI provider. |
| `aiDailyCeilingMicros` | `2000000` (USD 2) | Finance extraction spend ceiling per UTC day. |
| `archiveAfter` | `extracted` | When a mail is moved to the archive folder: after extraction, or after booking. |
| `retentionYears` | `10` | Retention lock on originals and `.eml` copies (not exports). |
| `duplicateWindowDays` | `3` | Window for the "same total, no number" duplicate rule. |
| `reviewConfidence` | `0.85` | Extraction confidence below this gets the `low_confidence` flag. |

Defaults for the base currency, the USDC peg, the accrual basis and the retention are **assumptions** (spec §1) that Mario still has to confirm.

**Starting chart.** An owner applies the neutral template once per project (`POST …/finance/setup`, the "Create default chart" screen). It creates eleven accounts (Bank, Card, Wallet, Receivables, Payables, Owner contributions, Owner draws, Revenue, Expenses, FX gains and losses, Rounding) and eight categories (Revenue, Software & SaaS, AI services, Hosting & infrastructure, Marketing, Services & contractors, Fees & banking, Office & other). Codes and names are plain and editable. Re-running adds nothing. `GET …/finance/setup` reports `{ ready, missingRoles }`; booking needs all six system roles.

## Intake

```
mailbox (owner = finance) → platform emailInbound → finance_mail_receipt job ─┐
upload (POST /finance/documents, raw bytes) ──────────────────────────────────┤
                                                                               ▼
                       store original (retention-locked file, sha256)
                       exact copy of a live document?  yes → status duplicate (no AI)
                                                                               ▼
              aiExtraction on → status received → finance_extract job → needs_review / failed
              aiExtraction off → status needs_review (flag ai_off)
                                                                               ▼
                       mail: archive request (archiveAfter) → email_archive job
                       review → book → invoice / payment + posted entries
```

### From a mailbox

An owner binds an e-mail connection to finance (Settings → Finance → Mailboxes). The binding sets `ownerModule = finance` on the connection, so the platform delivers that mailbox's mail **only** to finance; an unowned mailbox still broadcasts to every consumer (`docs/EMAIL_AND_NOTIFICATIONS.md`). Finance refuses a mailbox Support owns and Support refuses one finance owns (409 `EMAIL_MAILBOX_OWNED`). Support inboxes do not record an owner, so finance also refuses a mailbox a live Support inbox answers from, and the default mailbox while live unbound (pre-binding) Support e-mail inboxes route through it (409 `EMAIL_MAILBOX_IN_USE`). Finance takes inbound mail with `ownedOnly`: it gets the mail of mailboxes it owns and never the broadcast of unowned ones, so a Support mailbox creates no finance jobs. Support's contact erasure skips only mail of mailboxes another module owns, so it never deletes finance mail.

The mail job parses the raw `.eml` (`postal-mime`) and creates one document per accepted attachment (PDF, PNG, JPEG, WebP, XML; at most ten per mail). A mail without an attachment becomes one document from its body, stored as the `.eml`. The `.eml` itself is also copied into a retention-locked finance file. Rules:

- Mail of an unbound mailbox, automatic mail and bounces are ignored. An unreadable message is left in the inbox with a `finance.mail.unreadable` audit entry.
- Duplicate mail is detected by Message-ID (fallback: UID validity and UID).
- Inline images are skipped only when they are `image/*` with a Content-ID and smaller than 32 KB (signature logos). Small inline PDFs become documents.
- An accepted-type attachment that fails storage (size, signature) keeps the mail **unarchived** and writes a `finance.mail.attachment_failed` audit entry, so a person sees it in the inbox. Unaccepted MIME types (for example `.exe`, `.zip`) are only audited (`finance.mail.attachment_skipped`) and never block archiving.
- A retry after a partial failure reuses documents already created for that message.

**Archiving.** Orbit never moves mail on its own. After finance is done with a mail it asks the platform to move it into the archive folder (default `Orbit/Processed`): the `email_archive` job opens the INBOX read-write, creates the folder if missing and moves the message, then records `archivedAt` or `archiveError` on the inbound row. "Done" means: the mailbox binding is still active, no document of that message waits for extraction or has failed, no accepted part failed, and with `archiveAfter = booked` no document of the message waits for review either. A vanished message or a changed UID validity is recorded and never retried endlessly; a refused login is permanent; other IMAP errors are retried. A failed archive shows as `lastArchiveError` on the mailbox in Settings and as an attention item for owners. A recorded error is not retried by finance; the platform supports an explicit new attempt, but no finance control for it exists yet (see "Known limitations"). The IMAP account therefore needs permission to create folders and to move mail.

### From an upload

The Review page has an upload control (file picker or drag and drop, several files in sequence, per-file result). Accepted types: PDF, PNG, JPEG, WebP and XML (by type, else by extension). It needs `finance.write` and is hidden for others. The API is `POST /api/projects/:projectId/finance/documents` with the raw bytes (`application/octet-stream`), headers `x-file-type` and `x-file-name`; the limit is `FILES_MAX_BYTES`. Membership, module, permission and content type are checked before a byte of the body is read. An exact copy answers "Already received, marked as duplicate". A non-listed type is refused (`FINANCE_DOCUMENT_TYPE_UNSUPPORTED`).

## AI extraction and safety

Extraction is **off by default**. The owner switches `aiExtraction` on, which is recorded as a consent in the module settings audit (`module.settings_changed`, keys only). It also needs an active spend mandate: today the active project policy (`docs/MODEL_ROUTING.md`); its daily, monthly and per-run limits must cover the finance spend.

What happens per document in `received`:

1. Documents over 10 MB or 20 PDF pages are not sent (flag `too_long`, a person enters them).
2. The call takes the platform's paid path: `startRun` (run kind `finance`), `planCall` with the task class `finance_extraction`, spend mandate, the **finance daily ceiling** (`aiDailyCeilingMicros`, settled plus open finance reservations of the UTC day plus the estimate; over it the document is flagged `ai_ceiling` and left for a person), `reserve`, `respond`, `settle`. The route is the project's saved `finance_extraction` route, else the standard tier (the provider catalogue suggests `claude-sonnet-5-5`, 4,000 output tokens). A model without PDF/image capability is refused before transmission (`AI_INPUT_UNSUPPORTED`).
3. The model gets fixed instructions, the project's category and cost center names behind opaque keys (`c1`, `k2`), and the document as the only user input: a PDF as file input, an image as image input, XML or a mail body as bounded text between per-call markers. **No tools.** The OpenAI call uses `store: false`.
4. The answer is parsed against a strict zod schema and checked deterministically (`validate.ts`): amounts through `parseAmount`, real calendar dates, line sums against totals, known currency. Findings become fixed flag codes: `total_mismatch`, `unknown_currency`, `date_invalid`, `missing_total`, `low_confidence`, `possible_duplicate`, `ai_off`, `ai_ceiling`, `too_long`, `extraction_failed`.
5. A counterparty is matched and a category and cost-center split suggested from the history of confirmed bookings first, the AI suggestion second.
6. The document ends in `needs_review` (or `failed`, with a Retry button). **The AI never books.** Reviewers get one notification (`finance_review_needed`).

**Documents that arrived while AI was off.** With the consent off, intake puts a document straight into `needs_review` with the flag `ai_off`; it is not sent anywhere. Such documents (and those stopped by the daily ceiling or by an unusable answer) get their extraction later:

- **Automatically**, when the owner switches `aiExtraction` from off to on: documents in review with `ai_off`, unedited and received in the last 30 days, are queued (at most 50, newest first, audited as `finance.extraction.backlog_queued`). Nothing is queued while the project has no active policy. The daily ceiling still bounds the spend.
- **By a person** with **Run AI extraction** on the document (`POST …/documents/:id/retry`, `finance.write`), or over MCP with an owner-approved `finance_retry_extraction`. A start needs the consent (`FINANCE_AI_OFF`) and an active policy (`POLICY_REQUIRED`); it is refused for a hand-edited draft (`FINANCE_DRAFT_EDITED`, a new answer would overwrite it), a finished extraction (`FINANCE_EXTRACTION_DONE`), a too-long document (`FINANCE_DOCUMENT_TOO_LONG`) and a running job (`FINANCE_EXTRACTION_RUNNING`). Each start is a new attempt (`finance-extract:<id>:<n>`), so a document is never extracted twice at once.

**Processing status.** The reason an extraction stopped is kept on the document as a fixed code (`extraction.processing`: `lastErrorCode`, `lastErrorAt`, `agentRunId`) and cleared by the next good answer. `GET …/documents/:id/processing` returns the state, the current job, the last error and whether (or why not) a start is possible; `GET …/processing-errors` lists documents without a usable AI result. The review page shows the reason and the button.

**Untrusted documents.** The instructions state that everything in the user message is data; instructions inside a document are ignored. Because the model has no tools and its output is validated data, a hostile document can at most produce a wrong draft that a person reviews. Document content never reaches the assistant's context as instructions.

**Outcomes.** An unknown outcome (transport error after sending, missing usage) settles the reservation as unknown and is never retried automatically; the document becomes `failed` (`FINANCE_CALL_UNKNOWN`) and a person decides. A provider refusal with a 4xx status is not billed (`FINANCE_CALL_NOT_ACCEPTED`). Invalid output is billed and ends in `needs_review` with `extraction_failed` (`FINANCE_OUTPUT_NOT_VALID`). A retry uses a new idempotency key and, like any start, needs the AI consent and an active policy. If the AI route is saved during a run, the run stops before the call (`FINANCE_ROUTE_CHANGED`). A paused project does not extract.

`store: false` is not zero data retention; the provider's retention terms apply (see `docs/MODEL_ROUTING.md`). Only the document, the project's category and cost center names and fixed instructions are sent.

## Duplicates

1. **Exact:** the same SHA-256 as a live document in the project. The new document becomes `duplicate`, points at the original and is never extracted (no AI cost). Rejected and duplicate documents keep their hash and do not count as originals. Bytes the project already holds as a document (any status) are hashed in memory before storing and **not stored again**: the new row shares the earlier document's retained file, so duplicates cost no quota. Only two first copies racing each other can store the same bytes twice.
2. **Same counterparty and invoice number** (including numbers on booked invoices): `duplicate` linked to the original.
3. **Same counterparty, total and currency within `duplicateWindowDays` without a number:** flag `possible_duplicate`. A person must decide with "Not a duplicate" or reject it.

Editing the number or counterparty of a draft re-runs the check.

## Booking rules

A person reviews the draft in the Review page (original preview, editable fields, line splits, duplicate hint) and clicks **Book**. The booking checks the document `version` (409 `VERSION_CONFLICT`: someone else changed it, reload) and runs in the project lock, so a document is booked at most once. Postings (`ledger/posting.ts`, pure functions; the balance is checked before insert and again by the database):

| Transaction | Debit | Credit |
|---|---|---|
| Payable invoice | expense account per line category, one line per cost center | payables |
| Receivable invoice | receivables | income account per line |
| Credit note | the inverse of the invoice it credits | |
| Receipt (already paid) | expense | chosen payment account |
| Outgoing payment | payables | payment account |
| Incoming payment | payment account | receivables |
| Refund of a credit note | settles in the opposite direction | |
| Contribution | payment account | owner contributions |
| Withdrawal | owner draws | payment account |
| Transfer | target payment account | source payment account |
| Adjustment | free lines, must balance in their currency | |

As built:

- An invoice or credit note booked with `paid` posts its payment as a second entry at the payment date's rate. A receipt posts against the payment account at once and records its payment on the same entry.
- A payment settles invoices in their own currency, of one counterparty (422 `PAYMENT_MIXED_COUNTERPARTIES`), with the whole amount allocated (422 `PAYMENT_OVER_ALLOCATED` otherwise). The open base of an invoice is its posted base minus the base already settled, so the payment that clears an invoice leaves the open-item account at zero in base; the difference to the base the payment account moves is posted to `fx_gain_loss`.
- Rounding differences of a split go to the largest line; a residue that cannot be absorbed goes to the `rounding` account. An unbalanced adjustment is refused (422 `FINANCE_ENTRY_UNBALANCED`), never silently balanced.
- Archived accounts, categories and cost centers are refused (409 `FINANCE_ACCOUNT_ARCHIVED`); only reversals may touch archived accounts.
- Accrual basis: income and expense by document date.
- Status follows the allocations and credits (`open → partially_paid → paid`, and back after a void).

## Corrections

Posted entries are never edited or deleted. Corrections are new entries:

| Action | Effect |
|---|---|
| **Reverse a manual entry** (`POST entries/:id/reverse`) | A `reversal` entry with swapped sides, same amounts and rates; the reason is its memo. Only for manual entries; invoice and payment entries are corrected through their void endpoints. A reversal cannot be reversed again. |
| **Void a payment** (`POST payments/:id/void`) | Reverses the payment entry, marks the payment voided, and recomputes the status of every invoice it settled. A receipt's own payment is voided only with the receipt. |
| **Void an invoice** (`POST invoices/:id/void`) | Reverses its posting (dated today, or the issue date when later). A receipt's payment goes with it. Refused while a live payment is allocated (409 `FINANCE_INVOICE_HAS_PAYMENTS`) or a live credit note credits it (409 `FINANCE_INVOICE_CREDITED`). The invoice's **document returns to `needs_review`**, so it can be corrected and booked again. A voided credit note gives its invoice's open amount back. |
| **Credit-note settlement** | A credit note with `creditsInvoiceId` reduces the credited invoice's open amount and open base (derived, no allocation rows). When credits close an invoice and a base-currency residue remains (credits posted at other rates), a base-currency adjustment between the open-item account and `fx_gain_loss` zeroes it (source `invoice_close`) and the credit note counts as settled. Reopening the invoice reverses that closing entry. |

Reasons are stored on the reversal only and never in the audit trail. A draft a person edited is never sent to the AI again (`FINANCE_DRAFT_EDITED`); finish it by hand.

## Reports and exports

**Overview and reports** (`finance.read`): income, expenses and result per month, open and overdue totals, recurring monthly equivalent, cost per cost center and per category, and the review count. A standalone credit note (one that credits no invoice) is an **open credit**: never listed as an open invoice and never overdue, reported apart (`creditsOpen` in the summary and the year overview, `credits` in `finance_open_invoices`) and subtracted from the open, payable and receivable totals. All in the base currency; unknown values show "—". Charts are small accessible SVG components with table fallbacks.

**Exports** (`finance.export`, rate-limited to 10 per minute) are built from posted data, stored as a file with a `FinanceExport` row, and downloaded through the finance export route. Exports are derived and can be rebuilt, so they carry **no** retention lock:

| Export | Content |
|---|---|
| `journal_csv` | One row per posted line of the entries dated in the period. Columns: `entry_number`, `entry_date`, `kind`, `account_code`, `account_name`, `side`, `currency`, `amount`, `fx_rate`, `rate_date`, `rate_source`, `base_currency`, `base_amount`, `category`, `cost_center`, `counterparty`, `document_number`, `document_id`, `memo`. UTF-8 with BOM, RFC 4180 quoting, CRLF. |
| `documents_zip` | The originals of documents booked with an issue date in the period, plus documents still in review in a `pending/` folder, and an `index.csv`. Originals of void invoices stay out (they remain in storage; a reopened document is re-booked). A stored (uncompressed) ZIP written in-repo. |
| `year_overview` | The tax advisor's overview for exactly one calendar year (`from` 1 January, `to` 31 December, else 422 `EXPORT_PERIOD_INVALID`) as one CSV of titled sections: category by month, cost centers, open items **at 31 December** (not as of today), and booked documents. |

**CSV formula guard.** Every text cell that starts with `=`, `+`, `-`, `@`, tab or CR gets a leading `'`. Cells that are plain system-produced decimals (`^-?\d+(\.\d+)?$`) pass through unchanged, so negative credit-note and reversal amounts stay numeric for the advisor.

**Size.** The export file is a platform file, so it is bounded by `FILES_MAX_BYTES` (default 20 MB, at most 50 MB) and the ZIP sources by 200 MB uncompressed. Over that the export answers 413 `EXPORT_TOO_LARGE` ("export a shorter period"); the check runs before any original is read.

## Assistant tools

Four read-only tools (`R0_read`, `finance.read`, `exposure: { assistant: true, mcp: false }`, deferred loading), registered through the module contribution, so they exist only where finance is active and the member has the permission:

| Tool | Answers |
|---|---|
| `finance_report` | Income, expenses or result of a period (`this_month`, `last_month`, `this_year`, `last_year`, `last_12_months`, `custom`), grouped by total, month, category or cost center, filtered by category or cost center name prefix (children included), with the monthly average and the names the filter matched. |
| `finance_open_invoices` | Open payable and receivable invoices: totals and the 25 earliest due, plus open credits (`credits`), which reduce the totals. |
| `finance_review_queue` | How many documents need review or failed, and the 20 oldest with received date, flags and extracted counterparty name. |
| `finance_recurring` | Active recurring costs: each with its interval, its expected amount **in its own currency** (`currency` next to it) and `monthlyBase`, the monthly equivalent in the base currency; plus the monthly total and a `missingRate` count of items that could not be converted (their `monthlyBase` is null). |

**Never returned:** document text, file names, e-mail content, ids of files, amounts of the books in other currencies than the base. Money is a decimal string in base-currency units next to `baseCurrency` and the period; the one exception is `finance_recurring`, whose `expectedAmount` is in the item's own currency (with `currency`), next to the base-currency `monthlyBase`. Names and numbers can come from documents, so they are control-character-stripped, clipped and labelled untrusted in the tool description. These assistant tools are not exposed to MCP; outside clients use the separate tools under [MCP](#mcp). A delegated MCP work order (MCP 2.0 task) reaches them only with `orbit:finance.read` (their `mcpScopes`), and creating a task with the `finance` module without that scope is refused (`MCP_FINANCE_CONSENT_REQUIRED`).

## MCP

Outside clients (ChatGPT, Claude and other MCP clients) get four reads and one proposal through Orbit's MCP gateway (`apps/api/src/modules/finance/mcp-tools.ts`). They are MCP-only (`exposure: { assistant: false, mcp: true }`), owned by the finance module and listed only where `ORBIT_FINANCE` is on, finance is enabled in the project, the member's (module) role has the permission, `ORBIT_MCP_TASKS=true` (like the other module MCP tools) and the token carries the scopes. Each tool needs an explicit `projectId`.

| Tool | Risk / permission | Scopes | Returns |
|---|---|---|---|
| `finance_list_documents` | `R0_read`, `finance.read` | `orbit:read` + `orbit:finance.read` | Documents newest first, optional `status`, `limit` 1–50 (default 20), opaque `cursor`/`nextCursor`: id, status, docType, source, flags (known `^[a-z_]{1,40}$` codes only), confidence, `counterpartyName` (clipped to 60), `number` (clipped to 40), issueDate, `total` (decimal string), currency, receivedAt, updatedAt. |
| `finance_get_document` | `R0_read`, `finance.read` | `orbit:read` + `orbit:finance.read` | The fields above plus `extraction` (net, tax, total as decimal strings with currency; issue and due date; lines with clipped description, amount and tax; the booking suggestion: counterpartyId, categoryId, cost-center allocation, source), `duplicate` (duplicateOfId, possibleDuplicateOfId) and `invoiceIds`. |
| `finance_get_processing_status` | `R0_read`, `finance.read` | `orbit:read` + `orbit:finance.read` | `processingStatus`: status, flags, attempt, extracted, last failure as a fixed code, the current job, `canStartExtraction` and `blockedBy`. |
| `finance_list_processing_errors` | `R0_read`, `finance.read` | `orbit:read` + `orbit:finance.read` | `listProcessingErrors`, `limit` 1–50 (default 20). |
| `finance_retry_extraction` | `P_proposal`, `finance.write` | `orbit:propose` + `orbit:finance.extract` | A proposal receipt (`actionRequestId`, `status`, `deduplicated`, `approveUrl`). |

Every read answers `{ "available": false }` when finance is off for the project. Amounts are decimal strings in the document's currency (six decimals for a currency Orbit does not know).

**Scopes.** `orbit:finance.read` and `orbit:finance.extract` are explicit and unchecked on the consent screen, like `orbit:support`. Every scope a tool lists in `mcpScopes` is required (all-of), on top of its risk scope. Unlike Support, finance tools are not shown to discovery without their scope: a client must ask for `orbit:finance.read` (and `orbit:finance.extract` for the retry) when it connects. **Old grants gain no new scope**: reconnect and tick the scope in Orbit. `orbit:support` never stands in for a finance scope, and the finance scopes alone do not make a token usable (it still needs a risk scope).

**Approval flow of the retry.** The call stores a pending `finance.mcp.finance_retry_extraction` ActionRequest (owner decides, 24-hour TTL, `idempotencyKey` retries return the same request) and starts nothing. It is refused at once with the block code of `extractionBlock` (for example `FINANCE_AI_OFF`, `FINANCE_DRAFT_EDITED`, `FINANCE_EXTRACTION_RUNNING`, `FINANCE_EXTRACTION_DONE`). When an owner approves it in Orbit, the block is checked again with the current AI consent and a refusal carries its code; otherwise `startExtractionFor(…, "mcp")` queues the job `finance-extract:<id>:<n>` (audited with trigger `mcp`). The extraction then takes the normal paid path (spend mandate, finance daily ceiling, reservation, settlement). The request's cost ceiling is the project's `aiDailyCeilingMicros`, which bounds one extraction; a changed ceiling makes the approval fail with `COST_CEILING_CHANGED`. The approval card's summary is the document id only. Proposals need `ORBIT_MCP_PROPOSALS=true` and an active policy, like every MCP proposal, and an approval needs the proposing grant to still hold `orbit:propose` and `orbit:finance.extract`.

**Never returned:** file bytes, file ids, file names, e-mail metadata and bodies (sender, recipients, message ids), tax ids, rejection reasons, raw model output, raw job error messages (a job error is shown as a fixed code or `JOB_FAILED`). Counterparty names, numbers and line descriptions come from documents: control and format characters are removed, whitespace is collapsed, length is capped, and tool descriptions label them untrusted data. They are not screened, so an e-mail address or IBAN printed on an invoice can appear in them.

## Attention items and notifications

Attention items are computed at read time and carry counts only:

| Item | Shown to | Condition |
|---|---|---|
| `finance_review_pending` | `finance.read` | Documents in `needs_review` or `failed`. |
| `finance_invoices_overdue` | `finance.read` | Open or partially paid invoices due before today. |
| `finance_mail_archive_failed` | `finance.settings` (owner) | Active mailbox bindings with a `lastArchiveError`. Opens Settings → Finance mailboxes (`/settings?section=finance-mailboxes`). |
| `finance_fx_stale` | `finance.read` | `fxSource = ecb`, a configured pair needs ECB rates (USD and USDC alone do not), and the newest ECB date is older than four days or missing. Opens `/settings?section=finance-currencies`. |

Overdue counts never include credit notes. The two settings items badge the platform's settings entry (`navKey: "settings"`).

The member notification `finance_review_needed` ("A receipt needs review", no amounts, names or document words) goes once to the reviewers (owners and editors of the module; module roles apply) when a document reaches `needs_review` or `failed` after extraction, and when a **mailed** document skips AI (`ai_off`). Uploads do not notify; the uploader is the reviewer. E-mail delivery of the notice is off by default.

## Permissions

All four are `sensitive: true`; viewers have no finance access by default and module roles can narrow further. The web shell hides finance completely (navigation, home card, settings sections) from members whose module access is `viewer` (`minAccess: "editor"` in the web manifest); a deep link shows a "No access" notice instead of 403 errors. Finance files are private to finance's routes (`files.privateToModule`): the platform `/files/:fileId` routes answer 404 for them, and no member uploads into finance through the platform route.

| Permission | Default roles | Allows |
|---|---|---|
| `finance.read` | owner, editor | Overview, lists, documents and originals, entries, invoices, summary, settings (read), setup status, assistant tools. |
| `finance.write` | owner, editor | Upload, edit drafts, book, reject, not-duplicate, retry, manual entries, reversals, payments, voids, categories, cost centers, counterparties, recurring costs. |
| `finance.export` | owner, editor | Create, list and download exports. |
| `finance.settings` | owner | Settings (currencies, base currency, FX source, AI consent and ceiling, archive rule), applying the default chart, **accounts**, **mailbox bindings** (including the list of mailboxes) and manual FX rates. |

Every mutation writes a content-free audit event (`finance.document.booked`, `finance.mailbox.bound`, …: ids, counts and field names only).

## Data model

Seventeen project tables (migration `202610230002_finance_core`), all with `workspaceId`/`projectId`, `@@unique([projectId, id])`, a cascading project foreign key, composite `("projectId", id)` row foreign keys, and ENABLE + FORCE RLS `project_scope`:

`FinanceAccount`, `FinanceCategory`, `FinanceCostCenter`, `FinanceCounterparty`, `FinanceMailbox`, `FinanceDocument`, `FinanceDocumentRevision`, `FinanceInvoice`, `FinanceInvoiceLine`, `FinancePayment`, `FinancePaymentAllocation`, `FinanceJournalEntry`, `FinanceJournalLine`, `FinanceEntryCounter`, `FinanceRecurring`, `FinanceFxRate`, `FinanceExport`.

The migration `202610230001_platform_finance_prerequisites` adds `File.retainUntil` and widens `AgentRun_kind_check` with `finance`. Both are additive. The connection's `ownerModule` and the archive fields on inbound rows live in existing JSON data and need no migration.

**Integrity is enforced by the database**, not only by code (`finance-integrity.integration.test.ts`):

- `orbit_app` has **no DELETE** on journal entries and lines, the entry counter, documents, revisions, invoices, invoice lines, payments, allocations and exports (`scripts/db-deploy.ts`). Project deletion still cascades through the foreign keys, which use NO ACTION between these tables so a cascade never updates a posted row.
- A trigger rejects any UPDATE of a journal line. An entry may change only once, to record `reversedById` (which must point at an entry whose `reversalOfId` is this entry).
- Lines can be inserted only for an entry created in the same transaction; a later transaction cannot append a balanced pair to a posted entry.
- A deferred constraint trigger checks at commit that every new entry has at least two lines and that its base-currency debits equal its credits.
- One live account per system role; one live document per content hash.
- Originals and the `.eml` copies carry `retainUntil` (now plus `retentionYears`); rejected originals keep theirs. Exports carry none. `deleteFile` answers 409 `FILE_RETAINED` until then, whoever calls it, including Support's privacy erasure (only finance sets `retainUntil`, so Support files are unaffected). A legal erasure request on finance originals would need an owner-level override later.

## Security, privacy and operations

- Finance data and originals stay in the project's RLS scope. Files are AES-256-GCM encrypted at rest. Downloads are attachments with `nosniff`; only PDF and PNG/JPEG/WebP are allowed inline, under the sandboxing CSP (no weakening).
- **Logging:** no amounts, names or document text in logs or audit metadata. Audit events carry ids, counts and field names. Reversal reasons are stored on the entry only. Notifications and attention items are generic.
- **AI:** off by default; owner consent recorded; spend mandate, per-call reservation and the daily ceiling; no tools; `store: false`; untrusted-document handling as above.
- **Kill switches:** `ORBIT_FINANCE=false` (installation), disable the module (per project), `aiExtraction = off` (AI only), unbind the mailbox (intake only). Nothing is deleted by any of them.
- **Backups:** originals and journal are part of the database backup with the default `FILES_BACKEND=database`; without `FILES_ENCRYPTION_KEY` they cannot be read, backups included (`docs/PLATFORM_FILES.md`).
- **Boundaries:** zones `module:finance` and `web-module:finance` in `scripts/boundaries.json`; finance imports only platform code and `packages/*`; no baseline exceptions.
- **API:** all routes under `/api/projects/:projectId/finance`; the OpenAPI document and client are regenerated (`pnpm api:generate`); the access matrix has reviewed finance rows.

## Configuration guide: `payment@eds-labs.io`

Owner runbook for the first production activation. **None of these steps has been performed.** Each step needs its own approval; pushing to `main` deploys production, including the migrations. Do not enter credentials into chat, documents or the repository; the owner types them into Orbit.

1. **Approve the production deploy.** Mario approves pushing the branch to `main` (auto-deploy through Coolify). The deploy runs the migrations `202610230001_platform_finance_prerequisites` and `202610230002_finance_core` (additive; new tables, a nullable file column, a widened check). Take a database backup first and note its restore point. With `ORBIT_FINANCE=false` the module stays unreachable.
2. **Set the flags.** In Coolify set `ORBIT_FINANCE=true` and redeploy. Confirm the others are already on: `ORBIT_EMAIL=true`, `ORBIT_FILES=true` with `FILES_ENCRYPTION_KEY` present (generated by Coolify; keep a copy), and `ORBIT_MODULES=true` (on in production since 18.10; finance needs the explicit per-project row it writes). For real mail, `EXECUTION_MODE=live` and `ENABLE_EXTERNAL_WRITES=true` apply as for Support.
3. **Choose the finance project and enable the module.** Create or pick the Orbit project (for example "EDS Labs Finance"). As owner open Settings → Modules and enable **Finance**.
4. **Create the default chart.** Open Finance; the setup screen offers "Create default chart". It is idempotent. Rename accounts and categories if wanted.
5. **Set currencies and FX.** Settings → Finance → Currencies & FX: confirm the base currency (default USD), the currencies (USD, EUR, USDC), the USDC peg and the FX source (`ecb`, or `manual` if no feed is wanted). With `ecb` the first sync runs within a day; booking in EUR before that needs a manual rate.
6. **Add the mailbox connection.** In the project sidebar open **Connectors** (German: Verbindungen), find the **E-mail mailboxes** section and use **Add mailbox** for `payment@eds-labs.io`: IMAP and SMTP host, port and TLS mode, user name, and an app password. The owner enters the password; it is encrypted and never shown again. Run **Check login**; the connection must become `read_verified`. Hosts must be public DNS names.
7. **Bind the mailbox.** Settings → Finance → Mailboxes: bind the connection and set the archive folder (default `Orbit/Processed`). The IMAP account needs permission to **create folders and move messages**; otherwise the archive fails and shows as `lastArchiveError`. From now on that mailbox's mail goes to finance only (not to Support). Choose `archiveAfter` (after extraction, or after booking).
8. **Add cost centers and categories as data.** Settings → Finance: cost centers uLiquid, FamilyPlan, EDS Orbit and General; add or adjust categories (the template has eight). These are data, not code.
9. **Optional: AI extraction.** Check that the active policy's spend mandate (window, daily, monthly and per-run limits) covers the finance spend, and that a `finance_extraction` route is saved or the standard tier is acceptable (Settings → AI). Then Settings → Finance → AI extraction: switch on (this is the consent) and set the daily ceiling (default USD 2). Without it every document goes straight to review.
10. **Verify.** Send a test mail with a PDF receipt to `payment@eds-labs.io` and upload one document. Expect: the mail appears as a document within about two minutes (the fetch interval), appears in the review queue, can be booked, and (with archive on) the mail moves into the archive folder. Check the overview, then export a journal CSV. Do not call AI as a smoke test beyond one approved document.
11. **Rollback.** Unbind the mailbox first (otherwise its mail is held by a module that is off), then disable the module for the project, or set `ORBIT_FINANCE=false` and redeploy. AI only: set `aiExtraction = off`. Data stays; the migrations are additive, so reverting the code leaves no broken state. Finance rows cannot be deleted by the application role; removing them needs a deliberate database action with approval.

## Testing

Run with Node 24; integration tests need the worktree's own database (`node scripts/test-db-for-worktree.ts`, see the README, "Parallel worktrees").

| Level | Command |
|---|---|
| Unit | `node --env-file=.runtime/local.env ./node_modules/vitest/vitest.mjs run apps/api/tests/finance-money.test.ts apps/api/tests/finance-posting.test.ts apps/api/tests/finance-fx.test.ts apps/api/tests/finance-extraction.test.ts apps/api/tests/finance-exports.test.ts apps/api/tests/finance-module.test.ts` |
| Integration | the same runner on `apps/api/tests/finance-*.integration.test.ts` (ledger, booking, intake, extraction with a stubbed provider, fx, reports, exports, routes, master data, tools, integrity) plus the safety nets `rls-matrix.integration.test.ts`, `access-matrix.integration.test.ts` and `apps/worker/tests/queue-dispatch.integration.test.ts` |
| Web | `vitest run apps/web/src` (finance component tests under `apps/web/src/modules/finance/`) |
| Browser | `apps/web/tests/finance.spec.ts` (upload, review, book, overview, FX override, version conflict, mobile) |
| Repo | `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm api:generate`, `pnpm test:coolify-compose`, `node scripts/source-check.mjs` |

No test calls a paid provider.

**Running the browser spec locally.**

1. Create and migrate a dedicated database (local `127.0.0.1:55432` only), for example `orbit_test_e2e_<name>`, with `scripts/db-deploy.ts`; point `DATABASE_URL`, `AUTH_DATABASE_URL` and `MIGRATION_DATABASE_URL` at it; then `node --import tsx scripts/seed-e2e.ts` (writes `.runtime/e2e-user.json`).
2. Environment for API and web: `ORBIT_FINANCE=true ORBIT_FILES=true ORBIT_MODULES=true FILES_BACKEND=database`, a throwaway `FILES_ENCRYPTION_KEY` (64 hex characters), `APP_ORIGIN=http://localhost:4410`, `PORT=4411`, `ORBIT_API_ORIGIN=http://127.0.0.1:4411`. Leave `aiExtraction` off. No worker is needed.
3. Start `node --import tsx apps/api/src/main.ts` and, in `apps/web`, `next dev --hostname 127.0.0.1 --port 4410`.
4. Run `E2E_FINANCE=1 PLAYWRIGHT_BASE_URL=http://localhost:4410 ./node_modules/.bin/playwright test apps/web/tests/finance.spec.ts`. Without `E2E_FINANCE=1` the spec is skipped. The spec sets the FX source to manual, so no ECB request is made.

## Incident 2026-10-24: invoices not read by the AI

Three documents reached the EDS-Labs project on 24 October (09:54 and 15:35 UTC) while `aiExtraction` was still off; the owner switched it on at 15:36 UTC. Intake had marked them `ai_off` and nothing could start their extraction afterwards: switching AI on did not pick them up, and Retry refused documents in review. In addition the project had no active policy, so every paid call would have stopped at `POLICY_REQUIRED`. Fixed by the backlog on consent, the manual start for documents without an AI result, the upfront policy check and the recorded processing errors (above). To read the three documents: activate a policy with a spending mandate in EDS-Labs, then use **Run AI extraction** on each.

## Known limitations

- **Partial credit at very different rates:** a partial credit note posted at a rate far from the invoice's can leave the invoice's open base at or below zero while the open amount is still positive. Payments then fail closed (nothing wrong is posted); the fix is a proportional credit base and FX, planned. Void the credit note or close the difference with an adjustment.
- **Credit note with `creditsInvoiceId` and `paid`:** gives `PAYMENT_OVER_ALLOCATED`, which does not explain the cause. Book the credit note unpaid; it settles through the invoice.
- **A payment's `rateOverride`** is ignored when the payment date equals the issue date, and for receipts.
- **Export size:** the effective limit is the platform file limit (`FILES_MAX_BYTES`, at most 50 MB) and 200 MB of uncompressed originals. For long periods or many receipts export shorter periods (for example per quarter).
- **PDF preview:** originals are shown under the sandboxing CSP. Chromium may not render a PDF in the sandboxed frame; use "Open" or "Download". Images preview inline.
- **Review queue:** the queue shows at most 200 documents per status without telling you that more exist.
- **Invoice lists:** the open and partially paid filters are applied after paging, so a page can be shorter than the limit.
- **FX stale warning:** `finance_fx_stale` fires after four days without a new ECB date and can false-alarm after long holiday periods (ECB publishes on TARGET business days).
- **FX at the entry date:** the booking form's manual rate is always for the issue date; a stale paid date after an issue-date edit must be re-entered.
- **Time zones:** "this month" and the attention check use UTC, not the project's time zone. Percent changes show truncated permille.
- **Mail intake:** a mail whose first pass dies before any document exists can leave an orphan retention-locked `.eml` copy; attachment audit entries repeat on job re-runs; a persistent failed attachment keeps the mail in the inbox until a person handles it. A non-listed MIME type is refused on upload even with the right extension.
- **Retention vs erasure:** a legal erasure request does not override `retainUntil`.
- **Quota sizing:** `FILES_PROJECT_QUOTA_BYTES` is one value for every project of the installation (default 100 MB). The retention lock holds originals and `.eml` copies for `retentionYears`, so a finance project's usage only grows; size the quota before enabling finance (see "Switching it on").
- **Mail while finance is off:** mail arriving at a finance-owned mailbox while finance is disabled in the project is not processed later; its jobs are not created. Unbind the mailbox before disabling finance, or forward the receipts again.
- **Manual adjustments on open-item accounts:** a manual adjustment posting directly to payables, receivables or a payment account is not linked to an invoice, so invoice open items then differ from the account balance.
- **Lost paid result:** if storing the result fails after a settled AI call, the document ends as `failed` (or unknown) and a person decides. It fails closed, but the paid result is lost; a retry is a new call.
- **Archive retry:** after a failed archive (`lastArchiveError`) the mail stays in the inbox; the platform can start a new attempt, but finance has no button for it yet. Move the mail by hand.
- **Recurring costs** are expectations only; booked invoices are not matched to them yet.
- **DATEV** export is not available (`journal_csv` is the first exporter; the account `externalCode` field is reserved). Bank/card/wallet sync, on-chain USDC, uLiquid Desk revenue, XRechnung/ZUGFeRD parsing, monthly reports and further MCP operations (booking, rejecting, editing drafts) are follow-ups.
- **Closing entries:** one live `invoice_close` entry per invoice is enforced by the application, not by a unique index.
- **Concurrency details:** category rename and account guards are check-then-write without a database constraint; the FX sync throttle is per process.

## Open questions and manual setup

Copied from spec §15 and updated. None blocks the code; all block production use.

- **IMAP credentials for `payment@eds-labs.io`** (host, port, user, app password), entered by Mario in Orbit, and the permission to create and move into the archive folder.
- **Confirmation** of base currency USD, the USDC peg 1.000000, accrual basis and the 10-year retention (all assumptions).
- **EDS cost centers and categories** (uLiquid, FamilyPlan, EDS Orbit, General), entered as data.
- **AI consent and the daily ceiling** for the finance project, after checking that the policy's spend mandate covers it; the route for `finance_extraction` (default suggestion `claude-sonnet-5-5`) and its verified price entry.
- **Retention override policy** for a legal erasure request on finance originals.
- **DATEV details** (consultant and client number, SKR03/04) once the export is wanted.
- **Production activation** in this order: deploy approval, flag, enable module, setup, currencies and FX, mailbox connection and "Check login", bind mailbox, cost centers and categories, AI consent, verification.
- **Not yet done:** a visual browser check of the finance pages by a person on desktop and on a phone (the chart styles were tested in markup and the e2e only checks layout overflow).
