# Operations

## Start and inspect

Use the actual setup commands in `README.md`; production variants are in `DEPLOYMENT_BOOTSTRAP.md` and `SHARED_HOST_DEPLOYMENT.md`. The local dependency stack is isolated on 127.0.0.1:55432/56379. `pnpm dev` starts API, web and a separate worker; the deployed worker does not depend on a browser, Mac chat session or Codex.

`GET /health` checks database connectivity. The authenticated Operations screen reads durable jobs, undispatched outbox rows, knowledge/provider exceptions and a Redis worker heartbeat (fresh within 30 seconds). The worker also writes an atomic local health file used by its container check. Heartbeats describe the configured publisher instance and queue classes; they do not certify external publishing or model quality.

Queues: publishing concurrency 2; generation, ingestion, embedding, reindex, index evaluation, analytics, reconciliation and Slack notification concurrency 1 each. PostgreSQL holds all business states; Redis holds transport. Pump interval is 1.5 seconds, dispatch batch 40, waiting high-water mark 200 per queue, lease 120 seconds and at most three job attempts. Publishing has a separate queue so index work cannot exhaust its queue slot. A full memory/corpus workload capacity benchmark is not implied by these limits.

Compose caps API/web at one CPU and 768 MiB each, worker at two CPUs/1536 MiB, database at two CPUs/2048 MiB and Redis at 0.5 CPU/384 MiB. Redis reserves 256 MiB with `noeviction` and AOF; application state is recoverable from PostgreSQL/outbox. Containers use bounded logs and process counts, dropped capabilities, no-new-privileges, non-root runtime and a read-only application filesystem. CPU/RAM limits do not guarantee host disk IOPS, free-space isolation or all-neighbor latency. See the hosting report for measured versus proposed capacity.

## Agent telemetry, cost attribution and API logs

Migration `202609300001_agent_telemetry` adds `AgentRun` (one row per chat run, generation, retrieval, ingestion, reindex, index evaluation or image call; kind, agent name, task class, subject, optional mission, status, duration, error code) and `AgentSpan` (model call, tool call, embedding or image span with model, status, attempt, duration, token counts, cost micros, budget reservation ID and provider response ID). Both tables are project-scoped with forced row level security (`project_scope`). `BudgetReservation` gains nullable `agentRunId`, `taskClass`, `model` and `missionId`. The migration is additive; deploy it with the normal migration step before the API that uses it.

Telemetry stores only bounded codes, hashes of inputs/outputs, counts, durations, model names and IDs. Prompts, tool arguments, model output, source text and provider error messages are never written. Recording is non-throwing: a failed telemetry write is logged by error class only and never changes a chat, generation or ingestion result. A chat run whose outcome is unknown after a crash is closed as `blocked` with `CHAT_OUTCOME_UNKNOWN`. An image span that succeeded carries no cost (`costMicros` null); the reservation stays unknown and counted, as before.

Editors and owners read this through `GET /api/projects/:projectId/agent-runs` (newest first, 50 per page, optional `kind`) and `GET /api/projects/:projectId/ai-cost`. For cost per model or per mission use `?groupBy=model` or `?groupBy=mission` (other groupings: `day`, `category`, `taskClass`); the default range is the current UTC month and at most 93 days. Each row reports `reservedMicros` (reserved or in flight), `settledMicros`, `unknownMicros` and `count`; released reservations are excluded, rows without attribution (older reservations) appear under key `null`. Unknown amounts are real exposure and are not free. Cost micros are USD micros of the configured account currency.

The API uses the Fastify pino logger. Each request logs a random request ID (client IDs are ignored), method and path without the query string; each response logs the status code. Authorization and cookie headers are redacted and request or response bodies are never logged. A failed request adds one line `{code, status}` (level `warn` below 500, `error` from 500) and, only for errors outside the known domain/validation classes, `errorName`; never the message or stack. `/health` and `/api/health/ready` log at `warn` so probes do not flood info logs. Set `LOG_LEVEL` (`trace|debug|info|warn|error|fatal|silent`, default `info`); the test suite defaults to `silent`. Worker logging is unchanged by this phase.

## Failure and recovery

Pause before intervention. Unknown publication or Slack handoff must remain unknown until observed; do not create a fresh job to resend it. Known publication IDs are read-polled at most eight times with bounded delay. Postiz group cancellation remains a visible manual provider action, because current group scope cannot be proven safely from the list contract.

The Retry UI rechecks job state and maximum attempts; it cannot override budget, policy, source or outcome-unknown gates. Outbox rows survive queue interruption. Expired leases are reclaimed; ambiguous external handoffs are explicitly recorded before recovery. Paid reservations remain in-flight/unknown after a crash; reconcile provider usage rather than resetting them to zero. Never delete the ledger to make a retry pass.

Worker Redis connection failures have exponential backoff capped at 30 seconds and throttled logs. Shutdown allows at most ten seconds before exit. Failed database pumps apply backpressure rather than spawning workers. Parser inputs and deadlines are bounded; PDF extraction runs in a fixed child with a credential-free environment and memory/time limits. There is no shell or infrastructure tool in marketing jobs.

## Data and release maintenance

Source/document revocation purges active chunks/vectors and retained copied payloads while keeping tombstones and minimal audits. Fact withdrawal preserves version history and invalidates its dependents. Metric corrections invalidate insights. Memory retention/deletion is owner-only. Exported project data is private; review it before sharing.

Use `BACKUP_RESTORE.md`. Restore into a new isolated database, pause every project, set Observe and disable external writes before starting services. Keep the credential encryption key in separately controlled encrypted backup; losing it makes stored connector credentials unusable. Off-host transfer, production key escrow and external alarm delivery have not been performed by this task.

Before a release run lint/type checks, all unit/integration tests, the browser suite, production build, generated API contracts, framework validation, dependency audit and secret/license review. CI configuration exists but was not run on a remote repository. Update rates/model capabilities and retest installed provider versions before live activation. Deployment, migration, DNS, account test messages, repository publication and publisher cutover need their own explicit operator authorization.
