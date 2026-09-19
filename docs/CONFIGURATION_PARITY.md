# Configuration parity acceptance

## Scope

This local, forward-only change adds a versioned uLiquid marketing profile and campaign-bound content workflow. It does not deploy, publish, configure provider credentials, spend a budget, or mutate existing operational records.

## Local acceptance matrix

| Area               | Contract                                                                                                                             | Evidence / status                                                                              |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| Profile            | One active owner-managed profile plus immutable versions                                                                             | `ProjectMarketingProfile` and `ProjectMarketingProfileVersion`; API role check and audit event |
| Campaigns          | Product and presale are exclusive; new campaigns bind the active profile version                                                     | `assertCampaignContext`; mission schema and campaign builder                                   |
| Content            | New manual content needs a mission, matching campaign metadata and public evidence                                                   | `assertContentCampaignContext`; content editor                                                 |
| Guardrails         | Verified facts/official URLs, one primary CTA, prohibited financial/urgency language and presale-live fact gate                      | `profileGuardrailProblems`, review and publication preflight                                   |
| Sources and assets | Sources remain references; only assets with owner-set `approved` status attach to publishable content                                | profile validation and `asset-status` action                                                   |
| Change impact      | Only content of the replaced profile version is changed to `needs_review`; derived approvals/publications are blocked                | `saveMarketingProfile`, `content-invalidation`                                                 |
| UI                 | Configuration shows Profile, Strategy, Brand & voice, Official links, Sources & assets, Campaign rules, and Automation/notifications | `MarketingProfileConfiguration`                                                                |
| Visual identity    | Owner-managed palette, bounded local font presets, design rules and an approved selected logo                                        | `marketingProfile.visualIdentity`; `MarketingProfileConfiguration`                             |
| Asset library      | Owner upload, protected project preview, provenance/rights metadata, explicit approval or outdated state                             | `assets.ts`; `BrandAssetLibrary`; `asset-status` audit                                         |
| Image generation   | Optional GPT Image 2.5 with shared or dedicated encrypted UI key, model/cost/budget/prompt gates, reference-first output             | `image-generation.ts`; `generateImage`; OpenAI configuration UI                                |

## Compatibility and rollback

The Prisma migration creates new tables only. It does not update generic entity records. Application rollback leaves profile tables and audit history intact; no destructive schema reversal is part of this change.

## Separate approval gates

The following are intentionally not implementation evidence for this local configuration work: an OpenAI credential or real image/text call and approved paid test budget; verified Postiz and Telegram capability tests; Matomo and Slack provider tests; off-host backup and independent alert proof; production migration/deployment; and publication authority. Telegram remains a preference, not a verified connector, until its capability test is completed.
