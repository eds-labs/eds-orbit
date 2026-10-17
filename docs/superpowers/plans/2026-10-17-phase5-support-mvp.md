# Phase 5 Support MVP (WP5.2–WP5.8) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the rest of the support MVP on top of WP5.1:
- the agent workspace;
- e-mail;
- the widget;
- notifications and automations;
- AI;
- statistics;
- privacy and operations.

Each work package is one draft PR. There are no merges and no flag changes.

**Architecture:** Server code lives in `apps/api/src/modules/support/`, the web module in `apps/web/src/modules/support/`. The platform services from Phase 4 are used only through their contracts (ADR 0009):
- public API, webhooks and real-time;
- files, e-mail and notifications;
- knowledge audiences and the agent runtime.

Every PR is stacked on the previous one:

| Work package | Branch | Base |
|---|---|---|
| WP5.2 | `claude/wp52-support-workspace` | the WP5.1 branch |
| WP5.3 | `claude/wp53-support-email` | WP5.2 |
| WP5.4 | `claude/wp54-support-widget` | WP5.3 |
| WP5.5 | `claude/wp55-support-automations` | WP5.4 |
| WP5.6 | `claude/wp56-support-ai` | WP5.5 |
| WP5.7 | `claude/wp57-support-stats` | WP5.6 |
| WP5.8 | `claude/wp58-support-privacy` | WP5.7 |

**Tech Stack:** TypeScript (Node 24), Fastify, Prisma/Postgres RLS, BullMQ/Redis, Next.js, Vitest, Playwright.

**Spec:**
- `plans/orbit-modularization/07-roadmap.md` §WP5.2–WP5.8;
- `06-support-readiness.md`;
- `10-support-pilot-decisions.md`: Q-12a B, Q-12b 24 months, Q-13 uLiquid project with module roles, Q-17 no widget AI answer, Q-20 Desk first with Claude integrating the Desk side;
- `docs/SUPPORT.md`.

## Global Constraints

- **No production effect.** `ORBIT_SUPPORT` and every other flag stay `false`, and nothing is merged. Each PR lists its approvals and its open decisions.
- **Support gate.** Every support entry point calls `requireSupport` (flag plus explicit module row). Workers and jobs check it too.
- **Personal data (Q-12a):**
  - no message text, subjects, names or addresses in audit, events, telemetry or logs;
  - model calls of the support module use `store: false`, no trace export, and placeholders for contact e-mail and name.
- **Widget AI first answer:** off (Q-17). The `widget_answer` task class exists but is never offered while `aiMode` is not `widget_answer`, and that value stays refused by the API in the pilot.
- **Desk side (Q-20):** a separate step in the Desk repository, with its own PR and deploy approval. Mario sets the widget secret himself.
- **Migrations** are additive, one per work package where needed, ordered after `202610180001_support_core`.
- **Tests** run with the worktree test DB (`orbit_test_wp51`, env in the session scratchpad). The full suite must be green before each PR.

## Review Focus (across the phase)

1. **Cross-project or cross-contact reads.** Agents see only their project, and widget users only their own session's or verified identity's tickets.
2. **Duplicate or lost sends.** Outbound mail and widget messages are never re-sent after an ambiguous transmit (`outcome_unknown`).
3. **Mail loops.** Auto-replies are neither answered nor acknowledged.
4. **Text leaking into audit or telemetry.**
5. **Support work while support is off or the project is paused.**

---

## WP5.2 Agent workspace

Risk: medium. The server API follows the WP5.1 route pattern (`inSupport`).

### Task 1: Ticket workspace API

**Files:**
- Create: `apps/api/src/modules/support/workspace.ts`, `apps/api/src/modules/support/agents.ts`
- Modify: `routes.ts`, `tickets.ts` (SLA helper shared)
- Test: `apps/api/tests/support-workspace.integration.test.ts`

**Interfaces** (all below `/api/projects/:projectId/support`):

| Route | Permission | Behaviour |
|---|---|---|
| `GET /tickets` | read | Query `view` (`mine`, `unassigned` or `all`), `status`, `inboxId`, `category`, `priority`, `q`, `cursor`, `limit` (≤ 50). Answers `{ items, nextCursor }`, ordered by `updatedAt` desc then id. `q` matches the subject, the contact's name or e-mail, or the message full text (`searchVector @@ plainto_tsquery('simple', q)`). |
| `GET /tickets/:ticketId` | read | `{ ticket, contact, inbox, timeline }`. The timeline holds the messages, each with its attachments, plus the events, sorted by time. |
| `POST /tickets/:ticketId/replies` | reply | Body `{ bodyText, fileIds? }`. Creates an `agent_reply` that is visible to the customer, with `deliveryState: "pending"` and the ticket's channel, so the channel jobs of WP5.3/WP5.4 can send it. Sets `firstRespondedAt` once, moves `new`/`open` to `pending_customer`, and writes the events. |
| `POST /tickets/:ticketId/notes` | notes.write | Body `{ bodyText }`. An `internal_note`, never visible to the customer. |
| `PATCH /tickets/:ticketId` | assign | Body `{ status?, priority?, category?, tags?, assigneeUserId? }`. Writes one event per changed field. A priority change recomputes the due times, unless the first response or resolution has already happened. `resolved` sets `resolvedAt`, `closed` sets `closedAt`, and reopening clears both. The assignee must be a support agent of the project. |
| `POST /tickets/:ticketId/merge` | assign | Body `{ intoTicketId }`. Moves the messages, sets `mergedIntoTicketId`, closes the source ticket, and writes events on both tickets. |
| `GET /contacts` | read | `?q`, `cursor`. Live contacts only. |
| `GET /contacts/:contactId` | read | The contact with its tickets. |
| `PATCH /contacts/:contactId` | contacts.manage | Body `{ name?, notes?, locale? }`. |
| `POST /contacts/:contactId/merge` | contacts.manage | Body `{ intoContactId }`. Moves the tickets and identities, tombstones the source, and moves its e-mail to the target when the target has none. |
| `GET /agents` | read | Members whose effective support role is editor or owner: `{ userId, name }`. |

- Attachments in replies are platform files of the project with `moduleId: "support"` that are not deleted. Any other file id gives 400 `ATTACHMENT_INVALID`.
- Audit entries and events never carry text.

- [ ] Failing tests:
  - "lists, filters and searches tickets with a cursor";
  - "shows the timeline with notes for agents";
  - "replies, notes and status flow";
  - "recomputes SLA on priority change";
  - "assigns only support agents";
  - "merges tickets and contacts";
  - "refuses foreign or non-support files";
  - "viewer reads but cannot reply";
  - "no text in audit or events".
- [ ] Implement, run, commit.

### Task 2: Web module

**Files:**
- Create in `apps/web/src/modules/support/`:
  - `manifest.tsx`;
  - `api.ts`, with pure helpers: `ticketQuery`, `slaState`, `timelineItems`;
  - `inbox.tsx` (list with filters and ticket pane);
  - `ticket.tsx` (timeline, composer, contact panel);
  - `contacts.tsx`, `settings.tsx` (inboxes, categories, SLA, retention) and `home.tsx` (tile);
  - `labels.ts` (DE/EN).
- Modify: `apps/web/src/modules/registry.ts`.
- Test:
  - `apps/web/src/modules/support/api.test.ts`;
  - `apps/web/src/modules/support/ticket.test.tsx`, a render test of the composer and timeline where the existing web tests render;
  - `apps/web/tests/support.spec.ts`, the Playwright flow (written; run against the local stack when available).

**Views:**

| Key | Path | Shows |
|---|---|---|
| `support` | `` | The inbox. The ticket opens as `?ticket=<id>` and the view via `?view=`. Nav order 30, mobile. |
| `support-contacts` | `contacts` | The contact list. |
| (settings section) | tab `support` | Inboxes (create, edit, rotate with the secret shown once, archive), plus categories, SLA and retention. |

The home tile shows open, unassigned, at-risk and breached ticket counts. All of this works at 390 px; controls are focusable buttons and links with labels.

- [ ] Failing helper tests, then the components, the registry entry and the e2e spec. Commit, push and open the draft PR.

---

## WP5.3–WP5.8

Each section is written when its work package starts, from the platform API reference (Explore notes) and the roadmap text, in the same format.
