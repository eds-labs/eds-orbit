# 10 — Support pilot: decision note for Q-12 and the pilot inbox

**Status:** Partly decided by Mario on 2026-10-17 (see §0). The pilot facts in §2.2 marked "Mario to confirm" are still open. Nothing here is implemented.

## 0. Decisions (Mario, 2026-10-17)

| ID | Decision |
|---|---|
| Q-12a | **Option B.** Support AI may send customer text to OpenAI under its API DPA, with these safeguards mandatory for the support module: `store: false`, no OpenAI trace export, contact e-mail and name replaced by placeholders before the call, and no message text in telemetry. This supersedes D2 and ADR 0006 for the support module only. |
| Q-12b | **24 months** after closure as the default retention for closed tickets, as in §1.5. |
| Q-13 | Support runs in the **existing uLiquid project**, with staff separated by module roles (WP4.5). |
| Pilot channels | The pilot starts with **both channels at once**: the support mailbox and the Desk app widget. WP5.9 therefore needs WP5.3 and WP5.4 to be finished. |
| Q-20 | **Desk gets the widget first** (the pilot). **Claude builds the Desk-side integration**: the widget embed and the HMAC signing of `externalUserId` in Desk's backend. Mario's answer, "Das Widget baut Claude dann ein", was given in the platform session and relayed here. |

Still open: the §1.2 and §1.3 *legal check* items, which must be settled before WP5.9, and the facts in §2.2 marked "Mario to confirm".

**Desk-side work (Q-20).** This is its own step within WP5.4 and WP5.9:
- It lives in the Desk repository and gets its own PR there. Deploying it needs Mario's approval.
- Desk signs only on its backend and never calls Orbit server-side (master spec).
- **Mario sets the widget secret in Desk himself. No agent does.** Orbit shows the secret only once, when the inbox is created or the secret is rotated.


**Scope:** Before Phase 5 (`07` §Phase 5) starts, two things must be settled:
- **Q-12:** how Orbit may process customer personal data in Support, covering the legal basis, processors, OpenAI terms and retention. This revisits decision D2 and ADR 0006.
- **The pilot inbox:** which project, channels, mailbox and people run the WP5.9 pilot. This covers Q-13 and Q-17 and the remaining pilot facts.

**This is not legal advice.** It is a technical decision basis. Points marked *(legal check)* should be confirmed by whoever handles data protection for the operating company before the pilot goes live (WP5.9), but not before code starts.

**What each decision affects:**

| Decision | Needed before | Why |
|---|---|---|
| Q-12 retention and deletion | WP5.1 (data model), WP5.8 | Tombstones, retention settings and delete paths are part of the schema. |
| Q-12 AI processing | WP5.6 | Decides whether customer text may reach OpenAI at all, and how. |
| Q-12 legal basis, privacy notice and processors | WP5.9 | It is customer-facing only from the pilot on. |
| Pilot project (Q-13) | WP5.1 tests, WP5.9 | It sets the isolation model: module roles or a separate project. |
| Pilot channels, mailbox and widget | WP5.3, WP5.4, WP5.9 | Mailbox credentials, widget origins and the Desk embed. |
| Widget AI answer (Q-17) | WP5.6 | It sets the default `aiMode` per inbox. |

---

## 1. Q-12: customer personal data

### 1.1 What changes compared with today

**[Fact]**
- D2 (2026-09-30) and ADR 0006 assume that Orbit is used **only by Mario**, and both ask to be revisited once customer data enters Orbit.
- The code already sends `store: false` on every OpenAI call (`packages/ai/src/index.ts:212, 315, 358`).
- Orbit does not export traces to OpenAI.

Support introduces the following:
- **New data subjects.** These are customers of the app, for example uLiquid Desk users. Some are anonymous widget visitors.
- **New personal data:**
  - name and e-mail;
  - an external app user ID;
  - free-text messages;
  - attachments;
  - raw e-mail including headers and IP traces;
  - widget session metadata.
- **Free text can carry anything.** This includes account details, wallet addresses and occasionally special categories. Orbit cannot prevent customers from writing it, so it must handle it safely.

### 1.2 Roles and legal basis *(legal check)*

| Topic | Proposal |
|---|---|
| Controller | The company that operates the app towards its customers, for example the operator of uLiquid Desk. Orbit is that company's internal tool, not a separate service provider. **To confirm:** is it the same legal entity as EDS Labs? |
| Legal basis for registered users | Art. 6(1)(b) GDPR: answering a customer about their contract or account. |
| Legal basis for anonymous visitors and e-mail enquiries | Art. 6(1)(b), as steps prior to a contract, or Art. 6(1)(f), the legitimate interest in answering an enquiry. |
| AI triage and draft replies | Part of handling the enquiry. Art. 6(1)(f), with the safeguards in §1.4. It must be named transparently in the privacy notice. |
| Privacy notice | The app's privacy policy names the support tool, its processors (§1.3) and the retention (§1.5). The widget shows a one-line notice with a link before the first message. **Owner:** the app team or Mario. Orbit only supplies the text building block. |
| Data subject rights | Export and deletion per contact (WP5.8). The request arrives through the normal support channel and is executed by an owner (`ui_only`, hard floor D1/D2). |

### 1.3 Processors involved *(legal check: a DPA is needed with each)*

| Processor | Role in Support | Existing? |
|---|---|---|
| The Orbit production host (Coolify VPS) | The database, which holds tickets, messages and contacts | yes |
| Cloudflare R2 (own bucket, Q-19) | Encrypted attachments and raw e-mail. AES-GCM in Orbit, so Cloudflare sees only ciphertext. | yes (approved 17.10) |
| The mailbox provider (Q-16: existing mailbox through SMTP/IMAP) | Receives and sends support e-mail | yes, as the mailbox's provider |
| OpenAI (API) | Triage and draft replies, only if option B or C below is chosen | yes, for marketing |
| Backup bucket (R2) | Database backups contain support data | yes |

There is no new vendor. **Constraint:** retention in backups follows the backup rotation. A deleted contact disappears from backups only when they rotate out. The privacy notice should state this.

### 1.4 AI processing of customer text (decision Q-12a)

| Option | What it means | Effect |
|---|---|---|
| **A. No AI on support data in the MVP** | WP5.6 is dropped from the MVP. Tickets are handled manually. | Simplest. It gives away the main value of Orbit's support desk. |
| **B. OpenAI under its API DPA with Orbit safeguards** *(recommended)* | Safeguards: **`store: false` enforced** for the support task classes, independent of the D2 setting. **No** OpenAI trace export for `module=support`. Minimization: only the ticket text and the needed context are sent, and contact e-mail and name are replaced by placeholders before the call. Orbit's own telemetry never contains message text. Hard rules from `06` §3.5 (no financial advice, no promises, handoff). | Uses the existing provider and terms. *(legal check)* OpenAI's DPA, third-country transfer (SCCs) and the 30-day abuse-monitoring retention on OpenAI's side. |
| **C. B plus EU data residency or zero data retention** | The same as B, run through a separate OpenAI project with EU data residency, or with ZDR approval from OpenAI. | Strongest position. Requires an application or setup at OpenAI and possibly other model availability or prices. It can be added later without code changes, because it is project configuration. |

**Recommendation: B for the pilot, C as a later option.** A note in ADR 0006 records that D2 no longer applies to the support module: `store: false` and no trace export are mandatory there.

### 1.5 Retention (decision Q-12b)

These are defaults per project, stored in the support module settings. The owner can shorten them, and can lengthen them only within an upper limit.

| Data | Proposed default | Mechanism |
|---|---|---|
| Closed tickets including messages and attachments | **24 months after closure**, then deleted | A daily retention job (WP5.8) |
| Raw e-mail (MIME in platform files) | 90 days | The parsed message stays with the ticket. |
| Unsent AI drafts | 90 days | — |
| Widget sessions | 30 days after expiry | — |
| Contacts without tickets | Deleted together with their last ticket | Tombstone `deletedAt`, then a hard delete |
| Ticket events (timeline, without message text) | Same as the ticket | Statistics are kept aggregated only. |
| Telemetry and audit | Never message text or e-mail addresses; IDs only | Already a rule (`06` §2.1) |

*(legal check)* If support e-mails count as commercial letters (for example around a contract), German commercial and tax law may require **6 years** for those. Alternative: 24 months by default, with a "keep" mark per ticket for those cases. The mark is an E-extension, not part of the MVP.

---

## 2. The pilot inbox

### 2.1 Pilot project (Q-13)

| Option | Effect |
|---|---|
| **Support in the existing uLiquid project, staff separated by module roles** *(recommended, `06` §3.7)* | Support shares knowledge sources with marketing, which needs WP3.5 audiences for clean separation. Support agents get `support: editor` and `marketing: none` (WP4.5, flag `ORBIT_MODULE_ROLES`). |
| A separate "uLiquid Support" project | Hard separation without module roles. Knowledge has to be imported again, and there is no cross-module insight (E13). |

### 2.2 Channels and pilot facts

| Item | Proposal | Mario to confirm |
|---|---|---|
| Inbox name | "uLiquid Desk" | — |
| Channels | **Decided:** e-mail and the Desk app widget, both at the pilot start | — |
| Mailbox | A **dedicated** mailbox, for example `support@uliquid.vip`, that humans do not also work in. WP4.7 reads IMAP read-only, so a shared mailbox would show every mail twice. | Address, and whether it exists |
| Widget origin | `https://desk.uliquid.vip` | Claude embeds the script in Desk (Q-20). Desk never calls Orbit server-side (master spec). |
| Widget identity | HMAC-verified users: Claude adds the signing of `externalUserId` to Desk's backend (Q-20); Mario sets the secret. Anonymous visitors give an e-mail. | — |
| Language | English by default, German recognized | — |
| Agents in the pilot | Mario (owner) | Further people? Each needs an Orbit account plus module role. |
| SLA targets (24/7 clock) | First response: urgent 4 h, high 8 h, normal 24 h, low 72 h. Resolution: 3× the first-response target. | — |
| Auto-close | 7 days in `pending_customer` | — |
| Sensitive categories (immediate handoff, never answered by AI) | Billing, account security, legal, trading and financial questions | — |
| Widget AI first answer (Q-17) | **Off** in the pilot. AI only drafts for agents. | — |
| Chatwoot | Keeps running unchanged during the pilot. The switch happens only when the mailbox and widget point to Orbit (`06` §7). | Is Chatwoot currently used for uLiquid at all? |

---

## 3. What can start without the answers

WP5.1 (skeleton and data model) does not depend on the open answers, as long as:
- retention values are **settings** with the §1.5 defaults, not constants;
- contacts have a tombstone (`deletedAt`), and every support table is deletable per contact;
- the inbox carries `aiMode` with the default `off`.

Code work can therefore start. The pilot itself (WP5.9) stays blocked until §1.2 and §1.3 are confirmed.

WP5.1 is planned in `docs/superpowers/plans/2026-10-17-wp51-support-skeleton.md` and documented in `docs/SUPPORT.md`.
