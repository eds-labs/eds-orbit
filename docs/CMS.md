# Content module (`cms`)

Orbit's content hub for website articles ([ADR 0029](adr/0029-content-module.md), plan [CONTENT_HUB.md](plans/CONTENT_HUB.md)). Orbit stores entries, their immutable revisions, media, categories, tags and authors. Websites read the live content through the [delivery API](CMS_API.md), so publishing an article needs no commit or deploy on the website. Agents and integrations write drafts and propose publications; a person in Orbit decides.

Status (2026-11-19): phase 1 backend (CH1.1–CH1.13, CH1.15–CH1.17), and the web pages (CH1.14a–f: overview, entries and editor, calendar, media, categories and tags, authors, history, Decisions views, settings sections) are implemented and tested on the branch `claude/orbit-content-hub-architecture-0894a4`. It is not pushed, and every flag is off. The phase 1 acceptance (CH1.18) is still open.

## Switching it on

| Switch | Effect |
| --- | --- |
| `ORBIT_CMS=true` | The module exists in the installation. Off: every route answers `404 CMS_DISABLED`, workers skip, the scopes are disabled. |
| Project activation | Opt-in per project (Settings → Modules). Module roles `editor`, `viewer`, `none` apply ([MODULE_ACTIVATION.md](MODULE_ACTIVATION.md)). |
| `ORBIT_API_V1=true` | The versioned API with project API keys: delivery, preview and management ([API_V1.md](API_V1.md)). |
| `ORBIT_WEBHOOKS=true` | Outbound webhooks to websites ([OUTBOUND_WEBHOOKS.md](OUTBOUND_WEBHOOKS.md)). |
| `ORBIT_PUBLIC_INGRESS=true` | Public image URLs of live content and draft preview images ([PUBLIC_INGRESS.md](PUBLIC_INGRESS.md)). |
| `ORBIT_MCP_PROPOSALS` | MCP clients may propose publications (`cms_publish_propose`). |

The schema comes in three migrations (`202611160001_api_keys`, `202611160002_webhooks`, `202611160003_cms_core`). Production needs a newly approved schema hash in Coolify before the push to `main` ([deployment/COOLIFY.md](deployment/COOLIFY.md)).

## Editor

The editor (`?entry=<id>` under Content → Entries) writes orbit-doc through TipTap 3.32.2: headings 2–4, paragraphs, lists, quotes, callouts, code, images from the media library and dividers; links follow the content-doc rule. Drafts save automatically with their version; when someone else saved in between, the editor asks to reload instead of overwriting. Pasted HTML keeps its text; foreign images and disallowed links are removed and reported. The side panel holds publishing (sites, preflight, now or scheduled, cancel, withdraw, preview), SEO (slug, length meters, snippet and hints that never block), images and social, categories and authors, and translations. The server validates every save; the editor configuration is no security boundary.

## Web pages

| Page | Address | Who |
| --- | --- | --- |
| Overview, Entries (editor at `?entry=<id>`), Calendar, Media, Categories & tags, Authors | `/p/:projectId/cms/…` | members read; editors write |
| Websites, Publishing | `/manage/p/:projectId/modules/cms/sites`, `…/publishing` | members read; the owner changes |
| API keys, Webhooks | `/manage/p/:projectId/integrations/cms/api-keys`, `…/webhooks` | owner (needs `ORBIT_API_V1` / `ORBIT_WEBHOOKS`) |
| Publication requests | Decisions | deciders per the publishing setting |

API keys and webhooks are platform capabilities; Content contributes their sections because it is the only module with scopes and events today.

## Permissions

| Permission | Roles | What it allows |
| --- | --- | --- |
| `cms.read` | owner, editor, viewer | Read entries, drafts, revisions, media, sites, publications |
| `cms.compose` | owner, editor | Write drafts, media, categories, tags, authors, redirects |
| `cms.publish.request` | owner, editor | Publish, schedule, update or withdraw; directly or as a request |
| `cms.publish.decide` | owner, editor | Decide publication requests, narrowed by the setting below |
| `cms.sites.manage` | owner | Sites, routes, notifiers, verification |
| `cms.settings` | owner | Module settings |

Settings (`PUT /api/projects/:id/cms/settings`, versioned): `publishApprovers` (`owner_or_editor` by default, decision E-4, or `owner`), `fourEyes` (the requester may not decide), `timeZone` (scheduling; empty uses the project's), `lateWindowHours` (default 24).

## Entries, drafts and revisions

- An entry is one piece of content in one locale; translations share a translation group. Only the type `article` is enabled; `faq`, `help_doc`, `changelog` and `product` are defined for later.
- The draft is the working copy, saved with an optimistic version (`CMS_DRAFT_STALE`). Bodies are orbit-doc v1 (`packages/content-doc`), a closed block set without raw HTML.
- A revision is an immutable snapshot with a content hash. A publication always names a revision.
- Media: PNG, JPEG and WebP (no SVG), normalized, WebP variants `w480`/`w960`/`w1600` and a 1200×630 Open Graph image. Alt text and caption per locale. AI images keep their label (ADR 0028).

## Publishing (decision E-4)

- A member who may decide publishes directly. Anyone else, and every agent, MCP client or API key, creates a request (`cms.entry.publish` or `cms.entry.unpublish`, risk W2). It waits in Decisions, one open request per entry. No mandate covers it.
- The request binds the revision's content hash, the entry's sites and the time. A publication in between or changed sites make it stale. The settings at decision time apply.
- Preflight (on asking, deciding and going live): enabled type, title, at least one active site serving the locale, free slug, existing references, alt text in the entry's locale, AI label for every shown image, and each site's editorial rules.
- Going live switches the live pointer in one transaction. A slug change leaves a 301; a withdrawal leaves a 410 (or a 301 to a live replacement) and archives the entry; a site the update leaves out gets a 410 at the old address.
- Scheduled publications run on the worker (`cms_publish`). More than `lateWindowHours` late, or with changed sites, a publication waits for a person instead. A sweep re-queues lost jobs; resuming a paused project re-queues due ones.
- Domain events (content-free): `cms.entry.published|updated|unpublished|scheduled`, `cms.publication.needs_attention`.

## Sites

- A site has an HTTPS origin, locales, a route per type and locale (`/blog/{slug}/`), a trailing slash rule, an adapter, notifiers and editorial rules. The owner manages sites; members read them.
- Adapter `orbit_pull`: the site reads the delivery API. `wordpress` is named for phase 3 and cannot be chosen yet.
- Notifier `webhook`: one of the module's webhook endpoints. An event about a site goes to the endpoints that site names and to module endpoints no site names. `coolify_rebuild` and `github_dispatch` follow with phase 2.
- Editorial rules: forbidden phrases, plain-text profile, title length, required excerpt or hero image.
- Verification: `configured` → `read_verified` (Orbit reached the origin, `POST …/sites/:id/verify`) → `live_verified` (a live check passed). A new origin resets it.
- Live check (opt-in, `adapterConfig.liveCheck`): the worker (`cms_live_check`) fetches the canonical page and expects `<meta name="orbit-revision" content="<revision id or number>">`. A withdrawn page must answer 404/410 or redirect. The schedule is `adapterConfig.liveCheckMinutes` (default 1, 3, 10, 30, 60 minutes); the last miss marks the publication `CMS_LIVE_CHECK_FAILED`.
- A route change on a site with live entries leaves a 301 from each old path.

## What a site shows

An entry shows on a site when its live revision went live there (a visible publication of that revision on that site). Assigning or removing a site takes effect with the entry's next publication, like any other change.

## Other modules

`apps/api/src/modules/cms/contract.ts` is the module's interface: drafts from an origin record (`submitOriginDraft`), proposals (`requestOriginPublication`), status, live entries and URL maps. Marketing may import it (boundary `module:marketing → module:cms`). Nothing uses it before phase 4.

## Assistant and MCP

The MCP content scope is `orbit:cms` (explicit and unchecked on the consent screen).

| Tool | Risk | Notes |
| --- | --- | --- |
| `cms_sites`, `cms_entries`, `cms_entry_get`, `cms_publication_status`, `cms_media` | R0 | `cms_entry_get` includes preflight issues |
| `cms_draft_create`, `cms_draft_update`, `cms_media_import` | W0 | MCP only, with `orbit:write`. Draft create takes an idempotency key; bodies as orbit-doc or plain text |
| `cms_publish_propose` | proposal | Creates the `cms.entry.publish` request; a person decides in Orbit |

## Attention, retention and pause

- Attention: entries whose latest publication of the last week stopped for a person (`cms_publication_stopped`), and live checks a site failed (`cms_live_check_failed`). Open requests appear in Decisions.
- Retention: content is a business record and is kept until the project is deleted. Revisions and publication logs cannot be updated or deleted (grants, trigger). Webhook deliveries are kept 30 days, stored idempotency answers 24 hours (platform jobs).
- Pause: a paused project's scheduled publications stay queued; resuming queues the due ones again (the late window still applies).

## Operations

- Queues: `cms_publish`, `cms_live_check` (worker), `webhook_delivery` (platform).
- Audit (content-free): entries, drafts (field names only), revisions, approvals, publications, sites, redirects, previews, API-key proposals.
- Rollback: `ORBIT_CMS=false` (routes 404, workers skip, scopes off). API keys are revocable; webhook endpoints can be disabled. The tables are additive; websites keep their last snapshot.

## Rollout runbook (draft, each step needs Mario's approval)

1. Approve the schema hash of the three migrations in Coolify; push to `main` (deploys, all flags off).
2. Check the deploy: health, migrations applied, no CMS routes reachable (404).
3. Set `ORBIT_CMS=true` and enable the module in one test project only; check the overview and access matrix behavior.
4. Create a site, an article and a draft preview; publish it directly as an editor; check the publication log.
5. Set `ORBIT_API_V1=true`; create a delivery key limited to the site; read entries, by-slug, sitemap and feed with `curl`; check ETag/304.
6. Set `ORBIT_WEBHOOKS=true`; add the site's endpoint as notifier; send a test event; publish an update; check the signature on the receiver.
7. Website integration (phase 2) starts only after decision E-1 per site.
