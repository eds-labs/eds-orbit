# Marketing Creative Studio v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Orbit composes finished, brand-consistent marketing creatives (art and/or approved screenshots, headline, subline, CTA, the unchanged approved logo) per channel format, with stronger copy, deterministic quality checks, bounded corrections and a preview/edit UI. Everything is generic and tenant-scoped.

**Architecture:** A pure layout engine in `packages/creative` (sharp/libvips with Pango text, no new dependency) renders declarative templates. The marketing module gets a `creative/` service: brand kit loader, creative brief, art direction, pipeline, QA, corrections, routes. It reuses the existing image path, budgets, rights, review and publishing. The brand kit is the existing versioned profile `visualIdentity` with optional fields. Creatives are `Entity` rows of kind `creatives`; renditions are bound `generated_artwork` assets. Everything sits behind `ORBIT_CREATIVE_STUDIO`.

**Tech Stack:** TypeScript, Node 24.18.0, pnpm, sharp 0.35.5 (libvips 8.18, Pango 1.58), zod 4.6.5, Fastify 5, Prisma 7 (no migration), Next.js 16, Vitest 5, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-26-marketing-creative-studio-design.md` (approved by Mario 2026-10-26). Read it before any task; section numbers below refer to it.

## Global Constraints

- No new production dependency; no Prisma migration (CS-D5). Fonts: only `"Inter" | "DejaVu Sans" | "Arial" | "system-ui"`.
- Feature flag `ORBIT_CREATIVE_STUDIO`, `z.enum(["false","true"]).default("false")` (CS-D6). Off: no creative route (404 `NOT_FOUND`), no creative tool, no UI, and no changed prompt or behaviour anywhere.
- `brand_landscape`, `renderTemplate`, `renderRasterTemplate`, `renderBrandBanner`, `renderRasterBanner`, `DEFAULT_BANNER_STYLE` stay byte-for-byte unchanged (CS-D3).
- No product names, logos, colours or styles of a real customer in core code, prompts or tests. Demo brands are fictional: **"Lumora Home"** and **"Kestrel Analytics"** (section 12).
- Logos and screenshots are only ever their approved bytes (SHA-256 checked), scaled proportionally. They are never recoloured, cropped, redrawn, generated or sent to an image provider.
- Text is never cut. When copy does not fit at a template's minimum size, the result is `TEXT_OVERFLOW`.
- Every paid call follows `requireSpendMandate` → `reserve` → `markTransmitted` → call → `settle` → `recordSpan` inside existing limits. No automatic budget increase. `maxArtCorrections` default 1, max 2.
- Agent review authority does not cover creatives with `delivery: "publish"` (CS-D7). Content creation, rights approval and publication stay separate actions.
- Docs and code comments in English; follow surrounding code's comment density and naming.
- Commands (Node 24): `export PATH=~/.nvm/versions/node/v24.18.0/bin:$PATH`. Unit tests: `./node_modules/.bin/vitest run <path>`. Integration tests: run `node scripts/test-db-for-worktree.ts` once, then `node --env-file=/Users/marioeuchner/EDS-Labs/Development/EDS-Orbit/.runtime/local.env ./node_modules/vitest/vitest.mjs run <file>`.
- Never `git add -A` over folders with symlinked `node_modules`. Commit per task with the trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. No push or deploy without Mario's explicit approval (pushing to main deploys production).

## Review Focus

1. **Saving the profile in the existing Brand form** (or over MCP project configuration) must keep brand kit fields it does not show. Today `advanced.tsx:629` rebuilds `visualIdentity` from form fields. Test owner: Task 18 (web), plus Task 7 for a full-profile save.
2. **Long German compound words, emoji and non-Latin text in headlines** wrap or shrink. If they cannot fit, they fail with `TEXT_OVERFLOW`; they never draw outside the box. Test owner: Task 2.
3. **An opaque logo** (white square background) on a light backdrop, and a transparent dark logo on dark art, must stay visible. The engine switches the logo variant or draws a plate, without changing the logo. Test owner: Task 4.
4. **Small uploads** (a 400 px screenshot used as hero, a small logo) are flagged as `ASSET_UPSCALED` (warning), not silently blurred. Test owner: Task 5.
5. **A logo or profile change between planning and saving** (another tab, MCP) gives `BRAND_ASSET_CHANGED` / `MARKETING_PROFILE_CHANGED`, and leaves no half-saved creative or rendition. Test owner: Task 9.

---

## Phase A — Layout engine (`packages/creative`)

### Task 1: Ids, formats and brand types

**Files:**
- Create: `packages/creative/src/ids.ts`, `packages/creative/src/errors.ts`, `packages/creative/src/formats.ts`, `packages/creative/src/brand.ts`
- Modify: `packages/creative/src/index.ts`. Move `CreativeError` to `errors.ts` and `BrandPalette` to `brand.ts`, re-export both, and add `export * from` for the new modules. Legacy behaviour must not change.
- Test: `packages/creative/src/formats.test.ts`, `packages/creative/src/brand.test.ts`

**Interfaces:**
- Produces (`ids.ts`, no imports):
  - `CREATIVE_FORMAT_IDS = ["feed_portrait","square","story","landscape"] as const`
  - `CREATIVE_TEMPLATE_IDS = ["product_showcase","feature_highlight","problem_solution","lifestyle","tips","announcement","brand_message"] as const`
  - `CREATIVE_VARIANT_IDS = ["text_top","text_bottom","text_side","product_left","product_right","centered"] as const`
  - `LOGO_PLACEMENTS = ["auto","top_left","top_right","bottom_left","bottom_right"] as const`
  - `TEXT_SCALES = ["s","m","l"] as const`
  - `IMAGE_KINDS = ["scene","product","graphic","combined"] as const`
  - `LOGO_ROLES = ["primary","secondary","onDark","onLight","mark"] as const`
  - Types `FormatId`, `TemplateId`, `VariantId`, `LogoPlacement`, `TextScale`, `ImageKind`, `LogoRole`.
- Produces (`formats.ts`):
  - `type Insets = {top:number;right:number;bottom:number;left:number}`
  - `type CreativeFormat = {id: FormatId; width: number; height: number; safe: Insets}`
  - `CREATIVE_FORMATS: Readonly<Record<FormatId, CreativeFormat>>`
  - `DEFAULT_CHANNEL_FORMATS: Readonly<Record<string, readonly FormatId[]>>`
  - `formatsForChannel(identifier: string | null, overrides?: Readonly<Record<string, readonly FormatId[]>>): FormatId[]`
- Produces (`brand.ts`):
  - `type BrandFont = "Inter"|"DejaVu Sans"|"Arial"|"system-ui"`
  - `type BrandPalette` (unchanged shape)
  - `type RasterSource = {bytes: Buffer; sha256: string}`
  - `type CreativeLogo = RasterSource & {role: LogoRole}`
  - `type CreativeBrand = {brandName: string; palette: BrandPalette; typography: {headingWeight: 600|700|800; headingCase: "none"|"upper"}; logos: CreativeLogo[]; ctaStyle: "pill"|"outline"|"none"}`
  - `verifyBrand(brand: CreativeBrand): void`, which throws `CreativeError` with `BRAND_ASSET_INTEGRITY_FAILED`, `PRIMARY_LOGO_REQUIRED`, `INVALID_BRAND_COLOR` or `INVALID_BRAND_FONT`
  - `sha256Hex(bytes: Buffer): string`

Values:

| Format | Size | Safe insets |
| --- | --- | --- |
| `feed_portrait` | 1080×1350 | 72 on all sides |
| `square` | 1080×1080 | 72 on all sides |
| `story` | 1080×1920 | `{top:250,right:72,bottom:340,left:72}` |
| `landscape` | 1200×630 | 48 on all sides |

`DEFAULT_CHANNEL_FORMATS`:
- instagram, instagram-standalone, facebook → `["feed_portrait"]`
- linkedin, x, telegram → `["landscape"]`
- unknown or null → `["square"]`
- An override for an identifier replaces its default.

- [ ] **Step 1: Write failing tests.** In `formats.test.ts`:
  - The sizes and insets are exactly as in the table.
  - `formatsForChannel("instagram")` equals `["feed_portrait"]`.
  - `formatsForChannel("x")` equals `["landscape"]`.
  - `formatsForChannel("mastodon")` and `formatsForChannel(null)` equal `["square"]`.
  - `formatsForChannel("instagram", {instagram: ["square","story"]})` equals `["square","story"]`.

  In `brand.test.ts`:
  - A logo whose `sha256` is not `sha256Hex(bytes)` throws `BRAND_ASSET_INTEGRITY_FAILED`.
  - A brand without a `primary` logo throws `PRIMARY_LOGO_REQUIRED`.
  - `textColor: "red"` throws `INVALID_BRAND_COLOR`.
  - A valid brand does not throw.
- [ ] **Step 2: Run them.** `./node_modules/.bin/vitest run packages/creative/src/formats.test.ts packages/creative/src/brand.test.ts`. Expected: FAIL (modules missing).
- [ ] **Step 3: Implement the four files and re-exports.**
- [ ] **Step 4: Run them plus the legacy test.** `./node_modules/.bin/vitest run packages/creative`. Expected: PASS, and `creative.test.ts` is unchanged.
- [ ] **Step 5: Commit** `feat(creative): format registry, ids and brand types`.

### Task 2: Text fitting with real font metrics

**Files:**
- Create: `packages/creative/src/text.ts`
- Test: `packages/creative/src/text.test.ts`

**Interfaces:**
- Consumes: `CreativeError`, `BrandFont`.
- Produces:
  - `type TextStyle = {font: BrandFont; weight: 400|600|700|800; color: string; maxSize: number; minSize: number; lineHeight: number; align: "left"|"center"; uppercase: boolean; maxLines: number}`
  - `type FittedText = {png: Buffer; width: number; height: number; size: number}`
  - `fitText(text: string, box: {width: number; height: number}, style: TextStyle): Promise<FittedText>`
  - `escapeMarkup(text: string): string`

Approach: try sizes from `maxSize` down to `minSize` in steps of 2 px.
- Render each size with sharp's `text` input: Pango markup with escaped text, `font_family`, `font_weight`, `font_size` in Pango units (size × 1024), `foreground`; options `width: box.width`, `dpi: 72`, `rgba: true`, `wrap: "word"`, `align`, and `spacing` = round(size × (lineHeight − 1)).
- Accept the first render with `info.width <= box.width` and `info.height <= min(box.height, maxLines × size × lineHeight + 1)`.
- If none fits: throw `TEXT_OVERFLOW`.
- If the text is empty after trim, longer than 300 characters, or contains control characters `\u0000-\u001f`: throw `INVALID_TEMPLATE_INPUT`.
- `uppercase` uses `toUpperCase()` before escaping.

- [ ] **Step 1: Write failing tests** (style: Inter 700, maxSize 92, minSize 48, lineHeight 1.12, maxLines 3, width 900, height 360):
  - `fits a short headline at the maximum size`: `size === 92`, `width <= 900`.
  - `shrinks a longer headline within its range`: a 70-character headline gives `48 <= size < 92` and `height <= 360`.
  - `refuses text that cannot fit`: 290 characters reject with `TEXT_OVERFLOW`.
  - `never draws a compound word outside its box`: "Familienkalenderorganisationsassistent" in a 500 px box either resolves with `width <= 500` or rejects with `TEXT_OVERFLOW`.
  - `renders emoji and accented text`: "Plan your week 🎉 — Ça marche" resolves.
  - `escapes markup`: "<b>x</b> & y" resolves, and `escapeMarkup` returns `&lt;b&gt;x&lt;/b&gt; &amp; y`.
  - `is deterministic`: two calls give the same `{width, height, size}`.
- [ ] **Step 2: Run.** `./node_modules/.bin/vitest run packages/creative/src/text.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement `fitText` and `escapeMarkup`.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(creative): fit text with Pango metrics, never cut`.

### Task 3: Templates and layouts

**Files:**
- Create: `packages/creative/src/templates.ts`
- Test: `packages/creative/src/templates.test.ts`

**Interfaces:**
- Consumes: ids, `CREATIVE_FORMATS`, `CreativeError`.
- Produces:
  - `type Box = {x:number;y:number;w:number;h:number}` in pixels
  - `type RelBox = Box` in fractions 0..1
  - `type TextLayerKind = "eyebrow"|"headline"|"subline"|"cta"`
  - `type LayoutSpec = {format: CreativeFormat; background: "art"|"brand"|"brand_gradient"; art: Box|null; product: Box|null; textBox: Box; textAlign: "left"|"center"; stack: TextLayerKind[]; sizes: Record<TextLayerKind, {max:number; min:number}>; logo: {box: Box; corner: Exclude<LogoPlacement,"auto">}; scrim: {box: Box; direction: "up"|"down"|"left"|"right"|"full"; base: number; max: number} | null; reservedZones: RelBox[]}`
  - `TEMPLATE_VARIANTS: Readonly<Record<TemplateId, readonly VariantId[]>>`
  - `TEMPLATE_NEEDS: Readonly<Record<TemplateId, {art: "required"|"optional"|"none"; product: "required"|"optional"|"none"}>>`
  - `TEMPLATE_COPY_LIMITS: Readonly<Record<TemplateId, {eyebrow:number; headline:number; subline:number; cta:number}>>`
  - `variantsFor(template: TemplateId, format: FormatId): VariantId[]`
  - `layoutFor(template: TemplateId, variant: VariantId, format: FormatId, options: {logoPlacement: LogoPlacement; textScale: TextScale}): LayoutSpec`

Values:

| Template | Variants (first = default) | Art | Product |
| --- | --- | --- | --- |
| `product_showcase` | product_right, product_left, text_top | optional | required |
| `feature_highlight` | text_top, product_left, product_right | optional | required |
| `problem_solution` | text_top, text_bottom | required | optional |
| `lifestyle` | text_bottom, text_top, text_side | required | none |
| `tips` | text_top, centered | optional | none |
| `announcement` | centered, text_bottom | optional | optional |
| `brand_message` | centered, text_bottom | required | none |

Rules:
- `text_side`, `product_left` and `product_right` are valid only for `landscape` and `square`; `variantsFor` filters them, and `layoutFor` throws `INVALID_TEMPLATE_VARIANT` for them.
- Copy limits: eyebrow 32, headline 60 (70 for `tips` and `brand_message`), subline 120 (180 for `tips`), cta 24.
- Size ranges in px, from format width W:
  - headline max 0.085·W, min 0.045·W (landscape max 0.06·W)
  - subline 0.04·W / 0.028·W
  - eyebrow 0.028·W / 0.022·W
  - cta 0.032·W / 0.026·W
  - textScale multiplies the max by s 0.85, m 1, l 1.15; the min stays.
- Logo box: width 0.14·W (`mark` 0.10·W), height 0.06·H, inside the safe area at its corner. `auto` picks the first corner that does not intersect textBox or product, in the order top_left, top_right, bottom_left, bottom_right.
- `reservedZones` = textBox, logo box and product box, as fractions.

- [ ] **Step 1: Write failing tests:**
  - `lays out every template, variant and format inside the safe area` (loop over `variantsFor`): textBox, logo box and product box lie within the safe insets; textBox ∩ logo = ∅; product ∩ textBox = ∅; reservedZones contains textBox and logo.
  - `refuses side variants on portrait formats`: `layoutFor("lifestyle","text_side","story",…)` throws `INVALID_TEMPLATE_VARIANT`.
  - `anchors an explicit logo corner`: `bottom_right` gives logo.box.x + w === W − safe.right and y + h === H − safe.bottom.
  - `scales text maxima, not minima`: headline max l > m > s; min equal.
  - `covers all seven templates in every table`.
- [ ] **Step 2: Run.** `./node_modules/.bin/vitest run packages/creative/src/templates.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement the tables and `layoutFor`.** Base each variant on regions in fractions of the safe area; convert to px at the end.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(creative): seven declarative templates with variants`.

### Task 4: Composition and demo fixtures

**Files:**
- Create: `packages/creative/src/compose.ts`, `packages/creative/fixtures/demo-brands.ts`
- Test: `packages/creative/src/compose.test.ts`

**Interfaces:**
- Consumes: `layoutFor`, `fitText`, `verifyBrand`, `CREATIVE_FORMATS`, `TEMPLATE_NEEDS`.
- Produces:
  - `type CreativeCopy = {eyebrow?: string; headline: string; subline?: string; cta?: string}`
  - `type ComposeInput = {template: TemplateId; variant: VariantId; format: FormatId; brand: CreativeBrand; copy: CreativeCopy; art?: RasterSource; products?: RasterSource[]; options: {logoPlacement: LogoPlacement; textScale: TextScale}; scrimBoost?: 0|1|2|3; logoRole?: LogoRole}`
  - `type LayerRecord = {kind: "art"|"product"|"scrim"|TextLayerKind|"logo"|"logo_plate"; box: Box; sourceSha256?: string; sourceSize?: {width:number;height:number}; scale?: number; fontSize?: number; color?: string; role?: LogoRole}`
  - `type ComposeResult = {png: Buffer; sha256: string; width: number; height: number; format: FormatId; template: TemplateId; variant: VariantId; layers: LayerRecord[]; backdrops: Partial<Record<TextLayerKind|"logo", {p10:number; p90:number}>>; scrimOpacity: number; logoRole: LogoRole; renderer: {sharp: string; vips: string}}`
  - `composeCreative(input: ComposeInput): Promise<ComposeResult>`
  - Fixtures:
    - `demoBrand(name: "lumora"|"kestrel"): Promise<CreativeBrand>`
    - `fixtureArt(kind: "good"|"tiny_subject"|"flat"|"bright", brand: "lumora"|"kestrel"): Promise<RasterSource>`
    - `fixtureScreenshot(brand, size?: {width:number;height:number}): Promise<RasterSource>`
    - `opaqueLogo(): Promise<RasterSource>`

    All are generated in code from SVG strings with sharp. Lumora Home: coral `#E8604C`, cream `#FFF4E8`, ink `#2B1B17`, onDark logo variant. Kestrel Analytics: teal `#0F4C5C`, lime `#B5E655`, white surface, primary logo only.

Rules (spec §6):
- Art cover-fits its region with `sharp.strategy.attention`. When the art aspect differs by more than 35 %, it is contained over a blurred cover copy of itself.
- Products fit `inside` their box (aspect kept, scale recorded) with radius 0.03·W and a shadow.
- Scrim colour: `palette.textColor` if its luminance is < 0.2, else `#000000`. Opacity = base + 0.12·scrimBoost, then raised by 0.1 until the text contrast is ≥ 4.5 (body) / 3 (headline), capped at the layout's max. Record backdrop p10/p90 before drawing text.
- Text colour is the better contrast of `palette.textColor` and the light colour (`surfaceColor` if luminance > 0.8, else `#FFFFFF`).
- Eyebrow uses `accentColor` when its contrast is ≥ 3. CTA by `ctaStyle`:
  - pill: `primaryColor` fill with the better-contrast label colour
  - outline: `accentColor` stroke
  - none: no CTA layer
- Logo role from the luminance behind the logo box: below 0.4 prefer onDark, then primary; else onLight, then primary. `logoRole` forces a role. Fit `inside`. When logo contrast is < 2 and no better variant exists, draw a `logo_plate` (surface colour, 90 %, rounded) behind the unchanged logo.
- Errors:
  - `ART_REQUIRED` / `PRODUCT_ASSET_REQUIRED` per `TEMPLATE_NEEDS`
  - `BRAND_ASSET_INTEGRITY_FAILED` for any source whose bytes do not match its sha256
  - `TEXT_OVERFLOW` from `fitText`
  - `RASTER_RENDER_FAILED` for a sharp failure
- Output: PNG at compression level 9; dimensions must equal the format, else `RASTER_OUTPUT_INVALID`.

- [ ] **Step 1: Write failing tests** (demo fixtures):
  - `composes lifestyle in 4:5 with the approved logo`: 1080×1350 PNG signature; a `logo` layer with `sourceSha256 === primary.sha256`; logo box aspect = source aspect ±1 px.
  - `refuses logo bytes that are not the approved ones`: tampered sha → `BRAND_ASSET_INTEGRITY_FAILED`.
  - `uses the dark-background logo on dark art`: Lumora + `fixtureArt("good")` (dark) → `logoRole === "onDark"`.
  - `keeps the screenshot unchanged`: `feature_highlight`/square has a product layer with the screenshot's sha256 and aspect ±1 px.
  - `raises the scrim until text contrast passes`: `bright` art → `scrimOpacity > layout base`, and contrast(subline colour, backdrop) ≥ 4.5.
  - `keeps an opaque logo visible` (Review Focus 3): `opaqueLogo` as the only logo on `bright` art → a `logo_plate` layer exists, or the logo contrast is ≥ 2.
  - `refuses a missing required art`: `lifestyle` without art → `ART_REQUIRED`.
  - `omits the CTA with ctaStyle none`.
  - `is deterministic in one environment`: the same input twice gives equal `sha256` and `layers`.
  - `fails on overflow`: a 280-character headline → `TEXT_OVERFLOW`.
- [ ] **Step 2: Run.** `./node_modules/.bin/vitest run packages/creative/src/compose.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement fixtures and `composeCreative`.**
- [ ] **Step 4: Run.** Expected: PASS. Then write the 4 formats × 2 brands of `lifestyle` to the scratchpad and view them (Read tool) for a visual sanity check.
- [ ] **Step 5: Commit** `feat(creative): compose layered creatives with original logo and screenshots`.

### Task 5: Image analysis and composition checks

**Files:**
- Create: `packages/creative/src/analysis.ts`, `packages/creative/src/quality.ts`
- Test: `packages/creative/src/analysis.test.ts`, `packages/creative/src/quality.test.ts`

**Interfaces:**
- Consumes: `ComposeResult`, `RelBox`, fixtures.
- Produces:
  - `relativeLuminance(color: string | [number,number,number]): number`
  - `contrastRatio(a, b): number` (WCAG 2.x)
  - `regionLuminance(png: Buffer, box: Box): Promise<{mean:number; p10:number; p90:number}>`
  - `analyzeArt(png: Buffer, reserved: RelBox[]): Promise<{subjectCoverage:number; flatShare:number; meanDetail:number}>`
  - `CREATIVE_THRESHOLDS = {bodyContrast: 4.5, largeContrast: 3, largeTextPx: 32, logoContrast: 2, subjectMinCoverage: 0.25, flatMaxShare: 0.45, maxFileBytes: 8_388_608, minLogoWidthShare: 0.06, maxUpscale: 1.5, detailCell: 0.08, flatCell: 0.02, grid: 16} as const`
  - `type CreativeCheckCode = "CREATIVE_DIMENSIONS"|"CREATIVE_FILE_TOO_LARGE"|"TEXT_CONTRAST_LOW"|"LOGO_CONTRAST_LOW"|"LOGO_INTEGRITY"|"SCREENSHOT_INTEGRITY"|"SUBJECT_TOO_SMALL"|"EMPTY_AREA_EXCESSIVE"|"SAFE_AREA_VIOLATION"|"LAYER_OVERLAP"|"ASSET_UPSCALED"`
  - `type CreativeCheck = {code: CreativeCheckCode | "ASSET_RIGHTS"; passed: boolean; severity: "blocker"|"warning"; detail?: Record<string, number|string>}`
  - `checkComposition(result: ComposeResult, approved: {logoSha256: string[]; productSha256: string[]}): CreativeCheck[]`
  - `checkArt(png: Buffer, reserved: RelBox[]): Promise<CreativeCheck[]>`
  - `failedBlockers(checks: CreativeCheck[]): CreativeCheckCode[]`

Approach:
- Detail map: greyscale → Laplacian `convolve` → absolute value → mean per cell on a `grid`×`grid` grid, normalised by 255.
- `subjectCoverage` = bounding-box area of cells > `detailCell` / total area.
- `flatShare` = cells < `flatCell` outside reserved zones / non-reserved cells.
- `ASSET_UPSCALED` (warning) when a raster layer's `scale` > `maxUpscale`.
- Text contrast uses the recorded `backdrops`; large text = `fontSize >= largeTextPx`.

- [ ] **Step 1: Write failing tests:**
  - `computes WCAG contrast`: white/black = 21; `#777777`/white is 4.48 ±0.01.
  - `measures subject coverage and flat share`: `good` coverage ≥ 0.25 and flatShare ≤ 0.45; `tiny_subject` coverage < 0.25; `flat` flatShare > 0.45.
  - `flags bad art`: `checkArt(tiny)` contains failed `SUBJECT_TOO_SMALL`; `checkArt(flat)` contains failed `EMPTY_AREA_EXCESSIVE`; `checkArt(good)` has no failed check.
  - `passes a good composition`: no failed blocker.
  - `detects tampered or weak results`:
    - a logo layer `sourceSha256` not in approved → `LOGO_INTEGRITY`
    - a product layer sha not approved → `SCREENSHOT_INTEGRITY`
    - backdrops forced to the text colour → `TEXT_CONTRAST_LOW`
    - `png` of maxFileBytes + 1 bytes → `CREATIVE_FILE_TOO_LARGE`
  - `warns on upscaled assets` (Review Focus 4): `fixtureScreenshot(…, {width:400,height:300})` as hero → `ASSET_UPSCALED` failed with severity warning, and `failedBlockers` excludes it.
  - `calibration: both demo brands pass every template` (default variant, `feed_portrait`, `good` art, demo screenshot): zero failed blockers.
- [ ] **Step 2: Run.** `./node_modules/.bin/vitest run packages/creative/src/analysis.test.ts packages/creative/src/quality.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Adjust thresholds only together with the calibration test, and record any change in the spec's §9 table.
- [ ] **Step 4: Run.** `./node_modules/.bin/vitest run packages/creative`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(creative): deterministic creative quality checks`.

### Task 6: Image model capabilities

**Files:**
- Create: `packages/ai/src/image-models.ts`
- Modify:
  - `packages/ai/src/index.ts`: `ImageParams.size: ImageSize`, plus `export * from "./image-models.ts"`
  - `apps/api/src/modules/marketing/brand/image-generation.ts`: `size: z.enum(IMAGE_SIZES)` at line 35; `size?: ImageSize` in `generateAssignmentImage`
- Test: `packages/ai/src/image-models.test.ts`

**Interfaces:**
- Produces:
  - `IMAGE_SIZES = ["1024x1024","1536x1024","1024x1536"] as const`; `type ImageSize`
  - `type ImageModelCapabilities = {provider: "openai"; sizes: readonly ImageSize[]; transparentBackground: boolean; maxReferences: number; edit: boolean}`
  - `IMAGE_MODELS: Readonly<Record<z.infer<typeof imageModelSchema>, ImageModelCapabilities>>`: all four gpt-image entries with all three sizes, `transparentBackground: true`, `maxReferences: 16`, `edit: true`
  - `sourceSizeFor(model: z.infer<typeof imageModelSchema>, targetAspect: number): ImageSize`: the smallest |log(sizeAspect / targetAspect)|

- [ ] **Step 1: Write failing tests:**
  - every `imageModelSchema.options` entry has an `IMAGE_MODELS` entry
  - `sourceSizeFor(m, 1080/1350)` and `(m, 1080/1920)` → `"1024x1536"`
  - `(m, 1200/630)` → `"1536x1024"`
  - `(m, 1)` → `"1024x1024"`
- [ ] **Step 2: Run.** `./node_modules/.bin/vitest run packages/ai/src/image-models.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement it and replace the duplicated size enums.**
- [ ] **Step 4: Run.** `./node_modules/.bin/vitest run packages/ai apps/api/src/modules/marketing/brand`, then `./node_modules/.bin/tsc --noEmit`. Expected: PASS.
- [ ] **Step 5: Commit** `refactor(ai): central image model capabilities and source sizes`.

## Phase B — Brand kit

### Task 7: Brand kit schema, asset types and provider use

**Files:**
- Modify: `packages/schemas/src/index.ts` (`visualIdentity` at line 227); `apps/api/src/modules/assets.ts` (`brandAssetUploadInput.type`); `apps/api/src/modules/marketing/brand/drive-assets.ts` (`importDriveFile` type union and image-type list); `apps/api/src/modules/marketing/brand/marketing-profile.ts` (`assertProfileReferences`); `apps/api/src/modules/marketing/actions.ts` (`asset-status`)
- Test: `packages/schemas/src/brand-kit.test.ts`; `apps/api/tests/brand-kit.integration.test.ts`

**Interfaces:**
- Consumes: ids (import `../../creative/src/ids.ts`) and `TEMPLATE_VARIANTS` (`../../creative/src/templates.ts`, which imports no sharp).
- Produces: the optional `visualIdentity` fields exactly as in spec §5:
  - `logos {secondary?, onDark?, onLight?, mark?}`
  - `productAssetIds` (≤ 20)
  - `imagery {kind, mood ≤300, subjects ≤500 default "", avoid ≤20×200 default []}`
  - `typography {headingWeight 600|700|800, headingCase}`
  - `forbiddenDesigns` (≤ 20×300)
  - `creative {templates: z.partialRecord(z.enum(CREATIVE_TEMPLATE_IDS), {enabled, variant?}), formatsByChannel (≤ 10 keys, 1–4 formats), logoPlacement, ctaStyle, maxArtCorrections 0..2, visualReview}`

  Every object is `.strict()`; a refine requires `variant ∈ TEMPLATE_VARIANTS[template]`.
- Asset types: upload and Drive import accept `"screenshot"` and `"product"`.
- Asset flag: `asset-status` takes `providerUse?: boolean`. Changing it needs `PROJECT_OWN` (`OWNER_REQUIRED`). Status `outdated` sets `providerUse: false`. Audit `asset.provider_use_update`.
- Reference checks:
  - each `logos.*` id must be an approved `logo` asset with `sha256` and a raster mime, else `APPROVED_LOGO_ASSET_REQUIRED`
  - each `productAssetIds` id must be an approved `screenshot`, `product` or `photo`, else `APPROVED_PRODUCT_ASSET_REQUIRED`

- [ ] **Step 1: Write failing tests.** Schema:
  - `keeps saved profiles unchanged`: a profile fixture without the new fields parses deep-equal to its input plus the existing defaults.
  - `accepts a full brand kit`.
  - `refuses a variant the template does not have` (`lifestyle: {enabled:true, variant:"product_left"}`).
  - `refuses unknown formats`.

  Integration (two projects A and B):
  - B's profile referencing A's logo as `logos.onDark` → 404 `NOT_FOUND`.
  - An unapproved screenshot in `productAssetIds` → 409 `APPROVED_PRODUCT_ASSET_REQUIRED`.
  - An upload with type `screenshot` succeeds.
  - An editor setting `providerUse` → 403 `OWNER_REQUIRED`; an owner → stored.
  - `outdated` resets `providerUse`.
  - `full profile save keeps brand kit fields`: saving a profile that contains `imagery` and `creative` returns them unchanged in the new version (Review Focus 1, server side).
- [ ] **Step 2: Run.** `./node_modules/.bin/vitest run packages/schemas/src/brand-kit.test.ts`, then the integration command for `apps/api/tests/brand-kit.integration.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run both, plus `./node_modules/.bin/vitest run packages/schemas apps/web/src/modules/marketing/profile-fields.test.tsx`.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(marketing): brand kit fields, screenshot assets, provider use flag`.

## Phase C — Creative service (`apps/api/src/modules/marketing/creative/`)

### Task 8: Flag, brand kit loader, brief, art direction, store

**Files:**
- Modify:
  - `packages/config/src/index.ts`: `ORBIT_CREATIVE_STUDIO`
  - `docker-compose.yml`: pass-through next to `ORBIT_AGENT_REVIEW_AUTHORITY`
  - `scripts/check-coolify-compose.mjs`: add it to the env list at line 38
  - `apps/api/src/server.ts`: `features.creativeStudio: config.ORBIT_CREATIVE_STUDIO === "true"`
  - `apps/api/src/modules/marketing/agents/specialists/visual.ts`: `imageBytes` delegates to `assetContent`
- Create: `creative/flag.ts`, `creative/asset-content.ts`, `creative/brand-kit.ts`, `creative/brief.ts`, `creative/art-direction.ts`, `creative/store.ts`
- Test: `creative/brief.test.ts`, `creative/art-direction.test.ts`

**Interfaces:**
- Produces:
  - `creativeStudioEnabled(): boolean`
  - `assetContent(scope: Scope, data: Record<string, any>): Promise<{bytes: Buffer; mime: "image/png"|"image/jpeg"|"image/webp"; sha256: string}>`: stored base64 via `assetBytes`, else Drive via `driveContent`; `BRAND_IMAGE_FORMAT_UNSUPPORTED` 415 for other mimes.
  - `type ResolvedCreativeConfig = {enabledTemplates: TemplateId[]; defaultVariants: Partial<Record<TemplateId, VariantId>>; formatsByChannel: Record<string, FormatId[]>; logoPlacement: LogoPlacement; ctaStyle: "pill"|"outline"|"none"; maxArtCorrections: 0|1|2; visualReview: boolean}`. Defaults: all templates enabled, `auto`, `pill`, 1, false.
  - `resolveBrandKit(tx: DbTx, scope: Scope): Promise<BrandKitPlan>`, where `BrandKitPlan = {profileId: string; profileVersion: number; profile: MarketingProfile; logos: Partial<Record<LogoRole, EntityRow>>; products: EntityRow[]; config: ResolvedCreativeConfig}`. Throws `MARKETING_PROFILE_REQUIRED`, `PRIMARY_LOGO_REQUIRED` and `APPROVED_LOGO_ASSET_REQUIRED` (409).
  - `loadCreativeBrand(scope: Scope, plan: BrandKitPlan): Promise<CreativeBrand>` (outside any transaction).
  - `creativeBrief` (zod), `type StrategyCreative = {keyMessage; imageKind; motif; setting; template; mood?}`, and `type ResolvedBrief = {goal; audience; keyMessage; imageKind: ImageKind; motif; setting; mood: string; template: TemplateId; variant: VariantId; formats: FormatId[]; styleNotes: string; avoid: string[]; reservedZones: RelBox[]; fallbackReason?: "TEMPLATE_DISABLED"|"NO_PRODUCT_ASSETS"}`.
  - `resolveCreativeBrief(input: {proposal: StrategyCreative | null; content: {title: string; coreMessage?: string}; profile: MarketingProfile; config: ResolvedCreativeConfig; hasProducts: boolean; channelFormats: FormatId[]; template?: TemplateId; variant?: VariantId}): ResolvedBrief`.
  - `type ArtCorrection = {kind: "subject_larger"|"calm_text_zone"|"more_detail"; note?: string}`; `ART_NEGATIVES: string`; `artPrompt(brief: ResolvedBrief, profile: MarketingProfile, correction?: ArtCorrection): string` (≤ 4000 characters).
  - `CREATIVES = "creatives"`; `type CreativeRecord` (spec §8 shape); `type CreativeView`; `findCreative(tx, scope, id)` (404 `NOT_FOUND` for another kind or project); `creativeView(row: EntityRow, scope: Scope): CreativeView` (renditions carry `href: /api/projects/${projectId}/assets/${assetId}/content`).

Brief rules:
- A disabled template falls back to the first enabled template whose `TEMPLATE_NEEDS` fits the image kind (`fallbackReason: "TEMPLATE_DISABLED"`).
- `product` or `combined` without products becomes `scene` with `lifestyle` (`"NO_PRODUCT_ASSETS"`).
- Without a proposal: keyMessage = `coreMessage ?? title`, motif = title, imageKind `scene`, template `lifestyle`.
- Goal and audience come from profile `positioning` and `audience` (trimmed to 300).

`artPrompt` must contain:
- motif, setting and mood
- `imagery.kind`, `imagery.subjects` and `imagery.mood`
- the palette as hex
- the sentence "The main subject fills about 60 to 75 percent of the frame."
- a placement sentence derived from the text zone ("Keep the bottom third calm and uncluttered for text added later; place the subject in the upper part.")
- `ART_NEGATIVES` ("No text, letters, numbers, logos, watermarks, signage, user interfaces or screens with content. No tiny isolated subject, no empty plain background. No real or famous persons.")
- each `imagery.avoid` and `forbiddenDesigns` entry; trim avoid entries first if over 4000 characters
- for `product`/`combined`: "This is the setting for a real product screenshot added later; do not show any device screen content."

- [ ] **Step 1: Write failing tests:**
  - `artPrompt` contains "60 to 75 percent", contains each avoid entry, contains `ART_NEGATIVES`, contains the profile's `primaryColor`, stays ≤ 4000 characters with 20 × 200-character avoid entries, and `subject_larger` adds a sentence with "larger".
  - `resolveCreativeBrief` falls back from a disabled template, falls back without products, and takes formats from the channel formats.
  - `creativeStudioEnabled()` is false without the env var.
- [ ] **Step 2: Run.** `./node_modules/.bin/vitest run apps/api/src/modules/marketing/creative`. Expected: FAIL.
- [ ] **Step 3: Implement.** Then run `node scripts/check-coolify-compose.mjs`. Expected: passes with the new key.
- [ ] **Step 4: Run** the step 2 tests plus `./node_modules/.bin/vitest run apps/api/src/modules/marketing/agents/banner.test.ts`. Expected: PASS (visual refactor unchanged).
- [ ] **Step 5: Commit** `feat(marketing): creative brief, art direction and brand kit loader`.

### Task 9: Produce, recompose and attach with deterministic QA

**Files:**
- Create: `creative/quality.ts`, `creative/pipeline.ts`
- Test: `apps/api/tests/creative-studio.integration.test.ts` (sets `ORBIT_CREATIVE_STUDIO=true`)

**Interfaces:**
- Consumes: Tasks 4, 5, 8; `resolveChannelRules`; `invalidateContent`; `reviewContent` (`pipeline/workflow.ts:674`), called as `attachPackageImage` does; `create`, `update`, `audit`, `entity`.
- Produces:
  - `rightsCheck(tx, scope, rows: EntityRow[], use: "social"): CreativeCheck`: code `ASSET_RIGHTS`; every row approved, `usageApproved`, not `boundTo`, `validUses` includes the use, same project.
  - `type Correction = {kind: "scrim"} | {kind: "variant"; variant: VariantId} | {kind: "logo_variant"; role: LogoRole} | {kind: "text_scale"; scale: TextScale} | {kind: "art"; correction: ArtCorrection}`
  - `planCorrection(state: {template; variant; tried: VariantId[]; scrimBoost: number; textScale: TextScale; logoRoles: LogoRole[]; artAttempts: number; maxArtCorrections: number; artIsOrbitGenerated: boolean}, failed: Array<CreativeCheckCode | "TEXT_OVERFLOW">): Correction | null`. Order:
    - contrast → scrim (boost ≤ 3), then variant
    - logo contrast → another logo role
    - overflow → variant (≤ 2 tried), then text scale `s`
    - subject/empty → art (if attempts < max and Orbit-generated), else variant
    - otherwise null
  - `type ProduceRequest = {contentId: string; template?: TemplateId; variant?: VariantId; copy?: CreativeCopy; artAssetId?: string; productAssetIds?: string[]; options?: Partial<{logoPlacement: LogoPlacement; textScale: TextScale}>}`
  - `type PipelineDeps = {compose?: typeof composeCreative; afterCompose?: () => Promise<void>}` (test seam)
  - `produceCreative(scope: Scope, request: ProduceRequest, deps?: PipelineDeps): Promise<CreativeView>`: `PROJECT_WRITE`; social content only (`CREATIVE_SOCIAL_ONLY`); copy = `request.copy ?? content.creativeCopy`, else `CREATIVE_COPY_REQUIRED`.
  - `recomposeCreative(scope, creativeId, changes: {template?; variant?; options?; copy?}, deps?): Promise<CreativeView>`: `PROJECT_WRITE`; keeps components; previous renditions get `assetStatus: "outdated"`.
  - `attachCreative(scope, creativeId, input: {acceptQaFindings?: true}): Promise<{contentId: string; assetId: string}>`:
    - `PROJECT_WRITE`; status must be `composed`
    - `needs_owner` → 409 `CREATIVE_QA_FAILED`, unless `acceptQaFindings` by `PROJECT_OWN` (audited `creative.qa_override`)
    - sets `content.assetId` to the rendition of the channel's first format and `content.creativeId`; status `draft`; drops `review`; `invalidateContent`; then `reviewContent`
    - audit `creative.attached`

Flow (spec §8):
1. Transaction 1: plan.
2. Outside the transaction: bytes, then compose per format with up to 4 free corrections per format, then `checkArt` once.
3. Transaction 2: profile version, every component's version and sha256 unchanged, else `MARKETING_PROFILE_CHANGED` / `BRAND_ASSET_CHANGED` (409). Then create rendition assets (`generated_artwork`, `TEMPLATE_GENERATED`, approved, `boundTo {creativeId, contentId}`, `rightsSource` with every component's id, version and sha256, `validUses ["social"]`, `driveSyncStatus "LOCAL_ONLY"`) and the `creatives` row. Audit `creative.produced`.
4. Status: `composed` when no failed blocker remains, else `needs_owner`.

- [ ] **Step 1: Write failing tests** (project A with demo brand Lumora, project B with Kestrel, assets uploaded and approved through routes, content created in a mission context):
  - `composes an approved creative for a channel without rules`: `square` 1080×1080 rendition, approved, `boundTo.contentId`, status `composed`, `components.logo.sha256` = the logo's sha256.
  - `refuses another project's assets` (Test D): B producing with A's art id → 404; `GET` of A's creative from B → 404.
  - `refuses unapproved art`: 409 `ASSET_RIGHTS`, detail lists the asset.
  - `leaves weak art for the owner` (Test C, deterministic): flat art → status `needs_owner` with `EMPTY_AREA_EXCESSIVE`; editor attach → 409 `CREATIVE_QA_FAILED`; zero `publications` rows.
  - `owner may accept QA findings`: owner attach with `acceptQaFindings` succeeds, and an audit row `creative.qa_override` exists.
  - `stops when the brand changes meanwhile` (Review Focus 5): `afterCompose` saves a new profile → 409 `MARKETING_PROFILE_CHANGED`; no `creatives` row and no rendition asset.
  - `attaches and resets review`: `content.assetId` = rendition id, status `draft`, `review` absent.
  - `recomposes without new art`: variant change → new renditions, same `components.artAssetId`, `cost.settledMicros` 0, old renditions `outdated`.
  - `viewer cannot produce`: 403.
- [ ] **Step 2: Run** the integration command for `apps/api/tests/creative-studio.integration.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement `quality.ts` and `pipeline.ts`.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(marketing): produce, recompose and attach creatives with QA`.

### Task 10: Art generation, bounded regeneration and vision review

**Files:**
- Modify:
  - `packages/ai/src/routing.ts`: task class `creative_review`, `defaultOutputTokens` 1500, `legacyTier` "standard", optional route in `taskRoutesSchema`
  - every web or doc list of task classes found by `grep -rn "issue_triage" apps/web/src docs`
- Create: `creative/art.ts`, `creative/vision-review.ts`
- Modify: `creative/pipeline.ts` (`ProduceRequest.generateArt`)
- Test: `apps/api/tests/creative-art.integration.test.ts`; `packages/ai/src/routing.test.ts` (new class)

**Interfaces:**
- Consumes: `generateProjectImage` (owner path: confirmation fields, reservation at `maxCostMicrosPerImage`, unapproved reference asset); `currentImageTerms`; `sourceSizeFor`; `artPrompt`; the finance extraction pattern (`modules/finance/extraction/extract.ts:298-365`).
- Produces:
  - `ProduceRequest.generateArt?: {confirmMaximumCostMicros: number; confirmPromptMayBeSentToProvider: true}`: `PROJECT_OWN`. The new art is stored unapproved, the creative status is `needs_rights` (renditions composed but `usageApproved: false`, `assetStatus: "reference"`), and `attach` refuses with `CREATIVE_RIGHTS_REQUIRED` until the owner approves the art (existing `asset-status`) and recomposes.
  - `regenerateCreativeArt(scope, creativeId, input: {correction?: ArtCorrection; confirmMaximumCostMicros: number; confirmPromptMayBeSentToProvider: true}, providers?): Promise<CreativeView>`: `PROJECT_OWN`. When art corrections so far ≥ `config.maxArtCorrections`, it throws 409 `ART_CORRECTION_LIMIT` before any reservation. It records `corrections[]` with `costMicros`.
  - `type VisionVerdict = {scores: {subject:number; balance:number; legibility:number; brandFit:number; messageFit:number; channelFit:number; value:number}; issues: {kind: "art"|"layout"|"copy"|"logo"; note: string}[]; verdict: "pass"|"needs_correction"}`. Scores are integers 1–5; notes ≤ 200 characters.
  - `visionReviewCreative(scope, creativeId, options?: {runKey?: string; authorize?: (tx) => Promise<void>}, deps?: {respond?: typeof respond}): Promise<CreativeView>`:
    - 409 `VISION_REVIEW_DISABLED` unless `config.visualReview`
    - 409 `PROVIDER_USE_REQUIRED` unless every component asset has `providerUse === true`
    - reservation key `creative-review:${creativeId}:${version}`, category `creative_review`
    - pass = every score ≥ 3 and mean ≥ 3.5; otherwise status `needs_owner`
    - verdict stored in `qa.vision`
    - a provider throw settles `null` and leaves the creative unchanged

- [ ] **Step 1: Write failing tests** (injected providers; spend mandate test profile):
  - `regenerate needs the owner`: editor → 403.
  - `regenerate needs the exact ceiling`: a wrong `confirmMaximumCostMicros` → 409 `IMAGE_COST_CONFIRMATION_STALE`.
  - `regeneration is bounded` (maxArtCorrections 1): the second regenerate → 409 `ART_CORRECTION_LIMIT`; the provider was called exactly once; no second reservation row.
  - `budget stop happens before the provider`: daily budget 0 → refusal; provider mock not called.
  - `new art waits for rights`: status `needs_rights`; attach → 409 `CREATIVE_RIGHTS_REQUIRED`; after `asset-status` approve and recompose → `composed`.
  - `vision review is off by default` (`VISION_REVIEW_DISABLED`); a component without `providerUse` → `PROVIDER_USE_REQUIRED` and no `respond` call.
  - `vision review settles and stores the verdict`: a reservation settled with the usage cost; a failing verdict → `needs_owner`.
  - `an unknown vision outcome stays counted`: `respond` throws → reservation settled `null`; creative version unchanged.
  - `routing: creative_review resolves a route`.
- [ ] **Step 2: Run** `./node_modules/.bin/vitest run packages/ai/src/routing.test.ts`, then the integration command for `apps/api/tests/creative-art.integration.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(marketing): bounded creative art regeneration and optional vision review`.

### Task 11: Creative routes, OpenAPI and access matrix

**Files:**
- Create: `creative/routes.ts`
- Modify:
  - `apps/api/src/modules/marketing/routes.ts`: call `creativeRoutes(context)` after `marketingReportRoutes`
  - `apps/api/tests/access-matrix.integration.test.ts`: `ORBIT_CREATIVE_STUDIO: "true"`
  - `apps/api/tests/fixtures/access-matrix.json`, regenerated
  - `packages/schemas/openapi.json` and `packages/api-client/src/generated.ts`, regenerated
  - `docs/API_CONTRACT.md`
- Test: `apps/api/tests/creative-routes.integration.test.ts`

**Interfaces:**
- Consumes: Tasks 9–10 functions; `scopeFor`, `PROJECT_WRITE`, `PROJECT_OWN`.
- Produces routes. Every route first checks `creativeStudioEnabled()`, else 404 `NOT_FOUND`:

| Method and path | Scope | Notes |
| --- | --- | --- |
| `GET /api/projects/:projectId/creative/options` | viewer | `{templates: [{id, variants: Record<FormatId, VariantId[]>, needs, copyLimits}], formats: CREATIVE_FORMATS, defaultChannelFormats, config: ResolvedCreativeConfig \| null}` |
| `POST /api/projects/:projectId/creatives` | write; owner when `generateArt` | rate limit 3/min when `generateArt` |
| `GET /api/projects/:projectId/creatives/:creativeId` | viewer | |
| `GET /api/projects/:projectId/content/:contentId/creative` | viewer | latest non-superseded creative or `null` |
| `POST …/creatives/:creativeId/recompose` | write | |
| `POST …/creatives/:creativeId/regenerate-art` | owner | rate limit 3/min |
| `POST …/creatives/:creativeId/review` | owner | rate limit 3/min |
| `POST …/creatives/:creativeId/attach` | write | |

  Bodies are parsed with strict zod schemas mirroring the function inputs.

- [ ] **Step 1: Write failing tests:**
  - `routes are hidden while the flag is off`: every route → 404.
  - `marketing disabled answers MODULE_DISABLED`.
  - `roles`: viewer GET ok and POST 403; editor produce/recompose/attach ok; editor regenerate/review 403.
  - `outsider learns nothing`: 404.
  - `options list seven templates and four formats`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement the routes.** Then run `UPDATE_ACCESS_MATRIX=1` with the access-matrix integration test, and review the fixture diff line by line as a security change: only the eight new routes may appear, with the scopes in the table. Regenerate OpenAPI per the worktree memory (`ORBIT_CONFIG_FILE=<main>/.runtime/local.env node scripts/openapi.ts`, then openapi-typescript) and review its diff.
- [ ] **Step 4: Run** the route test and the access matrix without `UPDATE_ACCESS_MATRIX`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(marketing): creative studio routes`.

## Phase D — Copy, strategy and flows

### Task 12: Copy craft, creative copy and their review checks

**Files:**
- Modify:
  - `packages/ai/src/index.ts`: constants, `draftJsonSchema`, `generate` params, `withoutBannerClaims` also accepts creative copy
  - `apps/api/src/modules/marketing/pipeline/generation.ts`: contract fields, revision `previousCreative`, content fields `creativeCopy`, `coreMessage`, `hook`, `copyCraft`
  - `apps/api/src/modules/marketing/agents/specialists/review.ts`: deterministic problems, `REVISABLE`
- Create: `creative/copy-checks.ts`
- Test: `packages/ai/src/requests.test.ts` (extend); `creative/copy-checks.test.ts`; `apps/api/tests/agent-review.integration.test.ts` (extend)

**Interfaces:**
- Produces:
  - `generate(params: {…existing; creative?: {limits: CopyLimits}; copyCraft?: boolean})`, where `CopyLimits = {eyebrow:number; headline:number; subline:number; cta:number}`
  - output adds `creative: {eyebrow, headline, subline, cta}` (strings; empty = absent), and `coreMessage` and `hook` when `copyCraft`
  - contract: `copyCraft: true` exactly when `creativeStudioEnabled() && m.contentType === "social"`; `creative: {template, limits: TEMPLATE_COPY_LIMITS[template]}` when `m.creativeTemplate`
  - content stores `copyCraft: true`, `coreMessage`, `hook`, and `creativeCopy` with `cta` = `creativeCta(m.targetAction, limits.cta)` (the CTA without closing punctuation, or `""` when longer than the limit)
  - `creativeCopyProblems(copy: unknown, limits: CopyLimits, opts: {cta: unknown}): string[]`, with codes `CREATIVE_TEXT_MISSING`, `CREATIVE_UNSUPPORTED_CLAIM`, `CREATIVE_PROHIBITED_LANGUAGE`, `CREATIVE_TEXT_UNSAFE`, `CREATIVE_LINK_NOT_ALLOWED`. It reuses the banner rules' regexes and `PROHIBITED_LANGUAGE`; it does not duplicate them.
  - `copyCraftProblems(content: Record<string, any>): string[]`, with codes `CORE_MESSAGE_MISSING` and `FACT_TOO_LONG_FOR_SOCIAL` (any fact claim text > 220 characters in a social body). It runs only when `content.copyCraft === true`.
  - Review: both problem sets join `deterministicProblems`. `REVISABLE` += `CORE_MESSAGE_MISSING`, `FACT_TOO_LONG_FOR_SOCIAL`, `CREATIVE_UNSUPPORTED_CLAIM`, `CREATIVE_PROHIBITED_LANGUAGE`, `CREATIVE_TEXT_MISSING`. `CREATIVE_TEXT_UNSAFE` and `CREATIVE_LINK_NOT_ALLOWED` reject.

Exact instruction texts (appended like `BANNER_DRAFT_INSTRUCTION`):

`COPY_CRAFT_INSTRUCTION` = "The contract has copyCraft: build the post around exactly one core message and return it as coreMessage (one sentence of at most 160 characters, not copied from the body). Open the body with a hook in its first line: a question, a recognisable everyday moment or a concrete benefit; return that line as hook. Then show one concrete problem or benefit for the audience, introduce the product as the answer in at most one sentence, and close with the contract's exact intendedPrimaryCta, led into naturally for the channel. Do not describe the whole product: use at most two fact placeholders, prefer facts with short values, and never use a fact whose value is a long description. Use only hashtags that name the post's topic."

`CREATIVE_DRAFT_INSTRUCTION` = "The contract has a creative: also write creative, the short copy on the post's image. headline is the image's main line (the core message in a few words), subline is one short supporting line or empty, eyebrow is a label of two or three words or empty, and cta is the contract's intendedPrimaryCta without closing punctuation (Orbit sets it). Keep each field within creative.limits characters, write in the post's language and voice, and state nothing the body does not back with its facts: no figure, number word, percentage, price, date, status, promise or link. If the contract has revision.previousCreative, return it unchanged unless revision.instruction concerns the image copy. The creative copy is no claim: never record it in the claims ledger."

- [ ] **Step 1: Write failing tests:**
  - `requests.test.ts`:
    - with `copyCraft`, the request instructions end with `COPY_CRAFT_INSTRUCTION` and the schema requires `coreMessage` and `hook`
    - with `creative`, the schema requires `creative`
    - without either, the instructions equal `DRAFT_INSTRUCTIONS` and the schema equals today's (unchanged prompt)
    - a style claim that is only creative copy is dropped
  - `copy-checks.test.ts`:
    - "Save 30%" headline → `CREATIVE_UNSUPPORTED_CLAIM`
    - "risk-free" → `CREATIVE_PROHIBITED_LANGUAGE`
    - a zero-width space → `CREATIVE_TEXT_UNSAFE`
    - an empty headline → `CREATIVE_TEXT_MISSING`
    - a 300-character fact claim on social with `copyCraft` → `FACT_TOO_LONG_FOR_SOCIAL`
    - missing `coreMessage` → `CORE_MESSAGE_MISSING`
    - `copyCraft` absent → no copy-craft problems
  - `agent-review.integration.test.ts`: a draft with a long fact under `copyCraft` is revised once without a model call, and rejected when the revision still has it.
- [ ] **Step 2: Run** `./node_modules/.bin/vitest run packages/ai/src/requests.test.ts apps/api/src/modules/marketing/creative/copy-checks.test.ts` and the agent-review integration test. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** them plus `./node_modules/.bin/vitest run packages/ai apps/api/src/modules/marketing/agents`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(marketing): copy craft and creative copy with deterministic checks`.

### Task 13: Strategy creative brief

**Files:**
- Modify: `apps/api/src/modules/marketing/agents/specialists/strategy.ts`
- Test: `apps/api/src/modules/marketing/agents/specialists/strategy.test.ts` (extend)

**Interfaces:**
- Produces:
  - `CREATIVE_BRIEF_LIMITS = {keyMessage: 200, motif: 400, setting: 300, mood: 120} as const`
  - the brief adds `creative: z.object({keyMessage, imageKind: z.enum(IMAGE_KINDS), motif, setting, template: z.enum(CREATIVE_TEMPLATE_IDS), mood}).strict().nullable()`, with lengths checked after the answer like `STRATEGY_TEXT_LIMITS`
  - `checkBriefs` replaces a template outside `assignment.creative.templates` with the first allowed one, and never drops a brief for `creative`
- The instruction gains the sentence: "If assignment.creative is set, also give each brief creative: keyMessage (the one message of the post's image), imageKind (scene for people and everyday situations, product when the post shows a feature through the product's own screenshots, graphic for typographic tips or announcements, combined for a real situation with the product's screenshot), motif (the main subject, concrete and visual), setting (place, light, time of day), template (one of assignment.creative.templates) and mood; otherwise creative is null. A motif never contains text, logos, interfaces or real persons."

- [ ] **Step 1: Write failing tests:**
  - the schema accepts `creative: null` and a valid creative
  - an over-long motif fails the limit check
  - `checkBriefs` normalises a disallowed template
  - the output JSON schema lists `creative` as nullable
- [ ] **Step 2: Run.** `./node_modules/.bin/vitest run apps/api/src/modules/marketing/agents/specialists/strategy.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** it plus the `specialist-strategy` integration test. Expected: PASS.
- [ ] **Step 5: Commit** `feat(marketing): strategy briefs carry a creative brief`.

### Task 14: Assignments with creatives

**Files:**
- Create: `creative/assignment.ts`
- Modify:
  - `agents/assignments.ts`: field, `CLEARABLE`, validation, readiness
  - `agents/specialists/copywriter.ts` (`briefMission`)
  - `agents/specialists/visual.ts`: branch to the creative visual step; `attach` calls `composeRunCreatives`
  - `agents/specialists/copywriter.ts` (`draft`): calls `composeRunCreatives` like `composeRunBanners`
  - `agents/specialists/review.ts`: creative problems, `LEFT_FOR_OWNER`, `CHANNEL_PROBLEMS`, vision review before the model review
  - `agents/agent-review.ts`: CS-D7, `creativeHash`
  - `tools/assignment-tools.ts`: carry `creative`
- Test: `apps/api/tests/assignment-creatives.integration.test.ts`

**Interfaces:**
- Produces:
  - `assignmentCreative = z.object({templates: z.array(z.enum(CREATIVE_TEMPLATE_IDS)).min(1).max(7).optional(), artPer: z.enum(["run","post"]).default("post"), imageKind: z.enum(["auto", ...IMAGE_KINDS]).default("auto")}).strict()`
  - assignment field `creative: assignmentCreative.optional()`, hashed only when set; legacy hashes unchanged
  - validation codes: `CREATIVE_SOCIAL_ONLY`, `CREATIVE_NEEDS_IMAGE` (needs `image: true`), `CREATIVE_AND_BANNER`, `CREATIVE_STUDIO_DISABLED`, `CREATIVE_LOGO_REQUIRED` (via `resolveBrandKit`), checked at propose, change, confirm and resume and in the visual step before any cost
  - missions get `creativeTemplate` (brief template, else first assignment template, else first enabled template) and `creativeBrief` (`brief.creative`)
  - `creativeVisualStep(scope: Scope, task: AgentTask): Promise<{assetIds: string[]; skipped: Array<{unit: string; code: string}>}>`:
    - one art unit per run or per brief (`artPer`)
    - no art when the resolved template's art is `none` or optional and imageKind is `graphic`/`product`
    - else `generateAssignmentImage` with `artPrompt`, size `sourceSizeFor(model, aspect of the unit's first format)`, `requestId = runImageRequestId(task.id) + ":" + unitIndex`, assetFields `{creativeArt: true, creativeUnit}`
    - after generation, `checkArt`; on a failed blocker and with `artAttempts < config.maxArtCorrections` and task budget left (`assertTaskBudget`), regenerate with the planned `ArtCorrection` (`requestId` suffix `:c<n>`) and keep the art with fewer failed blockers
  - `composeRunCreatives(scope: Scope, runId: string): Promise<{composed: string[]; failed: {contentId: string; code: string}[]; error: string | null}>`:
    - idempotent per key `hash(artSha256, creativeCopy, template, variant, formats, brand hash)`
    - formats via `formatsForChannel(rules.providerIdentifier, config.formatsByChannel)`
    - free corrections only; saves under the run lock with the `BRAND_ASSET_CHANGED` re-check pattern of `composeRunBanners`
    - attaches the draft's rendition through the existing `refusal` media checks
    - render failures recorded as `creativeFailure {code: "CREATIVE_RENDER_FAILED"}`
  - review problems: `creativeCopyProblems` + state codes `CREATIVE_MISSING`, `CREATIVE_RENDER_FAILED`, `CREATIVE_QA_FAILED` (`LEFT_FOR_OWNER`) and `CREATIVE_MEDIA_REFUSED` (`LEFT_FOR_OWNER` and `CHANNEL_PROBLEMS`); with `config.visualReview`, `visionReviewCreative(scope, creativeId, {runKey: runBudgetKey(task.runId), authorize: (tx) => assertTaskBudget(tx, scope, task, estimateMicros)})` before the model review, where `estimateMicros` is the call plan's reservation estimate
  - `agentReviewAccepted`: content with `creativeCopy` and `delivery !== "postiz_draft"` → false; `review.creativeHash` must equal `hash(content.creativeCopy)`

- [ ] **Step 1: Write failing tests** (follow the setup of `assignment-banners.integration.test.ts`; image provider mock returns fixture art):
  - `refuses creative with banner`: `CREATIVE_AND_BANNER`.
  - `refuses creative without a logo`: `CREATIVE_LOGO_REQUIRED`.
  - `refuses creative while the flag is off`: `CREATIVE_STUDIO_DISABLED`.
  - `keeps legacy confirmations`: the hash of an assignment without `creative` is unchanged.
  - `art per post`: 2 slots → provider called twice, each draft carries its own rendition (`boundTo.contentId`) in its channel format, one `creatives` row per draft.
  - `bounded correction on bad art` (Test C): provider returns `tiny_subject` twice with maxArtCorrections 1 → provider called exactly 2 times; draft `needs_review` with `CREATIVE_QA_FAILED`; no `publications` row and no Postiz draft call.
  - `agent authority does not cover creatives` (Test E): `delivery: "publish"` + agent approve → not scheduled; `postiz_draft` → booked as before.
  - `budget bounds art`: a run pool for one image → the second unit refused, its draft carries `creativeFailure`, the provider is called once.
- [ ] **Step 2: Run** the integration command for the file. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the file plus `assignment-banners`, `assignments`, `assignment-runs`, `agent-review` and `assignment-copywriter-visual` integration tests. Expected: PASS (banner paths unchanged).
- [ ] **Step 5: Commit** `feat(marketing): assignments produce creatives per post`.

### Task 15: Content packages compose creatives

**Files:**
- Modify: `agents/content-packages.ts` (missions get `creativeTemplate` = the first enabled template when the package plans an image and the flag is on); `agents/package-image.ts` (`attachPackageImage`)
- Test: `apps/api/tests/content-packages.integration.test.ts` (extend)

**Interfaces:**
- Consumes: `produceCreative` with `artAssetId` = the package image, `attachCreative`.
- Produces: with the flag on and the profile's primary logo set, each chosen draft with `creativeCopy` gets its rendition instead of the raw image. A draft without `creativeCopy` keeps the old raw attach, and the response lists `{contentId, code: "CREATIVE_COPY_MISSING"}`. With the flag off, nothing changes.

- [ ] **Step 1: Write failing tests:**
  - flag on: the attached asset has `boundTo.creativeId` and the channel's format size
  - flag off: the attached asset is the package image, as today
  - a draft without creative copy gets the raw image plus `CREATIVE_COPY_MISSING`
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** it plus `package-schedule` and `chat` integration tests. Expected: PASS.
- [ ] **Step 5: Commit** `feat(marketing): content packages attach composed creatives`.

### Task 16: Instagram and Facebook channel rules

**Files:**
- Modify: `publishing/channel-rules.ts`; `policy/policy.ts` (preflight); `packages/connectors/src/postiz.ts` (`postizProviderSettings`, only if Step 1 requires it)
- Test: `publishing/channel-rules.test.ts` (extend); `packages/connectors/src/postiz.test.ts` (if changed); preflight integration test (extend `apps/api/tests/safety.integration.test.ts`)

**Interfaces:**
- Produces:
  - `ChannelRules.mediaRequired: boolean` (false everywhere else)
  - `instagram` and `instagram-standalone`: `characterLimit 2200`, `utf16_units`, `liveCapabilityKnown true`, `mediaRequired true`
  - `facebook`: `50000` (the Postiz client's bound; was 63206, ruling in Task 16), `utf16_units`, `true`, `false`
  - preflight blocker `MEDIA_REQUIRED` for social content without `assetId` on a `mediaRequired` channel

- [ ] **Step 1: Verify Postiz provider settings.** Use the Postiz MCP `integrationSchema` tool (read-only) for `instagram`, `instagram-standalone` and `facebook`, or the Postiz source for `__type` DTOs. Record the required settings fields in the commit message. If `instagram` requires `post_type`, `postizProviderSettings("instagram")` returns `{__type: "instagram", post_type: "post"}` plus any other required field with its documented default.
- [ ] **Step 2: Write failing tests:**
  - the Instagram rules as listed
  - Telegram and X unchanged
  - Facebook 50000
  - preflight `MEDIA_REQUIRED` for Instagram text-only content
  - the provider settings for Instagram (if changed)
- [ ] **Step 3: Run.** `./node_modules/.bin/vitest run apps/api/src/modules/marketing/publishing packages/connectors`, then the safety integration test. Expected: FAIL.
- [ ] **Step 4: Implement, then run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(marketing): Instagram and Facebook channel rules`.

## Phase E — Web

### Task 17: Creative panel in content detail

**Files:**
- Create: `apps/web/src/modules/marketing/creative/creative-api.ts`, `apps/web/src/modules/marketing/creative/creative-panel.tsx`
- Modify: `apps/web/src/modules/marketing/work.tsx` (`ContentDetail` at line 1125: with `shell.features?.creativeStudio`, render `<CreativePanel>` as a section and hide the old "Creative" button); `apps/web/src/app/globals.css` (`.creative-panel…`); the marketing module's copy dictionary (de/en)
- Test: `apps/web/src/modules/marketing/creative/creative-panel.test.tsx`

**Interfaces:**
- Consumes: Task 11 routes; `useResource`, `useMutation`, `post` from `@/lib/api`; `Tabs`, `Modal`, `Alert`, `Badge`, `Button` primitives.
- Produces:
  - `type CreativeView` and `type CreativeOptions`, mirroring the API (hand-written, like other web types)
  - `useCreativeOptions(projectId)`, `useContentCreative(projectId, contentId)`
  - `CreativePanel({projectId, content, access}: {projectId: string; content: {id: string; body: string; channel: string; creativeCopy?: CreativeCopy}; access: "viewer"|"editor"|"owner"})`

Panel (spec §12):
- rendition tabs per format (keyboard arrows, Home/End), each with its image and alt text = headline
- post text, channel and format
- components with their rights state
- QA checklist: failed codes in plain language, warnings separate
- cost formatted in USD, or "—" when unknown
- status badge: dot + text
- actions by role:
  - editor: produce (template, variant, art from approved assets or none), recompose (variant, logo placement, text size S/M/L, copy fields), attach
  - owner adds: regenerate art with a confirmation dialog naming the max cost and "prompt goes to the image provider"; vision review; accept QA findings
- loading, empty ("No creative yet") and error states; pending locks

- [ ] **Step 1: Write failing tests:**
  - `shows a rendition per format and switches with arrow keys`
  - `lists failed QA checks in words` (`EMPTY_AREA_EXCESSIVE` → readable label)
  - `hides actions from viewers`
  - `editor can recompose but not regenerate`
  - `owner regenerate asks for the cost confirmation` (dialog text contains the max cost)
  - `shows a warning for needs_owner`
  - `shows — for unknown cost`
  - `renders the empty state`
- [ ] **Step 2: Run.** `./node_modules/.bin/vitest run apps/web/src/modules/marketing/creative`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** it plus `pnpm --dir apps/web typecheck` (or `./node_modules/.bin/tsc -p apps/web --noEmit`). Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): creative panel with preview, QA and edits`.

### Task 18: Brand kit editor, safe profile save, draft thumbnails, assignment card

**Files:**
- Create: `apps/web/src/modules/marketing/creative/brand-kit-section.tsx`
- Modify:
  - `apps/web/src/modules/marketing/advanced.tsx`: the profile save at line 629 spreads the current `visualIdentity` first
  - `apps/web/src/modules/marketing/settings-sections.tsx`: Brand shows `BrandKitSection` with the flag
  - `apps/web/src/modules/marketing/assignments.tsx` (`AwaitingOwnerDraftList`): thumbnail
  - `apps/api/src/modules/marketing/agents/assignment-overview.ts`: `assetId` in drafts awaiting the owner, if missing
  - `apps/web/src/modules/marketing/assignment-card.tsx`: `CREATIVE_CONSENT` and summary
- Test: `apps/web/src/modules/marketing/creative/brand-kit-section.test.tsx`; `profile-fields.test.tsx` (extend); `assignment-card.test.tsx` (extend)

**Interfaces:**
- Produces:
  - `BrandKitSection({projectId, profile, version, isOwner})`, saving `PUT /marketing-profile` with `expectedVersion` and the merged `visualIdentity`
  - fields: logo variant pickers (approved `logo` assets only), product assets (approved screenshot/product/photo), imagery, typography, templates (enable plus default variant from `creative/options`), formats per channel identifier, logo placement, CTA style, art corrections 0/1/2, vision review with the hint "Sends the finished image to the configured model; billed per check"
  - `CREATIVE_CONSENT` = "Orbit generates the image art with your configured image model and composes it with your approved logo and product images. Logos and screenshots are never sent to the image provider."

- [ ] **Step 1: Write failing tests:**
  - `brand kit save keeps colours, design rules and logo` (merged body)
  - `variant options follow the template`
  - `only owners can edit`
  - `profile editor keeps brand kit fields` (Review Focus 1): saving the existing form with `imagery` and `creative` present sends them unchanged
  - the assignment card shows `CREATIVE_CONSENT` and "Art per post"
- [ ] **Step 2: Run.** `./node_modules/.bin/vitest run apps/web/src/modules/marketing`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): brand kit editor and creative assignment card`.

### Task 19: Browser flow

**Files:**
- Create: `apps/web/tests/creative-studio.spec.ts`
- Test: same

Precondition: local stack with `ORBIT_CREATIVE_STUDIO=true` (API and worker env), as the other marketing specs run.

- [ ] **Step 1: Write the spec:**
  1. The owner signs in, uploads the demo logo and screenshot (fixture PNGs written from `packages/creative/fixtures`), approves their rights, and sets the brand kit (primary logo, product).
  2. Create social content in a mission.
  3. Content detail → Creative panel → produce `feature_highlight` from the screenshot, with no art cost.
  4. Expect a 1080×1080 preview (`naturalWidth` 1080) and QA "passed".
  5. Switch the variant → a new image.
  6. Attach → content status "draft".
  7. At 390 px, the panel has no horizontal overflow.
- [ ] **Step 2: Run** with `PLAYWRIGHT_CHANNEL=chrome node node_modules/@playwright/test/cli.js test apps/web/tests/creative-studio.spec.ts`. Expected: PASS (fix the app, not the test, on failure).
- [ ] **Step 3: Commit** `test(web): creative studio browser flow`.

## Phase F — Acceptance and docs

### Task 20: Demo renders and acceptance tests A–E

**Files:**
- Create: `scripts/creative-demo.ts`; `apps/api/tests/creative-acceptance.integration.test.ts`

**Interfaces:**
- Produces:
  - `scripts/creative-demo.ts` (offline, 0 USD): renders both demo brands × 7 templates (default variant) × 4 formats, plus the test C cases, into `.runtime/creative-demo/<brand>/<template>-<format>.png`, with `report.json` (QA checks per file). It exits 1 when a good-art render has a failed blocker.
  - The acceptance file maps spec §12 tests A–E for projects Lumora and Kestrel:
    - **A:** `lifestyle` with good art. Both brands carry the logo sha in their layers; the CTA layer colour is the brand's `primaryColor`; copy fields are present; status `composed`.
    - **B:** `feature_highlight` from the screenshot in all 4 formats; screenshot integrity passes; 4 renditions.
    - **C:** tiny art → `needs_owner` via an injected regenerate mock; attempts = `maxArtCorrections`; no publication.
    - **D:** cross-project ids refused; Kestrel layer colours never contain Lumora palette values and vice versa.
    - **E:** after attach, preflight lists the approval blocker; schedule/publish and Postiz handoff routes refuse without approval; after the existing approval they proceed in test mode.

- [ ] **Step 1: Write the acceptance tests.** Expected: FAIL only where earlier tasks left gaps; fix those gaps in their owning files.
- [ ] **Step 2: Run** the acceptance test and `node scripts/creative-demo.ts`. Expected: PASS and exit 0.
- [ ] **Step 3: Visually inspect.** Open at least one render per template and format of each brand (Read tool). Check hierarchy, motif size, logo legibility, and no clipping or overlap. Fix layout values in `templates.ts` (keeping Task 3 and 5 tests green) until both brands look professionally designed. Send Mario a contact sheet (`.runtime/creative-demo/contact-sheet.png`, a montage made with sharp) via SendUserFile.
- [ ] **Step 4: Commit** `test(marketing): creative studio acceptance A–E and demo renders`.

### Task 21: Documentation and full verification

**Files:**
- Create: `docs/MARKETING_CREATIVE_STUDIO.md`
- Modify: `docs/OPERATIONS.md` (section after "Assignment banners"); `docs/IMPLEMENTATION_STATUS.md` (new top entry); `docs/REQUIREMENTS_TRACEABILITY.md` (rows for A–E); `docs/MODEL_ROUTING.md` (`creative_review`); `docs/MODULE_ACTIVATION.md` (flag row); spec status line → "accepted, implemented locally"

- [ ] **Step 1: Write the docs.** Cover:
  - flag and rollback
  - brand kit fields
  - templates and variants
  - formats and channel mapping
  - QA codes and thresholds
  - corrections and limits
  - costs and vision review (`providerUse`)
  - assignment `creative`
  - routes
  - CS-D3 follow-up (uLiquid migration)
  - known limits (spec §14)
- [ ] **Step 2: Run the full verification:**
  - `./node_modules/.bin/tsc --noEmit`
  - `node scripts/source-check.mjs` (lint + boundaries: 0 new violations)
  - `./node_modules/.bin/tsc -p apps/web --noEmit`
  - the full suite with the integration command (`./node_modules/vitest/vitest.mjs run`)
  - `node scripts/check-coolify-compose.mjs`
  - `next build --webpack` in `apps/web` (per worktree memory)
  - `git diff --check`

  Expected: all pass. Revert `evals/knowledge/last-deterministic-run.json` and `apps/web/next-env.d.ts` if touched.
- [ ] **Step 3: Request a whole-branch review** (superpowers:requesting-code-review, most capable model). Fix Critical and Important findings and re-run step 2.
- [ ] **Step 4: Commit** `docs(marketing): Creative Studio configuration and status`.

### Task 22: Live acceptance run (gated on Mario's go-ahead, ≤ 1 USD)

**Files:**
- Planned, not implemented: create `creative-demo-seed.ts` in the scripts directory. It runs on the local database only and refuses any `DATABASE_URL` host other than 127.0.0.1/localhost. It creates two demo projects (Lumora, Kestrel) with brand kits, assets and content.
- Modify: `docs/IMPLEMENTATION_STATUS.md` (result)

- [ ] **Step 1: Ask Mario for the go-ahead.** Name the cost ceiling: 2 art images at the project's `maxCostMicrosPerImage` (≤ 0.25 USD each), plus at most 2 vision reviews. Hard limit: project monthly budget 1 USD. He provides the image key through Settings → AI on the local stack.
- [ ] **Step 2: After a yes:** seed, then run test A per brand with `generateArt`. Approve the rights as owner, recompose, and run the vision review with `providerUse` set on the demo assets.
- [ ] **Step 3: Record the results:** cost settled, QA, vision verdict, and both images, inspected and sent to Mario. Note any quality gap as a follow-up.
- [ ] **Step 4: Commit** `docs(marketing): Creative Studio live acceptance result`.

---

Delivery after Task 21 (and optionally Task 22): integrate `origin/main`. Pushing to `main` deploys production (flag off: no behaviour change), so it needs Mario's explicit approval. Enabling `ORBIT_CREATIVE_STUDIO` in production is a separate owner step.
