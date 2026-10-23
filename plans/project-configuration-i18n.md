# Project configuration, content languages and links

Status: accepted by Mario 2026-10-23 (branch `claude/eds-orbit-config-i18n-a781a4`).

## Findings (current state)

| Area | Current implementation | Problem |
|---|---|---|
| Project settings | `Project.language` (`en`/`de`), edited in Settings → Project → "Edit project" (`project-administration.tsx`, action `project-settings`, owner only) | Single language, English-only labels ("Content language", "Project access") |
| Marketing profile | `ProjectMarketingProfile.data` (versioned): `contentLanguage` copied silently from `project.language` on save, `internalLanguage`, `officialLinks[{label,url,factId}]` | Panel titled "Project configuration" although it is the Marketing profile; fixed uLiquid labels (Web app, Beta registration, Getting Started required); "Presale strategy"; uLiquid brand terms in hints |
| Content language use | `mission.language`, `content.language`, facts, knowledge sources: `z.enum(["en","de"])`; `assertCampaignContext` requires `mission.language === profile.contentLanguage`; assignments/copywriter/review write in `profile.contentLanguage`; fact query matches `fact.language` exactly | No other languages; deterministic checks (fact-claim matcher, banner Latin-script check) are tuned for English/German |
| Saving the profile | New version → pending content set to `needs_review` | A data migration must not bump the profile version (would damage running assignments) |
| UI language | Per user (`User.locale`, localStorage `orbit.locale`), `labels.en/de` in `apps/web/src/lib/i18n.ts` | Already independent of project; many settings panels hardcode English or inline `de ? … : …` |
| Social links | Only as fact-bound official links in the Marketing profile (X, Telegram ×2, LinkedIn) | No Instagram, Facebook, TikTok, YouTube, Threads, Bluesky, Pinterest, Discord, App Store, Google Play, custom links |
| Publishing channels | Connections (Postiz, Telegram, Slack …) with verification | Must stay separate from profile links |
| Branding | `layout.tsx` metadata and `orbit.tsx` sign-in/landing copy: "A self-hosted marketing workspace" | Outdated since the modular platform |

## Plan

1. **Shared language model** (`packages/schemas`): `languageCode` (BCP 47 subset: `ll`, `ll-RR`, `ll-Ssss`), a curated catalog (≈35 common languages) with names via `Intl.DisplayNames`, plus `projectLanguages` = `{ contentLanguages: code[1..20], defaultContentLanguage ∈ contentLanguages }`.
2. **Project data + migration**: add `Project.contentLanguages text[]`; migration fills `ARRAY[language]` (lossless). `Project.language` stays the default content language (all existing readers keep working). `project-settings` accepts the list and the default; owner check unchanged; audit event added.
3. **Content pipeline**: mission/content/knowledge language schemas accept `languageCode`; new missions/contents must use one of the project's content languages. Marketing generation (assignments, copywriter, review, banners) keeps `profile.contentLanguage` — existing assignments are untouched; the profile editor offers the project's languages instead of copying silently. See decision 2 for languages without deterministic checks.
4. **Links**: see decision 1. Type catalog with per-type host validation (HTTPS; e.g. `instagram.com`, `apps.apple.com`, `play.google.com`), custom links with name/URL/type, list editor with add/remove/reorder. Clear wording: "Profile links are not publishing channels; channels are connected under Integrations."
5. **UI i18n + cleanup**: project settings, marketing profile panel and branding copy in de/en via `labels`; `t()` falls back to English, then the key; a test asserts DE has every EN key. Replace "self-hosted marketing workspace" with the modular wording. Move uLiquid-specific labels/hints out of the core (generic link types, generic hint text).
6. **Tests**: schema unit tests (codes, default ∈ list, links/hosts), migration/persistence integration test, permission negative test (editor/viewer cannot change), web tests for multi-select, default switching, link editor, language switch + fallback; desktop/mobile check in the browser.

## Decisions (Mario, 2026-10-23)

1. Links: one project-wide link list (Settings → Project); the Marketing profile picks its official target links from it and keeps the verified-fact binding. Stored `officialLinks` stay unchanged.
2. Languages: project, knowledge sources, facts, missions and content accept any supported language code; automatic Marketing agents/assignments stay English/German (fact and banner checks are tuned to them), shown clearly in the UI.
3. Delivery: implement and test locally, commit on the branch, ask before pushing to `main` (push = production deploy including the migration).

## Out of scope

No new publishing integrations; no change to running assignments' language; no production deployment or migration without separate approval.

## Implementation (2026-10-23, branch `claude/eds-orbit-config-i18n-a781a4`)

- `packages/schemas/src/project-settings.ts`: language tags (`languageCode`, normalization, catalog), `AGENT_CONTENT_LANGUAGES` (`en`, `de`), link types with host rules, `projectLinks`. The web copy is `apps/web/src/platform/project-settings/catalog.ts`; a parity test keeps both equal.
- Migration `202610250001_project_languages_and_links`: `Project.contentLanguages` (from `language`, plus a differing Marketing profile language) and `Project.links` (copied from the profile's `officialLinks`, type derived from the label, `custom` otherwise). The profile row and its version are not touched, so no pending content is invalidated. Both tables force RLS, so the copy lifts FORCE for the owner inside the migration's transaction and restores it.
- `project-settings` owner action (`apps/api/src/platform/tenancy/project-settings.ts`): languages, default, links; callers sending only `language` keep working; content-free audit `project_settings.update`.
- Content schemas: missions, contents, marketing plans, editorial briefs, knowledge sources/facts/imports, knowledge MCP tools and index evaluation cases accept any language tag. The Marketing profile's `contentLanguage` (what assignments and agents write in) stays `en`/`de`; assignment tools are unchanged.
- Campaign rule (`assertCampaignContext`): a campaign language must be the profile's language (unchanged behaviour) or one of the project's content languages.
- Assistant: `project_status.project.contentLanguages`, one prompt sentence on choosing a mission language.
- UI: Settings → Project shows content languages (multi-select, free default, other codes) and profile links (grouped list, editor with type, name, address, reorder, validation, note that links are not publishing channels). The Marketing "Project configuration" panel is now the localized "Marketing profile"; its official target links come from the project links that a public verified fact backs; current links are never dropped. Knowledge and Marketing forms offer the project's languages. New-project form asks for the default content language. UI labels fall back to English, then to the key. "Self-hosted marketing workspace" wording replaced by the modular platform wording.

## Rollout and rollback

- A push to `main` deploys and runs the additive migration. No flag; the new settings are visible to owners at once. Running assignments keep the profile language and are not invalidated.
- Rollback: redeploy the previous image; the two new columns are ignored by older code. Removing them (`ALTER TABLE "Project" DROP COLUMN "contentLanguages", DROP COLUMN "links"`) loses only data entered after the deploy.

## Follow-ups

- The fact-sentence matcher still falls back to built-in uLiquid brand words when a profile has no `brandTerms` (`apps/api/src/modules/marketing/policy/fact-claims.ts`). Removing that special case needs `brandTerms` set in the uLiquid profile first (a profile save creates a new version).
- The sidebar footer shows a hard-coded "0.1 RC" while `VERSION` is 1.1.0.
- Deterministic fact and banner checks for languages other than English/German, if agents should write in them later.
