# Orbit API v1

Same-origin `/api` proxy. Session via Better Auth. Every modifying request requires Origin matching APP_ORIGIN; all project resources require membership. Owner can administer, editor creates/reviews content, viewer reads. No public signup. Setup needs installation token (`setupToken` input), owner email/name/password/workspaceName. Token is created only in local ignored runtime configuration.

- GET /api/setup `{configured:boolean}`; POST /api/setup `{name,email,password,workspaceName,setupToken}` -> `{configured:true}` then sign in.
- POST /api/auth/sign-in/email `{email,password}`; POST /api/auth/sign-out; GET /api/me -> `{user:{id,name,email},workspaces:[],projects:[]}`.
- GET /api/projects -> `{items: Project[]}`; POST `{name,timezone,language}` -> Project. Project fields id,workspaceId,name,timezone,language,mode,paused,generation.
- GET /api/projects/:projectId/dashboard -> `{project,counts,exceptions,publications,jobs,budget,readiness}`.
- GET /api/projects/:projectId/:collection -> `{items: Entity[]}`. Entity `{id,kind,version,data,createdAt,updatedAt}`. Collection names in packages/schemas/src/index.ts.
- POST /api/projects/:projectId/sources with schema `source`; POST facts uses knowledge contract; POST missions with schema `mission`; POST content schema `content`; POST policies schema `policy`; POST metrics/preference/experiments corresponding schemas.
- PATCH /api/projects/:projectId/content/:id `{version,data:ContentInput}`; edits invalidate review and publication intents. Other generic writes forbidden.
- POST /api/projects/:projectId/actions/import `{sourceId,externalId,title,text,mimeType,language}` or `{sourceId,url}`. Inline text max 1 MB. Returns imported document.
- POST .../actions/retrieve `{query,language,purpose:'public'|'internal',at?}` -> EvidencePack entity or object.
- POST .../actions/revoke-source `{sourceId}` owner only; immediate tombstone and downstream invalidation.
- POST .../actions/run-mission `{missionId}` -> durable job. Local test drafts explicitly synthetic; live generation requires paid-test/automation budget.
- POST .../actions/review `{contentId,version}` -> server claim/evidence check.
- POST .../actions/approve `{contentId,version,packageHash}` owner only; obtain hash via POST .../actions/preflight `{contentId}`. No stale approvals.
- POST .../actions/publish `{contentId,version,scheduledAt?}` -> durable local intent; test executor never contacts external providers.
- POST .../actions/pause `{paused:boolean}` owner only; invalidates pending writes and exposes remote cancellation risk.
- POST .../actions/analyze `{campaign?:string}` -> deterministic aggregate-backed insight and bounded follow-up.
- POST .../actions/retry `{jobId}` editor/owner; bounded recovery only.
- GET .../export -> project export omitting secrets; GET .../content/:id/export -> article/markdown.
- GET .../knowledge-health -> conflicts,expiredFacts,failedImports,staleSources,missingEvidence,impacts (real data).
- POST .../actions/connector `{provider:'postiz'|'matomo'|'slack',baseUrl?,credential,siteId?,channelId?}` owner; encrypted server-side. GET connectors never returns credential. POST .../actions/connector-health `{connectorId}` owner triggers read-only capability check.

Errors `{error:{code,message}}`, no stack, provider text, source snippets or SQL. Specific shapes are validated server-side and generated OpenAPI supplements this contract.


## Integrated RC extensions

All paths below are project actions under `/api/projects/:projectId/actions/` unless noted. Zod schemas in the implementation are authoritative; generated OpenAPI/client files are checked in and regenerated locally.

| Action | Role | Contract / effect |
| --- | --- | --- |
| editorial-propose-brief | editor | `{brief,language}`; conservative local editable proposal, no inferred dates/numbers/authority |
| community-import | editor | `{label,authorizationConfirmed:true,sourceId?,questions:[{externalId,text,language,receivedAt?,sensitive?}]}`; authorized manual import/groups, no external reply |
| community-link | editor | `{groupId,version,missionId? or contentId?}`; scoped versioned linkage |
| adapt-content | editor | `{parentContentId,version,title,body,channel}`; current reviewed parent/evidence, explicit lineage, duplicate checks |
| calendar-block | owner | `{title,channels:[],startAt,endAt,reason}`; empty channels means all; blocks pending local intents |
| calendar-unblock | owner | `{blockId,version}`; releases block, never revives an old intent automatically |
| withdraw-fact | owner | `{factId,version}`; revokes fact authority and invalidates dependents |
| import-matomo | owner | `{connectorId,siteId,date,siteTimezone,currency,method,goalId?}`; approved read-only daily report with dimension/quality provenance |
| postiz-test-prepare | owner | `{connectorId,integrationId,confirmSandboxAccount:true,assetId?}`; exact fixed test package, no request |
| postiz-test-execute | owner | `{verificationId,packageHash,confirmPublishExactTest:true}`; explicit live-gated single test handoff |
| postiz-test-reconcile | owner | `{verificationId}`; observed remote ID/account/PUBLISHED required for write proof |
| begin-index | owner | `{profile}`; immutable eligible corpus manifest |
| build-index | owner | `{indexId}`; bounded shared-budget batches, no activation |
| evaluate-index | owner | `{indexId,datasetVersion,confirmQueriesMayBeSentToOpenAI:true,cases:[{id,query,expectedChunkIds,forbiddenChunkIds,language,purpose}]}`; 60–120 cases, paid query budget, no client-supplied vectors/provenance |
| activate-index / rollback-index | owner | `{indexId}`; fresh complete evaluated generation only |
| slack-configure / slack-digest | owner | explicit signed team/channel/actor mandate / durable digest intent |
| correct-metric / memory-lifecycle / retention | owner | versioned metric correction; disable/delete memory; bounded retention |

`GET /api/projects/:projectId/indexes` returns owner-visible generation/evaluation state. Read collections include `calendar_blocks`, `community_questions`, `community_groups`, `work_packages`, `followup_plans`, `connector_verifications` and `index_evaluations`. Index evaluation query inputs are private project data, not public content.

`POST /api/workspaces/:workspaceId/pause {paused}` requires a current workspace owner and atomically fences all current projects before per-project reconciliation. Resuming does not restore invalidated approvals or intents. New projects start in Observe.

`POST /api/slack/:workspaceId/:projectId/interactions` is the only write route exempted from browser Origin checking: it requires the exact raw signed body, current timestamp, replay protection, team/channel and current mapped-owner authorization. It returns no sensitive details.

Article export now includes content type, outline, internal-link suggestions, alt texts and newsletter subject/preview/segment/consent/suppression references where present. Export is a draft artifact and does not claim email delivery or CMS publication.
