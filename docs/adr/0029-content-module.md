# ADR 0029: Content module (headless articles and website publishing)

## Status

Proposed, 2026-11-14. The architecture review and implementation plan are in [`docs/plans/CONTENT_HUB.md`](../plans/CONTENT_HUB.md); Mario answered E-1 to E-4 (below) on 2026-11-14. Nothing is implemented. Every migration (schema hash), the TipTap dependency versions, the flag `ORBIT_CMS`, the public API domain, each website change and every production step need their own approval.

Extends [ADR 0009](0009-modular-platform.md) (module contracts) and follows the pattern of [ADR 0020](0020-social-module.md) (an independent publishing module that Marketing reaches through a contract). Amends the default decider of `W2` in [ADR 0008](0008-action-approvals.md) for the content module only (decision 6). [ADR 0019](0019-agent-mandates.md) §10 stays: publishing is never covered by a mandate.

## Context

Marketing accepts `blog` as a content type and writes blog drafts, but an approved draft only becomes Markdown in Google Drive; publishing is refused (`modules/marketing/agents/owner-release.ts`, `agents/veto.ts`, blocker `BLOG_TARGET_NOT_CONFIGURED`). Content is a generic `Entity` with a 40,000-character body and no SEO fields. There are no machine API keys, no versioned external API, no HTTP caching (`Cache-Control: no-store` on every response), no outbound webhook system and no rich-text editor.

The three websites (FamilyPlan, EDS Labs, uLiquid) are Next.js static exports with articles in their repositories; every article needs a commit and a deploy. FamilyPlan runs on Coolify, EDS Labs and uLiquid on Hostinger. The earlier GitHub pull-request delivery for uLiquid (branch `claude/uliquid-blog-publishing-c9a252`, 2026-10-12) was never merged and predates the modularization.

## Decisions by Mario (2026-11-14)

| # | Question | Decision |
| --- | --- | --- |
| E-1 | How websites show new articles without a commit (ISR or rebuild) | Decided later in a separate step. Orbit must support both. |
| E-2 | Hosting of EDS Labs and uLiquid | Decided after the FamilyPlan pilot. |
| E-3 | Editor | TipTap (MIT, ProseMirror) with Orbit's own versioned block JSON. |
| E-4 | Who approves publishing and updates | The owner or a content editor (still `W2`, never under a mandate). |

## Decision

1. **Own module `cms`** (display name "Content", opt-in, installation switch `ORBIT_CMS`, default off) with dedicated tables (`Cms*`, FORCE RLS, composite tenant keys), permissions `cms.*`, internal routes `/api/projects/:projectId/cms/…` and web pages `/p/:projectId/cms/…`. The id is not `content`, which is already a Marketing entity kind, a tool namespace, the prefix of the action `content.schedule` and a forbidden literal of `package:knowledge`.
2. **Independent of Marketing.** `cms` imports no other module. Marketing (and later Support or Knowledge) reach it only through `modules/cms/contract.ts` and domain events (`scripts/boundaries.json`: `module:marketing → module:cms`). Marketing keeps strategy, research, generation and its own review; `cms` owns entries, revisions, media, sites, approval of publication and delivery.
3. **Headless pull is the default delivery.** Publishing switches an entry's `publishedRevisionId` inside Orbit; websites read published revisions from a versioned delivery API and are notified by a signed webhook (cache revalidation) or by a rebuild notifier (Coolify deploy API, GitHub `repository_dispatch`). Both answers to E-1 are therefore served without changing Orbit. Because no external write carries the content, the publish step itself has no ambiguous outcome.
4. **Three generic platform capabilities** are added because nothing like them exists: project-bound, hashed **API keys** with module-registered scopes (`platform/api-keys`); a **`/api/v1` frame** with error envelope, keyset pagination, ETag and cache headers, an `Idempotency-Key` header and its own OpenAPI document (`platform/http/v1`); and **outbound webhooks** with endpoint registry, `v1=` HMAC signatures (the existing `X-Orbit-Signature` scheme) with secret rotation, retries with backoff, delivery log, replay and auto-disable (`platform/webhooks`). Outbound calls use `boundedFetch`.
5. **Structured documents.** Bodies are stored as `orbit-doc-v1` block JSON (closed node and mark set, no raw HTML) defined in a pure package `packages/content-doc`, which also renders escaped HTML (with `sanitize-html` as a second layer), plain text and a table of contents. The web editor is TipTap mapped onto that schema. Agents write the JSON through strict structured output, so no Markdown parser is needed.
6. **Approvals.** `cms.entry.publish` (publish, update, schedule; binds entry, revision, content hash, sites and time) and `cms.entry.unpublish` are `W2`, `approval_required`, `mcpProposable`, never mandatable. They use the existing `deciderRole: "editor"`, `inbox: "editors"` and `mayDecide` of `platform/governance/action-requests.ts` against the project setting `cms.publishApprovers` (`owner` or `owner_or_editor`, default `owner_or_editor` per E-4); a content editor is a member who writes in the module `cms`. An optional four-eyes setting stops a requester from deciding their own request. Agents, API keys and MCP clients only propose.
7. **Scheduled publishing** uses Orbit's outbox (`availableAt`), a publication row per site with an idempotency key and a fence, and a preflight at claim time (revision unchanged, alt texts, AI image label gate of ADR 0028, evidence validity of agent content, slug conflicts, module enabled, project not paused). Slug changes and archiving create redirects (301/410).
8. **Extensibility.** Content types are a code registry (`article` first; `faq`, `help_doc`, `changelog`, `product` defined but off). External CMS connectors such as WordPress (deferred) attach through a `PublishingAdapter` registry (`validate`, `render`, `push`, `reconcile`, `unpublish`, `capabilities`) on the same publication state machine, which already carries `sending`, `outcome_unknown` and reconciliation for push targets as in Social.
9. **MCP and assistant** tools are `OrbitTool`s with the new scope `orbit:cms`; drafts are `W0`, publication requests are proposals.
10. **Phase 4 SEO work lives in Marketing** (research, clusters, briefs, Search Console metrics) and hands drafts and publication requests to `cms` through the contract; editorial tasks reach Work through a new handoff target.

## Alternatives

- **Entries as `Entity` kinds** (no migration): no unique slugs, no relational queries for sites, translations, redirects and publications; ADR 0009 gives modules with relational needs their own tables.
- **An external headless CMS** (Strapi, Directus, Payload, a SaaS): a second system of record and auth model next to Orbit's tenancy, approvals and agents; ruled out by the request.
- **GitHub commits per article** (the October branch): every article is a commit and a deploy, which is exactly what should go away.
- **Push-only delivery to each site**: needs a write API on every website and has ambiguous outcomes; kept as the adapter path for WordPress later.
- **Reusing `PublicClientKey`**: it is an identifier with an origin allowlist for browsers, not a secret, and server requests without `Origin` pass; a delivery API for servers needs real secrets and scopes.
- **Owner-only approval** like Social: rejected by Mario (E-4).

## Consequences

- New platform tables `ApiKey` (control plane), `ApiIdempotencyKey`, `WebhookEndpoint`, `WebhookDelivery`, and module tables `CmsEntry`, `CmsDraft`, `CmsRevision`, `CmsTaxonomyTerm`, `CmsAuthor`, `CmsAsset`, `CmsSite`, `CmsEntrySite`, `CmsPublication`, `CmsPublicationAttempt`, `CmsRedirect`; RLS and access matrices grow; three schema hash approvals.
- A new public attack surface (API keys, `/api/v1`, a public media route): bearer-only `/api/v1` routes are exempt from the `Origin` check for writes and ignore cookies, which needs its own security review.
- A new web dependency (TipTap) with pinned versions.
- Marketing gains a `blogTarget` setting (`drive` or `cms`); Drive stays the fallback, existing drafts are untouched.
- The October GitHub delivery branch is superseded; its uLiquid validator rules move into a site content rule.
- Each website needs a one-time integration whose rendering variant is decided per site (E-1, E-2).
