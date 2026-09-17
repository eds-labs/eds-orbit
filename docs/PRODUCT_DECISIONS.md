# Product decisions

Accepted for isolated implementation on 2026-09-17. Risk: high; environment: local. The controlling contract is `EDS_ORBIT_UNIFIED_CODEX_MASTER_v3.md`. Production changes remain separately authorized.

| Decision | Implemented outcome and reason |
| --- | --- |
| Application structure | One pnpm monorepo with the `web-next-custom-postgres` preset. Next.js owns presentation; Fastify owns authentication, authorization and business validation; a separate BullMQ worker executes fixed durable jobs. |
| Storage and tenancy | Self-hosted PostgreSQL 17 with pgvector and FTS, Prisma 7 driver adapter, forced project RLS and separate restricted app/auth/migration roles. Typed business payloads use versioned envelopes; knowledge sources/versions/chunks use relational constraints. |
| Knowledge boundaries | Confirmed structured facts, source documents and measured marketing memory are distinct. Current evidence is retrieved before drafting and checked again before handoff; generated content cannot verify itself. Public and external-model rights are separate. |
| Retrieval | Exact filtered vector and lexical search combined with reciprocal-rank fusion, deduplication and token bounds. ANN is not enabled without a measured need. Immutable index profiles/builds/evaluations and explicit activation protect model/dimension changes. |
| Runtime AI | OpenAI only. Central task routing uses configured GPT-5.6 models; automatic expensive escalation is disabled. Genuine capability and semantic evaluation need the application's own credential and an approved budget. Test vectors/providers establish mechanics only. |
| Autonomy | Observe installation default; finite owner mission and policy, exact-package Assisted approval, current preflight, atomic project quotas/budgets and persistent outbox/action journal. Runtime has no host/SSH/cloud/Docker administration tools. |
| Planning and memory | Conservative local brief proposals require the owner to complete intent/limits. Finite work packages use current measured insights and confirmed preferences. Small/conflicting samples remain uncertain; corrections invalidate derived insights. |
| Publishing | Local test receipts never call a provider. Postiz live proof is account/instance/version bound; PNG proof is separate. Schedules stay local until due. Unknown outcomes require reconciliation and cannot blindly resend. Unsupported group-wide deletion remains a manual exception. |
| Additional channels | Complete portable blog/newsletter/ad/script drafts and exports. No unspecified CMS/mail/ads write provider is invented. Private community input requires an authorized import and retains its origin; no scraping or automatic replies. |
| Visual identity | Original EDS logo, Arctic Blue and Liquid Glass, EN/DE and responsive desktop/mobile controls. Four bounded template PNG formats are implemented. Optional generated-image production is not part of this RC. |
| Hosting | Isolated standalone and shared-host Compose variants tested on Linux ARM64. Shared mode publishes no application/database/Redis host ports. CPU/RAM/PID bounds are measured; disk I/O and sustained production capacity are not guaranteed. |
| Release rights | Private repository at `EDS-Labs/eds-orbit`. Code license and original-brand distribution rights require an owner decision before any public release. No framework license is assumed to grant rights to all application code or brand assets. |

Detailed tradeoffs are in `docs/adr`, `KNOWLEDGE_ARCHITECTURE.md`, `AUTONOMY_POLICY.md`, `MODEL_ROUTING.md` and `CONNECTOR_CAPABILITIES.md`. Acceptance is recorded separately from these design decisions in `ACCEPTANCE_REPORT.md`.
