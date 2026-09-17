# Migration plan — not executed

Date:2026-09-17. All steps below are proposals. Existing-service activity performed: read-only inventory and planning. No existing remote infrastructure/application/DNS/firewall/queue/provider state was changed. Separately, Orbit's own fresh isolated local container installations and synthetic restore drill passed; those tests are not an existing-service migration.

## Risk and ownership

Future execution is high/critical risk: persistent DBs, scheduled publication,OAuth,analytics and infrastructure. Mario owns decisions; execution operator/reviewer must be named. Target/provider is unbound. Desk/Forecast are excluded, with no training,backtest,model/snapshot migration or trading/wallet-data handling. FamilyPlan/Supabase is not implied scope. Chatwoot requires a separate resident/ownership decision and can block shutdown/cancellation.

## Proposed sequence

| Stage | Proposed work | Exit gate |
| --- | --- | --- |
|0 |Complete safe inventory:contracts,digests,DB/media sizes,writers,domains/callbacks,metrics,restore evidence |All residents/writers known; recoverability evidenced |
|1 |Select32GB target,region,exact CPU/disk/terms,backup/monitoring quote |Separate exact order/resize approval |
|2 |Provision/harden isolated target,private networks,Caddy,no global Orbit host privileges,external backups/monitoring |Approved change; recovery/security verified |
|3 |Deploy Orbit first with synthetic data and external writes/spend disabled |Integration/security/retrieval/capacity acceptance |
|4 |Migrate approved low-risk sites/MCP adapters |Callbacks/issuer/audience unchanged; no hidden writers |
|5 |Matomo same-version restore/rehearsal then cutover |Site IDs/tracking continuity;one archive scheduler;no unaccounted split writes |
|6 |Postiz full stack,queue/outbox/provider reconciliation then cutover |No ambiguous outcomes;exactly one publisher |
|7 |Chatwoot only if separately approved |Otherwise source remains and is not a saving |
|8 |Observe, retain recovery, then retire |All residents clear; separate cancellation and later deletion approvals |

No window selected. Do not assume a short-notice migration near the plannedSeptember 19, 2026 presale. Agree maintenance window, quiet period and communications. Never combine migration with major upgrades.

## Recovery set and isolated acceptance per service

- Orbit:database/schema,source files,document versions/ACLs,chunks/vectors/text indexes,model/version metadata,jobs/outbox,approvals/audit. Restore without provider writes. Verify retrieval/citations,tenant isolation,deletion/tombstones and index consistency. Reindex only from controlled original sources.
- Postiz:resolve floating running image digests without pulls. Preserve appPostgreSQL17,Redis7.2,Temporal1.28.1 and itsPostgreSQL16/Elasticsearch7.17.27 state,media and integrations. Use version-supported consistent backups and writer fencing. Recover credentials through an approved encrypted secret channel, never documents. Restore with no egress/fake providers; test draft/schedule/media and dry-run transitions, never real publishing.
- Matomo:resolve running app version; coordinate MariaDB11.4 with config/plugins/customizations/files. Preserve site IDs,custom dimensions,tracking URLs/query parameters,retention and archive schedule. Verify aggregate continuity and archival behavior on an authorized isolated fixture/copy without external notifications.
- MCP/webhooks:inventory actual endpoints first. Preserve domain,OAuth redirect,issuer/audience,discovery,tool contract,signature/idempotency semantics. Synthetic signed events only during isolated tests; no credential disclosure.
- Websites:versioned files/assets/redirects/TLS/domain config; isolated host-override parity check before ingress changes.
- Chatwoot(if explicitly included):app digest,pgvectorPostgreSQL16,Redis,attachments,Rails/Sidekiq. Coordinate workers/DB/files and disable outbound messaging/webhooks on target. This audit exports no customer data.

Provider VM backup is supplemental, not a verified app-consistent DB/media/queue recovery set. Use encrypted independent storage and an isolated restore with publishing/email/ad/network writes disabled. No backup/export/restore of an existing remote service was authorized or performed by this audit. Orbit's separate synthetic local restore result is recorded in BACKUP_RESTORE_TEST_RESULT.json.

Proposed discussion targets, not existing guarantees: routine source/DB RPO≤24h and RTO≤4h; planned publishing cutover must have a final consistent checkpoint with no unaccounted publications/accepted jobs. Measure restore time and agree stricter requirements when needed; provider restore_time is not acceptance evidence.

## Single-writer cutover

1. Record approved digests,source/target identities,exact ingress/callback contracts,checkpoint and cutoff. Verify independent backup and isolated restore first.
2. At approved window,fence source intake/schedulers/publishers with a migration lock. Queue draining/stopping are execution actions requiring approval and a bounded plan; never consume queues for discovery.
3. Account for in-flight jobs/external requests. Preserve idempotency keys/provider operation IDs/status through approved data handling without credentials/private message bodies. Ambiguous outcomes block cutover until provider status is reconciled.
4. Create final approved consistent DB/file/queue checkpoint; verify checksums/version compatibility; restore with target writers disabled and identifiers preserved.
5. Read-only target acceptance under host override. TTL/proxy/firewall changes require explicit approved steps;DNS alone does not fence writers.
6. Conclusively fence source,enable exactly one target writer/scheduler,preserve idempotency history,then approved ingress switch. Observe independent errors/queue age/DB writes/provider outcomes.
7. Reconcile all accepted jobs/publications/tracking events across cutoff. Source stays recoverable and cannot publish during observation.

Matomo needs a planned intake pause or controlled forwarding/buffering approach while DNS caches differ;preserve site IDs/parameters and exactly one archive scheduler. Postiz/Temporal require workflow state plus external-effect reconciliation;blind queue replay is prohibited.

## Rollback has two distinct boundaries

| State | Recovery | Requirement |
| --- | --- | --- |
|Before target writes/effects |Disable target,verify no writer enabled,restore original ingress,activate intact source under lock |Source remains authoritative;verify one writer and propagation |
|After target DB/queue writes |Fence both,choose authoritative data,reverse-sync or tested restore/forward-fix,then one writer |DNS reversal alone loses/duplicates new state;never blindly overwrite |
|After external publish/email/ad effects |Fence both,reconcile each provider operation/billing outcome,retain provider IDs/idempotency,then reconcile DB |External effects survive DB restore;no auto-republish/delete/refund/spend compensation without separate approval |

Time-box diagnosis and name escalation/communications before the window. Prefer a controlled outage to two publishers. Code rollback,DB rollback/forward-fix,flags,DNS/proxy restoration and provider reconciliation are separate controls.

## Acceptance and retirement

Cover login/RBAC/tenant isolation,source-file restore/retrieval citations,retries/idempotency,provider-disabled contract checks,PostizOAuth/media/schedules,Matomo sites/tracking/archives,MCP discovery/auth,independent alerts and measured restore. Healthy containers alone are insufficient. Observe a full scheduler/archive cycle and an agreed business window. Record post-cutover writes/incidents;keep source recoverable for owner-approved retention with publishing fenced. Only after all residents clear,approve cancellation and separately irreversible deletion. Do not cancel1269962 with Chatwoot remaining.

## Individual approvals required for later execution

Exact order/resize and cost;provision/deployment/security/firewall/proxy;protected-data backup/export and isolated restore;each service window/writer pause/sync/cutover;DNS/OAuth/provider changes and real write tests;post-write reconciliation/compensation;contract cancellation;later data/host deletion. This document requests none of these now. Continue missing read-only evidence and independent Orbit development. Migration was not executed.
