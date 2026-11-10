# Orbit Assistant (personal and project mode)

User and operator guide for the Orbit Assistant of [ADR 0022](adr/0022-personal-space-assistant.md), built on the agent platform ([ADR 0021](adr/0021-agent-platform.md), [AGENT_PLATFORM.md](AGENT_PLATFORM.md)). Plan: [Phase 3](plans/agent-platform-phase-3.md). It replaces [ORBIT_CHAT_V1.md](ORBIT_CHAT_V1.md) as the current description; that file stays as the history of project chat v1.

State (2026-11-05): Phases 3 and 4 are implemented on branch `claude/agent-platform-architecture-128114`. They are not merged and not deployed; `ORBIT_PERSONAL_ASSISTANT`, `ORBIT_PROACTIVE` and `ORBIT_VOICE` are off by default.

## Two modes, one backend

- **Project mode** is the existing project chat at `/p/:id/assistant` (also `/chat`). It runs in one business project, with that project's tools, limits and deep links (`?conversation=`). Phase 3 changes nothing in what it can do.
- **Personal mode** runs in the user's **personal space** (*Persönlicher Bereich*). It is reachable from the bubble on every signed-in page, from the side panel and from the full page `/assistant`. It works across the projects the user may access, with exactly the user's current rights in each.

Both modes use the same conversations, runs, jobs, limits (8 model calls, 16 tool calls, 128,000 input bytes per run), budgets and approvals. There is no second chat backend.

## Personal space

- There is one project of kind `personal` per user and organization. It is created on first use (`GET /api/assistant`).
- Only its user can open it. Organization owners and system administrators have no access to it, also not through a membership row. Administration cannot add anyone to it.
- It runs no business module, and its modules cannot be switched on.
- It is absent from every business list:
  - project lists and `/api/me`;
  - the approvals summary;
  - MCP grants;
  - administration lists and counts;
  - the social organization calendar;
  - maintenance reports.

  The organization's AI usage shows all personal spaces as one sum, never per user.
- Pausing the personal space pauses only the assistant. An organization pause pauses it too.
- When the user leaves the organization, the space is kept for 30 days and then deleted with everything in it by a daily clean-up. A user who rejoins in time gets it back. It is deleted at once with the user's account.

## Costs (D-09)

- The assistant's own model calls are paid by the personal space.
- Its spending authority is a read-only projection of the organization setting **assistant cap per member and month** (organization settings → AI). A day may use a tenth of it, and a run at most a day's share (USD 2 at most).
- Without a cap the assistant makes no paid calls (`POLICY_REQUIRED`).
- The user cannot raise the cap (`PERSONAL_SPACE_SPEND_READ_ONLY`).
- The organization budget counts this spend like any project's.
- Paid work inside a business project, such as a knowledge search, a creative preview or an agent work order, is reserved against that project's own authority and approvals.
- Organization owners can switch the assistant off per member ("Assistant allowed"). The organization's entitlement `assistantPersonal` gates it as a whole.

## What the assistant can do across projects

**Always available** in personal mode, at most 8 tools:

| Tool | What it does |
|---|---|
| `projects_list` | The user's business projects with their active modules and the user's role |
| `my_overview` | Per project: top attention items, decidable approvals, the user's open Work tasks, Support counts (urgent and breached only), failed agent work orders. One transaction per project, and every item is labelled with its project |
| `pending_approvals` | Approvals the user may decide, as decision cards |
| `agents_list` | Agents the user may run or view, per project |
| `agent_work_order_status` | Status and result of work orders the user requested or may read |
| `load_project_tools` | Loads up to 8 tools of one project for the rest of the turn; at most 24 per turn |
| `agent_delegate` | Hands work to a configured agent (see "Delegation") |
| `context_remember` | Remembers something the user said (see "Personal context") |

**Project tools** are not sent with every request:
- They enter a turn through `load_project_tools`. The focus project's tools are preloaded, at most 6.
- This works the same way for OpenAI and Claude: the loaded definitions are appended to the next model call, and the fixed part of the tool list stays the same within a turn.
- A call to a tool that was not loaded is refused (`CHAT_TOOL_NOT_ALLOWED`).

**Every project tool call names its project** and runs in that project's own transaction. It is checked against the user's current role, module roles and module activation there, and refused in a paused project. Refusals carry no data:
- `PROJECT_FORBIDDEN`, also for a project that does not exist or is someone else's personal space;
- `MODULE_DISABLED`;
- `PERMISSION_DENIED`;
- `PROJECT_PAUSED`.

**Page context.** The shell sends the open project and route as a hint. The server keeps it only for a business project the user may read, and never grants anything because of it. The focus project decides which tools are preloaded and which project-scoped context entries are included.

**Mixing projects (taint rule).**
- The assistant records which projects' data entered a conversation.
- A proposal in project B made after reading project A carries `crossProjectContext` and is never approved automatically under a mandate (`CROSS_PROJECT_CONTEXT`). A person in B decides it.
- Every proposal belongs to exactly one project, and its card names that project.

**Approvals in the conversation.**
- Decision cards show the project. When the user may decide the request there, they offer Approve and Reject, which go through the unchanged route `POST /api/projects/:projectId/action-requests/:id/decide`. The decision is bound to the version and package hash and audited as on the approvals page.
- Governance actions and types that need their full page (creative previews, scheduling and publishing, assignment confirmation) show a link instead.

## Delegation

`agent_delegate(projectId, agentId, goal, subjects?)` hands work to a configured agent in a business project, at most 10 subjects at once:
- **Rights.** The run's rights are those of the requesting user ∩ the agent's sponsor ∩ the agent's tool allowlist. The requester must be editor or owner in the agent's modules (D-06).
- **Confirmation and budget.** The requester confirms one card that names the agent, project, subjects, ceiling and on-behalf-of. The work orders run on the worker within the agent's run ceiling and month budget.
- **Report back.** When all of them have finished, the platform posts one **notice** into the conversation with a result card per work order. No model call is made for this. On the next message the assistant can summarize. If the conversation was deleted, nothing is posted and the work orders keep their results.

## Personal context (D-17)

Short notes the assistant may use: preferences, project notes, decisions, ways of working. They are stored in the personal space, visible only to their user, and managed on **My context** (`/account/assistant`): list, edit, archive, delete, export as JSON.

- **Automatic memory** (default): the assistant saves an entry itself with `context_remember`. Each save shows "Remembered: …" with **Undo** in the conversation, so nothing is saved silently.
- **Propose and confirm**: switch off "Remember automatically". The assistant then only proposes entries, and the user saves them.
- **Guardrails:**
  - Only what the user said in the current message may become an entry (`PERSONAL_CONTEXT_NOT_GROUNDED`), never text from tool results.
  - A deterministic screen refuses contact or account data (e-mail, phone, IBAN, card, IP, wallet), secrets and credential words, and health or financial details (`PERSONAL_CONTEXT_NOT_ALLOWED`).
  - At most 200 active entries.
- **Use:** active entries enter the personal-mode instructions, at most 2 KB. Entries with a project only appear while that project is the focus or named in the message.
- **Isolation:** entries never reach project chat, configured agents, work orders or MCP clients. Deleting an entry also deletes every stored version of its text. Audit records name the entry, never its text.

## API

All routes answer 404 while `ORBIT_PERSONAL_ASSISTANT` is off. `workspaceId` selects the organization; it defaults to the user's first one.

- `GET /api/assistant?workspaceId=` returns one of:
  - `{enabled: true, workspaceId, personalSpaceId, capMicros, autoMemory}`;
  - `{enabled: false, workspaceId, reason}`, with reason `ASSISTANT_DISABLED_FOR_MEMBER` or `ASSISTANT_ENTITLEMENT`.

  It creates the personal space on first use.
- Conversations use the existing project chat routes with `projectId = personalSpaceId`. The send body may carry `pageContext {projectId?, route?, entity?}` and `focusProjectId`. Run snapshots may carry `steps[]` (tool, project, state).
- `GET /api/assistant/context`, `POST /api/assistant/context`, `PATCH /api/assistant/context/:id` (with `version`), `DELETE /api/assistant/context/:id`, `PUT /api/assistant/context/settings` `{autoMemory}`, `GET /api/assistant/context/export`.
- Organization administration:
  - `assistantPerUserMonthlyMicros` in the organization AI budget (null for none; leaving it out keeps it);
  - `PUT /api/organizations/:workspaceId/members/:userId/assistant` `{enabled}`.

## Proactive notices and briefings (ADR 0023, local; flag off)

Orbit tells the user about relevant situations without being asked ([ADR 0023](adr/0023-proactive-signals.md), plan [Phase 4](plans/agent-platform-phase-4.md) WP4.1–WP4.4). Code: `apps/api/src/platform/signals/`, `apps/api/src/platform/proactive/`, module `signals.ts` in Work, Support and Marketing; web `apps/web/src/platform/account/proactive-preferences.tsx`, the bell and the bubble badge.

- **Signals are deterministic.** They are fed by domain events or by the hourly `signals-periodic` task, never by a model. The signals are:
  - failed agent work;
  - finished delegations;
  - budget thresholds (80 % and 100 % once per period);
  - approvals pending more than 24 hours (only to users who may decide them);
  - a failed briefing summary;
  - Work task completed and task due;
  - urgent Support tickets and Marketing assignment problems. These two are mappings of the existing notices, so nothing is detected twice.

  Signals carry ids, counts and codes, never free text. Owners can switch signals off per project (Settings → Modules).
- **No duplicates.** Every signal has a fingerprint with its period bucket (for example agent, code and UTC day). A repeat raises the notice's count instead of adding a row or sending another e-mail. A rise in severity marks it unread again.
- **Delivery preferences** live in the personal space ("My context" → Notifications):
  - quiet hours in the user's time zone;
  - the digest time;
  - e-mail and Telegram per severity: immediately, in the digest, or off;
  - whether urgent notices may break quiet hours (off by default).

  Turning a kind off in a project still wins. Recipients are checked again when a notice is delivered.
- **Digest.** One e-mail per user and digest slot through the system SMTP sender, with titles, counts and links grouped by project. A Work task's title is part of its notice title; customer content is never included.
- **Telegram (D-18).** The user connects their own bot to their personal space with the existing link-code flow. Notices from all their projects arrive as short texts (kind, project, count, link), once per notice, following the same quiet-hour and digest rules. `/stop` or disconnecting ends delivery at once.
- **All projects.** The bell has an "All projects" tab, and the bubble shows the unread count. `GET /api/notifications/summary` reads one project per transaction. A content-free wake-up after each new notice updates them; without realtime they poll once a minute.
- **Briefings** are off by default. They run daily or on weekdays at a local time, for chosen projects and sections:
  - approvals;
  - agent work;
  - urgent tickets and due tasks (counts);
  - budget status for owners.

  The briefing is a notice with project cards in a dedicated "Briefings" conversation, plus an optional e-mail, and it is built without a model. An **AI summary** is opt-in (2 model calls, no tools, at most USD 0.05, inside the per-member cap). If it fails, the deterministic briefing stays and a signal is raised.
- **Project reports.** The Work agent template `work.weekly_report` writes a weekly status report and notifies its sponsor.

Routes (404 while `ORBIT_PROACTIVE` is off):
- `GET/PUT /api/assistant/preferences`: notifications, quiet hours, time zone, digest, briefing.
- `GET /api/notifications/summary`.
- `GET /api/notifications/stream`: server-sent wake-ups; 404 without realtime.
- `GET/PUT /api/projects/:projectId/signal-settings`: owners write; members read.

Rollout: before switching `ORBIT_PROACTIVE` on, check that the system SMTP sender is configured and that the digest volume is acceptable (R4-6). Rollback: `ORBIT_PROACTIVE=false`. No signal jobs run, the routes answer 404, the Phase 1 failure notice is back, and written notices stay.

## Voice (ADR 0024, local; flag off)

Push-to-talk input and "Read aloud" in the personal assistant ([ADR 0024](adr/0024-speech-port-voice.md), plan [Phase 4](plans/agent-platform-phase-4.md) WP4.6/WP4.7). Code: `apps/api/src/platform/assistant/voice.ts`, `voice-routes.ts`; web `apps/web/src/platform/assistant/voice.tsx`.

- **Gates:** `ORBIT_VOICE` (default off; every voice route then answers 404 before authentication or reading a body), the entitlement `assistantVoice` (`VOICE_ENTITLEMENT`), and the personal-assistant gate. Voice runs only in the user's own personal space and within the per-member cap.
- **Input:** the microphone button in the composer opens the microphone only when pressed. Hold to talk, or click, Enter or Space to start and stop; Escape discards. The recording state is visible and announced in an `aria-live` region. MediaRecorder records WebM/Opus, or MP4 on Safari, at most 60 s and 2 MB. The transcript lands in the composer for review; "Send transcripts right away" is off by default (T4-3). Sending it is an ordinary text turn: same tools, rights, approvals and limits.
- **Read aloud:** a button under each assistant answer. It reads the visible text without Markdown, code blocks or link targets, then the card titles, never card content; at most 3,000 characters, cut at a word. "Read answers aloud automatically" is off by default and reads only answers that arrive after the conversation was opened.
- **Privacy (D-19):** audio is held in memory for the request only. It is not written to the database, platform files or logs, and the browser drops the recording after the upload. The transcript becomes a chat message only when the user sends it. Synthesized audio is streamed through and not stored. The provider must be on the personal-data allow-list (OpenAI only), else `SPEECH_PROVIDER_NOT_ALLOWED`.
- **Cost:** the transcription is estimated from the duration the server measures in the container and the speech from its characters, reserved before the call (`speech_stt`, `speech_tts`) and settled with actual usage. An unclear outcome is never retried (`SPEECH_OUTCOME_UNKNOWN`). Prices and routing: [MODEL_ROUTING.md](MODEL_ROUTING.md), "Speech".
- **Settings:** "Voice" on "My context" (`/account/assistant`), stored as `voice {autoSend, autoRead}` in the user-private `assistant_settings` entity; saving merges, so automatic memory and other preferences stay.

Routes (all 404 while `ORBIT_VOICE` is off; `workspaceId` as above):

- `GET /api/assistant/voice-settings` returns `{available: true, workspaceId, settings, limits, speechToText: {ready, reason?}, textToSpeech: {ready, reason?}}`, or `{available: false, workspaceId, reason, settings, limits}` when the entitlement or the member switch refuses.
- `PUT /api/assistant/voice-settings` `{autoSend?, autoRead?}` returns the merged settings.
- `POST /api/assistant/transcriptions[?language=xx]`: the raw recording as the body with `Content-Type: audio/webm` or `audio/mp4` (Orbit has no multipart plugin; like the platform file upload, the body is the bytes). It returns `{text, durationSeconds, estimateMicros, costMicros}`. Errors: `SPEECH_FORMAT_UNSUPPORTED` (415), `SPEECH_TOO_LARGE` (413), `SPEECH_TOO_LONG` (413), `SPEECH_UNREADABLE` (422), `SPEECH_PROVIDER_NOT_ALLOWED`, `SPEECH_NOT_CONFIGURED` and the routing codes (409), the budget codes (`POLICY_REQUIRED`, `BUDGET_EXCEEDED`, `RUN_BUDGET_EXCEEDED`, organization and grant budgets), `SPEECH_PROVIDER_REJECTED` and `SPEECH_OUTCOME_UNKNOWN` (502). Rate limit: 20 per minute.
- `POST /api/assistant/speech` `{messageId}`: one of the user's own assistant messages in the space, returned as streamed `audio/mpeg` with the headers `x-orbit-speech-characters` and `x-orbit-speech-truncated`. Another user's message, a user message or an unknown id answers 404.

Rollout: no live speech call without Mario's separate approval. Before switching `ORBIT_VOICE` on, an administrator checks and saves the speech prices under "Models & prices" (they are marked "please check"), and the iOS Safari and Android Chrome recording is checked by hand. Rollback: `ORBIT_VOICE=false`; the controls disappear and the routes answer 404.

## MCP

MCP clients and the assistant use the same capability layer (`platform/agents/project-calls.ts`). MCP-only safeguards stay MCP-only: OAuth scopes, grant checks and client quotas. MCP never sees personal spaces or personal context.

New MCP work orders (`orbit_create_task`) are stored as agent work orders (`target: assistant`). Older `orbit_tasks` records stay readable until task retention removes them. Tool names, shapes, scopes and approvals are unchanged ([MCP_2_0.md](MCP_2_0.md)).

## Rollout runbook

1. Migrations `202611040003_personal_space`, `202611040004_chat_notice_role`, `202611050001_notification_dedupe` and `202611050002_ai_price_units` are additive. Approve the branch's schema hash in Coolify **before** the `main` push (`docs/deployment/COOLIFY.md`).
2. Deploy with `ORBIT_PERSONAL_ASSISTANT=false`. Nothing changes for users. The changes that apply anyway are:
   - personal spaces are filtered from lists (there are none yet);
   - notices are understood by the chat runner;
   - the organization AI budget accepts the new field.
3. Set the assistant cap per member for the test organization (organization settings → AI).
4. Switch the flag on for a test run with one test user. Paid turns only within the cap and with Mario's approval.
5. Check the bubble, panel and `/assistant` on desktop and a phone, a cross-project question, a decision card, a delegation and "Remembered … / Undo".

Rollback: `ORBIT_PERSONAL_ASSISTANT=false`. The bubble disappears, `/api/assistant` answers 404, and personal spaces stay inert. Columns, constraints and stored data stay.
