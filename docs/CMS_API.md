# Content API v1 (delivery, preview, management)

How websites and integrations use Orbit's content module ([CMS.md](CMS.md), [ADR 0029](adr/0029-content-module.md)). The frame (keys, errors, rate limits, caching, idempotency, pagination) is in [API_V1.md](API_V1.md); the OpenAPI document is `packages/schemas/openapi-v1.json`.

Status (2026-11-19): implemented and tested on the Content Hub branch, not pushed, behind `ORBIT_CMS` and `ORBIT_API_V1` (both off).

## Keys and scopes

| Scope | For |
| --- | --- |
| `cms:delivery.read` | A website's server: published content of the key's sites |
| `cms:preview.read` | A website's preview route: drafts, with a preview token |
| `cms:manage.read` | Integrations: entries, drafts, revisions, media, terms, authors, sites |
| `cms:manage.write` | Integrations: create and edit drafts, media, terms, authors (confirm write) |
| `cms:publish.propose` | Integrations: propose publications (confirm write); a person decides in Orbit |

A key's `resourceFilter.siteIds` limits delivery to those sites; other sites answer `404 CMS_SITE_NOT_FOUND`. Management refuses keys with a site filter (`403 API_KEY_SITE_FILTER_UNSUPPORTED`). Keep keys on the server; never ship them to a browser.

## Delivery: `/api/v1/cms/sites/:siteId/…`

All reads show only what is live on the site: an entry whose live revision went live there. Answers carry an `ETag` (send `If-None-Match` for `304`) and `Cache-Control: private, max-age=60, stale-while-revalidate=86400, stale-if-error=604800`.

| Route | Query | Answer |
| --- | --- | --- |
| `GET entries` | `type` (default `article`), `locale`, `category` or `tag` (slug, needs `locale`), `limit` ≤ 100, `cursor` | `{ items: EntrySummary[], nextCursor }`, newest first |
| `GET entries/:type/by-slug/:slug` | `locale` (default: site default) | `Entry`, or `404 CMS_ENTRY_NOT_FOUND` with `detail.redirect` for an old address |
| `GET taxonomies/:kind` | `kind` = `category` or `tag`; `locale` | terms with live entry counts |
| `GET authors` | `locale` (bio) | authors named on live content |
| `GET redirects` | `limit` ≤ 1000, `cursor` | `{ fromPath, toPath, code }` with 301 or 410 |
| `GET sitemap` | `locale`, `limit` ≤ 1000, `cursor` | indexable pages with `lastmod` and hreflang `alternates` |
| `GET feed` | `type`, `locale`, `limit` ≤ 50, `format` = `json` or `rss` | feed data, or RSS 2.0 (`application/rss+xml`) |
| `GET manifest` | – | site settings, live entry count, a `revision` hash over live revisions, redirects and the latest change of terms, authors and media |

`EntrySummary`: `id`, `type`, `locale`, `translationGroupId`, `slug`, `path`, `url`, `title`, `excerpt`, `readingTimeMinutes`, `publishedAt`, `updatedAt`, `revision { id, number }`, `hero` (image), `authors`, `terms`.

`Entry` adds:

- `body { doc, html, text }`: orbit-doc, HTML from the escaping renderer sanitized again, and plain text;
- `toc`, `fields` (type fields, e.g. FAQ, checklist, related links, CTA);
- `seo { title, description, canonical, robots, keywords, og { title, description, image } }`;
- `alternates` (hreflang, with `x-default` = the site's default locale);
- `structuredData`: JSON-LD objects; embed each in `<script type="application/ld+json">` with `<`, `>` and `&` escaped as `\u003c`, `\u003e` and `\u0026`, so no text can close the script.

Images: `{ assetId, alt, caption, credit, aiGenerated, width, height, src, srcset, og, renditions[] }`. URLs point to Orbit's public media route; they do not expire and are cacheable. Show `aiGenerated` images with their label ("KI erstellt" / "AI generated").

Use `manifest.revision` to decide whether a static build needs new data, and keep the last good answers as a snapshot so the site keeps working while Orbit is unreachable.

## Live check

A site that opts in (`adapterConfig.liveCheck`) renders `<meta name="orbit-revision" content="{revision.id}">` (or the revision number) on the entry page. Orbit checks the page after each publication and marks the publication live-verified, or asks a person after the last miss.

## Webhooks

Orbit sends signed POSTs to the endpoints a site names as notifiers ([OUTBOUND_WEBHOOKS.md](OUTBOUND_WEBHOOKS.md)). Headers: `X-Orbit-Event-Id`, `X-Orbit-Event-Type`, `X-Orbit-Timestamp`, `X-Orbit-Signature: v1=<hex HMAC-SHA256(secret, timestamp + "." + body)>` (two signatures during a secret rotation). Reject old timestamps (5 minutes) and deduplicate by event id.

Body: `{ id, type, occurredAt, projectId, data }`. `data` for content events:

```json
{
  "siteId": "…",
  "entry": { "id": "…", "type": "article", "locale": "de", "slug": "…", "path": "/blog/…/", "revision": 7 },
  "previousPath": null,
  "tags": ["orbit:entry:…", "orbit:list:<site>:article:de", "orbit:sitemap:<site>"]
}
```

| Type | When |
| --- | --- |
| `cms.entry.published` | first publication |
| `cms.entry.updated` | a new live revision (`previousPath` when the path changed) |
| `cms.entry.unpublished` | withdrawn, or the site was left out (`entry.path` null, `previousPath` set) |
| `cms.entry.scheduled` | a publication was scheduled (`scheduledAt`) |
| `cms.redirect.created` | `{ siteId, fromPath, toPath, code, tags: ["orbit:redirects:<site>"] }` |

An ISR site revalidates by the tags; a static site starts a rebuild.

## Preview

1. A member creates a token in Orbit: `POST /api/projects/:projectId/cms/entries/:entryId/preview` with `{ siteId }`. It is valid 30 minutes. With `adapterConfig.previewPath` set, the answer has a ready `previewUrl` (`<site><previewPath>?token=…&path=…`).
2. The site's preview route reads the current draft: `GET /api/v1/cms/preview/entries?token=…` with a `cms:preview.read` key (never cached). The answer is an `Entry` plus `preview { draftVersion, expiresAt, status }`.
3. Draft images load from `/api/public/cms/preview-media/:assetId/:file?token=…` while the token is valid and the draft shows them.

## Management: `/api/v1/cms/…`

Writes accept `Idempotency-Key` (24 hours; a different body under the same key is `422 IDEMPOTENCY_KEY_REUSED`).

| Route | Scope |
| --- | --- |
| `GET entries`, `GET entries/:id` | manage.read |
| `POST entries` (origin `api`), `PATCH entries/:id/draft`, `PUT entries/:id/sites`, `POST entries/:id/translations` | manage.write |
| `GET entries/:id/revisions`, `GET entries/:id/revisions/:revisionId`, `GET entries/:id/preflight`, `GET entries/:id/publications` | manage.read |
| `POST entries/:id/revisions` | manage.write |
| `POST entries/:id/publication-requests`, `POST entries/:id/unpublish-requests` | publish.propose; `202` with `requestId` |
| `GET terms`, `POST terms`, `PATCH terms/:id`; `GET authors`, `POST authors`, `PATCH authors/:id` | read / write |
| `GET sites` | manage.read |
| `GET assets`, `GET assets/:id`; `PATCH assets/:id`; `POST assets` (raw bytes, `Content-Type: application/octet-stream`, optional `X-File-Name`) | read / write |

A proposal records the key (prefix, never the secret) as requester. It executes only while the key is neither revoked nor expired (`409 API_KEY_ENDED` at decision time).

## Common errors

| Code | Meaning |
| --- | --- |
| `API_KEY_INVALID` (401) | missing, unknown, revoked or expired key |
| `API_KEY_SCOPE_MISSING` (403) | the key lacks the scope |
| `CMS_SITE_NOT_FOUND` (404) | unknown, archived or outside the key's filter |
| `CMS_ENTRY_NOT_FOUND` (404) | not live on the site (see `detail.redirect`) |
| `CMS_PREVIEW_NOT_FOUND` (404) | invalid, expired or foreign preview token |
| `CMS_PREFLIGHT_FAILED` (422) | `detail.issues` lists what stops the publication |
| `CMS_REQUEST_PENDING` (409) | the entry already has an open request |
| `CMS_DRAFT_STALE` (409) | the draft changed since it was read |
