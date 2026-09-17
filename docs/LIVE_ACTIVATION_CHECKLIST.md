# Live activation checklist

2026-09-17. Local application and standalone/shared-host acceptance passed. This checklist records the remaining concrete production/provider decisions; it is not an activation mandate. Current runtime defaults are `EXECUTION_MODE=test`, `ENABLE_EXTERNAL_WRITES=false`, project mode Observe and no application OpenAI credential.

## 1. Approve the target and recovery plan

- Select the host, architecture, domain, maintenance window and responsible owner using `HOSTING_DECISION.md` and the read-only inventory. The tested image is Linux ARM64; validate an AMD64 build before selecting it for an AMD64 host.
- Approve the exact deployment/migration and rollback steps. Preserve separate Orbit project names, networks, volumes and credentials. Desk and Forecast retain their existing isolation.
- Provision independent application/auth/migration roles and new secret-store entries; keep the migration role out of the running API/worker. Complete first-owner setup, HTTPS session/Origin checks and public-signup denial on the actual target.
- Configure encrypted off-host backup plus separately protected `CREDENTIAL_KEY` escrow. Restore into a clean paused Observe target and verify source rights, tombstones, media, audit and unknown remote receipts. Record recovery time and actual loss window.
- Verify independent alarm delivery. Runtime health and local recovery evidence do not prove off-host alarms or backups.

## 2. Establish model and knowledge evidence within an approved budget

- Configure only an application-owned OpenAI credential, explicitly verified model IDs and a current rate card. Approve bounded daily/monthly/per-run ceilings and external-model rights for each source. Review actual OpenAI data handling; `store:false` does not promise zero retention.
- Execute a genuine strict structured-output call; retain model ID, provider usage and settled cost. A mocked provider test is not this result.
- Build the selected immutable embedding index and execute at least 60 versioned evaluation cases, including 48 answerable and 12 negative cases. Require Recall@10 >= 0.90, zero forbidden hits, current source/corpus/config bindings and settled build/evaluation receipts. Record latency and cost.
- Explicitly activate only the evaluated generation. Preserve an evaluated same-profile baseline for rollback. Re-evaluate after relevant corpus/config changes or expiry. `LIVE_RAG_EVAL_PASSED` is deprecated and cannot replace database proof.

## 3. Verify each intended connector separately

- Review the exact Postiz sandbox account, text and optional PNG, then authorize the bounded proof operation. Require the observed remote ID, intended account and published status. Image publication needs its own media proof. Bind proof to the connector version and `PUBLISHER_INSTANCE_ID`; credentials or an HTTP receipt alone are insufficient.
- If Slack is enabled, configure the signed app, exact workspace/channel and owner mappings. Verify delivery and a current one-use response under its time-bounded mandate. No actual Slack message or response was exercised during local acceptance.
- For Matomo, configure the scoped site token and verify actual reports, timezone, currency and attribution against the source. Missing metrics remain missing, rather than zero.
- Select an actual downstream blog/CMS, mail or ads provider before proposing its implementation/activation. Portable article/newsletter/ad drafts and exports work now; unsupported external write capabilities stay unavailable. Community ingestion is authorized import, not private scraping or automatic replies.

## 4. Review the publishing mandate and cutover

- Confirm owner-approved channels, content types, link origins, source public/model rights, verified facts, branding rights, dates, quiet hours, calendar blackouts, quotas, spacing and finite mission size. Assisted mode requires approval of the exact current package; Autopilot requires the current bounded policy and mission action grant.
- Reconcile unknown/accepted/scheduled remote actions and disable the old publisher before moving a deployment. Same-database transaction serialization and instance-bound proof are not a cross-host lease or a global exactly-once guarantee.
- Confirm pause and manual escalation ownership. Postiz group-wide cancellation is not exposed because current group membership cannot be proven; an accepted remote action can require manual provider intervention.
- Only after these proofs and the explicit production/live mandate, set the intended execution/write gates and enable the narrowly scoped project policy. Start with the approved finite pilot and inspect its provider reconciliation, costs and evidence freshness.

## 5. Public release

Choose the code license and confirm original EDS brand distribution rights. Review inventory/evidence for private operational details before publication. Run CI on the approved repository and retain the tested source/lock/image identifiers. No repository push, public release or production deployment occurred during this implementation.

Evidence and exact remaining acceptance IDs: `ACCEPTANCE_REPORT.md`, `REQUIREMENTS_TRACEABILITY.md`, `RELEASE_READINESS.md`. External rows are A05, A14, A17, H07, H08 and K08; all executable local acceptance rows are complete.
