# Marketing Agent v2 — MA-00 / MA-01 implementation record

## Baseline and provenance

Implementation branch: `codex/marketing-agent-v2-ma00-ma01`, created from fetched
`origin/main` at `e67cb711dbd94c62f76d31e170e26d2a3bbd64ac` on 2026-10-20.
The strategy document `docs/plans/marketing-agent-v2.md` was copied unchanged
from the uncommitted planning worktree `EDS-Orbit-marketing-plan`, branch
`codex/marketing-agent-v2-plan` (analysis base `dd902d8`). Its inventory is a
historical planning snapshot; implementation uses the newer base above.

## Risk / environment / approach

High risk, isolated local environment. AI-agent-app profile with fullstack-SaaS
and existing web-frontend conventions; feature workflow and existing modular
monolith. No new dependencies, migrations or production configuration.

Threats addressed: model approval mistaken for human authority; draft handoff
bypassing publishing approval; stale body/media/policy/assignment authorization;
removed owner permission; duplicate confirmation/worker dispatch. Existing
RLS, budgets, module activation and outbox identities are retained.

Implementation sequence: characterize existing legacy services; add creation-only
safe default and exact package gate; surface mode through chat and management;
exercise real services with synthetic transports; run focused regressions and
required repository checks. MA-02 is preparation only.

Rollback: pause new human-gated assignments before deploying an older binary
that cannot enforce the mode. Preserve records/approvals/publications and legacy
confirmation hashes. Never remove the server guard merely by hiding the UI.

## Verification

Pending execution; final results and MA-02 prerequisites will be recorded here.
