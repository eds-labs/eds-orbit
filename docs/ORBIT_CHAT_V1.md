# Orbit Chat / Operator v1

Orbit Chat is a private, project-bound control surface. The UI is `/chat`; all business data and tool execution stay in Fastify and the existing modules. Chat text does not become a Verified Fact.

## API

All routes require the existing session and project membership. `:projectId` is checked through `scopeFor`; every conversation also requires its original user. Chat tables use FORCE RLS over workspace, project, and user session variables. Viewer may create and read only their own chat records. Only editor/owner may confirm a proposal.

- `GET /api/projects/:projectId/chat/conversations?cursor=:uuid`: at most 20 recent conversations and `nextCursor`.
- `POST /api/projects/:projectId/chat/conversations`: creates a private conversation.
- `GET /api/projects/:projectId/chat/conversations/:id`: messages, runs, and proposal versions.
- `POST /api/projects/:projectId/chat/conversations/:id/messages` with `{text,clientRequestId}`: returns `202 {runId,jobId,status}`. Replaying the same request ID in that conversation returns the original run.
- `GET /api/projects/:projectId/chat/runs/:id`: durable run state.
- `GET /api/projects/:projectId/chat/runs/:id/events`: SSE `snapshot` events containing `status`, `partialText`, `errorCode`, and `sequence`. Connections close after 39 seconds and may reconnect; a connection is never the execution owner.
- `POST /api/projects/:projectId/chat/runs/:id/cancel`: cancels the run. If a provider call may already have transmitted, cost is recorded as unknown and the call is not retried.
- `POST /api/projects/:projectId/chat/proposals/:id/confirm` with `{version,hash,confirmationId}`: confirms only the exact current proposal. A repeated confirmation returns the saved mission and job IDs.

## Execution

The `chat` BullMQ class persists status and answer snapshots. Responses API calls use `store:false`, current project OpenAI configuration, verified route/pricing, and the shared policy budget journal. Limits per run are three model calls, four tool calls, 24,000 input bytes, 1,200 output tokens per model call, and 8,000 displayed characters. A single run key shares the policy's per-run cost ceiling across all calls. Missing credentials, mandate, or price blocks execution before transmission. A crash after transmission is treated as an unknown outcome and does not trigger another paid request.

The registry exposes `project_status`, `knowledge_search`, `approved_assets`, and `analytics_memory` as read tools. `propose_campaign` can save only a draft-only proposal and is denied to viewer. The model cannot invoke proposal confirmation or any existing write, publishing, provider, shell, or SQL endpoint. The proposal snapshots project generation, policy, marketing profile version, source/fact/asset versions, active index, model and cost ceiling. Confirmation rechecks them, creates the mission once, and queues one generation job at mission start. Chat missions carry `allowedActions: ["draft"]`; the worker skips its autopilot review/publishing continuation for them. Images and external publication remain on the existing controlled pages.

A first draft is queued rather than generated before a future mission start time. The proposal shows a conservative first-draft ceiling (including retrieval) and an upper bound for the whole plan. The chat-created mission carries the first-draft ceiling, which is rechecked before text generation; actual spend and result come from budget reservations and the job. Subsequent drafts use the existing mission lifecycle.

## Local verification and release

Use Node 24.18.0 and isolated local PostgreSQL/Redis. Apply the additive migration before starting the updated API or worker. Check `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm test:e2e`, `pnpm api:generate`, and `pnpm secrets:check`. Browser acceptance uses a synthetic account with no approved paid mandate and makes no live provider calls. Production migration, deployment, paid provider tests, and rollback require a separate approved release procedure and backup/restore evidence.
