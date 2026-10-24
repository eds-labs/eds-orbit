# FamilyPlan: Marketing setup over MCP

Project `118371ad-5f28-4397-9cef-877cbb1ffbe1`. The state was read live in Orbit on 2026-10-24 (read-only). The tools are described in [MCP_PROJECT_ADMINISTRATION.md](../MCP_PROJECT_ADMINISTRATION.md). Every change below is an MCP proposal that Mario approves in Orbit → Decisions. Nothing publishes.

## State on 2026-10-24

| Area | Found | Status |
|---|---|---|
| Marketing profile | Version 2 with product, audience, 90-day strategy, CTAs, official links `https://familyplan.cloud/` and the App Store | Kept, not changed |
| Policy | Version 1: `observe`, channel `knowledge`, type `script`, `maxPerDay` 0; budgets 10 USD per day, 10 USD per month, 1 USD per run; window until 2026-11-19 | Change proposed (step 1) |
| AI | Own settings: Anthropic key, default provider `anthropic`, Claude Haiku, Sonnet and Opus 5.5 verified and priced; routes for chat, social and blog drafts on Claude | Chat and text drafting ready since `f0076f00` |
| AI (OpenAI) | No OpenAI key in the project settings. They replace the deployment key, and no OpenAI connection is granted. `text-embedding-3-small` and `gpt-image-2.5-flare` are neither verified nor priced here | Manual step 2 |
| Postiz | Bound to the organization connection `b889fd5d…`, `read_verified`. Facebook `cmufs9sra0001qm87aaxugx2k` and Instagram `cmufsb4kx0003qm87rrudkj65` are assigned | `postiz_draft` ready; write verification is manual step 4 |
| Google Drive | Connected (owner account), root is the FamilyPlan folder, logo folder found automatically | `drive_save` ready |
| Matomo | No connection and no grant | Manual step 5 |
| Knowledge | 13 documents, 96 chunks (curated source `7179fa92…`, official, internal). Active index with 0 embeddings, no evaluation | Search works full-text; live evaluation is step 3 |
| Support drafts 21–22.10 | `CURRENT_PRICE_REQUIRED`: the search tried to buy a query embedding without a price or key | Fixed (full-text without embeddings); the open exception can be closed |

## 1. Policy (MCP, approval)

First `marketing_policy_get` (version 1), then `marketing_policy_update`:

```json
{
  "expectedVersion": 1,
  "changes": {
    "mode": "assisted",
    "channels": ["cmufs9sra0001qm87aaxugx2k", "cmufsb4kx0003qm87rrudkj65"],
    "contentTypes": ["social", "script", "blog"],
    "allowedOrigins": ["https://familyplan.cloud", "https://apps.apple.com"],
    "maxPerDay": 1,
    "minIntervalMinutes": 240
  },
  "idempotencyKey": "familyplan-policy-assisted-1"
}
```

- **Approval mode.** `assisted` is `human_each`: every post needs the owner's approval of its exact package. Autopilot is not settable over MCP.
- **Posting limit.** `maxPerDay` counts per channel and day. With 1, Instagram and Facebook each get at most one post a day. That fits the strategy, which plans 3 reels, 1 carousel and stories per week. A limit only bounds what may be scheduled; it does not create a post.
- **Budgets and window.** The budgets stay unchanged. The window ends on 2026-11-19, while the strategy runs November to January; extending it is a separate decision (`endAt`).

## 2. OpenAI key and models (manual, then MCP)

Embeddings, which the live RAG evaluation needs, and images need an OpenAI key for FamilyPlan. MCP never takes keys. Choose one:

- **a) Central:** Administration → Connections: create an OpenAI connection in the organization with the existing key, and grant it to FamilyPlan with purposes `text` and `image` and a monthly budget.
- **b) Project:** Orbit → FamilyPlan → Settings → AI: add the OpenAI key.

Then select the models with `ai_models_update`. `text-embedding-3-small` must be verified and priced globally (`OPENAI_VERIFIED_MODELS` / `OPENAI_RATE_CARD_JSON` in the deployment); `ai_models_get` → `candidates` shows `source: "global"` and `price: "current"`. The image ceiling (`imageGeneration.maxCostMicrosPerImage`, `pricingVerifiedAt`) needs a price checked by Mario on the official OpenAI pricing page; Orbit does not invent one.

## 3. Live RAG evaluation (MCP, approval, paid)

Dataset: `evals/knowledge/familyplan-knowledge-2026-10-24.v1.json`. Mario reviews it with the review sheet beside it.

1. `knowledge_evaluate` `begin_index`: free; snapshots the 96 chunks, whose ids the dataset uses.
2. `knowledge_evaluate` `build_index`: paid embedding of 96 chunks, within the policy budget (well under 1 USD).
3. `knowledge_evaluate` `evaluate`: with `datasetVersion` and `cases` from the file and `confirmQueriesMayBeSentToOpenAI: true`; paid query embeddings.
4. `knowledge_evaluation_get`: recall@10 must be at least 0.9 with no forbidden hit.
5. `knowledge_evaluate` `activate`: only after a passed evaluation. `LIVE_RAG_EVAL_REQUIRED` then clears.

If the corpus changes after `begin_index`, the chunk ids change and the dataset needs a new version.

## 4. Postiz write verification (manual in Orbit)

- **What it is.** The verification publishes a real test post, "EDS Orbit connection verification. Test reference: …", on the chosen channel. Facebook and Instagram are FamilyPlan's real channels, not sandbox accounts.
- **Where.** Orbit → Marketing → Connections → Postiz → "Verify sandbox write". The flow asks for confirmation that the account is a sandbox, then for confirmation of the exact text.
- **Instagram** needs an approved image (PNG) for the test post.
- **Recording.** After the post is observed as published, the connection records `writeVerifiedIntegrationIds`. `integration_verify` (target `postiz`) then shows `writeVerified: true` per channel.
- **Deployment.** The verification needs `EXECUTION_MODE=live` and `ENABLE_EXTERNAL_WRITES=true`. These are operator switches that also enable publishing.
- **Not needed for this phase.** Live publishing is not an acceptance criterion now. Drafts in Postiz (`postiz_draft`) work without a write verification.

## 5. Matomo (administration, then MCP)

1. **Grant.** Administration → Connections: grant an existing Matomo connection with read access to FamilyPlan. If none exists, create it for the existing Matomo instance with a token; no new Matomo instance is needed.
2. **Bind.** `integrations_configure` `attach_connection` with `connectionId` and the FamilyPlan `siteId`, then approve.
3. **Verify.** `integration_verify` target `matomo` with the `connectorId`; afterwards `MATOMO_READ_VERIFICATION_REQUIRED` clears.

## 6. Controlled draft (after steps 1–3)

In ChatGPT, ask the Orbit assistant or a task for one Instagram post draft. The draft stays in Orbit or as a Postiz draft, waiting for approval. Check `project_readiness_get`: `text_draft` and `postiz_draft` are ready, and `postiz_live` stays blocked.
