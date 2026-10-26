# Marketing Creative Studio v2 — design

Status: proposed design, awaiting Mario's review. Date: 2026-10-26.
Branch: `claude/orbit-creative-studio-v2-3ae0b3` (worktree), base `origin/main` `ad29a197`.

## 1. Goal and success criteria

Orbit's Marketing module produces finished, brand-consistent marketing creatives
— not a raw AI illustration plus generated text. A creative is a composed image
(AI artwork and/or approved product screenshots, headline, subline, optional
CTA, the unchanged approved logo) in the formats its channels need, with copy
that has one clear message, a hook, a concrete benefit and a channel-fitting
call to action. Measurable quality is checked deterministically before a person
sees it; bad results get bounded, budgeted corrections and are never published
automatically.

Everything is generic and tenant-scoped: no product names, logos, colours or
styles of FamilyPlan, uLiquid or EDS Labs in the core. A project configures its
brand kit and templates as data.

Success criteria (Mario's acceptance tests A–E, section 12):

- A lifestyle post from a general brief: strong motif, clear message, original
  logo composed, brand colours, complete copy, QA passed.
- A product feature post from an approved screenshot: the screenshot is used
  unchanged, professional layout, several formats.
- A deliberately bad image is caught, a concrete correction is proposed or
  applied within limits, nothing is published.
- Two projects never see each other's brand assets, colours or information.
- A finished creative is published only with the approvals required today.

## 2. Findings in the current code

| Symptom (first end-to-end test) | Cause |
| --- | --- |
| Tiny abstract motif, large empty areas | The assignment image prompt is only the strategy brief's `imageIdea` ("a short picture idea", 600 chars) or its topic (`agents/specialists/visual.ts:542-550`), sent at 1024×1024 medium quality through `assignmentImagePrompt` (`brand/image-generation.ts:128-143`). No composition, subject scale, reserved zones, palette or style. |
| Approved logo not in the motif | The logo is composed only by the assignment banner `brand_landscape` (16:9 only). Its colours (`#040B1A`, `#22D3EE`) and background prompt `DEFAULT_BANNER_STYLE` ("fintech", "@uLiquid_desk") are uLiquid-specific and hard-coded (`packages/creative/src/index.ts:312-330`, `agents/banner.ts:80-87`). Without a banner the raw artwork is attached. |
| No real composition | The manual `CreativeRenderer` (`brand/render-asset.ts`, `renderTemplate`) draws the visual at 16 % opacity behind a white card; text widths are estimated per character, not measured with the font. |
| Generic, long copy | `DRAFT_INSTRUCTIONS` (`packages/ai/src/index.ts:274`) is about facts only. A text fact is inserted through `{{fact:id}}` as its complete sentence, so long knowledge-base descriptions end up in social posts. No hook / benefit / CTA structure. |
| No visual quality check | The review checks claims, links, format and banner copy; the image is checked only as "approved PNG" in preflight (`policy/policy.ts:623-632`). |
| Wrong formats | One image per run for all channels. Instagram and Facebook have no channel rules (`publishing/channel-rules.ts:23-86`), so `mediaRefusal` refuses images there with `MEDIA_NOT_SUPPORTED`. |

Reusable foundations: sharp 0.35.5 with libvips, Pango, HarfBuzz and librsvg
(already a dependency of `@orbit/creative`; a spike confirmed real font
measurement with the installed Inter and DejaVu); the logo integrity check by
SHA-256; image rights consent at assignment confirmation; the paid-call path
(`requireSpendMandate` → `reserve` → `markTransmitted` → call → `settle` →
`recordSpan`); bounded revisions; novelty and channel history; `respond()` with
`input_image` parts (used by finance extraction) for an optional vision check.

## 3. Decisions

Mario, 2026-10-26:

- **CS-D1 Architecture A:** extend the existing pipeline. Generic layout engine
  in `packages/creative`, brand kit in the existing versioned marketing profile,
  creatives as a marketing entity kind, existing approvals and budgets. No
  second marketing platform, no HTML/Chromium renderer.
- **CS-D2 AI image review optional per project:** built in, default off, own
  task class, reserved and settled like finance extraction; only assets marked
  for provider use are sent.
- **CS-D3 uLiquid banner frozen:** `brand_landscape` and `DEFAULT_BANNER_STYLE`
  stay byte-for-byte unchanged as a legacy template. uLiquid moves to a generic
  template through its profile later; then the hard-coded template is removed.
- **CS-D4 Acceptance:** automated tests with two fictional demo brands and
  deterministic test artwork (0 USD), plus one real image run per brand with
  Mario's key, capped at 1 USD in total, only after his go-ahead.

Defaults taken in this design (Mario may overrule in review):

- **CS-D5 No new production dependency, no schema migration.** Rendering stays
  sharp/libvips; fonts stay the installed Inter and DejaVu (`infra/Dockerfile`).
  Brand kit data lives in the profile JSON, creatives in `Entity` rows.
- **CS-D6 Feature flag** `ORBIT_CREATIVE_STUDIO` (default `false`). Off: no
  route, no tool, no UI, every existing path behaves exactly as today.
- **CS-D7 Agent review authority does not cover creatives** until the review
  eval set has creative cases and has passed (as R79 for banners): with
  `delivery: "publish"` such posts wait for the owner; `postiz_draft` is
  unchanged.

## 4. Pipeline and ownership

```
Marketing brief (assignment / package / manual content)
 → content strategy (strategy specialist: brief + creative brief)
 → copywriting (copywriter: post text + creative copy)
 → creative brief resolution (deterministic: brand kit, template, formats, zones)
 → asset selection (approved logo variants, screenshots, product images)
 → AI artwork (art direction prompt; only when the image kind needs it)
 → layout / composition (packages/creative, per channel format)
 → creative QA (deterministic; optional vision review) → bounded corrections
 → review (existing review specialist + creative problems)
 → approval (existing owner release / veto / Postiz draft)
 → export / publishing (existing Postiz paths, rendition per channel)
```

| Unit | Location | Owns |
| --- | --- | --- |
| Layout engine | `packages/creative/src/` (new files next to `index.ts`) | formats, templates, text fitting, composition, image analysis; pure, no DB |
| Image model capabilities | `packages/ai/src/image-models.ts` | sizes, aspect ratios, transparency, references per model; source-size choice |
| Brand kit schema | `packages/schemas/src/index.ts` (`visualIdentity`) | optional brand kit fields |
| Creative service | `apps/api/src/modules/marketing/creative/` | creative brief, art direction, pipeline, QA, corrections, persistence, routes |
| Integration | `agents/specialists/{strategy,copywriter,visual,review}.ts`, `agents/package-image.ts`, `publishing/channel-rules.ts` | calling the service from existing flows |
| UI | `apps/web/src/modules/marketing/creative/` | creative panel, brand kit editor sections |

Boundaries (`scripts/boundaries.json`): everything new sits in packages or in
the marketing module; no platform-to-module or cross-module import.

## 5. Brand kit

The existing `visualIdentity` object of the marketing profile stays the single
brand configuration. All new fields are optional, so every saved profile stays
valid and unchanged; saving still creates a profile version and invalidates
pending content as today.

```ts
visualIdentity: {
  // existing, unchanged
  primaryColor, secondaryColor, accentColor, backgroundColor, surfaceColor, textColor,
  headingFont, bodyFont,          // "Inter" | "DejaVu Sans" | "Arial" | "system-ui"
  logoAssetId?,                   // the primary logo
  designRules,
  // new, optional
  logos?: { secondary?, onDark?, onLight?, mark? },   // approved logo asset ids
  productAssetIds?: id[],          // approved screenshots / product images (≤ 20)
  imagery?: {
    kind: "photo" | "illustration" | "3d" | "flat" | "mixed",
    mood: string,                  // ≤ 300, e.g. "warm, calm, optimistic"
    subjects: string,              // ≤ 500, typical people/places/objects
    avoid: string[],               // ≤ 20 × 200, forbidden motifs and styles
  },
  typography?: { headingWeight: 600 | 700 | 800, headingCase: "none" | "upper" },
  forbiddenDesigns?: string[],     // ≤ 20 × 300, forbidden layout/design variants
  creative?: {
    templates?: Partial<Record<TemplateId, { enabled: boolean; variant?: VariantId }>>,
    formatsByChannel?: Record<string, FormatId[]>,   // provider identifier → formats
    logoPlacement?: "auto" | "top_left" | "top_right" | "bottom_left" | "bottom_right",
    ctaStyle?: "pill" | "outline" | "none",
    maxArtCorrections?: 0 | 1 | 2,                    // default 1
    visualReview?: boolean,                           // CS-D2, default false
  },
}
```

`assertProfileReferences` checks every referenced logo and product asset like
`logoAssetId` today: same project, approved, `usageApproved`, right type.

**Assets.** Brand assets stay `assets` entities (base64 in `Entity` data, the
existing model). Upload and Drive import accept two more types, `screenshot` and
`product`. Rights fields stay as they are (`source`, `license`, `validUses`,
`rightsInformationConfirmed`, `usageApproved`, `assetStatus`, `approvedBy`). One
new owner-set flag, `providerUse` (default `false`), allows an asset — or a
creative containing it — to be sent to an AI provider (vision review, style
references). Without it, the asset is only composed locally.

## 6. Layout engine (`packages/creative`)

**Formats** (`formats.ts`), each with safe-area insets:

| Id | Size | Typical channels |
| --- | --- | --- |
| `feed_portrait` | 1080 × 1350 | Instagram, Facebook, LinkedIn feed |
| `square` | 1080 × 1080 | all feeds |
| `story` | 1080 × 1920 (top 250 / bottom 340 px reserved for platform UI) | Instagram/Facebook story, reel cover |
| `landscape` | 1200 × 630 | X, LinkedIn, Facebook link, Telegram, blog |
| `wide` | 1600 × 900 | legacy `brand_landscape` only |

Default channel mapping (overridable per project via
`creative.formatsByChannel`): instagram → `feed_portrait`; facebook →
`feed_portrait`; linkedin → `landscape`; x → `landscape`; telegram →
`landscape`; unknown → `square`.

**Templates** (`templates.ts`) are declarative specs: regions in fractions of
the safe area, a text stack (eyebrow, headline, subline, CTA), logo anchor and
size, art fit, optional product frame, scrim rules. Seven templates, each with
two or three variants (text top / bottom / side, product left / right):

| Template | Composition |
| --- | --- |
| `product_showcase` | scene or brand-gradient background, large framed product screenshot, headline and subline, logo, CTA |
| `feature_highlight` | brand colour field with subtle art, screenshot as hero, eyebrow, feature headline, short subline |
| `problem_solution` | two-zone layout: problem line on calm area, solution headline over the motif |
| `lifestyle` | full-bleed AI scene, gradient scrim on the text side, headline and subline, compact logo, optional CTA |
| `tips` | brand colour background, numbered tip headline, up to three short lines, small art accent |
| `announcement` | big headline with eyebrow, motif with strong scrim, prominent CTA |
| `brand_message` | full motif, centred statement headline, prominent logo |

**Text** (`text.ts`): every text block is set with Pango through sharp's text
input, so measured size = drawn size. A block auto-fits between a template's
maximum and minimum size (steps of 2 px); if the copy does not fit at the
minimum it fails with `TEXT_OVERFLOW` — text is never cut. Headline case and
weight come from the brand kit; markup is escaped, no user markup reaches
Pango.

**Composition** (`compose.ts`), all in one sharp pipeline:

1. Canvas in the brand background colour.
2. Art: cover-fit into its region with sharp's `attention` strategy (keeps the
   salient subject); an art with the wrong aspect is extended with a blurred or
   colour-matched margin instead of being stretched.
3. Product screenshot: the approved bytes, only scaled (aspect kept), in a
   rounded frame with shadow; never redrawn or generated.
4. Scrim: a gradient under the text stack, strengthened automatically until the
   measured contrast passes (step 5 of QA), bounded at a maximum opacity.
5. Text layers and CTA (pill or outline in palette colours).
6. Logo: the approved file's exact bytes (SHA-256 checked against the asset as
   today), scaled proportionally into its anchor with clear space; the variant
   (`onDark` / `onLight` / primary / `mark`) is chosen by the luminance behind
   the anchor. Never recoloured, cropped, redrawn or generated.

Output: PNG, exact format size, plus a layer manifest (box, source hash, font
size of every layer) used by QA. Same input → same layer geometry; raster bytes
may differ by font installation, as noted today.

**Analysis** (`analysis.ts`), deterministic and cheap:

- WCAG contrast of each text layer against the composed pixels behind it
  (dark/light percentile of the region, not the average).
- Logo contrast against its local background.
- Detail map of the art (grid of local standard deviation / edge energy):
  subject coverage (bounding box of high-detail cells) and the share of flat
  cells outside reserved text zones.
- Palette distance of the art's dominant colours to the brand palette
  (informational).

The legacy `renderTemplate`, `renderRasterTemplate`, `renderBrandBanner` and
`renderRasterBanner` stay unchanged (CS-D3); the manual render action moves to
the new engine only when the flag is on.

## 7. Image models and art direction

**Capabilities** (`packages/ai/src/image-models.ts`): one table per image model
(provider, supported sizes, aspect ratios, transparency, max references, edit
support). `sourceSizeFor(model, targetAspect)` picks the supported size closest
to the format (`1024x1536` for portrait/story, `1536x1024` for landscape,
`1024x1024` for square); the composition crops or extends. The size enum, today
duplicated in three places, is derived from this table. Only the existing
OpenAI adapter is implemented; another provider needs only an adapter and table
rows (a new provider stays an explicit decision, AGENTS.md).

**Creative brief** (`creative/brief.ts`): the strategy specialist returns, per
brief, a structured `creative` object instead of only `imageIdea`:

```ts
{ goal, audience, keyMessage, imageKind: "scene" | "product" | "graphic" | "combined",
  motif, setting, template: TemplateId, mood? }
```

Orbit completes it deterministically: brand kit style and avoid list, template
variant, formats from the channels, reserved zones of the chosen layout,
product assets for `product`/`combined`. `imageIdea` stays for assignments
without a creative (unchanged behaviour).

**Art direction** (`creative/art-direction.ts`) turns the brief into the
provider prompt: subject and setting, subject scale ("the main subject fills
about 60–75 % of the frame"), placement opposite the reserved text zone,
lighting and mood, palette words from the brand colours, imagery kind, the
project's avoid list, and fixed negatives (no text, letters, numbers, logos,
watermarks, UI or screens with content, no tiny isolated subject, no empty
plain background). For `product`/`combined` the art is a setting for the real
screenshot, never an invented interface. Prompts contain only profile and
brief text derived from approved facts — no customer data, no screenshots
(screenshots are composed locally).

## 8. Creative service and data

**Entity kind `creatives`** (JSON like every marketing object; not in the
generic `collections`, read through creative routes):

```ts
{
  contentId?, assignmentRunId?, packageId?, profileVersion,
  brief,                                   // resolved creative brief
  template, variant, options: { logoPlacement, textScale: "s" | "m" | "l" },
  copy: { eyebrow?, headline, subline?, cta? },
  components: { artAssetId?, logo: {assetId, sha256}, products: [{assetId, sha256}] },
  renditions: [{ format, channel?, assetId, width, height, bytes, sha256 }],
  qa: { checks: [...], vision?: {...}, verdict: "pass" | "corrected" | "needs_owner" },
  corrections: [{ kind, reason, at, costMicros? }],
  cost: { reservationIds: [...], settledMicros, unknownMicros },
  status: "composed" | "needs_owner" | "attached" | "superseded",
}
```

Renditions are `generated_artwork` assets with `sourceType:
TEMPLATE_GENERATED`, `boundTo: { creativeId, contentId }` and a `rightsSource`
recording every component's id, version and SHA-256 — the pattern of composed
banners (R78): bound renditions stay out of the asset library and pickers, and
they count only while their components are approved and unchanged.

**Pipeline** (`creative/pipeline.ts`, `produceCreative`): resolve brand kit and
assets with rights checks → resolve brief → art (generate through the existing
`generateAssignmentImage`/`generateProjectImage` paths, or reuse an approved
asset, or none for `graphic`) → compose one rendition per needed format → QA →
corrections → persist creative and renditions in one transaction under the
existing re-check pattern (profile version and asset versions unchanged, else
`BRAND_ASSET_CHANGED` / `MARKETING_PROFILE_CHANGED`) → attach renditions to the
content rows of their channels.

Re-composition (layout variant, logo placement, text scale, edited creative
copy) is free and keeps the art; only art regeneration and vision review cost
money. A revision keeps unchanged components (art, assets, copy) and rebuilds
only what changed.

## 9. Quality assurance and corrections

Deterministic checks (`creative/quality.ts`), codes:

| Code | Check | Handling |
| --- | --- | --- |
| `CREATIVE_DIMENSIONS` | exact format size and aspect | render bug → `needs_owner` |
| `CREATIVE_FILE_TOO_LARGE` | PNG over the channel/Postiz limit (default 8 MB) | re-encode once, else `needs_owner` |
| `TEXT_OVERFLOW` | copy does not fit at minimum size | other variant, then one copy revision |
| `TEXT_CONTRAST_LOW` | < 4.5:1 (body) / < 3:1 (large text from 32 px; the subline is body text at every size) | stronger scrim, then other variant |
| `TEXT_BACKDROP_BUSY` | detail energy (mean absolute Laplacian / 255) behind a text layer > 0.06 (R17) | stronger scrim (compose raises it up to the layout's maximum), then other variant |
| `LOGO_CONTRAST_LOW` | < 2:1 against local background | other logo variant, then logo plate |
| `LOGO_INTEGRITY` | logo bytes ≠ approved SHA-256, aspect changed, below minimum size | refuse (never render) |
| `SCREENSHOT_INTEGRITY` | screenshot bytes ≠ approved SHA-256 or aspect changed | refuse |
| `SUBJECT_TOO_SMALL` | high-detail coverage < 25 % of the art region | art correction |
| `EMPTY_AREA_EXCESSIVE` | flat cells outside reserved zones > 45 % | art correction or tighter crop |
| `SAFE_AREA_VIOLATION`, `LAYER_OVERLAP` | layer boxes against safe area and each other | render bug → `needs_owner` |
| `ASSET_UPSCALED` | an art, screenshot or logo layer drawn at more than 1.5× its source size | warning only (shown, never blocks) |
| `ASSET_RIGHTS` | every component approved, `validUses` covers the use, not outdated, same project | refuse |

Thresholds are constants in one place with tests; they are calibrated on the
demo brands' fixtures. The busy-backdrop threshold (0.06, R17) was set by
measuring the demo compositions: calm backdrops measure 0.01–0.04, text over
the motif's edges and patterns 0.07–0.13. Art is measured at display scale
(shorter side at most 1080 px), so a high-resolution upload does not read as
flat.

**Vision review** (CS-D2, optional per project `creative.visualReview`): one
`respond()` call with the composed rendition as `input_image`, new task class
`creative_review`, strict JSON rubric (subject clarity, balance, legibility,
brand fit, message–image fit, channel fit, concrete value; each 1–5, plus
issues mapped to correction kinds). It runs only when every component has
`providerUse`, through mandate → reserve → transmit → settle like finance
extraction, inside the run or package budget. Its verdict can trigger a
correction or `needs_owner`; it never approves or publishes anything.

**Corrections**, strictly bounded:

1. Free, deterministic: other layout variant (≤ 2), stronger scrim, other logo
   variant or plate, smaller text scale.
2. Art regeneration: at most `maxArtCorrections` (default 1, max 2) per
   creative, with a targeted prompt delta from the findings (for example
   "larger subject, ~70 % of the frame", "calm area on the left for text");
   each reserved before transmission in the existing run/package budget; a
   budget stop ends corrections.
3. Still failing: creative `needs_owner` with the findings; the content gets
   `CREATIVE_QA_FAILED` (left for the owner). Nothing is attached as approved
   and nothing is published.

## 10. Copywriting

The draft contract gains `copyCraft` for social content when the flag is on.
An instruction addition (separate constant, so the draft prompt for everything
else stays unchanged) asks for: one core message; a hook in the first line;
a concrete problem or benefit for the audience; the product introduced as the
solution in at most one sentence; the contract's CTA phrased for the channel;
0–2 fact placeholders, preferring short facts; topical hashtags only (count
from the format, else channel defaults). The output adds `coreMessage` and
`hook` (stored for preview and QA) and, when a creative is planned,
`creative: { eyebrow?, headline, subline?, cta? }` with the template's limits —
the generalisation of banner copy, checked by the existing deterministic
banner copy rules (figures, status words, prohibited language, links, unsafe
characters) and never part of the claims ledger (R83 applies).

Deterministic additions to the review: `FACT_TOO_LONG_FOR_SOCIAL` (a resolved
text fact longer than 220 characters in a social body → one revision asking for
a shorter fact or none) and `CORE_MESSAGE_MISSING` (no `coreMessage` when
`copyCraft` was asked → one revision). The strategy instructions prefer facts
with short values for social posts. Channel variants keep using
`packageDrafts`/history; shared mode (R76) stays an explicit owner choice.

## 11. Integration points

**Assignments.** New optional confirmed field `creative` (social, `image: true`,
mutually exclusive with `banner`):
`{ templates?: TemplateId[], artPer: "run" | "post", imageKind?: "auto" | "scene" | "product" | "graphic" }`.
Hashed into the confirmation only when set, so existing confirmations stay
valid. The visual step produces one art per run or per post, the copywriter
writes creative copy, and composition runs per slot and channel format after
the drafts exist (where `composeRunBanners` runs today). The confirmation card
shows the templates, formats and an image cost estimate; the consent text names
the logo and product assets used. `banner` and `brand_landscape` keep working
unchanged (CS-D3).

**Content packages.** A package with an approved image (existing
`attachPackageImage`) composes renditions per channel draft instead of
attaching the raw image when the flag is on and the profile has a primary logo.

**Manual Creative Studio.** From a content item: produce a creative from
approved assets (free, editor) or with new art (owner, explicit prompt and cost
confirmation as `images/generate` today); recompose; regenerate art; run the
vision review; attach. Attaching resets the content to `draft` and re-runs
`reviewContent`, like `attachPackageImage`.

**Publishing.** Channel rules gain Instagram (`instagram`,
`instagram-standalone`: caption 2,200, media required) and Facebook
(`facebook`: 63,206) with `liveCapabilityKnown: true`, verified against the
Postiz integration schema before merge; each channel's content row carries its
own rendition as `assetId`, so Postiz handoff and publishing code stay as they
are. Preflight keeps requiring an approved PNG.

## 12. API, UI and acceptance tests

**Routes** (marketing module, behind the flag, project and module role checks;
added to the access matrix):

| Route | Role | Cost |
| --- | --- | --- |
| `POST /api/projects/:id/creatives` (content, template, variant, art source) | editor; owner when new art | art only |
| `GET /api/projects/:id/creatives/:creativeId` | viewer | — |
| `POST …/creatives/:creativeId/recompose` | editor | free |
| `POST …/creatives/:creativeId/regenerate-art` | owner, cost confirmation | 1 image |
| `POST …/creatives/:creativeId/review` | owner (paid) | vision call |
| `POST …/creatives/:creativeId/attach` | editor | free |

OpenAPI and client are regenerated (`pnpm api:generate`).

**UI** (`apps/web/src/modules/marketing/creative/`):

- *Creative panel* in content detail (replaces the "Creative" modal when the
  flag is on): rendition tabs per format; post text; channel and format;
  components with their rights; QA checklist with findings; cost; approval
  status. Actions: edit text (existing editor), replace image (approved asset or
  new art), regenerate (text only / art only / layout only), layout variant,
  logo placement, text size S/M/L. Loading, empty and error states, keyboard
  access, 390 px layout, as `docs/DESIGN_SYSTEM.md` requires.
- *Assignment drafts* awaiting the owner show the rendition thumbnail and link
  to the panel.
- *Brand kit* (Settings → Brand): logo variants, product images, imagery,
  typography, templates and channel formats, vision review switch, correction
  limit.

**Acceptance tests** (CS-D4), two fictional demo brands with their own vector
logos, palettes, audiences and synthetic product screenshots (created for the
fixtures, no real brand):

| Test | Automated (0 USD) | Live (≤ 1 USD total, after go-ahead) |
| --- | --- | --- |
| A Lifestyle | `lifestyle` from a general brief with fixture art: logo bytes, palette, copy fields, QA pass | one real art per brand, QA and visual inspection |
| B Product feature | `feature_highlight` from a screenshot in 4:5, 1:1, 9:16, 1200×630; screenshot integrity | — |
| C Bad image | tiny-subject and flat fixture art → `SUBJECT_TOO_SMALL` / `EMPTY_AREA_EXCESSIVE`, bounded correction, `needs_owner`, no publication | — |
| D Tenant isolation | project B referencing project A's logo, screenshot or creative → refused / 404; profile data never mixed | — |
| E Approvals | creative content cannot be scheduled/published/handed off without the existing approvals; agent authority does not cover it (CS-D7) | — |

Plus unit tests for every engine part, integration tests for routes, budget
limits, disabled flag, module roles and cross-project negatives, web component
tests and one Playwright flow. A demo script renders both brands × templates ×
formats into `.runtime/creative-demo/` for visual inspection.

## 13. Security, cost, rollout

- Risk **high** (paid calls, rights, approvals, multi-tenant data); target
  environment local until Mario approves a deploy. No migration; profile and
  entity JSON only.
- Tenancy: every asset, creative and rendition is read through scoped
  transactions under RLS with explicit project checks; referenced ids of other
  projects fail as not found.
- Cost: no automatic budget increase; every image and vision call is reserved
  before transmission in the existing run, package, project and organisation
  limits; correction counts are hard limits; unknown outcomes stay counted.
- Privacy: prompts carry only profile and brief text; screenshots and logos
  never go to the image provider; vision review requires `providerUse` on all
  components.
- Publishing: unchanged approval paths; creation, rights and publication stay
  separate actions.
- Rollout: merge with the flag off changes nothing in production. Enabling is a
  separate owner step per environment; projects opt in by brand kit and
  assignment configuration. Rollback: flag off, or redeploy the previous image;
  stored creatives are ignored by old code.

## 14. Out of scope and follow-ups

- More fonts (would need font packages in the runtime image: new dependency).
- Video, carousels, animated formats.
- New image providers (adapter-ready, needs a provider decision).
- Moving marketing assets from `Entity` base64 to platform files.
- Migrating uLiquid from `brand_landscape` to a generic template, then removing
  the hard-coded template (CS-D3 follow-up).
- Instagram links are not clickable in captions; a "link in bio" convention is
  a later copy rule.
- Review eval cases for creatives before agent authority may cover them (CS-D7).
