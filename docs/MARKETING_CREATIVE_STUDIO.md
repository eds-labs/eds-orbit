# Marketing Creative Studio

State (2026-10-27): implemented locally on branch `claude/orbit-creative-studio-v2-3ae0b3` with the fixes of the whole-branch review (final fix wave, R61–R66), **not pushed, not deployed**, `ORBIT_CREATIVE_STUDIO` off. Design: [specs/2026-10-26-marketing-creative-studio-design.md](superpowers/specs/2026-10-26-marketing-creative-studio-design.md); plan: [plans/2026-10-26-marketing-creative-studio.md](superpowers/plans/2026-10-26-marketing-creative-studio.md); routes: [API_CONTRACT.md](API_CONTRACT.md#creative-studio); model route: [MODEL_ROUTING.md](MODEL_ROUTING.md#creative-vision-review-2026-10-27-local-flag-off).

The Studio turns a social post into a finished creative: AI artwork and/or approved product screenshots, headline, subline, optional call to action and the unchanged approved logo, composed per channel format and checked deterministically before a person sees it. It is generic: a project describes its brand and templates as data in the marketing profile; nothing in the code names a product, logo or colour of a real brand.

## Flag, scope and rollback

- `ORBIT_CREATIVE_STUDIO` (default `false`; `.env.example`, `docker-compose.yml`, `packages/config`). Getters read it per call. No migration: brand kit data lives in the profile JSON, creatives are `creatives` entities, renditions are assets.
- **With the flag off (CS-D6, R64):** no creative route (404 `NOT_FOUND`), no assistant tool and no `creative` field in the assignment tools, no UI (creative panel, Brand kit section, draft thumbnails, provider-use toggle, `screenshot`/`product` upload types, the "Creative vision review" task row). The draft instructions and JSON schema, the strategy's instructions and answer schema, and the JSON schemas of the assignment tools and the MCP `project_configuration_update` tool are those of the merge base `ad29a197`, pinned by SHA-256 in `creative/flag-off.test.ts`. Instagram and Facebook are unknown providers as before (no character limit, no `MEDIA_REQUIRED`, no Postiz `post_type`); the package snapshot has no `carriesPackageImage` and the package attach refuses `acceptQaFindings`. **The one intended change with the flag off:** a partial MCP configuration change no longer carries zod defaults, which used to overwrite the stored colours, fonts and design rules of fields the client left out (a data-loss fix; the tool's JSON schema is unchanged). The API also accepts, without any UI or tool sending them while off, the asset types `screenshot`/`product` and the `asset-status` field `providerUse`; with `ORBIT_IMAGE_REFERENCES=true` (off in production) reference image bytes need `providerUse` (R28 as narrowed by R64).
- **Enable sequence (R65):** (1) Turn the flag on. The manual studio works for a project with a brand kit and an approved primary logo; with the flag alone the Instagram/Facebook channel rules, draft thumbnails, the MCP brand kit keys and the vision review task row appear, and nothing automatic changes: drafts, the strategy and packages are written and illustrated as before. (2) The owner opts a project in to automatic creatives in Settings → Brand → "Automatic creatives for this project" (`visualIdentity.creative.enabled: true`, absent = off). Then social drafts are written with copy craft (core message and hook), packages with an image compose a creative per draft, and assignments accept `creative` (else 409 `CREATIVE_STUDIO_NOT_ENABLED_FOR_PROJECT`). (3) Per assignment, `creative` turns on art planned by the strategy and composed per post. The Marketing module must be active for the project (`MODULE_DISABLED` otherwise, see [MODULE_ACTIVATION.md](MODULE_ACTIVATION.md)).
- **Rollback (M7):** before turning the flag off, pause the assignments with `creative`: with the flag off the review no longer checks a creative's image copy or QA (no `CREATIVE_QA_FAILED` hold), so with `delivery: "postiz_draft"` an agent approval could hand off a creative that failed its checks. Then set the flag to `false` and redeploy. Redeploying the previous image instead also drops the rendition rights checks at preflight (R36) and at the Postiz draft handoff (R48). Stored creatives and renditions are ignored by old code; posts that already carry a rendition keep it as a normal approved PNG.
- Rollout note: compose changes alter rendered bytes. Creatives stored before a deploy that changed the engine recompose differently (layout, scrim, logo size); the stored renditions stay as they are until someone recomposes. The legacy uLiquid `brand_landscape` banner (assignment `banner`) is unchanged byte for byte (CS-D3).

## Brand kit

Settings → Brand (owner edits, others read). All fields are optional in `visualIdentity` of the marketing profile, so every saved profile stays valid; saving makes a profile version and invalidates pending content as it does today.

| Field | Meaning |
| --- | --- |
| `logoAssetId`, `logos.{secondary,onDark,onLight,mark}` | Approved raster logos. The composer picks the variant by the luminance behind the anchor. A logo is placed with its exact approved bytes (SHA-256), never recoloured, cropped or redrawn. |
| `productAssetIds` (≤ 20) | Approved `screenshot` / `product` assets used unchanged (scaled, aspect kept). |
| `imagery` | `kind` (photo, illustration, 3d, flat, mixed), `mood` (≤ 300), `subjects` (≤ 500), `avoid` (≤ 20 × 200): art direction input. A partial update over MCP replaces `imagery` as a whole. |
| `typography` | `headingWeight` 600/700/800, `headingCase` none/upper. Fonts are the installed Inter and DejaVu Sans only (no new font dependency). |
| `forbiddenDesigns` (≤ 20 × 300) | Layout or design variants the art direction must avoid. |
| `creative.templates` | Per template `{enabled, variant?}`. An explicit manual template ignores `enabled` (R30); automation respects it. |
| `creative.formatsByChannel` | Provider identifier → formats (override of the channel mapping). |
| `creative.logoPlacement` | `auto` (first free corner) or a corner. |
| `creative.ctaStyle` | `pill`, `outline`, `none`. |
| `creative.maxArtCorrections` | 0, 1 (default) or 2 paid art attempts per creative. |
| `creative.visualReview` | Optional vision review (default off). In an assignment it needs `providerUse` on every brand kit logo (`VISION_REVIEW_PROVIDER_USE_REQUIRED`, M3). |
| `creative.enabled` | The project's opt-in to automatic creatives (R65, owner toggle "Automatic creatives for this project"; absent = off). |

The Brand tab lists stale references (an unapproved or outdated logo, screenshot or product) with a Remove button; a stale reference blocks every profile save otherwise. The `creative` block is read-only over MCP; the other brand kit keys (`logos`, `productAssetIds`, `imagery`, `typography`, `forbiddenDesigns`) are offered to MCP clients only with the flag on (R64).

**Assets and rights.** Brand assets stay `assets` entities. Upload and Drive import accept the types `screenshot` and `product`; with the flag on the upload forms of the asset library and of Google Drive offer them (R61). The owner-set flag `providerUse` (default `false`) allows an asset's bytes to be sent to an AI provider. With the flag on the owner sets it as "May be sent to AI providers" on approved assets in the Brand asset library and for the brand kit's logos and product images (the primary logo included); others see the state read-only. The web sends it with the existing `asset-status` action (`{assetId, version, assetStatus: "approved", confirmUsageRights: true, providerUse}`, owner only, see API_CONTRACT.md). Every asset whose bytes go to any provider (reference images, vision review) must be approved, usage-approved and `providerUse` (R28, one shared helper `mayTransmitToProvider`, built on `isApprovedAsset`); the written style description of an assignment's approved references keeps its behaviour from before (R64). Art generated by Orbit for an assignment run is stored with `providerUse: true` (R59): it already came from the provider; logos and screenshots still need the owner's flag. A rendition counts as an approved image only while every component in its `rightsSource` is still approved with the recorded SHA-256 (R36); the owner-confirmed Postiz draft handoff checks the same (R48).

## Templates, variants and formats

Seven templates, each with 2–3 variants (the first is the default). Side variants exist only on `landscape` and `square`; when a project default does not exist for a format the resolver uses the first valid one (R1), and on landscape it prefers the first side variant of a template with a product or lifestyle (R12, R16). A manual explicit variant a format does not offer fails with `CREATIVE_VARIANT_NOT_AVAILABLE` (R31).

| Template | Variants | Art | Product |
| --- | --- | --- | --- |
| `product_showcase` | product_right, product_left, text_top | optional | required |
| `feature_highlight` | text_top, product_left, product_right | optional | required |
| `problem_solution` | text_top, text_bottom | required | optional |
| `lifestyle` | text_bottom, text_top, text_side | required | none |
| `tips` | text_top, centered | optional | none |
| `announcement` | centered, text_bottom | optional | optional |
| `brand_message` | centered, text_bottom | required | none |

Copy limits (characters): eyebrow 32, CTA 24, headline 60 (tips and brand_message 70), subline 120 (tips 180). Text is set with Pango through sharp, so measured size equals drawn size; it auto-fits between a template's maximum and minimum and fails with `TEXT_OVERFLOW` rather than being cut.

| Format | Size | Default channels |
| --- | --- | --- |
| `feed_portrait` | 1080 × 1350 | instagram, facebook |
| `square` | 1080 × 1080 | unknown channels |
| `story` | 1080 × 1920 (top 250 / bottom 340 px reserved) | override only |
| `landscape` | 1200 × 630 | x, linkedin, telegram |
| `wide` | 1600 × 900 | legacy banner only (`brand_landscape`), not a Studio format |

One rendition is composed per format a post needs (`creative.formatsByChannel` overrides the defaults); a post carries the rendition for its channel's format. Art is generated once per brief from the primary format's layout (R32); other formats crop the same art.

## Channel rules

Only with the flag on (R64; off, both are unknown providers as before): Instagram (`instagram`, `instagram-standalone`): caption 2,200 UTF-16 units, media required (preflight 409 `MEDIA_REQUIRED`; a text-only draft can still be reviewed; the agent review leaves it for the owner), Postiz `post_type: "post"` (stories are not modelled). Facebook: 50,000 (the Postiz client's bound; Postiz itself allows 63,206), media optional. Both carry `liveCapabilityKnown: true`, verified read-only against the Postiz integration schema. Preflight keeps requiring an approved PNG. Instagram captions have no clickable links.

## Quality assurance

Deterministic checks (`creative/quality.ts`, thresholds in `CREATIVE_THRESHOLDS`, calibrated on the demo fixtures and listed in spec §9):

| Code | Threshold / rule | Handling |
| --- | --- | --- |
| `CREATIVE_DIMENSIONS`, `SAFE_AREA_VIOLATION`, `LAYER_OVERLAP` | exact format size, layers inside safe area, no overlap | render bug → `needs_owner` |
| `CREATIVE_FILE_TOO_LARGE` | PNG > 8 MiB | blocker, not corrected automatically → `needs_owner` |
| `TEXT_OVERFLOW` | copy does not fit at minimum size | other variant, then the small text scale (`s`); still too long → 409 `TEXT_OVERFLOW` (manual) or `needs_owner` (run). `CREATIVE_TEXT_TOO_LONG` is the earlier copy-limit check |
| `TEXT_CONTRAST_LOW` | < 4.5:1 body text and every subline; < 3:1 large text (≥ 32 px) | stronger scrim, then other variant |
| `TEXT_BACKDROP_BUSY` | busyness behind text > 0.015 (R17) | compose already raises the scrim itself (under a full tint capped at 0.6, R17, R23/R23a); the correction is a variant switch (R22) |
| `LOGO_CONTRAST_LOW` | < 2:1 | compose already picks the best variant and draws a plate behind the unchanged logo when none reads (`logo.ts`); it also plates a transparent logo below a comfort contrast of 3:1 or on a backdrop busier than `busyLogo` (0.015, as for text), keeping the plate only when it improves the logo's contrast and never shrinking the logo below the R19 minimum (the padding is capped, a comfort plate without room is left out); a logo with its own opaque backing is never plated (R70); the correction switches to another logo variant |
| `LOGO_INTEGRITY` | bytes ≠ approved SHA-256, aspect changed, drawn longer side < 0.06 of the canvas's shorter side (R19) | **refuse** |
| `SCREENSHOT_INTEGRITY` | bytes ≠ approved SHA-256 or aspect changed | **refuse** |
| `ASSET_RIGHTS` | component not approved, use not covered, outdated, other project | **refuse** |
| `SUBJECT_TOO_SMALL` | all connected subjects ≥ 64 cells cover < 25 % of the drawn art | art correction |
| `EMPTY_AREA_EXCESSIVE` | flat cells outside the reserved zones > 45 % of the drawn art | art correction |
| `ASSET_UPSCALED` | a raster layer drawn at > 1.5× its source | warning only |
| `CREATIVE_UNSUPPORTED_CLAIM`, `CREATIVE_PROHIBITED_LANGUAGE`, `LINK_UNVERIFIED` | the image copy names a figure, number word, price or status, a promise or the profile's prohibited wording, or a bare host (the banner copy rules, spec §10, R66) | blocker, not corrected → `needs_owner` (manual, recompose, package and run copy) |
| `CREATIVE_TEXT_UNSAFE`, `CREATIVE_LINK_NOT_ALLOWED` | invisible or look-alike characters, an explicit link on the image | **refuse** with 409 before anything is read or stored; `detail.codes` lists every copy problem |

The image copy is checked with the banner copy rules wherever it comes from (R66): a person's copy in the studio, a recomposition's, a package draft's and a run draft's. The CTA is exempt from the claim and wording checks only when it is the post's mission CTA. Art checks judge the art as it is drawn (`drawnArt`, `artZones`, R21) on an area-averaged 64-cell grid, so grain, JPEG artefacts and resolution do not change a verdict (R20, R25, R26). A decorative strip beyond 4:1 is not judged (R24); art in a band beyond 2.5:1, such as the tips band on square and portrait (2.9:1), is judged for `SUBJECT_TOO_SMALL` only and `EMPTY_AREA_EXCESSIVE` is a warning there (R60). Known limits (R27): a smooth gradient or vignette can count as subject; `drawnArt` composites onto black, which matters only for art with an alpha channel.

**Refusals (R34, R46).** `LOGO_INTEGRITY` (every reason), `SCREENSHOT_INTEGRITY` and `ASSET_RIGHTS` are never overridable by `acceptQaFindings`: produce or recompose stores nothing and answers 409 with the code and a `detail` of ids and codes (R56). `needs_owner` findings can be accepted only by an owner.

## Corrections and limits

1. **Free and deterministic:** other layout variant (up to 2), stronger scrim (low contrast only, while the drawn scrim is below the layout's maximum), other logo variant (compose draws a plate itself when no variant reads), smaller text scale. Recomposition (variant, logo placement, text scale, edited copy) is free and keeps the art.
2. **Art regeneration** (owner, costs one image): at most `maxArtCorrections` (default 1, maximum 2) per creative, with a targeted prompt delta (`subject_larger`, `calm_text_zone`, `more_detail`). Every attempt that was sent counts (`ART_CORRECTION_LIMIT` before anything is reserved). Regenerate replaces the art with new Orbit art, also uploaded art (R52).
3. **Still failing:** the creative is `needs_owner`; the content gets `CREATIVE_QA_FAILED` and is left for the owner. Nothing is attached as approved and nothing is published.

Before new art is paid for (produce with `generateArt`, regenerate) one free placeholder composition runs and refuses art-independent failures (`TEXT_OVERFLOW`, `LOGO_INTEGRITY`, `SCREENSHOT_INTEGRITY`, `ASSET_RIGHTS`) so no money is spent on a creative that cannot succeed (R53). New art is stored unapproved: the creative is `needs_rights` until the owner approves the art and recomposes. After a failure that followed payment, the error `detail.artAssetId` names the paid art, which stays as an unapproved reference. The client `requestId` (uuid) makes a retried paid request answer `RESERVATION_ALREADY_USED` instead of paying twice (R51).

## Costs and the vision review

- Composition, recomposition and deterministic QA are free. Only art generation and the vision review cost money, and both go through the existing path: spend mandate, reservation before transmission, settle after the call, unknown outcomes stay counted and are never resent. There is no automatic budget increase; run, package, project and organisation limits apply. Manual paid requests are limited to 3 a minute per client in a bucket of their own and need `confirmMaximumCostMicros` and `confirmPromptMayBeSentToProvider`; every produce request, free or paid, also counts against the client's ordinary write limit (M4). A paid regeneration refused because another request holds its attempt (`VERSION_CONFLICT`, `RESERVATION_ALREADY_USED`) leaves the attempt and its cost to that request (M1); the produce form draws a new request id after a paid creative was made (M9).
- **Vision review (CS-D2).** Optional per project (`creative.visualReview`, default off), owner-started (`POST …/review`). Task class `creative_review`, `respond()` with the first format's rendition as `input_image`, a strict rubric of seven scores from 1 to 5 (subject, balance, legibility, brandFit, messageFit, channelFit, value) and issues of kind art, layout, copy or logo. Orbit computes the verdict: `pass` when every score ≥ 3 and the mean ≥ 3.5, otherwise `needs_correction`. It runs only when every component has `providerUse` (`PROVIDER_USE_REQUIRED`) and never for a `superseded` creative or one that `needs_rights` (409 `CREATIVE_NOT_REVIEWABLE` before anything is reserved, M2). The review is keyed on the rendition's SHA-256 (`creative-review:<creativeId>:<sha>`): an already judged rendition returns its stored verdict without a second payment (R50). It is scoped per creative; a newly produced creative starts without a verdict (R57, known limit: no per-rendition verdict history, so recomposing back to an earlier layout or re-reviewing identical pixels after an unknown outcome needs a visible change). A failing verdict sets `qa.verdict: "needs_owner"`, survives recomposition (R49) and, on an attached creative, keeps the status `attached` (R5a). It never approves, attaches or publishes anything. The run kind is `image` (telemetry), see MODEL_ROUTING.md.
- The assignment card shows the templates and an image cost estimate; the consent text names the logo and product assets used.

## Creative statuses

`status` is the lifecycle: `composed`, `needs_owner`, `needs_rights`, `attached`, `superseded`. `qa.verdict` is the quality: `pass`, `corrected`, `needs_owner`. Attaching sets `attached`; recomposing an attached creative makes new renditions while the post keeps the attached one until the next attach (R5). Attaching resets the content to `draft` and re-runs `reviewContent`, like `attachPackageImage`; repeating an attach changes nothing.

## Assignments and packages

- **Assignment field `creative`** (social only, `image: true`, exclusive with `banner`): `{templates?: TemplateId[1..7], artPer: "run" | "post" (default post), imageKind?: "auto" | "scene" | "product" | "graphic" | "combined" (default auto)}`. Hashed into the confirmation only when set, so existing confirmations stay valid. Readiness 409 codes in order: `CREATIVE_STUDIO_DISABLED`, `CREATIVE_STUDIO_NOT_ENABLED_FOR_PROJECT` (R65), `CREATIVE_SOCIAL_ONLY`, `CREATIVE_NEEDS_IMAGE`, `CREATIVE_AND_BANNER`, `CREATIVE_LOGO_REQUIRED`, `VISION_REVIEW_PROVIDER_USE_REQUIRED` (M3); checked at proposal, change, confirmation, resume and in the visual step before any cost.
- The strategy specialist gets the creative prompt and answer schema only for a task whose assignment carries `creative`, which the runner passes only for an opted-in project (R65); it returns a structured `creative` brief (goal, audience, keyMessage, imageKind, motif ≤ 400, setting, template, mood); the copywriter returns `coreMessage`, `hook` and `creative` copy (`CREATIVE_TEXT_TOO_LONG` is a revisable code, `CREATIVE_TEXT_MISSING` for absent copy; creative copy is never in the claims ledger). The visual step generates one art per run or per post, checks it and applies bounded art corrections within the run budget. Composition runs per slot and channel format after the drafts exist. In a run, a creative with findings stays `attached` with `qa.verdict: "needs_owner"`; the agent review reports `CREATIVE_QA_FAILED` from `qa.verdict`, not from the status.
- **CS-D7: agent review authority does not cover creatives.** With `delivery: "publish"` a post with image copy or with any attached creative (also one a person attached in the studio to a draft of an assignment without `creative`, R66) waits for the owner's release until the review eval set has creative cases and has passed; `postiz_draft` is unchanged. A person's attach in the studio also drops the post's agent review. A channel that cannot carry the image holds back only that channel (`CREATIVE_MEDIA_REFUSED`).
- **Content packages.** With the flag on, the project opted in (R65) and a primary logo, attaching a package image composes renditions per channel draft instead of attaching the raw image. A QA failure, also an image copy finding (R66), fails the whole attach atomically (409 `CREATIVE_QA_FAILED` with the failing content ids and codes); an owner may pass `acceptQaFindings` (R54, accepted only with the flag on). With the flag on the snapshot exposes `carriesPackageImage` per draft (R58), and the web hides "Attach package image" then.

## Routes

See [API_CONTRACT.md](API_CONTRACT.md#creative-studio) for bodies and errors.

| Route | Role |
| --- | --- |
| `GET /api/projects/:id/creative/options` | any member |
| `POST /api/projects/:id/creatives` | editor; owner with `generateArt` |
| `GET /api/projects/:id/creatives/:creativeId`, `GET /api/projects/:id/content/:contentId/creative` | any member |
| `POST …/creatives/:creativeId/recompose` | editor (free) |
| `POST …/creatives/:creativeId/regenerate-art` | owner (one image) |
| `POST …/creatives/:creativeId/review` | owner (vision call) |
| `POST …/creatives/:creativeId/attach` | editor; owner for `acceptQaFindings` |

**Art direction (R71).** With new art, the produce form and the regenerate dialog offer optional fields Motif, Setting (place, light, time of day) and Mood (`artDirection: {motif, setting?, mood?}`, the strategy's limits 400/300/160). Without a motif a manual creative's art shows the post's title, which can make a weak picture; a regeneration without one keeps the stored art plan. Because an art direction replaces motif, setting and mood as a whole, the regenerate dialog shows the stored ones as editable values: unchanged, it sends nothing (the stored plan is used); changed, it sends exactly what it shows, and an emptied setting or mood is left out. It is for new art: produce refuses it together with a chosen `artAssetId` (400 `INVALID_TEMPLATE_INPUT`, R31), and the web sends it only with new art. The art direction is stored in the creative's `brief`, kept by every recomposition (also with another template) and replaced only by a regeneration that brings a new one. It follows the image copy's character and link rules (409 `CREATIVE_TEXT_UNSAFE` / `CREATIVE_LINK_NOT_ALLOWED` with `detail.codes`, before anything is read, paid or stored); the art prompt keeps its fixed no-text, no-logo and no-real-person rules. Known limit: when the recomposition after a paid regeneration fails, the paid art (kept as an unapproved reference, `detail.artAssetId`) was made from the new art direction while the stored brief keeps the old one. The paid path is unchanged: free trial composition first (R53), the client's `requestId` (R51) and the owner's confirmation.

Request bodies are strict and no body can choose how a creative is attached (R45). Error `detail` carries ids and codes only (R56). The routes are in the access matrix. The web has a creative panel in the content detail (replaces the old Creative modal when the flag is on; rendition tabs per format, components and rights, QA checklist, cost, actions) and the Brand section described above.

## Internal previews over MCP and the assistant (2026-10-28)

A client (ChatGPT over MCP, the Orbit Assistant) can have one finished creative made without a post, assignment, package, schedule, publication or Postiz draft. Decisions (Mario, 2026-10-28): **CP-D1** the client writes the post text and the image copy (using Orbit's fact search); Orbit checks it with the studio's copy rules and reports exact duplicates of existing posts, and pays only for the image. **CP-D2** the result tool returns the image as MCP image content (a JPEG of at most 720 px on the longer side, MCP_IMAGE_LIMIT_BYTES 512 KB); `orbitUrl` points at the PNG rendition and needs an Orbit sign-in; there is no public or signed link. **CP-D3** the tools are listed while `ORBIT_CREATIVE_STUDIO` is on (feature `creative_studio`); the proposal tool also needs `ORBIT_MCP_PROPOSALS` and the scope `orbit:propose`, the reads `orbit:read`. No new flag, migration or dependency.

| Tool | What it does |
| --- | --- |
| `marketing_creative_options` | Brand kit state: the configured primary logo (`visualIdentity.logoAssetId`) and whether it is usable, logo roles, palette and fonts, product asset ids, enabled templates; approved art assets (metadata); templates with copy limits and variants; formats with pixel sizes; formats per channel (defaults plus the project's `formatsByChannel`); image model and cost per image; the preview budget maximum. |
| `marketing_creative_preview_create` | Proposal (owner approval in Orbit): `channel` (provider identifier, e.g. `instagram`), optional `format` (`feed_portrait` 1080×1350, `square`, `story`, `landscape`), `language`, `title`, `postText`, `copy {eyebrow?, headline, subline?, cta?}`, optional `template`/`variant`/`logoPlacement`, `art` = `generate` (one paid image, owner only, optional `artDirection`), `asset` (`artAssetId`, an approved art asset) or `none`, optional `productAssetId`, `maxBudgetMicros` (≤ USD 2), `idempotencyKey`. |
| `marketing_creative_preview_status` | By `previewId`, or by `actionRequestId` before approval: `awaiting_approval`, `queued`, `running`, `completed`, `failed`, `blocked`; phase, progress, error code, blockers, cost. |
| `marketing_creative_preview_result` | Post text, image copy, rendition (format, size, aspect ratio, asset id, SHA-256, `orbitUrl`), template and variant, brand kit profile version and the logo asset drawn, art and product ids, QA checks, rights state, duplicate post ids, cost; plus the image. |

**Flow and guarantees.** The proposal is checked for free (brand kit, brief, copy rules, rights of named assets, `PREVIEW_BUDGET_TOO_LOW` when the image ceiling exceeds `maxBudgetMicros`) and saves an exact owner approval whose ceiling is the image ceiling (0 without new art) and whose approval context holds the profile version, ceiling and exact art prompt; a change before the decision is `PREVIEW_STALE`. The approval stores a `creative_previews` entity and queues one job (`creative_preview`, `maxAttempts: 1`). The worker plans with the proposer's current role, refuses a changed prompt or ceiling before paying, composes a free trial over stand-in art (R53), generates at most one image through the owner's image path (reserved at the ceiling, request id = preview id, so it is never paid twice; the project's spending policy applies), composes the renditions and stores a creative with `previewId` instead of `contentId`. The worker also refuses a changed brand kit profile version (`PREVIEW_STALE`). New art stays an unapproved reference, so the creative `needs_rights` (`rights.status: awaiting_owner_rights_decision`). A preview's renditions are stored as references bound to the preview (`boundTo.previewId`) and never count as approved: preflight and the Postiz draft handoff refuse them (`ASSET_NOT_APPROVED_OR_UNSUPPORTED`) even when a post names one. Refusals are recorded on the preview (`blocked` for brand kit, budget, policy and rights codes, else `failed`); a lease expiry while running is `PREVIEW_OUTCOME_UNKNOWN` and never retried. A preview's approval is not a publishing approval; nothing moves it into publishing, Postiz or an assignment.

**Known limits.** No vision review in a preview (new art needs the owner's rights first, M2); no Orbit-written text (CP-D1; a later option); a preview cannot be attached to a post yet; the duplicate check is exact text only.

## Verification and demo

- `node scripts/creative-demo.ts [outDir]` renders two fictional demo brands × 7 templates × 4 formats with fixture art (0 USD) plus the bad-art cases of acceptance test C into `.runtime/creative-demo/` with a contact sheet and `report.json`; it exits non-zero when a good render fails QA or a bad art goes unnoticed.
- Flag off: `apps/api/src/modules/marketing/creative/flag-off.test.ts` pins the draft and strategy prompts and schemas and the assignment and MCP configuration tool schemas to the merge base (SHA-256).
- Acceptance A–E (`apps/api/tests/creative-acceptance.integration.test.ts`): A lifestyle, B product feature in four formats with the screenshot unchanged, C bad art caught and bounded, D tenant isolation, E approvals unchanged. The browser flow is `apps/web/tests/creative-studio.spec.ts`, gated by `CREATIVE_STUDIO_E2E=true`; `scripts/creative-studio-browser.ts` seeds and starts the API with every `OPENAI_*` and `ANTHROPIC_*` key and route variable removed from its environment, so no paid generation is possible (R62); its header has the run recipe (test database, seed, `next dev` on 4310, `CREATIVE_STUDIO_E2E=true`, a fresh seed per run).
- Font metrics differ per host: tests assert relations only, and the engine was also checked in the Linux image with Inter and DejaVu (R11). Production fonts: `fonts-inter`, `fonts-dejavu-core` (`infra/Dockerfile`).

## Known limits and follow-ups

- Task 22 (live acceptance) passed on 2026-10-27: one real image per demo brand, QA and vision review pass, USD 0.51 booked. `scripts/creative-live-run.ts` runs it again on the worktree's isolated database (free dry run by default; `--pay` needs `OPENAI_API_KEY` in the launch environment and is capped at USD 1).
- **CS-D3 follow-up:** uLiquid still uses the hard-coded `brand_landscape` banner. Moving it to a generic template through its profile, then removing the hard-coded template, is a later step.
- Fonts are Inter and DejaVu only; more fonts need font packages in the image (new dependency).
- No video, carousels or animated formats; no new image providers (adapter-ready, needs a decision).
- Marketing assets stay base64 `Entity` data, not platform files.
- Instagram stories are not modelled; links in Instagram captions are not clickable (a "link in bio" copy rule is later).
- Review eval cases for creatives are missing, so agent authority does not cover them (CS-D7).
- Vision verdict is per creative, with no per-rendition history (R57).
- Art direction: a smooth gradient can pass `SUBJECT_TOO_SMALL` (R27); product prompts ask 60–75 % subject size while two reserved zones exist; busyness is inflated by synthetic grain in fixtures.
- Non-default stacked landscape variants (for example product_showcase `text_top`) offer less text room and may need a variant switch.
