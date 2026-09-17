# VPS inventory — read-only evidence

Audit date: 2026-09-17, approximately 11:23–11:30 UTC. Scope: Appendix A of EDS_ORBIT_UNIFIED_CODEX_MASTER_v 3.md. Only local documentation was changed. No infrastructure deployment, restart, installation, backup creation, restore, queue operation, training, backtest, purchase, DNS change or publication was performed.

## Evidence sources

| ID | Source | Established facts |
| --- | --- | --- |
| I 1 | Authenticated Hostinger VPS_getVirtualMachinesV 1 | Current account inventory, status, plans and allocations |
| I 2 | VPS_getProjectListV 1 and selected VPS_getProjectContainersV 1 fields | Projects, image tags, states, health signals, ports and instantaneous resource statistics |
| I 3 | VPS_getMetricsV 1 | Existing history, locally summarized in RESOURCE_AND_COST_COMPARISON.md |
| I 4 | VPS_getBackupsV 1 / VPS_getSnapshotV 1 | Backup metadata, not application consistency or restore success |
| I5 | Existing staking-vps SSH alias, BatchMode and strict host-key verification | Bounded OS/resource/Docker metadata; stopped deeper investigation after identifying Desk containers |
| I6 | Selected local SSH alias destination metadata and current DNS resolution | Alias identity and forecast.uliquid.vip A destination; no full domain/proxy audit |

No secrets, environment values, full Docker inspection/Compose configuration, user data, subscriber lists, private prompt text, logs or database rows were collected. Raw provider/config output is not retained in these documents. No connector configuration was modified.

## Current provider inventory

| Current ID / hostname | Provider / state | Role and confidence | Plan | vCPU | RAM | Disk |
| --- | --- | --- | --- | ---: | ---: | ---: |
| 1269962 / srv 1269962.hstgr.cloud | Hostinger / running | Postiz, Matomo and Chatwoot, runtime-confirmed | KVM 1 | 1 | 4 GiB | 50 GiB |
| 1284853 / srv 1284853.hstgr.cloud | Hostinger / running | Forecast candidate: matches current forecast.uliquid.vip DNS; application identity not independently authenticated | KVM 2 | 2 | 8 GiB | 100 GiB |
| 1286926 / srv 1286926.hstgr.cloud | Hostinger / running | Desk workload confirmed by container names; excluded from consolidation | KVM 1 | 1 | 4 GiB | 50 GiB |

Provider allocations are 4096/8192 MiB RAM and 51200/102400 MiB disk. vCPU numbers are virtual allocations, not proof of dedicated physical cores. All three show an Ubuntu 24.04 LTS template, not a verified current guest patch level. Their data-center ID 19 was absent from the available-data-center response. Exact location remains unresolved; backup labels containing lt-bnk do not independently verify it.

The configured uliquid-desk alias points to a different address than all returned VPS. It was not contacted because Desk is excluded. Its current provider/state and relationship to staking-vps remain unresolved. Absence from this account is not deletion evidence. No historic hosts were imported as current. FamilyPlan/Supabase was not treated as a VPS migration candidate.

## Confirmed host 1269962 services

Image tags below are not immutable digests or independently checked application versions. Resolve floating tags to running digests before any eventual migration without pulling new versions.

| Project / observed path | Images/components | State / health |
| --- | --- | --- |
| postiz-local / /root/postiz-app/docker-compose.postiz-local.yaml | ghcr.io/gitroomhq/postiz-app:latest; postgres:17-alpine; redis:7.2; ghcr.io/getsentry/spotlight:latest; temporalio/auto-setup:1.28.1; temporalio/admin-tools:1.28.1-tctl-1.18.4-cli-1.4.1; elasticsearch:7.17.27; postgres:16; temporalio/ui:2.34.0 | Nine running. PostgreSQL17, Redis, Spotlight and Temporal report healthy; others provide no health signal. |
| matomo / /docker/matomo/docker-compose.yml | matomo:latest; mariadb:11.4 | Both running; MariaDB healthy; app health unreported |
| chatwoot / /opt/chatwoot/docker-compose.production.yaml | chatwoot/chatwoot:latest (base/Rails/Sidekiq); pgvector/pgvector:pg16; redis:alpine | Four running; base exited0. No health signals. Discovered resident, not automatically approved migration scope. |

Uptimes were approximately19–20h. Provider uptime also resets during this period; cause was not investigated and the audit did not cause it. Restart/OOM counts and actual cgroup limits are unavailable in selected fields.

Postiz publishes wildcard IPv4/IPv6 host ports4008,8970,7234,9081 (app, Spotlight, Temporal and TemporalUI); Matomo publishes8080; Chatwoot Rails binds127.0.0.1:3000. Public internet reachability/effective firewall policy was not probed. Internal DB/Redis exposed ports do not prove public exposure. A null provider firewall-group ID does not prove absence of guest firewall. Do not reproduce these wildcard bindings without a reviewed access design.

Point snapshots: Postiz~685MiB, Elasticsearch455MiB, Temporal101MiB, Matomo390MiB, MariaDB82MiB, Chatwoot Rails341MiB/Sidekiq302MiB. Reads occurred seconds apart and are not summed into a peak. Provider container memory_total is not evidence of an enforced limit.

## Desk boundary metadata

staking-vps returned srv1286926, Linux6.8.0-137-generic x86_64, one online CPU,3915MiB RAM,4095MiB swap/753MiB used. Root ext4: about48GiB total,37GiB used,11GiB available(78%). Docker29.1.3; Compose2.40.3+ds1-0ubuntu1~24.04.1. Container names identified Desk web/API/runner/strategy, PostgreSQL16, Redis7 and nginx; reported healthy. No authenticated Desk UI, records, credentials or trading/wallet data were accessed. This excludes the machine; it does not establish production acceptance.

## Recovery metadata

| Host | Latest provider backup UTC | Previous backup UTC | Usable snapshot / restore evidence |
| --- | --- | --- | --- |
| 1269962 | Sep 11 15:46:32 | Sep 04 16:21:08 | No usable snapshot established; no verified restore |
| 1284853 | Sep 13 12:59:12 | Sep 06 14:12:25 | Same |
| 1286926 | Sep 13 14:45:35 | Sep 06 15:08:26 | Same; Desk excluded |

Each had two backup records. Snapshot responses were ID0, restore_time0 and identical creation/expiry timestamps: treated as sentinel metadata, not usable snapshots. Provider backup size/restore_time units were not verified and are not used as byte sizes or measured RTO. No backup/restore was started. Application-consistent off-host backups, independent retention, encryption, restore tests and agreed RPO/RTO remain unproven.

## Exact gaps and blockers

- Billing: no callable Hostinger billing/subscription tools despite a configured server entry. Actual invoices, VAT, term, renewal and cancellation dates need an authorized sanitized billing read/export. No integration was reconfigured.
- Services guest detail: no configured SSH alias to1269962 was found. CPU model, guest versions/swap, enforced limits, restart/OOM counts, mount paths, DB/media/log sizes and growth require specifically bound read-only guest access. Safe provider fields do not contain them.
- Forecast services: Docker Manager returns VPS:2044, installed OS unsupported by Docker Manager. No guest changes attempted. Fourteen-day metrics HTTP 500; one seven-day retry returned only Sep 13–17.
- Matomo container stats: initial VPS:2045 temporary Docker Manager error; one bounded retry succeeded.
- Domains/proxy/OAuth redirects/MCP issuer-audience-discovery/provider mappings: not exposed by safe project metadata; require safe endpoint/relationship inventory without credentials.
- Cron ownership, archive duration, historical queue depths/job duration/overlap, working sets, I/O and DB load: no existing task-level monitoring source exposed. No queue inspected or consumed, no monitoring installed.
- External uptime monitoring and alarm operator: not established; verify and name ownership before migration.

All three current VPS were read through provider metadata. Only staking-vps was read over SSH, at metadata level. Postiz/Matomo already share one small services host with Chatwoot. There is no evidence for multiple removable non-Desk/non-Forecast contracts. The inventory supports a conditional recommendation, not a migration or cancellation.
