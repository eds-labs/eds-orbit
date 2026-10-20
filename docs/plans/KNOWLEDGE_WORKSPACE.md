# Knowledge workspace implementation

Approved scope: three primary views (project knowledge, sources, review), resumable guided onboarding, reviewed ingestion and private GitHub App sources in one package. Existing routes and verified knowledge remain compatible. Manual updates only. No production installation, credentials, deployment or real repository import is authorized by implementation.

Risk: high / local. Primary profile: AI agent app, with web frontend and backend API rules. Preserve the existing modular Next/Fastify/Postgres/BullMQ stack. No new provider SDK is needed.

## Sequence
1. Add staging records and review decisions using the existing versioned, project-scoped Entity storage. Quarantined text never enters retrieval. Promote reviewed evidence through the shared knowledge engine.
2. Add GitHub App OAuth proof, restricted installation tokens, bounded commit-pinned reads, and resumable/cancellable worker analysis through existing AI routing and spend mandates.
3. Replace the management navigation with three task views, guided source forms, profile and review UI. Preserve expert routes and previous imports.
4. Run unit, isolation, review-invalidation, provider-mock, browser and standard project checks. Regenerate API artifacts.

## Threat model and tests
Private repository substitution, cross-project access, OAuth CSRF/install-ID spoofing, secrets in file bodies, injected repository instructions, fabricated evidence, promotion before review, repeated decisions/jobs, concurrent updates, revoked users, provider uncertainty and budget exhaustion are the main risks. Test these boundaries with synthetic fixtures, no paid or real external calls. Use project-scoped advisory locks and optimistic entity versions for decisions/jobs. Revalidate the initiating owner's current role before worker processing. Provider-transmitted uncertainty must stop automatic retries.

## Rollback and introduction
The new workflow is behind ORBIT_KNOWLEDGE_WORKSPACE, default off. Existing data is untouched; new kinds use existing Entity RLS and EntityVersion without a schema migration. Disabling the flag restores existing UI/actions and blocks new workflow jobs, retaining drafts and decisions. Published reviewed facts remain ordinary knowledge; normal revocation applies. Set the flag consistently on web/API/worker at introduction. Register the GitHub App and enter encrypted app credentials separately after local acceptance; use selected repositories and Contents/Metadata read only, with the documented callback. Deployment and real FamilyPlan acceptance are separate owner-authorized steps.

## AI data and costs
The analyst is tool-free, receives selected bounded text only, and returns schema-validated proposals with exact quoted evidence. Source text cannot change instructions or execute tools. Live analysis requires explicit model-use consent, the existing active spend mandate and routed/priced model. One bounded call per analysis, medium cost driven by input size; one reservation per attempt, settle known usage, retain unknown spend and require reconciliation after ambiguous failure.
