# FamilyPlan marketing readiness (P3): preparation

Status: **applied 2026-10-26 with Mario's decisions**: Postiz write verification deferred, Matomo skipped for now, the two PNGs imported and approved (logo `004c5c80`, icon `69b34bd7`; Mario confirmed the usage rights), the logo set in marketing profile version 4 (only `visualIdentity.logoAssetId` changed), and the four project links set. Correction: the project links were not empty before; there were three, and the website link lacked the trailing slash of its verified fact, so the profile editor treated it as unverified. Project `118371ad-5f28-4397-9cef-877cbb1ffbe1`.

## 1. Current state

| Item | State |
|---|---|
| Readiness blockers | Only `PUBLISHER_WRITE_VERIFICATION_REQUIRED` (RAG check passed, generation 3 active) |
| Postiz | Workspace connection "Postiz", read verified; FamilyPlan channels Facebook „FamilyPlan" and Instagram „FamilyPlan", both assigned and allowed by the active policy (`assisted`, monthly budget 10 USD); not write verified |
| Matomo | No Matomo connection for FamilyPlan and none in the organization. familyplan.cloud has **no tracking at all** (no Matomo, no other analytics). The only Matomo instance in use is uLiquid's (`analytics.uliquid.vip`, site 1) |
| Google Drive | Connected; brand folder with 6 images, all on a white background (none transparent) |
| Assets in Orbit | 0 (no approved logo, so no logo in banners and no image for the Instagram test) |
| Project links | Three (website without trailing slash, web app, App Store); the marketing profile v3 has 4 official links backed by verified facts |

## 2. Postiz write verification

**What it does.** Orbit's write verification (`postiz-test-prepare` → `postiz-test-execute` → `postiz-test-reconcile`, owner, Marketing → Connections) publishes **one real post immediately** on one channel, text `EDS Orbit connection verification. Test reference: <id>.`, optionally with an approved PNG. Only after Postiz reports it `PUBLISHED` does that channel count as write verified. Orbit never deletes it: remove it afterwards in Postiz or on the platform. Instagram does not accept a post without an image, so the Instagram test needs an approved PNG asset (section 4).

**Is it needed now?** Not for the first organic test phase. Marketing drafts handed to Postiz as drafts (`postiz_draft`) need only assigned channels and `ENABLE_POSTIZ_DRAFTS`; you then publish or schedule them yourself in Postiz. Write verification is required only when Orbit itself should publish or schedule (`postiz_live`/`postiz_schedule`), and only then does the readiness blocker clear.

**Options**
- A (recommended): defer it. Run the first test phase as Postiz drafts; the blocker stays and blocks nothing you need.
- B: verify Facebook only now (text post, delete it right after).
- C: verify both (Instagram with the approved logo PNG, then delete both test posts).

Each test post is a separate explicit approval of the exact package (channel, text, image) at execution time.

## 3. Matomo

Matomo would measure visits from social posts to familyplan.cloud. That needs three things that do not exist yet:
1. A Matomo site for familyplan.cloud. Either a new site in the existing instance (`analytics.uliquid.vip`, a uLiquid host; a separate site keeps the data apart) or a separate EDS instance.
2. Tracking code on familyplan.cloud. This is a privacy decision: FamilyPlan addresses families and children. Recommended configuration if you want it: cookieless (`disableCookies`), IP anonymization, no user IDs, honour Do Not Track, and the privacy policy updated. Without cookies no consent banner is legally needed in most setups, but your privacy review decides.
3. In Orbit: a Matomo connection (URL, token with view access to that site only, site id), granted to FamilyPlan, then the read check.

**Options**
- A (recommended): skip Matomo for the first test phase. Measure with UTM links and the Postiz/platform statistics; decide on website tracking separately.
- B: set it up now (steps 1–3); steps 1–2 are yours (website and privacy), step 3 I can prepare.

## 4. Image assets from Drive

Brand folder files:

| File | What it is | Size | Proposal |
|---|---|---|---|
| `F85009E9-….PNG` | Wide logo (family in a calendar card + "FamilyPlan") | 1672×941 | **Import as `logo`, approve** |
| `8A03C823-….PNG` | App icon (square, wordmark below) | 1254×1254 | **Import as `icon`, approve** |
| `familyplan-logo-wide.jpg` / `.webp` / `-460.webp` | Smaller copies of the wide logo | 1280×720 / 460×259 | Not needed |
| `familyplan-app-icon.jpg` | JPG copy of the app icon | 1254×1254 | Not needed |

Steps: import (owner, "Import from Drive") → approve with the usage-rights confirmation (`asset-status`, owner: you confirm FamilyPlan owns the rights) → set the logo as `visualIdentity.logoAssetId` in the marketing profile (profile version 4). The logos sit on a white card; on light banner backgrounds (`#F5F8FC`) that fits. For dark backgrounds a transparent version would be needed, which I can derive from the PNG on request (as for uLiquid).

## 5. Project links

The marketing profile editor offers official links only from the project links (Settings → Project) and matches them to verified facts by exact URL; the Android test link was missing there and the website link did not match its fact. Proposed project links (types per `packages/schemas/src/project-settings.ts`):

| Type | Label | URL |
|---|---|---|
| `website` | Website | https://familyplan.cloud/ |
| `app_store` | App Store | https://apps.apple.com/us/app/familyplan-organizer/id6773054991 |
| `web_app` | Web-Beta | https://familyplan.cloud/app/ |
| `custom` | Android-Test | https://familyplan.cloud/android-beta-test/ |

`google_play` is not possible for the Android test link (it must point to play.google.com). Facebook and Instagram page URLs can be added once you name them.

## 6. Decisions for Mario

1. Postiz write verification: A (defer), B (Facebook only) or C (both)?
2. Matomo: A (skip for now) or B (set up)?
3. Import and approve the two PNGs (logo, app icon) and set the logo in the profile? This includes your usage-rights confirmation.
4. Set the four project links as listed?
