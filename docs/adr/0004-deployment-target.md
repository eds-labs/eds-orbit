# ADR 0004: Deployment target

## Status

Local packaging and topology accepted, 2026-09-17. The production provider, exact host, region, tariff and deployment window remain undecided and unauthorized. This completes the imported framework template; it does not approve a server order or migration.

## Context and decision

Prepare one self-hosted Docker Compose application with separate web, API, worker, PostgreSQL and Redis services. Provide a standalone reverse-proxy variant and a shared-host variant that attaches only web to the selected proxy network. Runtime containers are non-root, use read-only application filesystems and have explicit CPU, memory, PID, log and temporary-storage limits. Marketing jobs receive no Docker socket, SSH key or host-administration credentials.

Both variants passed fresh local Linux ARM64 image/bootstrap/HTTPS/authentication and isolation acceptance. The [container acceptance record](../evidence/container-acceptance.json) binds the tested image, platform and measured limits. This establishes local ARM64 packaging evidence only; AMD64, a production host, representative co-host workload capacity and public DNS/TLS operation were not tested.

## Alternatives and environments

The shared-services VPS option is conditional on capacity, isolation, independently recoverable backups and single-writer migration acceptance. A dedicated Orbit host is a realistic alternative if resource measurements or operational ownership make co-hosting unsuitable. No existing Desk or Forecast service is an implied deployment target. The actual provider comparison and conditional recommendation are in [hosting decision](../HOSTING_DECISION.md) and [consolidation recommendation](../CONSOLIDATION_RECOMMENDATION.md).

Local and isolated Compose acceptance are exercised. Preview/staging and production are planned environments, not claimed deployments. New installations remain in Observe/test mode, with external writes disabled and no inherited provider credentials.

## Operations and rollback

Follow [deployment bootstrap](../DEPLOYMENT_BOOTSTRAP.md) only after approval of the concrete release. Forward migrations, limited-role checks and fresh isolated recovery precede application start. Rollback distinguishes compatible image reversal from database restoration and external-action reconciliation; switching DNS cannot undo new writes. Never run two publishers for the same state.

[Operations](../OPERATIONS.md), [shared-host deployment](../SHARED_HOST_DEPLOYMENT.md), [backup/restore](../BACKUP_RESTORE.md) and [service migration](../SERVICE_MIGRATION_PLAN.md) define the remaining operator steps. Off-host backups, external alert delivery, production capacity and every actual deployment/migration/cutover require their own evidence and explicit authorization.
