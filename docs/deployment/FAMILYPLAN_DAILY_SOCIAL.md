# FamilyPlan: daily social automation on assignments

Design: [superpowers/specs/2026-11-07-daily-social-automation-design.md](../superpowers/specs/2026-11-07-daily-social-automation-design.md). Project `118371ad-5f28-4397-9cef-877cbb1ffbe1` (see [FAMILYPLAN_MARKETING_SETUP.md](FAMILYPLAN_MARKETING_SETUP.md)).

Orbit prepares one German Facebook and Instagram post with an AI image every day. The owner releases it in Marketing → Freigaben, the native Social module publishes it at 18:30 Europe/Berlin, and per-platform status and permalinks show in the assignment detail (`?assignment=<id>` on the Marketing assignments page). The code is on branch `claude/familyplan-social-media-automation-d7ff4e`; nothing below has been deployed or executed in production. No schema change, no migration, no schema hash.

Behaviour rules built for this flow:

- An owner release at or after the run slot is refused with `SLOT_EXPIRED` (409), for every delivery. Agent-approved drafts past their slot are dropped. The slot is never moved to a later time.
- A Marketing publication whose job runs more than 30 minutes after its slot becomes `blocked_dependency` with `SLOT_EXPIRED` and is never handed to Social.
- Social never sends a post more than 30 minutes after the Marketing slot (`SOCIAL_SLOT_EXPIRED`, never retried), including after throttle waits and retries. The limit counts from the slot, not from the hand-off: a post handed over at 18:50 must still go out by 19:00.
- A failed image leaves the run `partial`: no review, nothing delivered. The owner can retry the run at least 60 minutes before the open slot.
- Meta crossposting is not part of Orbit (see "Meta crossposting check").

## Rollout

Every step needs Mario's explicit approval. Nothing here is done by merging.

### Step 1. Push to `main` (deploy)

Integrate current `origin/main`, push the fast-forward. No migration. Check the Coolify deployment finished and the app is healthy.

### Step 2. Profile: Creative brand kit

Edit the FamilyPlan marketing profile: Creative brand kit (imagery kind, mood, subjects, avoid list; the approved raster logo already exists) and `visualIdentity.creative.enabled`. A profile save invalidates content prepared under the old profile version.

### Step 3. Extend policy and AI spend authority

The marketing policy `endAt` and the AI spend authority `endAt` are both 2026-11-19. Extend both before that date (see "Policy and spend authority extension"). Nothing extends automatically.

### Step 4. Meta crossposting check

Mario verifies the Meta settings (see "Meta crossposting check") before the first real post.

### Step 5. Policy channels and assignment switch

Add the two native accounts to the policy channels as `social:<accountId>` references (lowercase). The project's `publishingBackend` must be `social`; on a Postiz project they are refused with `SOCIAL_CHANNEL_REQUIRES_SOCIAL_BACKEND`. Account ids are listed by `marketing_policy_get` (options) or the assistant; the policy editor is free text, there is no picker. Then reconfigure the assignment `6766a12d` ("FamilyPlan Testwoche") through the confirmation card (assistant chat or MCP). Mario confirms. Older `needs_review` drafts of the test week are withdrawn by the confirmation.

Card values:

| Field | Value |
|---|---|
| times | `["18:30"]` (Europe/Berlin) |
| leadMinutes | `630` (run starts 08:00) |
| delivery | `publish` |
| approvalMode | `human_each` |
| creative | `{ artPer: "run" }` |
| sharedAcrossChannels | `true` (one content package: the same text and the same image on Facebook and Instagram) |
| historyDays | `30` |
| channels | `social:<facebook-account-id>`, `social:<instagram-account-id>` |
| topic frame | See below; the topic list lives in `topicFrame` and the profile, never in code |
| budget | Monthly cap fitting one image plus text per day |

With `sharedAcrossChannels: true` the run writes one text for the slot on the strictest channel (Instagram), the review judges it once, and the draft is copied for Facebook with the same rendition: both platforms get the same 1080x1350 image, Social stores it as one library asset (same sha256) and both posts reference it. Each platform still has its own draft, release, publication, status and permalink. Without it, each platform gets its own caption and its own rendition, which Social stores as separate assets.

Topic frame (theme names are German because they are content):

- Audience: Eltern mit Kindern, insbesondere Schulkindern, im DACH-Raum.
- Primary themes: Familienkalender und gemeinsame Terminorganisation; Aufgaben für Kinder mit Punkten und Belohnungen; Schule, Stundenpläne und Schulalltag; Einkaufslisten und gemeinsames Einkaufen; Essensplanung und Rezepte; Familienorganisation und weniger Alltagsstress.
- Secondary themes: Budgetverwaltung; Familienchat; Freiwillige Standortfreigabe; KI-Unterstützung, only where the features are demonstrably available.
- Constraints: vary topics and avoid repeats; claims must match the actually available FamilyPlan features; no invented features, prices, ratings or usage numbers; the existing marketing strategy and project knowledge take precedence over this list.

### Step 6. First day

At 08:00 the run is created. Mario checks the preview in the assignment detail and in Freigaben. Releasing each draft before 18:30 is the first real post and is a separate approval. After 18:30 a release answers `SLOT_EXPIRED`.

## Modes

| Mode | Setup | Notes |
|---|---|---|
| Manual | No assignment | The owner composes posts in Social |
| With approval (this rollout) | Assignment with `approvalMode: human_each` | Owner releases each draft; the release binds the exact package hash |
| Fully automatic | `delegated_review` plus agent review authority (owner confirmation, `ORBIT_AGENT_REVIEW_AUTHORITY`) | Creatives stay owner-gated (CS-D7). Not part of this rollout |

## Meta crossposting check

Orbit does not crosspost. Mario checks in Meta that Instagram's "share to Facebook" and the Business Suite crossposting settings are off for the FamilyPlan Page and Instagram account. Otherwise Facebook would get the Instagram post a second time.

## Policy and spend authority extension

Before 2026-11-19 extend the marketing policy `endAt` (Administration & settings → Modules → Marketing → Publishing rules) and the AI spend authority `endAt` (Administration & settings → AI → Budget). Seven days ahead the owner gets the attention items `marketing_policy_expiring` and `platform_spend_authority_expiring` (counts and dates only, links to the place to extend). After expiry there are no slots and paid calls fail with `PAID_MANDATE_EXPIRED`.

## Rollback

- Pause the assignment, or set its delivery back to `postiz_draft` (Social drafts only).
- Code: revert the commits of the branch; there is no schema change.
- A post that already went out is not retracted by Orbit.
