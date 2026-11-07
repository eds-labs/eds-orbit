# Brand-true assignment banners and draft decisions on the approvals page

Task from Mario, 2026-11-07. Branch `claude/orbit-creatives-approval-management-64303d`.

## Classification

- Risk: **medium-high**. The change touches publishing gates (what may still be released or published) and paid image prompts. It changes no authentication, authorization model, tenancy, schema or migration, and adds no dependency or provider.
- Environment: local. A push to `main` deploys production, so delivery waits for Mario's approval.
- App profile: primary `fullstack-saas` (marketing module, owner role), with `web-frontend` for the approvals page and `backend-api` for the routes.
- Workflow: `bugfix.md` for both causes, plus small feature parts (reject, discard, archive).

## Findings

### 1. FamilyPlan banner in the uLiquid look

The FamilyPlan assignment "FamilyPlan Testwoche" uses the legacy assignment banner (`banner: {template: "brand_landscape", style}`, R78). That path does not read the project's brand kit:

- `agents/banner.ts` `DEFAULT_BANNER_STYLE` is the uLiquid prompt: dark navy `#040B1A`, cyan light waves, frosted glass cards, "fintech product banner". `bannerBackgroundPrompt` only appends the owner's style notes ("light style") after it, so the explicit navy and cyan instructions win.
- `packages/creative` `renderBrandBanner` composes with fixed navy and cyan constants: base, left shade, glass card, second headline, button and wordmark accent.
- The project's palette reaches the image model only as one generic line in `buildBrandImagePrompt`.
- No brand check exists for banners. The review checks banner copy, not the image.
- No cross-project reuse was found. Every asset, background, style-description and logo lookup is scoped by `workspaceId` and `projectId`, and reservations are keyed per project.
- Creative Studio (`creative`) is already profile-driven (`artPrompt`, brand-kit layout). It is not the cause.

### 2. Approvals page offers only "Freigeben"

The mobile "Freigaben" tab is the marketing approvals page (`ApprovalInbox`), not the ActionRequest inbox ("App-Freigaben", which has Approve and Reject). Assignment drafts waiting for the owner are rendered by `AwaitingOwnerDraftList`, which has a single "Freigeben" button. The backend has no route to reject, discard or archive a single draft. No CSS hides a button.

Related gaps:

- `releaseAssignmentDraft` moves a post whose slot has passed to the next free half hour of the same day: a late approval publishes late.
- `reviewContent` sets any content to `reviewed`/`needs_review`, also a `rejected` or `archived` one. A rejected draft could thus be reviewed, approved and published again.
- Drafts whose slot day has passed disappear from the list, but stay in the content list and keep counting toward the assignment's review backlog (`ASSIGNMENT_REVIEW_BACKLOG_FULL`).

## Plan

### A. Banners from the project's brand kit (no brand in code)

1. `agents/banner.ts`: `bannerBackgroundPrompt(banner, identity)` builds the art prompt from the profile's `visualIdentity`. It includes:
   - the imagery kind, mood, subjects and avoid list;
   - the palette as colour words, and the tone derived from the background colour (light or dark);
   - the design rules and forbidden designs;
   - the owner's style notes, marked as taking precedence;
   - the fixed layout needs: a calm left half for the headline, room on the right for the logo card, no text, logos or people.

   `DEFAULT_BANNER_STYLE` (uLiquid) is removed.
2. `packages/creative`: `BannerInput.palette` (optional). `bannerPalette(identity)` derives base, shade, text, accent, card and outline colours from the profile and picks text and accent colours by contrast (≥ 4.5:1 for text, ≥ 3:1 for the large accent headline). Without `palette` the renderer keeps today's constants, so package tests and earlier fixtures stay byte-identical. The API always passes the profile palette.
3. Deterministic brand-tone check `brandToneCheck(imageBytes, identity)` in `packages/creative`: mean luminance and palette coverage of the generated background against the brand's base tone. A dark image for a light brand, or the reverse, is `mismatch`. The result is stored on each composed banner (`brandCheck`). The review then reports `BANNER_BRAND_MISMATCH`, which leaves the draft for the owner and is never agent-approved.
4. Tool and card copy no longer name the uLiquid style as the default.

Effect on uLiquid: its banners follow its own brand kit, which is dark navy and cyan per profile v3. This intentionally departs from CS-D3 ("frozen byte for byte"), because the task asks for every project's style to come from its profile. To keep the earlier glass-card motif, it belongs in uLiquid's imagery or banner style notes (data, owner action).

### B. Draft decisions in the existing marketing approval flow

No new approval system. The decisions extend the marketing content lifecycle that the approvals page already shows. The ActionRequest inbox keeps Approve and Reject unchanged.

1. `pipeline/content-decisions.ts` (new): one function `decideDraft(tx, scope, contentId, {decision, version, reason?})`, owner only (`PROJECT_OWN`):
   - `reject`: the draft becomes `rejected`, with `ownerDecision {action, by, at, reason?}`. The reason is stored on the content; the audit record only notes whether there is one.
   - `discard`: the draft becomes `archived`, with the archive fields the draft cleanup uses (`statusBeforeArchive`, `archivedAt`, `archivedBy`, `archiveReason: "OWNER_DISCARDED"`), so history is kept.
   - `archive`: removes a decided or expired item from the active overview (`ownerDecision.hiddenAt`). An expired, never-released draft becomes `archived` with `archiveReason: "SLOT_PASSED"`.
   - Refused with a 409 while an active publication or Postiz draft exists (`DRAFT_HAS_PUBLICATION`; use "Stop" there) or when the status does not allow it (`DRAFT_NOT_DECIDABLE`). Calling again with the same decision is idempotent.
   - An assignment draft frees its run slot (`releasedAt`, `releaseReason: "OWNER_REJECTED"` or `"OWNER_DISCARDED"`). It then no longer counts toward the review backlog.
   - Audit events: `content.owner_rejected`, `content.owner_discarded`, `content.owner_archived`. No hard delete: audit and approval history must stay.
2. Routes:
   - `POST /api/projects/:projectId/assignment-drafts/:id/{reject,discard,archive}` (owner, Orbit Agents on);
   - marketing actions `reject-content`, `discard-content` and `archive-content` (owner) for the content detail.
3. Closed content stays closed:
   - `reviewContent` and `approve` refuse `rejected` and `archived` content (`CONTENT_CLOSED`);
   - preflight adds the blocker `CONTENT_CLOSED`, which also covers handoff, Postiz drafts and Social.
4. No late catch-up: `releaseAssignmentDraft` refuses with `SLOT_PASSED` when the planned slot has passed. A taken slot that is still ahead still moves to the next free slot of the same day.
5. `GET assignment-drafts` returns:
   - `items`: pending drafts (`state: "pending"`) and drafts whose slot passed in the last 14 days (`state: "expired"`);
   - `history`: owner decisions of the last 30 days (`released`, `rejected`, `archived`), without hidden ones.

   Attention and agent activity keep counting pending drafts only.

### C. Approvals page (mobile first)

- Every draft card shows a status badge: Ausstehend, Abgelaufen, Freigegeben, Abgelehnt or Archiviert.
- Card actions:
  - pending: Freigeben, Ablehnen, Verwerfen;
  - expired: Ablehnen, Archivieren;
  - history: Archivieren (remove from the overview).
- On narrow screens the buttons wrap to full width. Nothing is hidden by overflow.
- Ablehnen opens a dialog with an optional reason. Verwerfen asks for confirmation. There is no permanent delete.
- Members who are not owners see the buttons disabled, with the reason ("Nur Owner können …"), not missing buttons.
- The content detail gets Ablehnen and Verwerfen for owners, disabled with a note for others.
- The approvals page links to "App-Freigaben" (requests of other modules).

## Tests

- Unit tests:
  - banner prompt from the brand kit (light and dark kits, no uLiquid wording, style notes kept);
  - palette derivation and contrast;
  - renderer without a palette is unchanged, with a palette uses it;
  - brand-tone check: a dark image for a light kit is a mismatch, for a dark kit it passes.
- Integration tests:
  - reject, discard and archive (owner only, non-owner 403, version conflict, idempotent);
  - a rejected draft cannot be released, reviewed, approved or published;
  - late release refused (`SLOT_PASSED`);
  - list states and history;
  - the review backlog is freed;
  - FamilyPlan and uLiquid banners each use their own palette and assets.
- Web unit tests: draft list actions per state and role, the reject dialog, the discard confirmation.
- Existing approval tests (ActionRequests, social, support) run unchanged.
- Mobile check in the browser at 375 px.

## Rollback

Revert the commit. There is no migration and no flag. Rejected and archived drafts written meanwhile keep their status, and old code treats them as settled.
