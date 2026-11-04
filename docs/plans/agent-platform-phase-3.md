# Agent platform, Phase 3: personal Orbit Assistant and global chat

Status: **proposed plan, documentation only** (2026-11-04). Builds on [Phase 1](agent-platform-phase-1.md) and uses the [Phase 2](agent-platform-phase-2.md) Support agent as its first delegation target. Overview and decisions: [agent-platform-architecture.md](agent-platform-architecture.md) (§4.5, §7.4, §14). Work packages are **WP3.n**.

## 0. Goal and scope

**Goal.** A personal assistant for each signed-in user, reachable from a floating chat bubble on every Orbit page. It represents that user with exactly the user's current rights. It can:
- read and act across the projects the user may access;
- use the same internal capabilities MCP offers, without internal MCP HTTP calls;
- delegate work to configured agents and report their results;
- show pending approvals;
- keep a small, user-controlled personal context.

It extends the existing Orbit Chat: there is no second chat backend.

**Out of scope:**
- proactive messages and briefings (Phase 4);
- voice (Phase 4);
- crossing organizations;
- an always-on assistant model;
- chatting through Telegram.

**Classification**
- **Risk: high.** Authorization, multi-tenant and cross-project access, personal data, a new auth rule for the personal space.
- **Environment:** local and preview.
- **App profiles:** primary `ai-agent-app.md`, plus `web-frontend.md` and `fullstack-saas.md`.
- **Workflows:** `feature.md`, `migration.md` (WP3.1, WP3.6).
- **Quality gates:** in addition, `accessibility-checklist.md`.

---

## 1. Starting point

All rows below are [Fact] from `cc8a14cf`. The details are in architecture §2.6.

### 1.1 Backend

| Fact | Consequence |
|---|---|
| `ChatConversation`/`ChatMessage`/`ChatRun`/`ChatProposal` have NOT NULL `projectId` and composite FKs. RLS policy `chat_owner_scope` requires workspace, project and user. | The assistant needs a project-shaped home: the personal space (D-08). |
| Jobs, outbox, worker pump (`Project.workDueAt`), pause, AI configuration, spend authority, telemetry and realtime channel are all keyed by project. | The personal space gets all of them unchanged. |
| `Project.kind` CHECK allows `project` and `library` (`202610240002_central_connections`). | Widen it with `personal`. |
| Org owners are owners of every project in the org (`platform/tenancy/member-scope.ts` ≈ 17–39). | Personal spaces must be excluded from that rule. |
| The MCP adapter already injects a `projectId` argument into every registry tool and authorizes each call in that project (`platform/mcp/adapter.ts` ≈ 228–237, `visibility.ts` ≈ 173–184). The tool set is a union over the principal's projects. | Reuse that code for the assistant's cross-project calls. |
| `GET /api/action-requests/summary` reads one project at a time, each in its own transaction (`server.ts` ≈ 725–763). | This is the pattern for cross-project reads. |
| Native MCP tools (`orbit_projects`, `search`, `fetch`, `orbit_*_task`, `orbit_action_status`) are not registry tools. | Move them into the registry (WP3.2). |
| The chat runner sends the last 12 messages as text. Claude receives every offered tool in full. Only ≥ 48 KB headroom is guaranteed (`chat-runner-limits.test.ts`). | Load tools in stages (WP3.3). |
| `ChatMessage_role_check` allows `user` and `assistant`. | System notices need a new role `notice` (WP3.6). |
| `CHAT_MAX_MODEL_CALLS` 8, tool calls 16, input 128,000 bytes, output 8,000 characters. | The same limits apply to personal turns. |

### 1.2 Web

| Fact | Consequence |
|---|---|
| `apps/web/src/components/chat.tsx` is a 722-line monolith that depends on `useWorkspace()`. It is mounted inside the project shell's keyed `<div>`, which remounts on project change (`components/orbit.tsx` ≈ 851–868). | Refactor it into a headless hook plus views (WP3.8). |
| There is no drawer, sheet or popover primitive. `Modal` is a native modal `<dialog>`. A fixed `.mobile-nav` sits at the bottom of phones (`app/globals.css` ≈ 2663). | Add a new panel/sheet primitive and avoid the nav. |
| Only Marketing's assignment and plan cards decide inline. Other approvals show a status badge. | Add project-aware inline decisions (WP3.5). |
| `/api/me` already returns the user's projects. | The bubble works on non-project pages too. |

---

## 2. Target design

### 2.1 Personal space (D-08, D-09)

**Shape**
- One `Project` row per (user, organization), with `kind = 'personal'` and the new nullable column `personalUserId`.
- A partial unique index on `(workspaceId, personalUserId) WHERE kind = 'personal'`.
- Created lazily by `ensurePersonalSpace(workspaceId, userId)`, which is idempotent, on the first assistant use. The project is named `Personal space`, its time zone comes from the user's locale or the org default, and the user is its only `ProjectMember`, with the owner role.

**Membership rule** (`platform/tenancy/member-scope.ts` `projectMembership`)
- For kind `personal`, only `personalUserId` is a member. Implicit org-owner access does **not** apply.
- Global admins get no access either.
- This is an auth change, so it needs access-matrix rows and RLS probes.

**Hidden from business lists**
- `/api/me` projects, `/api/projects`, the project picker, MCP `orbit_projects`, the administration project lists (they show counts only), the org social calendar and the cross-project summaries.
- Only some queries filter by kind today (for example `kind: "project"` in `platform/connections/channel-assignment.ts`); most project lists do not. WP3.1 therefore audits every `project.findMany`/membership listing, adds `kind <> 'personal'`, and adds a test that enumerates the list endpoints.

**Modules**
- No business module is activated.
- The platform assistant and the personal context work regardless of `ProjectModule`.
- Pausing the personal space pauses only the assistant.

**AI configuration**
- Inherited from the org `AiProfile` (ADR 0014). There is no project key.

**Spend authority**
- A read-only projection of a new org setting, `assistantPerUserMonthlyMicros`, with day and run limits derived from it.
- It is set by org owners in organization settings → AI. It needs a new nullable column on `OrganizationAiBudget`.
- The user cannot raise it. `reserve` treats the personal space like any project, so the org budget counts its spend.

**Entitlements**
- `assistantPersonal` (Phase 1 port) gates provisioning and the bubble.
- An org-level per-member switch can disable the assistant for a member. It is stored in `WorkspaceMember` settings JSON, or as an entity in the org library project; WP3.1 decides.

**Lifecycle**
- When a user leaves an org, their personal space is deleted after 30 days. Its content is user-private and is not exported to others.
- User erasure deletes it immediately.

### 2.2 Cross-project capability (question 4)

**Tool shapes.** Every registry tool has a `scopeShape` (Phase 1 field).

*Project tools*, offered in personal mode:
- They get an injected `projectId` parameter. The code is moved from the MCP adapter into the capability layer and shared by both.
- `executeCapability` opens the **target** project's own `userScoped` transaction with `actorScope(user, target)`.
- It then checks module activation, module role, entitlement and pause in that project.
- Refusal codes are uniform (`PROJECT_FORBIDDEN`, `MODULE_DISABLED`, `PERMISSION_DENIED`), and no data comes back.
- The personal-space transaction is never held during a target-project call, so there are no nested project locks.

*User tools* are new platform tools. They are always loaded in personal mode, at most 8 of them:

| Tool | Risk | Purpose |
|---|---|---|
| `projects_list` | R0 | Accessible projects: name, id, active modules, the user's role. Replaces native `orbit_projects`; the MCP name stays as an alias. |
| `my_overview` | R0 | Per requested project, each in its own transaction: top attention items, open approvals the user may decide (count + titles), the user's open Work tasks, Support counts (urgent, breached; counts only), failed work orders in 24 h. Every item is tagged `{projectId, projectName}`. |
| `pending_approvals` | R0 | Decidable ActionRequests across projects (titles, effect badges, links), from the summary pattern. |
| `load_project_tools` | R0 | `(projectId, goal)` loads up to N project tools for the rest of the turn (§2.3). |
| `agents_list` | R0 | Agents the user may run or view, per project. |
| `agent_delegate` | P | §2.5. |
| `work_order_status` | R0 | Status and result of work orders the user requested or may read. |
| `context_list` | R0 | The personal context (§2.6). |

*Cross-project knowledge search* is not a new union search. `knowledge_search` runs per target project and keeps its audiences; results are labelled.

**Taint rule** ([Proposal], architecture §7.4)
- The run records `contextProjects`: every project whose data entered the turn.
- A P tool in project B, in a turn whose `contextProjects` contains another project A, sets `requestedBy.crossProjectContext = [A]`. `resolveAuthorization` then refuses mandate auto-approval with `CROSS_PROJECT_CONTEXT`.
- The card shows "uses information from A". The decision stays with a human in B.

**One project per approval.** Every proposal belongs to exactly one project, and its card carries `projectId`.

### 2.3 Staged tool loading, provider-neutral

**Personal-mode budget.** A personal turn starts with the platform user tools plus `tool_search` semantics. Project tools enter only through `load_project_tools`.

**Implementation**
- Generalize today's client-executed tool search (`platform/agents/tools/registry.ts` `searchTools`, `legacy-responses.ts` `ToolHost.search`) so it also works for Anthropic models. For them, the loaded definitions are appended to the next model call's tool list within the same turn. This is today's "found tools enter at the end of the input", applied provider-neutrally.
- The deferred tool list stays identical across the turn, so prompt caching holds.

**Guard.** A new limits test asserts that the personal static bytes (instructions, project list, personal context, user tools) leave ≥ 64 KB of headroom under `CHAT_MAX_INPUT_BYTES`.

**Project mode is unchanged.** The existing `/p/:id/assistant` keeps today's loading: Claude gets all tools in full (`fullTools`), OpenAI uses tool search behind `ORBIT_TOOL_SEARCH`.

### 2.4 Conversation modes and instructions

**One backend, two modes**
- Project mode is today's chat in a business project.
- Personal mode runs in the personal space.

**Personal-mode instructions** are versioned constants:
- they say the assistant represents the user and has only the user's rights;
- they require every project tool call to name its project;
- they forbid mixing project data across proposals without saying so;
- they mark tool data as untrusted;
- they route consequential steps through proposals.

**Page context.** Each message carries an optional `pageContext {projectId?, route?, entity?: {type, id}}` from the web shell.
- It is a *hint*: the server checks the user may read that project and entity, and drops it if not.
- It never grants access.
- It is stored with the user message for traceability.

**Focus project.** Set by page context or an explicit switch in the panel. It changes:
- which personal context entries are included;
- which project tools are preloaded (at most 6, chosen by the focus project's active modules).

### 2.5 Delegation from the assistant (question 6, scenario C)

`agent_delegate(projectId, agentId, goal, subjects?[≤ 10])` works in five steps.

1. **Build the principal.** It is `requester (user) ∩ sponsor ∩ agent allowlist`, using the Phase 1 delegation core. The rules are depth 1, fan-out ≤ 10, child ceiling ≤ the agent's run ceiling × children, and the agent's month budget.
2. **Create the work orders.** The call creates a parent work order (`target: agent`, `origin: assistant`), plus children when subjects are given. It returns a **confirmation card** with the agent, project, subjects, ceiling and on-behalf-of. Per D-06 the requesting user confirms when they are editor+ in the agent's modules. A per-agent start mandate is optional. MCP's `platform.task.start` keeps owner approval, unchanged.
3. **Run.** The work orders run on the worker (Phase 1). The parent's status is derived from its children, the same way `taskSnapshot` derives it today.
4. **Report back.** On `platform.agent.work_order.finished` or `failed`, the platform subscriber writes one `notice` message into the originating personal conversation (`ChatMessage.role = 'notice'`) with a result card per work order. **No model call is made.** If the conversation was deleted, the notice is skipped and the work order keeps its result.
5. **Summarize.** On the user's next message the assistant reads `work_order_status` and summarizes.

**MCP work orders** (D-05):
- New `orbit_create_task` calls create an `AgentWorkOrder` with `target: assistant`, a private conversation and the frozen MCP delegation. That is today's `orbit_tasks` behaviour, persisted in the table.
- `orbit_get_task`, `orbit_list_tasks` and `orbit_cancel_task` read both the table and legacy `orbit_tasks` entities until those expire under task retention.
- Tool names, shapes, scopes and approvals are unchanged.
- The MCP proposal quota already moved into the capability layer (Phase 1).

### 2.6 Personal context (D-17)

**Storage.** A user-private entity kind `personal_context` in the personal space (no migration):

```text
{ category: "preference" | "project_note" | "decision" | "workflow",
  text ≤ 500, projectId?, source?: {conversationId, messageId},
  status: "active" | "archived", createdBy: "user" | "assistant_confirmed" }
```

**Creation**
- The user writes an entry on the "My context" page, or
- the assistant calls `context_propose`. That returns a card ("Remember: …? Save / Edit / Dismiss"), and only the user's click saves it. There is no silent memory.

**Use**
- Active entries are included in personal-mode instructions, at most 2 KB, newest and pinned first.
- An entry with a `projectId` is included only while that project is the focus or is named in the turn.

**Control**
- List, edit, archive, delete and export (JSON) on "My context".
- Every assistant answer that used context can show "used: 3 context entries" with links.

**Isolation**
- Never visible to other users, org owners or admins: user-private RLS plus the personal-space membership rule.
- Never passed to configured agents or MCP clients.
- The MCP `orbit_profile` stays as it is.

**Retention.** Kept until deleted. It is deleted together with the personal space.

### 2.7 Web: bubble, panel and page

```text
apps/web/src/platform/assistant/
  use-assistant-conversation.ts   NEW headless hook: list, load, send (clientRequestId), follow run (SSE), cancel, archive
  conversation-view.tsx           NEW messages + cards + composer (from chat.tsx)
  assistant-panel.tsx             NEW panel shell: header (mode, focus project switch, new, history), body, composer
  assistant-bubble.tsx            NEW floating button + unread/attention badge
  project-cards.tsx               NEW project badge + project-aware links and decide buttons
apps/web/src/platform/ui/
  sheet.tsx                       NEW non-modal side panel (desktop) / bottom sheet (phone) primitive
apps/web/src/components/chat.tsx  becomes a thin page using the hook (project mode, unchanged URL)
```

**Mounting.** The bubble is mounted once at the `.orbit` root (`components/orbit.tsx` ≈ 708), outside the keyed workspace `<div>`, so it survives project switches. It is also mounted in the `frame()` layout for non-project pages: org picker, account, administration.

**Panel**
- Desktop: a 420 px non-modal right panel; the page stays usable.
- Phone: a full-height sheet above `.mobile-nav`, with the bubble offset above the nav. The textarea font is 16 px, as today, so there is no zoom.

**Full page.** `/assistant` (personal mode). The project chat stays at `/p/:id/assistant`, and all existing deep links (`?conversation=`) keep working.

**Streaming**
- SSE on the personal-space run (`/api/projects/:personalSpaceId/chat/runs/:id/events`), with no new endpoint.
- Optional `steps[]` in the snapshot (tool started or finished, by name and project) for progress lines. This is additive to the snapshot event.

**Cards and decisions**
- Every card shows its project badge. Links go through a project-aware `AppLink` variant.
- `status` cards for ActionRequests get **Approve / Reject** buttons when the user may decide in that project. The buttons use `useDecideActionRequest` with the card's `projectId`, and the decision stays hash- and version-bound. Otherwise the card shows "Open approvals in <project>".

**Errors.** Readable German and English texts for every `CHAT_*` code (`components/chat-errors.ts`), in place of raw codes.

**Accessibility**
- Focus moves into the panel on open and back to the bubble on close.
- Escape closes the panel; a keyboard shortcut opens it (chosen per T3-4 after checking the shell's existing bindings).
- Streaming text uses `aria-live="polite"`.
- Visible focus rings; touch targets ≥ 44 px.

**Design system.** Uses `globals.css` tokens and `components/ui/primitives.tsx`. `docs/DESIGN_SYSTEM.md` gains the sheet primitive and the assistant surfaces. The UI restructure spec keeps the nav entry plus the home prompt; the home prompt now opens the panel.

---

## 3. Work packages

### WP3.0 ADR 0022 and decision record (docs)

- ADR 0022 "Personal space and user-scoped assistant". It records D-08, D-09, D-10 and D-17, the taint rule, and how MCP work orders fold into `AgentWorkOrder` (D-05).
- Effort: 0.5 day.

### WP3.1 Personal space

- **Migration** `…_personal_space`:
  - `Project_kind_check` gains `personal`;
  - new column `Project.personalUserId` (nullable) with an FK to `User` (cascade);
  - partial unique index;
  - CHECK `kind <> 'personal' OR personalUserId IS NOT NULL`;
  - `OrganizationAiBudget.assistantPerUserMonthlyMicros` (nullable).
- **Code:**
  - `platform/assistant/personal-space.ts` (`ensurePersonalSpace`, lifecycle hooks);
  - the membership rule in `platform/tenancy/member-scope.ts`;
  - list filters (`server.ts` `/api/me`, `/api/projects`, MCP `orbit_projects`, administration lists, social org calendar, summaries);
  - the spend-authority projection in `platform/ai/spend-policy.ts` for kind `personal`;
  - org settings UI for the per-user cap;
  - the per-member disable switch.
- **Tests:**
  - an org owner gets 404 on another user's personal space (API and RLS);
  - a global admin gets 404;
  - lists never show personal spaces;
  - provisioning is idempotent under parallel calls;
  - the spend cap is enforced and cannot be raised by the user (403);
  - leaving the org deletes the space after 30 days;
  - user erasure deletes it at once.
- **Safety nets:**
  - `apps/api/tests/access-matrix.integration.test.ts`: the personal-space rows and the changed org-owner row are reviewed as a security change;
  - `apps/api/tests/rls-matrix.integration.test.ts`.
- **Effort:** 2–3 days. **Schema hash approval required.**

### WP3.2 Cross-project capability layer and user tools

- **Move** the `projectId` injection and per-call project authorization from `platform/mcp/adapter.ts` into `platform/agents/capabilities.ts`. The MCP adapter calls it; MCP behaviour is unchanged, and the existing gateway suites prove it.
- **Move** the native MCP tools into the registry as platform tools:
  - `projects_list`;
  - `action_status`;
  - `search`/`fetch` as per-project labelled knowledge reads.

  `orbit_*` names are aliases, and the MCP schemas and outputs are unchanged.
- **New user tools** (§2.2): `my_overview`, `pending_approvals`, `agents_list`, `work_order_status`, `context_list`. All read per project in separate transactions.
- **Taint tracking:** `contextProjects` on the run, `requestedBy.crossProjectContext`, and `resolveAuthorization` refusing `CROSS_PROJECT_CONTEXT`.
- **Tests:**
  - scenario B: the user is an editor in A and has module role `none` for Work in B. `my_overview` returns A's tasks and, for B, only a refusal code.
  - A viewer of B sees only viewer data.
  - A project B the user is not in returns `PROJECT_FORBIDDEN` and no name leak beyond what `projects_list` shows.
  - Taint blocks mandate auto-approval.
  - No nested project transactions: a lock-order assertion in test mode.
  - MCP gateway regression.
- **Effort:** 3–4 days.

### WP3.3 Staged, provider-neutral tool loading

- **Generalize** `searchTools` and `ToolHost.search` for Anthropic. Add the `load_project_tools` semantics.
- **Personal static-bytes guard test.**
- **Preload rule:** the focus project's top tools, at most 6.
- **Tests:**
  - a Claude and an OpenAI scripted turn load project tools mid-turn;
  - definitions count toward input bytes;
  - a forged call to an unloaded or forbidden tool returns `CHAT_TOOL_NOT_ALLOWED`;
  - the cache-stable tool list stays the same within a turn;
  - project mode is unchanged.
- **Effort:** 2–3 days.

### WP3.4 Personal conversation mode

- **Chat runner** (`platform/assistant/chat-runner.ts`):
  - a mode switch based on the conversation's project kind;
  - personal-mode instructions;
  - project list and focus;
  - the personal-context section;
  - `pageContext` validation;
  - cards carrying `projectId` (`platform/assistant/cards.ts`, an optional field);
  - `getConversation` validating card resources per their own project, one transaction per project.
- **Routes.** None new: the personal space is a project, so `/api/projects/:personalSpaceId/chat/*` works. `GET /api/assistant` returns `{personalSpaceId, enabled, capMicros}` and provisions on first call.
- **Flag** `ORBIT_PERSONAL_ASSISTANT` (default off), plus the entitlement `assistantPersonal`.
- **Tests:**
  - pause of the personal space;
  - the cap reached (`AI_BUDGET_*` codes shown readably);
  - a page-context hint for an inaccessible project is dropped;
  - a card with a foreign `projectId` the user cannot read is dropped on load;
  - limits unchanged.
- **Effort:** 2–3 days.

### WP3.5 Inline, project-aware decisions

- **Decide buttons** on generic `status` cards for ActionRequests the user may decide in the card's project. They are hash- and version-bound and go through the existing route `POST /api/projects/:projectId/action-requests/:id/decide`.
- **Not inline:** governance (`G`) actions. Neither are types whose renderer requires the full approvals page (creative previews, schedule moves); those cards show a link.
- **Tests:** an editor can decide a Work type inline, a viewer sees no buttons, a stale hash returns the existing error, and the decision is audited as today.
- **Effort:** 1–1.5 days.

### WP3.6 Delegation and the work-order fold-in

- **`agent_delegate`** (§2.5): a confirmation card, children and the parent status.
- **`ChatMessage_role_check`** gains `notice` (migration). A completion subscriber writes notices and cards without a model call.
- **MCP fold-in.** `orbit_create_task` writes `AgentWorkOrder (target: assistant)`. The read tools merge legacy `orbit_tasks`, and `platform/tasks/tasks.ts` becomes a compatibility reader. Before the fold-in, verify the production state of `ORBIT_MCP_TASKS` and the count of live `orbit_tasks` [Unverified].
- **Tests:**
  - scenario C: delegate 5 tickets to the Support agent; worker restart between children; the parent completes; one notice with 5 result cards; no second paid call for a transmitted child (provider spy).
  - Depth: an agent cannot call `agent_delegate` beyond depth 2.
  - Fan-out 11 is refused.
  - The requester lacks Support rights, so the principal intersection is refused before any work order exists.
  - MCP `mcp-2-workflows` regression, including the G5 inbox-rule fix.
- **Effort:** 2.5–3.5 days. **Schema hash approval** (role constraint).

### WP3.7 Personal context

- **Entity kind** `personal_context`, declared user-private in `platform/modules/platform-declaration.ts`.
- **Tools:** `context_list`, `context_propose` (card).
- **Routes:** `GET/POST/PATCH/DELETE /api/assistant/context`, plus export.
- **Page:** *Mein Kontext* under the account (`/account/assistant`).
- **Prompt:** inclusion rules (§2.6).
- **Tests:**
  - only the owner reads it (API, RLS, org owner, admin);
  - proposals never save without a click;
  - project-scoped entries appear only when that project is in focus;
  - export and delete;
  - the 2 KB budget;
  - context is never in agent work orders or MCP outputs (assertion on the captured inputs).
- **Effort:** 1.5–2 days.

### WP3.8 Web: hook, panel, bubble

- **Components:** the components in §2.7, plus the extraction from `chat.tsx` (the project page keeps its behaviour and URL).
- **Shell mounting:** in `components/orbit.tsx` and the `frame()` layout.
- **Placement and controls:**
  - mobile placement above `.mobile-nav`;
  - focus-project switch;
  - "new conversation" and history.
- **Panel content:**
  - project badges;
  - inline decide buttons;
  - progress lines from `steps[]`;
  - readable errors;
  - the home prompt opens the panel.
- **Tests:**
  - component tests: hook state machine, sheet focus trap and escape, cards with project badges, decide buttons, error texts;
  - Playwright `assistant-panel.spec.ts`: open on a project page, send, see a streamed scripted answer, switch focus, open a linked record, close; phone viewport without horizontal scroll; the bubble does not cover the nav.
  - If the e2e model transport is unavailable, use component tests plus a documented browser check, as the Work PM precedent did.
- **Effort:** 3–4 days.

### WP3.9 Docs, MCP alignment and rollout preparation

- **New** `docs/ORBIT_ASSISTANT.md`. It replaces the outdated `docs/ORBIT_CHAT_V1.md`, which keeps a pointer.
- **Updates:** `docs/MCP_2_0.md` (work orders in the table), `docs/DESIGN_SYSTEM.md`, `docs/IMPLEMENTATION_STATUS.md`, `docs/REQUIREMENTS_TRACEABILITY.md`.
- **Rollout runbook:**
  1. Schema hashes.
  2. Flag off.
  3. Org cap set.
  4. One test user.
  5. Paid turns only within the cap, with Mario's go.
- **Effort:** 0.5–1 day.

---

## 4. Database changes

| Change | Kind | Migration |
|---|---|---|
| `Project_kind_check` + `personal`; `Project.personalUserId` + FK + partial unique index + CHECK | constraint, column, index | additive (WP3.1) |
| `OrganizationAiBudget.assistantPerUserMonthlyMicros` | column | additive (WP3.1) |
| `ChatMessage_role_check` + `notice` | constraint widen | additive (WP3.6) |
| `AgentWorkOrder.target = 'assistant'` rows, `conversationId` | existing Phase 1 columns | none |
| `personal_context` | entity kind (user-private) | none |
| Card `projectId`, `pageContext` on user messages | JSON fields | none |

WP3.1 and WP3.6 can share one migration directory if they ship together. Otherwise each needs its own schema hash approval.

---

## 5. API and UI changes

**API**

| Area | Change |
|---|---|
| New routes | `GET /api/assistant`, `GET/POST/PATCH/DELETE /api/assistant/context`, `GET /api/assistant/context/export` |
| Changed routes | Project lists and MCP `orbit_projects` exclude personal spaces; chat routes work for the personal space unchanged |
| Additive | Card `projectId`; `pageContext` on the send body; snapshot `steps[]` |
| Error codes | `PROJECT_FORBIDDEN` (uniform), `CROSS_PROJECT_CONTEXT`, `ASSISTANT_DISABLED`, `ASSISTANT_ENTITLEMENT` |
| Generated client | `pnpm api:generate` + diff review |

**UI.** The bubble, the panel, `/assistant` and "My context" (§2.7); the org setting for the per-user cap; the per-member switch.

---

## 6. Permissions and security

- **Rights.** The assistant holds exactly the user's current rights per project, checked per call. Delegation never adds rights: requester ∩ sponsor ∩ allowlist.
- **Isolation.**
  - No cross-organization access.
  - Personal spaces are invisible to org owners and admins.
  - Personal context is never shared.
- **Mixing projects.** Results are labelled, there is one project per approval, and the taint rule blocks automatic approval of mixed-context proposals.
- **Prompt injection.** Tool data from any project is untrusted, and the page context is a hint only.
- **MCP parity without HTTP.** The assistant and the gateway use the same capability layer. MCP-only safeguards stay MCP-only: OAuth scopes, grant checks, client quotas. Not every MCP capability becomes an assistant tool automatically: `exposure.assistant` stays explicit, and `orbit_create_task` stays MCP-only (the assistant uses `agent_delegate`).
- **Approvals.** Inline decisions use the unchanged decide route and checks. Governance decisions stay on their pages.
- **Quality gates:** `ai-agent-checklist.md`, `security-checklist.md`, `data-safety-checklist.md`, `accessibility-checklist.md`, `migration-checklist.md`.

---

## 7. Worker and scheduler

- **Personal-space chat jobs** use the existing `chat` queue class. Its concurrency is 1 per process today, so this phase introduces `CHAT_CONCURRENCY` (default 2), measured with the project-lock measurement harness of modularization WP4.3 Part A (`docs/IMPLEMENTATION_STATUS.md`, "Project lock measurement"). Per-project serialization stays, because each personal space is its own project.
- **The completion-notice subscriber** is a platform domain-event subscriber. Its jobs are idempotent per work order.
- **No new scheduler work.** Personal-space lifecycle clean-up (30 days after leaving) is a platform `PeriodicTask` that runs daily.

---

## 8. Dependencies

- **Phase 1:**
  - WP1.1 capability layer;
  - WP1.2 principal and quotas;
  - WP1.4 tables and entitlements;
  - WP1.6 delegation core and events.
- **Phase 2:** the Support agent, as the scenario C target. Phase 3 can also be tested with a blank agent if Phase 2 is late.
- **Decisions:** D-05, D-06, D-08, D-09, D-10, D-17.
- **Phase 4 builds on** the personal space (briefings, notices, user channel) and the panel (voice).

---

## 9. Migration and backward compatibility

- **Unchanged:**
  - project chat at `/p/:id/assistant` and `/chat`, with its tools, limits and URLs;
  - MCP tool names, schemas, scopes and approvals;
  - legacy `orbit_tasks` rows remain readable until retention removes them.
- **Changed behaviour:**
  - org owners lose implicit access to personal spaces, which are a new kind;
  - project lists filter that kind.
- **Rollback:**
  - `ORBIT_PERSONAL_ASSISTANT=false`: the bubble is hidden, `/api/assistant` returns 404, and personal spaces stay inert.
  - Constraints and columns stay. MCP keeps writing to the table, and its reads handle both.

---

## 10. Tests (summary)

| Level | Content |
|---|---|
| Unit | Membership rule; list filters; spend projection; taint tracking; staged loading bytes; context inclusion; card project validation |
| Integration | Scenario B; scenario C; scenario D (assistant variant: the user loses a project role mid-turn, so the next call in that project is refused); personal-space isolation (org owner, admin); provisioning race; cap; MCP fold-in and legacy reads; notices without model calls |
| Safety nets | Access matrix (personal-space rows, org-owner change reviewed as a security change); RLS matrix; queue dispatch (notice subscriber) |
| Regression | Chat runner and limits, MCP gateway and visibility, `mcp-2-workflows`, approvals summary, social org calendar, administration lists |
| Web | Hook, sheet, bubble, cards, decisions and errors components; `assistant-panel.spec.ts` on desktop and phone viewports |
| Paid | None. Live acceptance turns only within the org cap, with Mario's approval |

---

## 11. Acceptance criteria

1. **Bubble.** On every authenticated page (project, org, account, admin) the bubble opens the panel. The panel works with a keyboard and on a 375 px phone without horizontal scroll, and does not cover the mobile nav.
2. **Scenario B.** A question about open tasks in two projects returns one combined answer. Every item is labelled and linked, and a project or module without access contributes only a refusal reason.
3. **Scenario C.** "Have the Support agent investigate tickets 101–105" yields one confirmation card. After confirmation, five work orders run on the worker, survive a worker restart, and post one notice with five result cards into the conversation without a model call. The follow-up question gets a summary.
4. **Approvals.** Pending approvals across projects are listed. Decidable ones can be approved inline, and the decision is identical to the approvals page (hash, version, audit).
5. **Isolation.** No org owner, admin or other user can read a personal space, its conversations or its personal context (API and RLS proofs).
6. **Personal context.** Entries appear only after the user's confirmation, can be edited, deleted and exported, and affect answers only within their project scope.
7. **Taint.** A proposal in project B made after reading project A is never auto-approved under a mandate, and its card names A.
8. **Budget.** Assistant turns are paid from the personal space within the org's per-user cap, and stop with a readable message when the cap is reached.
9. **No regressions.** Project chat and MCP behave unchanged; all safety nets pass.

---

## 12. Risks and open decisions

**Risks**

| # | Risk | Mitigation |
|---|---|---|
| R3-1 | The auth change leaks or blocks access | Access and RLS matrix rows reviewed as a security change; mutation-check the membership rule |
| R3-2 | Context size and cost growth with many projects | Staged loading; ≤ 8 user tools; project list capped (names only, at most 50 projects, then search); the per-user cap |
| R3-3 | Lock contention or deadlocks across projects | No nested project transactions (test-mode assertion); `CHAT_CONCURRENCY` measured |
| R3-4 | A Claude tool-loading change breaks project-mode chats | Project mode unchanged; personal mode only; scripted provider tests for both providers |
| R3-5 | Users expect the assistant to "remember everything" | Clear "My context" UI; explicit confirm cards; no hidden memory |
| R3-6 | The bubble distracts on small screens | Collapsible; hidden on the full `/assistant` page; per-user "hide bubble" preference |

**Phase-local technical decisions**

| # | Decision | Default |
|---|---|---|
| T3-1 | Where the per-member assistant switch lives | `WorkspaceMember` settings JSON, if that table gets a settings column in this migration; otherwise an org-library entity |
| T3-2 | Notice role (`notice` constraint) or an assistant-role card | `notice` role (clearer for users and the model) |
| T3-3 | Personal project tools preloaded for the focus project | At most 6, chosen by module order and recency |
| T3-4 | Keyboard shortcut | Pick one free in the shell, checked against existing bindings |

**Owner decisions:** D-05, D-06, D-08, D-09, D-10, D-17 (architecture §14).

---

## 13. Effort and PR split

| PR | Content | Estimate | Flag | Migration |
|---|---|---|---|---|
| 1 | WP3.0 ADR 0022 | 0.5 d | — | — |
| 2 | WP3.1 personal space | 2–3 d | `ORBIT_PERSONAL_ASSISTANT` | **yes** |
| 3 | WP3.2 cross-project capability + user tools + taint | 3–4 d | same | — |
| 4 | WP3.3 staged loading | 2–3 d | same | — |
| 5 | WP3.4 personal mode + WP3.5 inline decisions | 3–4.5 d | same | — |
| 6 | WP3.6 delegation + MCP fold-in | 2.5–3.5 d | same (+ `ORBIT_MCP_TASKS` for MCP) | **yes** |
| 7 | WP3.7 personal context | 1.5–2 d | same | — |
| 8 | WP3.8 web hook, panel, bubble | 3–4 d | same | — |
| 9 | WP3.9 docs and runbook | 0.5–1 d | — | — |
| | **Total** | **18.5–25.5 d** | | |

WP3.8 (web) can run in parallel with WP3.3–WP3.7 once WP3.4's API shape is fixed. Delivery follows the main workflow, with a schema hash for each migration.
