# Marketing memory

The implementation keeps three distinct data classes in project-scoped, versioned records:

- `preferences`: proposed, owner-confirmed or disabled editorial rules with expiry. Imported comments are never owner instructions.
- Content/work-package history: evidence, claims, origin, versions, channel lineage, publication receipt and execution mode. Generated text remains derived material and cannot self-certify facts.
- `insights`: deterministic metric snapshots, referenced row IDs/versions, sample denominator, source/account/currency/timezone, limitations and expiry. Fewer than 30 observations produces a hypothesis; larger observational samples still do not prove causality.

CSV and Matomo report snapshots preserve missing values separately from zero. Matomo account dimensions distinguish report families and page-level observations to prevent double-counting incompatible datasets. Metrics corrections create new versions and invalidate dependent insights. `analyze` propagates provider completeness caveats; experiments require a declared hypothesis, variants, sample threshold and stopping rule, and never invent a winner from small data.

`modules/planning.ts` creates a bounded follow-up inside the original mission. It takes current campaign insights and owner-confirmed preferences only, records their versions, and rechecks expiry/disabled/invalidated status. The text prompt carries at most five insights and twenty rules. All prompt bytes are included in the conservative pre-call reservation. These observations guide editorial planning, never replace structured facts or evidence checks.

Owner lifecycle actions disable or delete memory. Deletion purges historical memory payloads while keeping a minimal audit event. Retention accepts 30–3650 days and removes expired eligible records. Source/document/fact withdrawal invalidates dependent evidence, approvals, drafts and recommendations. The private project export is authenticated and excludes encrypted credentials; a public article/newsletter export requires current public-use evidence.

Evidence: `apps/api/tests/safety.integration.test.ts`, `matomo.integration.test.ts`, `editorial.integration.test.ts`, and `packages/knowledge/tests/knowledge.integration.test.ts`. The seven-day simulated cycle, data correction, small-sample, project-isolation and deletion tests use synthetic fixtures and real PostgreSQL. No performance improvement or production marketing outcome is claimed.
