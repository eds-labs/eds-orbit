# System & Administration V2: one settings center for four scopes

Status: **decisions D-1 to D-9 taken by Mario on 2026-11-11, all as recommended ([ADR 0027](../adr/0027-settings-center.md)). Phases 2 and 3 are on `main` (flag `off`); phase 4 is on `main` since 2026-11-12 (flag `off`, section 9). Phase 5, rows 5.1 to 5.3 with the F-5 fix and the public access section, is on `main` since 2026-11-12 (branch `claude/settings-center-phase-5`, section 10); the production flag is unchanged (`off`). Row 5.4 and phase 6 are not implemented.** Written 2026-11-10. Base: `main` @ `6c0ac035`, worktree branch `claude/system-management-v2`. Task: EDS-Labs → EOP → #5.

This plan covers phase 1 of the task (analysis and target architecture) and the work plan for phases 2 to 6. The decisions are in [section 11](#11-decisions-mario-2026-11-11). Each phase gets its own implementation plan before code changes.

## 1. Goal and understanding

**Stated by Mario**

- One administration surface, "Verwaltung & Einstellungen", that adapts to the chosen scope (whole system, organization, project, my account) and to the member's permissions.
- Every setting has exactly one canonical place to edit it. Modules may link to central settings; they must not create a second, independent configuration.
- Existing backend services and data models come first. No rebuild of the connection or AI backends, no silent change to roles, permissions, credentials or stored configuration.
- System administrators do not automatically get protected project content. Secrets stay encrypted and are never read back.
- Incremental, backwards compatible, behind its own feature flag, German and English, in the existing Liquid Glass style, usable on desktop, tablet and phone.
- Old URLs, bookmarks, `?section=` links, OAuth returns and module deep links keep working.

**Assumptions made here (correct them if wrong)**

- "Core, not separately switchable" describes the end state. The flag in this plan is a temporary rollout switch that is removed in the last step; it is not a module.
- The settings center mounts the existing panels (connections, AI defaults, members, …) in a new frame wherever they already do the job. New code is the frame, the registry, the integrations catalog, the AI origin view and a handful of read-only endpoints.
- Where the data model has no organization-level or system-level setting today (for example an organization default for the project spending authority), the plan shows the real state and invents nothing.

## 2. Risk, environment, profile, workflow

| Item | Value |
| --- | --- |
| Risk level | **High.** The work touches the administration UI, role-dependent visibility, tenant boundaries and connection and AI configuration. No payment, no production secret change. |
| Reason | Roles and tenants are affected; new read endpoints cross projects for organization owners; forms that write AI configuration move. |
| Environment | Local and this worktree's own test database. Production only through the usual push to `main`, each step approved separately. |
| App profile | `fullstack-saas` (primary), with `web-frontend` and `backend-api` rules. |
| Workflow | `.agentic/workflows/feature.md` per phase; `refactor.md` for the removal in phase 5. No `migration.md`: the plan needs no schema change. |
| Approval needed | Yes: each push to `main` and each flag change in production. Decisions D-1 to D-9 are taken (section 11). |
| Stack decision | None. Existing stack, no new dependency. |

## 3. Inventory of today's settings surfaces

Sources: five read-only analyses of `main` (system/organization/account UI, project and module UI, connection backend, AI configuration, access control and tests). Server permissions were read from code, not exercised at runtime. `P` = `/api/projects/:projectId`, `act/x` = `POST P/actions/x`, `O` = `/api/organizations/:id`. "New location" is a path below `/manage` (section 5.2). "UI move" means: same component or same endpoints, no data migration.

### 3.1 System scope (`/admin…`, gate `me.systemAdmin`, flag `ORBIT_ADMINISTRATION`)

| ID | Current location | Owner (component) | Storage | API | New location | Migration | Duplicates / notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| S1 | `/admin` overview and system status | `administration/admin-area.tsx` `Overview` | control-plane tables; env for system mail | `GET /admin/overview` | `system/overview` | UI move | Status strings untranslated |
| S2 | `/admin` webmail status | `administration/admin-webmail.tsx` | env (`WEBMAIL_*`) | `GET /admin/webmail/status` | `system/overview` (status card) and `system/integrations` (e-mail, status only) | UI move | – |
| S3 | `/admin/integrations` | `administration/connections-ui.tsx` `ConnectionsPanel mode="admin"` | `Connection`, `ConnectionSecret`, `ConnectionGrant`, `WorkflowBinding` | `/admin/connections…`, `/admin/connection-grants/:id` | `system/integrations` | UI move, then catalog view on top | Nav says "Integrations", panel says "Connections" |
| S4 | `/admin/ai` | `ai-defaults-ui.tsx`, `ai-catalog-ui.tsx`, `ai-knowledge-ui.tsx` (`AiProfileEditor`) | `AiProfile`, `AiModelPrice` | `/admin/ai/defaults`, `/admin/ai/models`, `/admin/ai/profile` | `system/ai/{standard,models,advanced}` | UI move; profile editor becomes "advanced" | Three editors for the same runtime fields (finding F-7) |
| S5 | `/admin/mcp` | `administration/admin-mcp.tsx` | `OauthClient`, `McpGrant` | `/admin/mcp…` | `system/mcp` | UI move | MCP grants also in project settings (P11, O12) |
| S6, S7 | `/admin/users[/:id]` | `admin-area.tsx` `UserList`, `UserDetail` | Better Auth `user`, `session` | `/admin/users…` | `system/users[/:id]` | UI move | – |
| S8 | `/admin/invitations` | `admin-area.tsx` `Invitations` | invitation table | `GET /admin/invitations`; writes through `O/invitations/:id` | `system/users/invitations` | UI move | Writes use organization routes |
| S9, S10 | `/admin/organizations[/:id]` | `admin-area.tsx`, `organization-manager.tsx` | `Workspace`, `WorkspaceMember`, `ProjectMember` | `/admin/organizations`, `O…` | `system/organizations[/:id]` | UI move | Same component as O1 |
| S11 | `/admin/projects` | `admin-area.tsx` `Projects` | `Project` (metadata) | `GET /admin/projects` | `system/organizations/projects` | UI move | – |
| S12 | `/admin/audit` | `admin-area.tsx` `Audit` | `SystemAuditEvent` | `GET /admin/audit` | `system/security/audit` | UI move | Readable by system administrators only |

### 3.2 Organization scope (`/o/:id/settings`, one unsectioned page)

Page gate today: `canManage || systemAdmin`; O4 to O10 additionally need the organization role `owner` (server: `workspaceOwnerFor`).

| ID | Current location | Owner (component) | Storage | API | New location | Migration | Duplicates / notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| O1 | members × projects matrix, rename, invite | `organization-manager.tsx` | `Workspace`, `WorkspaceMember`, `ProjectMember`, `ProjectMemberModuleRole` | `O`, `O/members/:uid`, `O/projects/:pid/members/:uid` | `o/profile` (name), `o/members`, `o/projects` | UI move; split one page into three sections | Members also in S10 and project settings; two module-role editors |
| O2 | "Assistant allowed" column | `MemberAssistantSwitch` | workspace member flag | `PUT O/members/:uid/assistant` | `o/members` | UI move | – |
| O3 | open invitations | `InvitationList` | invitation table | `O/invitations…` | `o/members/invitations` | UI move | – |
| O4 | connections | `ConnectionsPanel mode="owner"` | as S3 | `O/connections…` | `o/integrations` | UI move, then catalog view | – |
| O5 | standard models | `AiDefaultsPanel` | `AiProfile.data.defaults` | `O/ai/defaults` | `o/ai/standard` | UI move | – |
| O6 | AI budget, provider caps, assistant cap | `AiBudgetPanel` | `OrganizationAiBudget` | `O/ai/budget` | `o/ai/budget` | UI move; keep anchor `#assistant-budget` | Provider limits exist in three mechanisms (F-7) |
| O7 | AI usage | `AiUsagePanel` | spend counters | `GET O/ai/usage` | `o/ai/usage` | UI move | – |
| O8 | models and prices | `ModelPricesPanel` | `AiModelPrice` | `O/ai/models…` | `o/ai/models` | UI move | – |
| O9 | AI profile (raw) | `AiProfileEditor` | `AiProfile` | `O/ai/profile` | `o/ai/advanced` (collapsed) | UI move plus a version check (4.3) | Overwrites `defaults` with a stale copy (F-8) |
| O10 | shared knowledge | `KnowledgeSharesPanel` | `KnowledgeShare` | `O/knowledge-shares…` | `o/knowledge` | UI move | Flag `ORBIT_KNOWLEDGE_SHARES` |
| O11 | `/o/:id/agents` | `agents/org-agents.tsx` | – | `GET /agents/summary` | stays (not a setting); linked from `o/overview` | none | Reachable only from the project agents page |
| O12 | organization's connected apps, shown in project settings `?section=apps` | `connect/connected-apps.tsx` | `McpGrant` | `/workspaces/:ws/mcp-grants` | `o/policies/apps` | UI move | Organization data inside project settings |
| O13 | organization-wide pause, shown on `/p/:id/operations` | `operator-tools.tsx` `WorkspacePause` | `Project.paused` | `POST /workspaces/:ws/pause` | `o/policies` | UI move; stays linked from Operations | English only, says "Workspace"; also pauses members' personal spaces, by design (F-12) |
| O14 | project creation in the picker | `shell/pickers.tsx` | `Project` | `POST /projects` | `o/projects` (and stays in the picker) | none | – |

### 3.3 Personal scope (`/account`, `/account/assistant`, flag `ORBIT_ACCOUNT`)

| ID | Current location | Owner (component) | Storage | API | New location | Migration | Duplicates / notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| P1 | profile: name, language | `account/account-view.tsx` | `user` (`locale`) | `GET\|PATCH /account` | `me/profile`, `me/preferences` | UI move | Language also in the top bar (P13) |
| P2 | e-mail change | `account-view.tsx` | `user` | `POST /account/email` | `me/profile` | UI move | – |
| P3, P4 | password, sessions | `account-view.tsx` | `user`, `session` | `/account/password`, `/account/sessions…` | `me/security` | UI move | – |
| P5–P8 | assistant switches, voice, context entries | `account/personal-context.tsx`, `assistant/voice.tsx` | assistant tables | `/assistant/context…`, `/assistant/voice-settings` | `me/assistant` | UI move | Only while the assistant is available |
| P9 | notifications, quiet hours, digest | `account/proactive-preferences.tsx` | assistant preferences | `/assistant/preferences` | `me/notifications` | UI move | – |
| P10 | personal Telegram | `proactive-preferences.tsx` (`TelegramPanel`) | `telegram_connections` (personal space) | `P/telegram/connect\|disconnect` | `me/connections` | UI move | Bot tokens in three places (F-3) |
| P11 | my connected apps, shown in project settings `?section=apps` | `connect/connected-apps.tsx` | `McpGrant` | `/mcp-grants…` | `me/connections` | UI move | Personal data inside project settings |
| P12 | per-project notification settings (bell modal) | `notification-bell.tsx` | notification preferences | `P/notification-preferences` | stays in the bell; listed and linked in `me/notifications` | none | – |
| P13 | top bar EN/DE toggle | `orbit.tsx` | `localStorage` | – | stays; also writes the account language when the account is on | small fix | Reverts after reload today |
| P14, P15 | `/invite`, `/reset-password`, `/account/confirm-email`, `/connect…` | token and consent pages | – | – | unchanged (not settings) | none | – |

### 3.4 Project scope: settings page (`/p/:id/settings?section=…`)

| ID | Section | Owner (component) | Roles today (UI; server) | Storage | API | New location | Migration | Duplicates / notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| J1 | `project`: summary, export, readiness, setup links | `components/management.tsx` | all members | – | `GET P/dashboard`, `P/export` | `p/overview`; export in `p/data` | UI move | Marketing content in a core panel |
| J2 | `project`: languages, profile links, name, timezone | `project-settings/project-configuration.tsx`, `project-administration.tsx` | owner edits (`PROJECT_OWN`) | project settings | `act/project-settings` | `p/profile` | UI move; three panels become one section | Three panels on one action |
| J3 | `project` → public keys | `components/public-keys.tsx` | owner | public key table | `P/public-keys…` | `p/integrations/public-access` | UI move | Support widget keys are separate (F-5) |
| J4 | `members`, module roles | `project-administration.tsx`, `module-roles.tsx` | owner | `ProjectMember`, `ProjectMemberModuleRole` | `P/members…`, `P/members/:uid/module-roles`, `P/invitations` | `p/members` | UI move; one module-role editor | Second editor in `organization-manager.tsx` |
| J5 | `integrations`: Google Drive | `components/google-drive.tsx` | owner acts | `drive_connection` entity; env OAuth app | `P/google-drive…` | `p/integrations/google-drive` | UI move; callback fix (5.4) | – |
| J6 | `integrations`: webmail mailbox access and grants | `modules/webmail/settings.tsx` | module owner | `WebmailMailbox`, `WebmailMailboxGrant` | `P/webmail/settings…` | `p/modules/webmail` (access); mailbox itself in `p/integrations/email` | UI move | Module section inside a platform tab |
| J7 | `ai` | `spend-policy.tsx`, `agent-mandates.tsx`, `ai-settings.tsx`, `ai-model-choice.tsx` | owner (`PROJECT_OWN`) | `ai_spend_policies`, `agent_mandates`, `openai_configuration` entities | `P/ai-spend-policy`, `P/agent-mandates`, `P/openai-configuration`, `P/ai-budget`, `act/ai-configure` | `p/ai/{overview,providers,models,budget,usage,agents}` | UI move plus safe-save fixes (4.3) | Most-linked section; ten save risks (F-8) |
| J8 | `retention` | `components/retention-control.tsx` | owner | – | `act/retention` | `p/data` | UI move | Really marketing memory; English only |
| J9 | `modules`: switches, proactive notices | `module-settings.tsx`, `signal-settings.tsx` | owner switches | `ProjectModule`, signal settings | `P/modules…`, `P/signal-settings` | `p/modules` | UI move | – |
| J10 | `policy`, `brand` | `modules/marketing/settings-sections.tsx` | owner edits | `policies`, marketing profile | `P/policies`, `P/marketing-profile` | `p/modules/marketing/{policy,brand}` | UI move | Two editors PUT the same profile |
| J11 | `work` | `modules/work/settings.tsx`, `pm-settings.tsx` | module owner | module settings | `P/work/settings`, `P/work/pm/settings` | `p/modules/work` | UI move | PM budget is an AI ceiling (F-6) |
| J12 | `issues` | `modules/issues/settings.tsx` | module owner | module settings, inbound sources | `P/issues/settings`, `P/issues/sources` | `p/modules/issues`; sources and GitHub listed in `p/integrations` | UI move | Triage ceiling is an AI ceiling |
| J13 | `support` | `modules/support/settings.tsx` | project owner | `SupportInbox`, support settings | `P/support/inboxes…`, `P/support/settings` | `p/modules/support` | UI move | Uses the project role, not the module role |
| J14 | `finance-*` (five sections) | `modules/finance/settings.tsx` | finance owner | finance tables | `P/finance/…` | `p/modules/finance/{mailboxes,accounts,cost-centers,currencies,ai}` | UI move | Mailbox binding (F-2), AI ceiling (F-6) |

### 3.5 Project scope: connectors page and configuration elsewhere

| ID | Current location | Owner (component) | Storage | API | New location | Migration | Duplicates / notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| C1 | `/connectors`: Postiz, Matomo, Slack | `modules/marketing/connectors.tsx` via `management.tsx` | `connectors` entity (legacy) or central binding | `GET P/connectors`, `act/connector`, `act/connector-health`, … | `p/integrations/{postiz,matomo,slack}` | UI move | Vanish when Marketing is off although they are project connections |
| C2 | `/connectors`: granted connections | `components/granted-connections.tsx` | `ConnectionGrant`, binding in `connectors` | `GET P/connections`, `act/connector-attach` | `p/integrations` (state "granted, not bound") | UI move | – |
| C3 | `/connectors`: Telegram owner bot | `telegram-connection.tsx` | `telegram_connections` | `P/telegram…` | `p/integrations/telegram` | UI move | F-3 |
| C4 | `/connectors`: mailboxes | `email-connection.tsx` | `connectors` entity, provider `email` | `GET P/email`, `act/email-connect\|disconnect` | `p/integrations/email` | UI move | Mailboxes in four places (F-2) |
| C5 | `/connectors`: customer context | `customer-context-connection.tsx` | `connectors` or central | `act/customer-context-connect…` | `p/integrations/customer-context` | UI move | Binding in the support inbox form |
| C6 | `/p/:id/social/accounts` | `modules/social/accounts.tsx` | `SocialAccount` plus project `Connection` | `P/social/accounts…` | `p/integrations/social` (canonical, D-6); the module page keeps the list and links there | UI move by contribution | Connection management inside a module |
| C7 | `/p/:id/knowledge/github` | `modules/knowledge/github-page.tsx` | `knowledge_github_*` entities | `act/knowledge-github-configure` | `p/integrations/github` (linked; with `on` the Knowledge tab shows state and a link, the page itself stays until row 5.4) | UI move by contribution | Second GitHub App next to the central `github_app` |
| C8 | `/p/:id/marketing/analytics`: Matomo import and schedule | `modules/marketing/insights.tsx` | module data | `act/import-matomo`, `act/configure-matomo-schedule` | stays (module-specific use of a connection) | none | – |
| C9 | `/p/:id/operations`: project pause | `management.tsx` | `Project.paused` | `act/pause` | stays; linked from `p/data` | none | – |
| C10 | `/p/:id/ads/accounts` | placeholder | `AdAccount` (no provider registered) | – | not listed as an integration until built | none | Declared only |

### 3.6 What exists only as environment configuration

Shown as "configured / missing" plus health, never editable (ADR 0014, decision 9): system mail (`ORBIT_SYSTEM_SMTP_*`), database and Redis, `AUTH_SECRET`, `CREDENTIAL_KEY(S)`, files storage (`FILES_*`), the Google Drive OAuth app (`GOOGLE_DRIVE_CLIENT_*`), the AI fallback keys, webmail (`WEBMAIL_*`) and the MCP switches. Today the overview reports only database, worker, system mail and version.

## 4. Findings that shape the design

### 4.1 Duplicates and unclear ownership

| # | Finding | Resolution in V2 |
| --- | --- | --- |
| F-1 | Three connection surfaces per project: `/connectors`, Settings → Integrations, module pages. Error links for Postiz, Telegram and Matomo point to a section that has none of those cards. | One list: `p/integrations`. |
| F-2 | Mailboxes in four places: created on `/connectors`, bound in Finance, chosen in the Support inbox form, granted in webmail. | The mailbox (credentials, check) lives in `p/integrations/email`. Modules keep only "which mailbox do I use" and link to it. |
| F-3 | Telegram bot tokens in three places (project bot, Social channel bot, personal bot). | Three different records by design; each listed once in its scope (`p/integrations`, `me/connections`), named distinctly. |
| F-4 | Members, roles and invitations in three places; two module-role editors. | One editor component; organization scope edits all projects, project scope its own. |
| F-5 | Public keys and Support widget keys are issued in two places. They share one store (established 2026-11-11, see below; phase 5 relies on it and fixes the revoke path). | Verified 2026-11-11: one store. Support widget keys are `PublicClientKey` rows with `moduleId: "support"`, issued through the platform's `createPublicKey` (`enableWidgetKey` in `support/widget.ts`); the project's public keys list (`listPublicKeys` in `public-api.ts`, shown by `public-keys.tsx`, which prints `moduleId`) has no module filter and shows them too, so a widget key appears on two pages and either can revoke it (both call `revokePublicKey`). Revoking on the public keys page does not clear `SupportInbox.publicClientKeyId`, so the inbox keeps pointing at a revoked key until its widget key is enabled again or removed: the widget answers 404 after its key was revoked on the public keys page until the inbox gets a new key. The public keys page can also create a `support` key that no inbox references. No change in phase 3 (the center has no public-access section yet and the old panel stays unchanged); phase 5 lists each key once under `p/integrations/public-access` and marks widget keys as managed by their inbox. **Fixed in phase 5 (on `main` since 2026-11-12):** revoking a key releases the reference of the module that uses it in the same project transaction, so the Support inbox shows no key instead of a dead one; a revocation is never vetoed; the keys list says who uses each key (`usedBy`, for Support the inbox name). |
| F-6 | AI ceilings in five places (project AI, Finance, Work PM, Issues triage, Support daily budget). | They stay module settings. `p/ai/budget` shows all of them read-only with links ("who may spend what"). |
| F-7 | AI at organization and system level: three editors each for model tiers, prices and provider limits; all three provider-limit mechanisms are enforced independently. | One guided editor per concept; the raw profile editor becomes a collapsed "advanced" section. The guided UI edits the organization caps (D-7). |
| F-8 | Ten save risks in the AI forms, for example: a first save freezes environment defaults into the project; saving a provider budget on an "organization standard" project rewrites the stored default provider; the route form deletes routes of tasks it does not show; the profile editor writes back a stale `defaults`; the setup wizard's last step replaces an existing spending authority. | Fixed with regression tests **before** any AI form is mounted in the new frame (phase 4, work package 4.3). |
| F-9 | Scope mixing: personal and organization MCP grants and the organization-wide pause sit in project pages. | Moved to their scopes (O12, O13, P11). |
| F-10 | Language is set in two places and the top bar choice reverts after reload. | The toggle also saves the account language. |

### 4.2 Security findings (code reading; not exercised at runtime unless stated)

| # | Finding | Evidence | Proposal |
| --- | --- | --- | --- |
| F-11 | A system administrator passes `organizationManagerFor` for every organization and can make any user, themselves included, owner of a project or of the organization. The action is audited, but only system administrators can read that audit. ADR 0013 does not forbid it. | `administration/authz.ts:36-49`, `routes.ts:217-251`, `memberships.ts:204-239`; access-matrix fixture `sysadmin: allowed` | Kept in V2, with a confirmation that names the consequence (D-8). V2 changes no permission. |
| F-12 | **Not a defect (checked 2026-11-11).** `POST /api/workspaces/:id/pause` also pauses the members' personal spaces. ADR 0022 decides exactly that: "Pausing the personal space pauses only the assistant; an organization pause pauses it too." The response lists the paused project ids, personal spaces included; the web does not read them. | `server.ts:1078-1107`; `docs/adr/0022-personal-space-assistant.md` (line 18); `docs/ORBIT_ASSISTANT.md` (line 28) | No change. The V2 page for the organization pause says that members' assistants pause too. |
| F-13 | **Confirmed and fixed (2026-11-11, on `main` since `4aa82f83`).** `GET P/invitations` returned, for each invitation, every project it covers, so a project owner who is not organization owner saw other projects' names and roles. Resend and revoke were already limited correctly. | `administration/routes.ts:321-329`; failing test first in `administration.integration.test.ts` | Fixed outside V2: a project owner gets only their own project's part; the organization owner still gets the whole invitation. |
| F-14 | The administrator's password reset returns the link to the administrator whenever system mail did not send. | `platform/account/service.ts:229-257` | Kept in V2 (D-8). |
| F-15 | Organization pages use two guards: members and invitations admit system administrators, connections, AI and shares admit owners only. The web mirrors this by hand. | `authz.ts:36-84`, `organization-integrations.tsx:24-27` | The capabilities endpoint (5.5) states it per section, from the same guard functions. |
| F-16 | New route prefixes are not flag-gated until a predicate and a hook line exist. | `server.ts:377-427` | Phase 2 adds the predicate with a rule test; the access matrix covers every new route. |
| F-17 | `GET P/connectors` is open to viewers and removes only `encryptedCredential`; connection `config` is free-form. | `platform/shared.ts:246-249`, `administration/connections.ts:126-149` | New read endpoints use explicit allow-lists of fields; no change to the existing route in V2. |

No place was found in project settings where the UI is the only gate.

### 4.3 Backend facts the UI must respect

- A system administrator who is not a member gets 404 on every `/api/projects/:id/…` route, and administration code may use only the control-plane database role (`administration-boundary.test.ts`). Any cross-project read for administrators would break this boundary.
- Central connections: an administrator edits only `scope = system` connections; an owner only their organization's. Grants: system → organization (always with a budget for paid providers) → project. Revoking a grant makes the connection invisible on the next transaction.
- Real providers in code: `openai`, `anthropic`, `n8n`, `customer_context`, `github_app`, `email`, `postiz`, `matomo`, `slack` (partial, no check), `social.app.meta`, `social.app.x` (no check), `social.account.{x,facebook,instagram,telegram}`, `issues_webhook`; outside the registry: Google Drive, the Telegram owner bot, Knowledge GitHub, the MCP server. **Not built:** TikTok, LinkedIn, YouTube, Threads, an MCP client for external servers, Ads accounts.
- No uniform status exists. Central connections use `configured | read_verified | write_verified | failed` (+ disabled); social accounts `active | reconnect_required | disabled`; Drive booleans; Telegram `none | pending | linked | disabled`.
- Project-stored AI keys are never verified against the provider; only central connections have a check. A `failed` central connection is still used at runtime.
- AI inheritance exists for keys, model fields, prices and provider budgets. It does **not** exist for the spending authority, agent mandates, agent definitions and module ceilings (project only), and there is no system-level organization budget. A saved "custom" project configuration masks every organization model field; real inheritance after a save exists only with `routing.source = "organization"`.
- The web learns flags from `/api/me`, from `P/modules` and by probing for 404. There is no single capabilities object.

## 5. Target architecture

### 5.1 Ownership rule

| Kind | Canonical place | Modules may |
| --- | --- | --- |
| Credentials, connections, developer apps, grants, connected accounts | Integrations, in the scope that owns the record | show state and link to it; choose which connection they use |
| AI providers, models, prices, budgets, spending authority, agent permissions | AI area, in the owning scope | keep their own ceilings; link to the AI area |
| Members, roles, module roles, invitations | Members (organization or project) | – |
| Module behaviour (inbox rules, brand profile, publishing rules, accounts and categories, workflow) | the module's section under `…/modules/<module>` | be reached from the module's sidebar "Settings" link |

### 5.2 Navigation and URL scheme

One entry "Verwaltung & Einstellungen" / "Administration & settings": in the user menu (replacing Account, Organization settings, Administration) and as the project sidebar's settings entry. Module groups keep their "Settings" link; it opens the module's section.

```
/manage                                  → the member's default scope (open project, else account)
/manage/system[/<area>[/<section>[/<id>]]]
/manage/o/:orgId[/<area>[/<section>]]
/manage/p/:projectId[/<area>[/<section>]]
/manage/me[/<area>]
```

Sections are path segments, so every section has a stable address; `?section=` survives only as a redirect source. `manage` joins the reserved first segments in `routes.ts`.

| Scope | Areas (in order) |
| --- | --- |
| System | Overview & status · Users (incl. invitations) · Organizations & projects · Integrations · AI (standard, models & prices, advanced) · MCP · Security & audit |
| Organization | Overview · Profile · Members (incl. invitations) · Projects · Integrations · AI (providers, standard, models & prices, budget, usage, advanced) · Knowledge · Policies (organization-wide pause, connected apps) |
| Project | Overview · Profile · Members · Modules (switches, then one section per enabled module) · Integrations · AI (overview, providers, models, budget, usage, agents) · Data (retention, export, pause link) |
| My account | Profile · Security (password, sessions) · Language & display · Connections (connected apps, personal Telegram) · Notifications · Assistant |

"Policies" at organization level and "Language & display" hold only what exists today. An area without a visible section is not shown.

**Scope switcher.** A labelled control at the top of the frame: "Whole system" (system administrators only), one entry per organization the member owns, one per project the member belongs to (grouped by organization), "My account". It always names the open organization or project. A system administrator reaches a foreign organization through System → Organizations, as today, not through the organization scope (D-9).

**Frame.** The same layout on all four scopes: scope switcher and search on top, grouped section list on the left (the existing `SettingsNav` pattern, 208 px, a select at 760 px and below), content on the right, one page head with a short explanation per section, advanced settings in collapsed disclosures. A "back to …" link returns to the project or picker. The project scope uses the same frame, without the project sidebar (D-2).

**Search.** Client-side over the registry entries the member can see (label, description, keywords, both languages). No server search, no content search.

### 5.3 Old URL → new URL

Applied only when the flag is `on` (5.7). Search and hash are kept unless mapped.

| Old | New |
| --- | --- |
| `/admin` | `/manage/system/overview` |
| `/admin/integrations`, `/admin/ai`, `/admin/mcp`, `/admin/audit` | `/manage/system/integrations`, `…/ai`, `…/mcp`, `…/security/audit` |
| `/admin/users[/:id]`, `/admin/invitations` | `/manage/system/users[/:id]`, `…/users/invitations` |
| `/admin/organizations[/:id]`, `/admin/projects` | `/manage/system/organizations[/:id]`, `…/organizations/projects` |
| `/o/:id/settings` | `/manage/o/:id/overview`; `#assistant-budget` → `/manage/o/:id/ai/budget#assistant-budget` |
| `/account`, `/account/assistant` | `/manage/me/profile`, `/manage/me/assistant` |
| `/p/:id/settings` | `/manage/p/:id/overview` |
| `…?section=members` | `/manage/p/:id/members` |
| `…?section=integrations`, `…?googleDrive=…` | `/manage/p/:id/integrations`; with `googleDrive` (alone or with `section=integrations`): `/manage/p/:id/integrations/google-drive?googleDrive=…` (P5-D4, see the note below the table) |
| `…?section=ai`, `…?section=policy` when Marketing is off | `/manage/p/:id/ai` |
| `…?section=retention` | `/manage/p/:id/data` |
| `…?section=modules` | `/manage/p/:id/modules` |
| `…?section=apps` | `/manage/me/connections` |
| `…?section=policy`, `brand` | `/manage/p/:id/modules/marketing/policy`, `…/brand` |
| `…?section=work`, `issues`, `support` | `/manage/p/:id/modules/<module>/settings` |
| `…?section=finance-<x>` | `/manage/p/:id/modules/finance/<x>` |
| `/p/:id/connectors` | `/manage/p/:id/integrations/connections` (P5-R2: the section that mounts the panel the old page showed; this row printed the catalog before) |
| `/settings…`, `/connectors` (pre-WP1.7 legacy) | resolved to the last project as today, then mapped as above |
| `/p/:id/social/accounts?connected=…\|error=…` | `/manage/p/:id/integrations/social/accounts` with the search kept; the table maps it, and with the flag `on` the Social accounts page also forwards a result it receives (see the note below the table) |
| `/connect…`, `/invite`, `/reset-password`, `/account/confirm-email`, `/data-deletion` | unchanged |

Differences between the table above and phase 5 as built (the table is `apps/web/src/platform/settings-center/redirects.ts`; its literal rows are in `apps/web/src/platform/settings-center/redirects.test.tsx`):

- Google Drive return (P5-D4): `?googleDrive=<value>`, with or without `section=integrations`, lands on the project's Google Drive section, `/manage/p/:id/integrations/google-drive?googleDrive=<value>`, not on the catalog. The `section` parameter is dropped.
- Connectors (P5-R2): `/p/:id/connectors` lands on `/manage/p/:id/integrations/connections`.
- Administration sections with an id (P5-R1): `/admin/users/:id` and `/admin/organizations/:id` keep the id. For any other section, `/admin/<section>/<id>` lands on the section and drops the id, because the old shell showed that section and ignored the id.
- Module settings: a module tab key maps to `/manage/p/:id/modules/<module>/<section>`. A key a module shares with a platform tab follows the platform row. Only `policy` has a moved target (`ai`), used while Marketing is off in that project; while that is not known yet the redirect waits. The address of a module that is off or whose settings the member may not use still maps to the module's address in the center, which says the settings are not available; it never leads back to the old page.
- Fallback (P5-D5): a redirect needs the member to be able to open the target. When the member lacks the target area, it goes to the first area of that scope they can open, and search and hash are dropped. When the scope is not available to the member (its flag is off or they hold no capability in it), the old page stays, so a non-administrator on `/admin` sees "not found" as before. While the member's capabilities load, the shell shows its loading screen; if they cannot be read, the old page stays.
- Social accounts: the table maps the OAuth return to `/manage/p/:id/integrations/social/accounts`, and with the flag `on` the Social accounts page itself forwards a result it receives with `router.replace`. The page without `connected` or `error` stays and shows the accounts and a link (section 10, row 5.2).
- Every redirect uses `router.replace`; a `/manage…` address is never mapped; the table leaves every other address alone (`/connect…`, `/invite`, `/reset-password`, `/account/confirm-email`, `/data-deletion`, `/o/:id/agents`, module pages).

Links sent by the API (attention items, signals, run notices: `/settings?section=ai`, `policy`, `finance-mailboxes`, `finance-currencies`) keep their old form until row 5.4 (not implemented) and resolve through this table; the table stays permanently.

### 5.4 Google Drive return

The callback redirects to `${APP_ORIGIN}/settings?googleDrive=…` without the project, although it knows the project from the OAuth state. The browser then lands in the last project stored in `localStorage`, which can be another project. Phase 3 (task 3.7, done) changes the redirect to `/p/<projectId>/settings?googleDrive=…`, with the id of the project the member's access was checked against, not a query value. That address works with the old page and, through 5.3, with the new one.

### 5.5 Web components (`apps/web/src/platform/settings-center/`)

| File | Purpose |
| --- | --- |
| `types.ts` | `ManagementScope`, `ManagementSection`, `IntegrationContribution`, capability types |
| `registry.ts` | builds and validates the section table (unique ids per scope, known areas, known modules); adapts today's `SettingsSection` contributions |
| `platform-sections.tsx` | the platform's own sections per scope, mounting existing panels |
| `routes.ts` | parse and build `/manage` URLs; `legacy-redirects.ts`: the table of 5.3 as a pure function |
| `settings-center.tsx`, `layout.tsx`, `scope-switcher.tsx`, `navigation.tsx`, `overview.tsx`, `search.tsx` | the frame |
| `capabilities.ts` | hook over the capabilities endpoint |
| `integrations/` | catalog, provider card, provider detail, setup wizard, status mapping |
| `ai/` | AI area per scope, origin badge, effective-configuration view, readiness |
| `texts.ts` (and one per subfolder) | German typed against the English keys, like `project-settings/texts.ts` |

The registry entry:

```ts
type ManagementSection = {
  id: string;                    // URL segment, unique per scope and area
  scope: "system" | "organization" | "project" | "account";
  area: string;                  // "integrations", "ai", "modules", …
  moduleId?: string;             // owning module; the platform when absent
  label: Label;
  description: Label;            // shown on overviews and in search
  keywords?: Label;
  order: number;
  access: Access;                // required capability, checked against the server's answer
  advanced?: boolean;            // collapsed by default
  provider?: string;             // connection provider this section configures
  legacy?: readonly string[];    // old ?section= keys that redirect here
  useSection(): { content: ReactNode; label?: Label; notice?: ReactNode } | null;
};
```

`WebModule.settings` keeps working: the adapter turns each contribution into a project-scope section under `modules/<moduleId>`. A module's sections are collected only while the module is shown for the project (`moduleShown`: enabled, access not `none`, `minAccess` reached), as today. `WebModule.connectors` is generalized to `WebModule.integrations` so a module can contribute its provider UI (Postiz, Matomo, Slack, social accounts, Knowledge GitHub) without the shell importing the module (`scripts/boundaries.json`).

`orbit.tsx` gets one new place kind (`manage`). The project scope needs the same project context the project pages have. The shell resolves the project of `/manage/p/:projectId` exactly as it does for a project page, so the context (`orbit.tsx:348-417`) is reused where it is and no shell code moves.

### 5.6 API additions (`apps/api/src/platform/management/`)

All are **read-only**, need no schema change and no new permission, return explicit field lists, sit behind the rollout flag and are added to the access matrix. They reuse existing guards and services.

| Endpoint | Guard | Returns | Why it is needed |
| --- | --- | --- | --- |
| `GET /api/management/capabilities` | session | per scope: which areas and sections the caller may open and edit (system: administrator; organization: per section `manage`/`none`, from `organizationManagerFor` and `workspaceOwnerFor`; projects: role and module access), plus the flags that hide areas | One source for navigation, switcher and search instead of probing; closes F-15. A hint only: every route keeps its own check. |
| `GET /api/management/integrations/catalog` | session | every provider that has code: id, category, auth type, scopes, checkable, where it is stored, and `available: true` only for a registered adapter whose module is installed | The existing catalog lists central providers only. Availability comes from the registry, so nothing unbuilt can appear as ready. |
| `GET /api/projects/:id/integrations` | `PROJECT_READ` (state); owner for details | one list of the project's integrations with a uniform state: granted central connections and bindings, project connectors, mailboxes, Drive, Telegram, social accounts, GitHub, webmail | Today six endpoints and four vocabularies. Module-owned parts come through module contributions on the server. |
| `GET /api/organizations/:id/integrations/usage` | `workspaceOwnerFor` | per connection: the projects that actually bind it; per project: its project-level integrations (metadata only) | "Which projects use this connection" is not answerable today. Organization owners are owners of every project, so no boundary changes. **Not** offered to system administrators (D-4). |
| `GET /api/projects/:id/ai/effective` | `PROJECT_OWN` | for each model field, key and provider budget: stored value, effective value, origin (environment, system, organization, preset, project), whether a project exception is active; readiness per provider as stored / verified / ready | The UI requirement "value, origin, inherited or not" cannot be met from existing HTTP routes. The logic exists as `readAiModels` behind MCP and moves into a shared service. |
| `GET /api/organizations/:id/ai/projects` | `workspaceOwnerFor` | per project: follows the standard or overrides it (which parts), own keys or granted, spending authority state | "What else is affected" before an owner changes a standard. |
| `GET /api/admin/overview` (existing route, more status fields) | `systemAdminFor` | configured / missing and health for Redis, files storage, Drive OAuth app, AI fallback keys, key ring, MCP switches, cutover list | Section 3.6. Names and booleans only. |

Two small changes to existing writes, both additive: the AI profile `PUT` accepts an expected version (the column exists) and answers 409 on a stale copy (F-8); the Drive callback redirect (5.4).

### 5.7 Feature flag

`ORBIT_SETTINGS_CENTER` with three values, default `off`:

| Value | Effect |
| --- | --- |
| `off` | Nothing changes. `/manage` and the new endpoints answer 404. |
| `preview` | The center is reachable (user menu entry, `/manage`). All old pages and links stay as they are. |
| `on` | The navigation points to the center and old URLs redirect (5.3). |

The web learns the value from `/api/me`. The scopes follow their existing flags: system and organization need `ORBIT_ADMINISTRATION`, the account `ORBIT_ACCOUNT`, integrations and central AI `ORBIT_CONNECTIONS`. The flag is added the way earlier flags were (config schema, `.env.example`, both compose files and their hash, `scripts/check-coolify-compose.mjs`, a route predicate in the `onRequest` hook with a rule test, the access-matrix environment). It is removed in phase 6 together with the old pages.

### 5.8 Integrations center

**Catalog.** Cards by category: e-mail, social media, Google, AI providers, automation, MCP, development, analytics. Each card shows name, description, connection type, scope, state and last check, linked accounts, projects using it, purposes, and the actions the caller may take (connect, check, renew, disconnect). TikTok and an external MCP client appear in a separate "not available yet" group without actions.

**Uniform state** (mapped from the existing vocabularies, no data change):

| State | Meaning | Maps from |
| --- | --- | --- |
| not set up | no record | – |
| stored | credentials saved, never checked | `configured`; project AI key present |
| verified | last check succeeded | `read_verified`, `write_verified`; social `active`; Telegram `linked` |
| ready | verified and usable for its purpose here (grant active, bound, account or channel assigned) | derived |
| needs attention | check failed or re-consent needed | `failed`, `reconnect_required`, Drive `reconnectRequired` |
| disabled | switched off or revoked | `disabled`, `revokedAt` |

**Setup wizard.** Six steps over the existing writes; no new write path:

| Step | Existing call | Who |
| --- | --- | --- |
| 1 Choose provider | catalog | anyone who may set it up |
| 2 Configure connection or developer app | `POST …/connections` (central) or the provider's project action | administrator (system), owner (organization), project owner |
| 3 Check | `POST …/connections/:id/check` or `act/connector-health` | same |
| 4 Authorize organization and projects | `POST …/connections/:id/grants` | administrator → organization; owner → projects |
| 5 Assign account or channel | `act/connector-attach`, `PUT …/channels`, social account connect | project owner |
| 6 Validate | check again plus the uniform state | same |

Each step names who can do it. A member does the steps their role allows and gets a link for the rest. The developer app, the central connection, the grant and the connected account stay four records.

**E-mail.** Today a mailbox is one project-level record that holds server, address and password; there is no separate mail server record, and mailboxes are not part of the central connections by an earlier decision. V2 separates them in the UI: mailboxes are grouped by server, and adding a second mailbox on the same server reuses host, port and TLS. Mailboxes shared across projects need `email` as a central provider at organization scope; that is a backend change with a cutover and is not part of V2 (D-5). System mail stays a status display.

### 5.9 AI area

| Sub-area | System | Organization | Project |
| --- | --- | --- | --- |
| Providers | system connections, fallback key status | own and granted connections | origin of each key (project, granted, environment), stored / verified / ready |
| Models | standard, models & prices | standard, models & prices | follow the standard, a preset, or own choice; per-task deviations; fallback; image model |
| Inheritance | – | which projects follow or override | every value with its origin badge and "exception active" |
| Costs | connection budgets, organization grants | organization budget, provider caps, assistant cap, usage | spending authority, provider budgets, usage; module ceilings read-only with links |
| Agents | – | – | agent permissions (mandates), agent ceilings against the authority |

Rules for the forms:

- Each form saves only the fields it shows, built from the **stored** value, never from the effective one. Where the API replaces whole objects, the form resends the stored remainder unchanged.
- No control is preselected in a way that writes on save without the member touching it (price check date, catalog apply, prefilled budgets, the wizard's USD 10).
- A project that follows the organization standard cannot edit model fields; it can switch to a preset or its own choice, which is the permitted exception. Spending authority and agent permissions stay project settings.
- Saving any AI configuration stops running work before its next paid call (route version). Organization and system forms say how many projects that touches before the save.
- Existing profiles and project configurations are not rewritten by opening or moving anything.

This replaces phase D of `docs/plans/ai-central-management.md` (project page rebuild). Phase E (removing project keys and prices) is **not** part of V2.

## 6. Phase 1: analysis and target architecture (this document)

| Step | Result |
| --- | --- |
| 1.1 | Inventory and mapping: sections 3 and 5.3. |
| 1.2 | Target architecture: section 5. |
| 1.3 | Done 2026-11-11: ADR 0027 "Settings center" (amends ADR 0013 decision 1 for the URLs; records D-1 to D-9). The entries in `docs/IMPLEMENTATION_STATUS.md` and `docs/REQUIREMENTS_TRACEABILITY.md` follow with the first delivery to `main`. |

Acceptance: Mario decided D-1 to D-9 on 2026-11-11.

## 7. Phase 2: settings center frame

Status (2026-11-11): implemented and delivered to `main` with the flag `off`; not enabled in production.

Implementation plan: [2026-11-11-settings-center-phase-2.md](../superpowers/plans/2026-11-11-settings-center-phase-2.md).

| WP | Work | Tests |
| --- | --- | --- |
| 2.1 | Flag `ORBIT_SETTINGS_CENTER` (5.7); `/api/me` field; route predicate and rule test. | flag `off` → 404 before authentication; compose check; access matrix |
| 2.2 | `GET /api/management/capabilities` (5.6). | integration test per role: system administrator without membership, organization owner, project owner, editor, viewer, outsider, module role `none`, disabled module; answers match the route guards |
| 2.3 | Web: `/manage` place in `routes.ts`, registry, frame, scope switcher, navigation, search; `orbit.tsx` resolves the project of `/manage/p/:id` like a project page. | unit: URL parse/build, registry validation, visibility per capability, search; `routes.test.tsx` |
| 2.4 | Platform sections for all four scopes that mount the **existing** panels unchanged (members, connections, account, modules, retention, MCP, audit). The AI areas link to the existing AI pages until 4.3 is done. New read-only overviews per scope. A confirmation that names the consequence before a system administrator assigns an organization or project role (D-8). | unit per scope; `settings-nav.test.tsx` stays green; the confirmation is shown to administrators only |
| 2.5 | Adapter for `WebModule.settings`; module sections appear under `p/modules/<module>`. | unit: disabled module, access `none`, `minAccess` |
| 2.6 | Texts in German and English; keyboard and screen-reader pass; 1440, 768 and 390 px. | parity test for the new text files in both directions; Playwright `settings-center.spec.ts` (flag `preview`) |

Acceptance: with the flag at `preview`, all four scopes are reachable through one navigation; each member sees only permitted scopes and sections; every old page still works unchanged; with the flag `off` nothing differs from today.

## 8. Phase 3: integrations center

Status (2026-11-11): implemented and delivered to `main` with the flag `off`; not enabled in production. Implementation plan: [2026-11-11-settings-center-phase-3-integrations.md](../superpowers/plans/2026-11-11-settings-center-phase-3-integrations.md); state of the work in `docs/IMPLEMENTATION_STATUS.md`.

Deviations from the table below, decided during the implementation:

- The setup "wizard" (3.6) is steps with a link to the section that edits the entry, and a "Refresh state" button, not a click-through wizard. It mounts no form: decided by Mario on 2026-11-11 ("Einrichtung auf Link zum Abschnitt Verbindungen reduzieren"), one canonical place per setting, the `connections` section (in a project the section the card's "Manage" leads to). It shows only the steps that apply to the provider ("Authorize" and "Assign" only on a central path the installation supports, never for project-only providers or a project running its own record), and steps a scope cannot observe (system: assign and validate; organization: validate) say "Follows in the project".
- A project shows no card and no setup for an entry the member cannot use there (the answer's `unavailable`: module off or hidden, owner-only state); the catalog's `centralUsable` gates every central-path offer (P3-R28).
- A catalog card links to "Manage" only where that page manages the provider; otherwise it says "Managed in its module.". The provider detail of 3.5 is the card plus the guided setup; the existing cards were not moved.
- The organization usage route is `GET /api/management/organizations/:workspaceId/integrations`, the project list `GET /api/management/projects/:projectId/integrations` (both under the flag's `/api/management` prefix).
- `/api/projects/:projectId/operations` keeps its old fields; the environment status is shown to administrators only.
- Each module contribution of the project list reads in its own savepoint.

Moved to phase 5 (or later): the public-access section with the F-5 fix (a widget key revoked on the public keys page leaves its inbox pointing at it), redirects of old addresses, mailboxes shared across projects (D-5), project AI keys in the integrations list (phase 4) and the organization's name on system catalog cards.

| WP | Work | Tests |
| --- | --- | --- |
| 3.1 | Catalog endpoint; server-side descriptors for integrations outside the provider registry (Drive, Telegram owner bot, MCP server, Knowledge GitHub, webmail), contributed by their owners. | availability follows the registry and module installation; nothing unbuilt is `available` |
| 3.2 | `GET P/integrations` with the uniform state; module contributions for social accounts and the Marketing connectors. | per role; disabled module hides its entries; revoked grant, disabled connection, failed check, `reconnect_required` map to the right state; no secret or free-form `config` in the answer |
| 3.3 | `GET O/integrations/usage`. | owner only; system administrator and other organizations get 404; cross-organization negative test |
| 3.4 | System status fields (3.6). | names and booleans only; administrator only |
| 3.5 | Web: catalog, provider detail, `WebModule.integrations`, the three scope pages (`system`, `o`, `p`). The existing cards move in as provider details. | unit; Playwright with test connectors |
| 3.6 | Setup wizard over the existing writes (5.8). | wizard runs against the test transports only; no external write in tests |
| 3.7 | Drive callback with the project in the redirect (5.4); verify F-5 (public keys and widget keys). | OAuth return opens the right project in the old and the new UI |

Acceptance: a Matomo or Postiz connection is created, checked, granted and bound from the center alone, at organization and project level; a system connection is granted to an organization and from there to a project; existing connections keep working (`connection-cutover`, `connections`, `social-accounts` suites unchanged and green).

## 9. Phase 4: central AI configuration

Status (2026-11-12): implemented and delivered to `main` with the flag `off`; not enabled in production. Implementation plan: [2026-11-11-settings-center-phase-4-ai.md](../superpowers/plans/2026-11-11-settings-center-phase-4-ai.md); state of the work in `docs/IMPLEMENTATION_STATUS.md`; the effective read and the safe saves in [MODEL_ROUTING.md](../MODEL_ROUTING.md), "Effective read and safe saves".

Deviations from the table below, decided during the implementation (rulings P4-R1 to P4-R13 of the phase's ledger):

- P4-R1: modules contribute their AI ceilings as an optional `WebModule.aiCeilings` (Finance, Issues, Support, Work), collected for the project's shown modules like phase 3's `integrations`; the project budget section lists them read-only with links.
- P4-R2: `GET /api/management/capabilities` carries `flags: {connections, aiCatalog, aiDefaults, aiOrgBudget}`; sections read them from the capabilities they already receive instead of a second prop.
- P4-R3: before a first save the Claude dialog with empty tier fields still sends the view's Claude tiers: a first save creates the whole configuration from the view and the member confirms it with the first-save box (risk 1 guarded, not removed).
- P4-R4: `connection_disabled` and `keys.<k>.connection.disabled` stay in the effective answer, but a disabled connection is not visible to a project today, so the key reads as the next source or as none.
- P4-R5: three origin rules follow the runtime instead of the plan's table: under a preset only the preset provider's tiers and the default provider are `preset`; a layer's task routes replace the lower layer's as a whole; a value without an effective value has origin null (Claude tiers are never `environment`). The image key falls back to the OpenAI text key, as image calls do.
- P4-R6: `GET O/ai/projects` adds `unreadable` (projects whose read failed, left out and logged); the organization's notices and projects list say so when it is above 0.
- P4-R7: "Exception" badges appear only on rows whose part the API lists in `exceptions` while the project's own settings are in force; "No exceptions" only when nothing is listed and no value has origin `project`.
- P4-R8: readiness marks carry their state as screen-reader text ("yes"/"no"), not only by colour and glyph.
- P4-R9: one notice text for unreadable projects, above the projects table and appended to the organization notices.
- P4-R10: while the runtime applies no standard (`ORBIT_AI_DEFAULTS` off) the organization's profile notices and the system's standard notice state only that a save changes the route version, and the projects list says that standard models are off.
- P4-R11: the notices are count-neutral: a count stands in parentheses after its noun ("every project of this organization (1)"), never as a bare number before a plural noun.
- P4-R12: a project that follows the standard while neither the organization nor Orbit has set one says so on its overview (only while the standard applies; otherwise the routing-off notice explains).
- P4-R13: final review fixes: spending authority renewal, suggested Claude tiers, first-save confirmation for routing forms with a second wording, stored values kept in selects.
- Section ids as built: project `overview`, `providers`, `models`, `budget`, `usage`, `agents`; organization `standard`, `models`, `budget`, `usage`, `projects`, `advanced`; system `standard`, `models`, `advanced`. The organization and system areas exist only with `ORBIT_CONNECTIONS` (their capabilities `organization.ai` and `system.ai` need it). `advanced` opens closed in an "Advanced" disclosure.
- F-8 risk 8 (the organization budget `PUT` replaces monthly amount, provider caps and credits together) is not fixed: the one form shows all three and is mounted whole, so nothing is lost today; a characterization test pins the full replace so a later split cannot drop a part unseen.

| WP | Work | Tests |
| --- | --- | --- |
| 4.1 | Shared service from `readAiModels`; `GET P/ai/effective` with origin and three-state readiness. | fixtures for environment only, system profile, organization standard, preset, own choice, own key, granted key, revoked grant, missing key, failed check |
| 4.2 | `GET O/ai/projects`. | owner only; follows / overrides per project |
| 4.3 | Safe-save fixes for the existing forms (F-8): save only shown fields from stored values; keep routes of tasks not shown; no writing preselections; profile `PUT` with expected version; the setup wizard never replaces an existing spending authority unasked. | one regression test per risk, written first and failing against today's code |
| 4.4 | Web: AI area per scope (5.9), origin badge, effective view, "affected projects" notice, module ceilings read-only. The existing panels are mounted section by section. | unit; Playwright: an owner sets an organization standard, a project owner sees it as inherited and can only switch to a preset or own choice |
| 4.5 | Update `docs/MODEL_ROUTING.md` and the status of `docs/plans/ai-central-management.md`. | – |

Acceptance: the acceptance sentence of the task holds in the browser test; a byte comparison of stored AI configuration before and after opening every AI section shows no change; no stored profile or project configuration is modified by the rollout.

Prerequisite to check before production: which of `ORBIT_AI_CATALOG`, `ORBIT_AI_DEFAULTS` and `ORBIT_AI_ORG_BUDGET` are on. The area shows the real state for each combination.

## 10. Phase 5: module settings, redirects, removal

Status (2026-11-12): rows 5.1 to 5.3, the F-5 fix and the public access section are implemented on branch `claude/settings-center-phase-5` and delivered to `main` on 2026-11-12. The production flag is unchanged (`off`). Row 5.4 is not implemented; it gets its own plan after the flag value `on` is accepted in production. Implementation plan: [2026-11-12-settings-center-phase-5.md](../superpowers/plans/2026-11-12-settings-center-phase-5.md); the state of the work and its verification are in `docs/IMPLEMENTATION_STATUS.md`, the requirement rows in `docs/REQUIREMENTS_TRACEABILITY.md`.

What was built per row:

- 5.1: every module settings section carries its own description (English and German) and optional search words, and the adapter uses them for the center; `validateModuleSections` checks id, uniqueness and both texts; it is a check run in tests over the real registry, not at runtime, and it does not check that an id's first segment is the section's module. No section declares an access floor (P5-D6). A module integration section can depend on an installation feature (`IntegrationContribution.feature`, P5-R4); Knowledge's GitHub section does.
- 5.2: Social accounts and the Knowledge "GitHub App" tab show their state and a link to their section in the center when the flag is `on` (P5-D3; Knowledge's section also appears in the center under `preview`, because it is a module contribution, and only while the installation's Knowledge workspace feature is on, P5-R4). Support's inbox form and Finance's mailbox section state where mailboxes are managed and link to the project's connections: the old connectors page with `off` and `preview`, the connections section only with `on`.
- 5.3: with `on`, one pure table maps every old settings address to its center address (`mapOldAddress`), the shell applies it with the member's capabilities (`oldAddressTarget`), and the same table drives the sidebar, the user menu and the links of the workspace (`centerLink`), so links and redirects cannot disagree. The sidebar shows one entry "Administration & settings" and no Connectors entry (P5-D1).
- F-5 and the public access section: section 4.1. The keys list moved into the center as the section `integrations/public-access`; the keys panel and the old page's modal ask before revoking and say who uses a key.

Decisions of the plan, as built:

- P5-D1: with `on`, one project sidebar entry "Administration & settings" replaces "Settings", and "Connectors" is not shown.
- P5-D2: revoking a public key always succeeds; a module that uses the key releases its reference in the same step; nothing can veto a revocation.
- P5-D3: with `on`, the Social accounts page and the Knowledge GitHub tab show state and a link; the editors live only in the center.
- P5-D4: the Google Drive return lands on `…/integrations/google-drive`.
- P5-D5: the capability fallback of section 5.3.
- P5-D6: module sections get no declared access floor; who may see a section stays in the module's own hook and on the server.

Controller rulings during the work:

- P5-R1: `/admin/<section>/<id>` for a section other than users and organizations lands on the section with the id dropped.
- P5-R2: the old connectors page maps to `integrations/connections`.
- P5-R3: the public keys panel and the old page's keys modal are localized; the old modal reads German for German members, which is a text change on the old page. The center's profile section no longer names public keys.
- P5-R4: an integration contribution may name an installation feature and is left out without it.
- P5-R5: the browser run with `on` is its own CI job with a stage guard step; the existing job is unchanged.
- P5-R6: final review fixes: the redirect decides on the committed location; module settings links go to the module's section; the English mailbox sentence names no page title (see P5-R7); a failed module-states load is treated as the shell treats it.
- P5-R7: the English mailbox sentence names no page title ("Mailboxes are added and checked in the project's connections."), because the old page is titled "Connectors" and the center section "Connections" in English; the German sentence keeps "Verbindungen", which is right for both. Finance's "no mailbox yet" text names the same place ("…in the project's connections first.", German "…unter Verbindungen.").

Other deviations from the plan, as built: `moduleTabIndex` derives the platform keys itself; `useResource` additionally returns `errorPath`, so a redirect never decides on an earlier request's error or on another project's module states (`redirectModuleShown`); while module states load, a legacy address also loads the states of the project it leads to; the module links in the shell are mapped in one place (the workspace `href` behind every `AppLink` and `ProjectLink`) instead of file by file; Support's own key flows forget or replace the inbox's key before revoking and tolerate only the refusals `NOT_FOUND` and `OWNER_REQUIRED`.

Known limits: the key revocation is not one atomic step, because the key row lives on a separate connection and `revokedAt` is written last (a failed commit after it leaves the key revoked with the inbox still pointing at it; a second revoke call to the API releases the reference, but the keys page offers no Revoke button for a revoked key, so in the interface Support's "Widget key" or removing the widget channel repairs it). A failed revocation of the old key inside "Widget key" leaves the new key unreferenced; it shows on the keys list with no user. A Support settings manager who is not an owner can clear the inbox's pointer but not revoke the key. The module pages' summaries list live Social accounts only. The new CI job has not run in CI yet.

| WP | Work | Tests |
| --- | --- | --- |
| 5.1 | Modules add the registry metadata (category, scope, required permission, canonical route, optional provider) to their sections; the adapter becomes the only path. As built: module sections carry an id, both titles and descriptions, and optional search words, validated in tests (`validateModuleSections`); no declared access floor (P5-D6); the adapter is used for the center. Not built: category, scope, required permission, canonical route and provider as declared metadata, and the adapter as the only path (the old settings page still reads the module sections as before until row 5.4). | registry validation; a disabled module contributes nothing |
| 5.2 | Module pages that duplicated central configuration keep state and a link (social accounts, Knowledge GitHub, mailbox choice in Support and Finance). | module suites; links resolve |
| 5.3 | Flag `on`: redirect table (5.3) in the shell; navigation points to the center. | every row of 5.3 as a unit test; Playwright for bookmarks, `?section=`, `googleDrive`, the social return, attention links |
| 5.4 | After acceptance of 5.3 in production: API-sent links switch to the new addresses; remove `ProjectSettings`, `Connectors`, the admin area's own navigation, the unsectioned organization page and dead code. The redirect table stays. | full suite; `navigation.spec.ts`, `workspace.spec.ts`, `administration.spec.ts` updated |

Nothing in this phase deletes stored settings or data. The review's deferred minors and known limits are recorded in `docs/IMPLEMENTATION_STATUS.md` only.

## 11. Decisions (Mario, 2026-11-11)

Mario took every recommendation as the decision.

| # | Question | Decision |
| --- | --- | --- |
| D-1 | New root `/manage` with path sections, or keep the four existing roots and unify only the frame? | `/manage`. One address scheme, sections get stable URLs, old URLs redirect. |
| D-2 | Project scope: own frame like the other scopes (project sidebar hidden, "back to project" link), or inside the project shell? | Own frame. Same layout on every scope; the sidebar's settings links still lead in. |
| D-3 | Three-stage flag `off / preview / on`? | Yes. `preview` gives a production check next to the old pages; `on` is a separate, reversible step. |
| D-4 | May organization owners see a metadata list of their projects' integrations? May system administrators see such a list across organizations? | Owners: yes (they own every project already). Administrators: no; it would break the metadata-only boundary of ADR 0013. |
| D-5 | E-mail: UI grouping by server now (no backend change), or also make mailboxes central connections that several projects can share? | UI grouping in V2. Shared mailboxes as a separate, later decision: it changes an earlier "not cut over" decision and needs a cutover. |
| D-6 | Social accounts: connect and manage them in the integrations center, with the Social page showing state and a link? | Yes. One place for connections; publishing rules stay in Social. |
| D-7 | Provider limits exist three times at organization level (profile budgets, organization caps, project budgets). Which one does the guided UI edit? | Organization caps in "Budget"; profile budgets only in "advanced"; project budgets in the project. No mechanism is removed. |
| D-8 | F-11 and F-14: keep that a system administrator can assign memberships in any organization and receives reset links without system mail? | Keep the behaviour in V2 (no silent permission change). Add a confirmation that names the consequence, and decide separately whether organization owners get to read audit entries about their organization. |
| D-9 | Should a system administrator who is not a member see foreign organizations in the organization scope? | No. Through System → Organizations as today, with members and invitations only. |

## 12. Not part of V2

- The fix for F-13 (invitation list): its own branch `claude/tenancy-pause-invitations`, delivered separately. F-12 needs no fix.
- New providers (TikTok, LinkedIn, an external MCP client, Ads accounts), organization-level spending authority or agent mandates, verification of project-stored AI keys, project archiving and deletion (phase 4 of the global administration plan), a `SystemSetting` table, MFA, themes.
- Removing project-level AI keys and prices (phase E of the AI plan).
- Any change to roles, permissions, production credentials or flags without separate approval.

## 13. Files

**New (web):** `apps/web/src/platform/settings-center/` as listed in 5.5, each with its test file; `apps/web/tests/settings-center.spec.ts`.

**New (API):** `apps/api/src/platform/management/` (`routes.ts`, `capabilities.ts`, `integrations-catalog.ts`, `project-integrations.ts`, `organization-integrations.ts`, `ai-effective.ts`, `ai-projects.ts`, `flag.ts`); tests `management-capabilities`, `management-integrations`, `management-ai`, `management-route-rule` in `apps/api/tests/`.

**Changed (web):** `platform/shell/routes.ts`, `routes.test.tsx`, `types.ts`, `settings-nav.tsx`, `nav-groups.ts`, `user-menu.tsx`, `sidebar-nav.tsx`; `components/orbit.tsx`, `workspace-context.tsx`; `modules/registry.ts` and each module manifest that contributes settings or integrations; `components/ai-settings.tsx`, `ai-model-choice.tsx`, `spend-policy.tsx`, `platform/administration/ai-knowledge-ui.tsx` (4.3); `lib/api.ts`, `lib/i18n.ts`, `lib/exception-text.ts`; `app/globals.css`. Removed in 5.4: the page shells in `components/management.tsx` and `platform/administration/admin-area.tsx` (their panels stay).

**Changed (API):** `packages/config/src/index.ts`; `apps/api/src/server.ts` (`/api/me`, hook, Drive redirect); `platform/administration/ai-profiles.ts` (expected version); `platform/ai/mcp-tools.ts` (logic moves to the shared service); `packages/module-contracts` (integration descriptors); module contributions for social, marketing, knowledge, issues, webmail; `apps/api/tests/fixtures/access-matrix.json`; OpenAPI and the generated client.

**Changed (operations and docs):** `.env.example`, `docker-compose.yml`, `docker-compose.pve.yml`, `docker-compose.pve.source.sha256`, `scripts/check-coolify-compose.mjs`; `docs/adr/0027-settings-center.md` (new), `docs/DESIGN_SYSTEM.md`, `docs/API_CONTRACT.md`, `docs/MODEL_ROUTING.md`, `docs/IMPLEMENTATION_STATUS.md`, `docs/REQUIREMENTS_TRACEABILITY.md`, `docs/deployment/COOLIFY.md`.

**Database:** no migration, no schema hash change.

## 14. Dependencies, risks, rollback

| Dependency | Note |
| --- | --- |
| Phase 2 before 3, 4, 5 | Frame, registry and capabilities are shared. Phases 3 and 4 are independent of each other. |
| 4.3 before 4.4 | No AI form is mounted in the new frame before its save is safe. |
| 5.3 before 5.4 | Removal only after the redirects are accepted in production. |
| Production flags | `ORBIT_ADMINISTRATION`, `ORBIT_ACCOUNT`, `ORBIT_CONNECTIONS` must be on for their scopes; the AI flags decide what the AI area shows. To be read from Coolify before each rollout step. |

| Risk | Mitigation |
| --- | --- |
| A new read endpoint shows more than its caller may see | Reuse the existing guards; explicit field lists; access matrix and cross-organization negative tests; security review of every fixture change |
| Navigation shows something the server refuses, or hides something allowed | Capabilities come from the same guard functions; a test compares them with the route answers per role |
| An AI form silently changes stored configuration | 4.3 with regression tests; byte comparison in the acceptance |
| Broken bookmarks, OAuth returns or links in sent notifications | The redirect table is permanent and fully unit-tested; API links switch only in 5.4 |
| The `orbit.tsx` change breaks the project shell | No code moves: one more source for the project id and one render branch, covered by the existing shell, navigation and workspace tests |
| Two UIs in parallel confuse members during `preview` | `preview` only adds a menu entry; no old link changes |
| Scope creep into backend rebuilds | Section 12; every endpoint in 5.6 is read-only |

**Rollback.** Per stage: set the flag back (`on` → `preview` → `off`) and redeploy. There is no data or schema to undo. Until 5.4 the old pages exist in the code; after 5.4, rollback is a revert of that commit. The two additive write changes (profile version check, Drive redirect) are compatible with the old UI and stay.

## 15. Phase 6: tests, acceptance criteria and rollout

**Role matrix** (API integration and Playwright where a UI state matters):

| Actor | Must hold |
| --- | --- |
| System administrator without project membership | sees System; 404 on every project route and on organization connections, AI and shares; no project scope offered; no secret anywhere |
| Organization owner | sees the organization and all its projects; cannot open another organization; cannot edit system connections |
| Project owner (not organization owner) | sees the project scope fully; sees inherited AI values with origin; cannot edit the standard; cannot see other projects |
| Project editor | sees only sections editors may use; no credentials, members or AI budget sections |
| Viewer | read-only sections only; no action controls |
| No project access | `/manage/p/:id` shows "not found"; the switcher does not list the project |
| Module disabled / module role `none` | the module's sections, integrations and search hits are absent; direct URL shows the no-access notice; API answers 404 |
| Grant revoked / connection disabled | state "disabled" or "needs attention"; the consuming project fails closed (existing suites) |
| Missing API key, provider check failure, expired OAuth | states "not set up", "needs attention"; never "ready" |
| Permission removed during a session | next request refused by the server; the UI shows the refusal, not stale controls |

**Also checked**

- German and English complete for every new text (parity test in both directions); no English-only panel remains in the center.
- Keyboard: skip link, tab order, `aria-current` in the section list, labelled scope switcher, focus management in the wizard; reduced motion and reduced transparency.
- 1440, 768 and 390 px without horizontal scrolling.
- Every row of 5.3; the Drive return; the social return.
- No secret in any new response or log line (`logging` and redaction suites; assertions on the new endpoints).
- No external write in tests: wizard and checks run against the existing test transports.
- `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build` after every phase; `pnpm test:e2e` for affected specs; `pnpm test:coolify-compose` after the flag; `pnpm api:generate` after each API change. Integration tests use this worktree's own database (`node scripts/test-db-for-worktree.ts`); if it cannot be provided, the report says which tests did not run.

**Rollout order**

1. Phase 2 to `main`, flag `off`. Then `preview` in production; smoke test with Mario's session.
2. Phase 3, then phase 4, each to `main` under `preview`, each followed by a production smoke test (read-only first, then one edit per area).
3. Flag `on` (5.3). Regression and smoke tests on old links.
4. After acceptance: 5.4, then removal of the flag.

Each push to `main` and each flag change needs Mario's approval.

## 16. Work split for the implementation

| Agent | Owns (no shared files) |
| --- | --- |
| Architecture | ADR 0027, `packages/config`, flag plumbing, `platform/management/capabilities.ts`, compose files |
| Frontend | `settings-center/` frame, registry, routes, redirects; `shell/` changes; `orbit.tsx` extraction |
| Integrations | `platform/management/*integrations*`, `settings-center/integrations/`, module integration contributions |
| AI configuration | `platform/management/ai-*`, `settings-center/ai/`, the 4.3 fixes in the AI components |
| Security | review of every new guard and fixture diff; cross-tenant negative tests; findings F-11 to F-17 |
| QA | Playwright specs, role matrix, redirect tests, parity and accessibility checks |

`orbit.tsx`, `routes.ts`, `types.ts`, `server.ts` and the access-matrix fixture each have exactly one owner per phase; other agents hand their changes to that owner.
