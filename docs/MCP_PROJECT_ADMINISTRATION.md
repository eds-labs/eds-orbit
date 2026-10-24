# Project administration over MCP

Requested by Mario on 2026-10-24. External assistants (ChatGPT over the Orbit MCP gateway, or the Orbit Assistant) can set up a project's Marketing policy, AI models, integrations and knowledge quality gate, and read its readiness. FamilyPlan is the first project; nothing in the code is specific to it.

These tools extend [project configuration over MCP](MCP_PROJECT_CONFIGURATION.md) and use the same building blocks:

- **Reads** run with `orbit:read`.
- **Changes** are proposals (`orbit:propose`) that an owner approves in Orbit → Decisions.
- **Approval** runs each change through the existing service, the same one Orbit's settings use. No logic is duplicated.

## Tools

| Tool | Scope | Who | Module | Effect |
|---|---|---|---|---|
| `marketing_policy_get` | `orbit:read` | members | marketing | Reads the active policy with its version, approval mode, budgets in micros and USD, posting limits, quiet hours and allowed origins, plus the assignable Postiz channels, the content types and the deployment's publishing switches. |
| `marketing_policy_update` | `orbit:propose` | owners | marketing | Proposes a policy change. |
| `ai_models_get` | `orbit:read` | members | platform | Reads the AI configuration: global profiles, key presence and source (never the key), the project's own selection, the effective verified models with price status, routes, image settings, provider budgets, checks and selectable models. |
| `ai_models_update` | `orbit:propose` | owners | platform | Proposes the project's model selection. |
| `integrations_get` | `orbit:read` | members | marketing | Reads Postiz, Matomo and Google Drive: status, channels (assigned, write-verified, posting time), Matomo site, Drive connection and root, granted central connections, and for organization owners the central Postiz channels that are free to assign. |
| `integrations_configure` | `orbit:propose` | owners | marketing | Proposes an integration change. |
| `integration_verify` | `orbit:read` | owners | marketing | Runs a provider's read-only check (Postiz, Matomo or Drive) and records the verified state. Publishes nothing. |
| `knowledge_evaluation_get` | `orbit:read` | members | knowledge | Reads the live RAG gate: valid or not and why, index generations with embedding coverage and metrics (recall@10, MRR, forbidden hits, missed cases), runs, sources missing from search, requirements and paid mandate. |
| `knowledge_evaluate` | `orbit:propose` | owners | knowledge | Proposes one step of the official live evaluation. |
| `project_readiness_get` | `orbit:read` | members | marketing | Reads every action's state and each blocker with code, cause, affected actions, fix, resolution, the tools that fix it and its check status. |

`integration_verify` is a read: a check only reads from the provider and records what it can do. It still needs the owner role, the same role as the `connector-health` action in Orbit.

### `marketing_policy_update`

```json
{ "expectedVersion": 0, "changes": { "mode": "assisted", "channels": ["…"], "contentTypes": ["social"], "allowedOrigins": ["https://…"], "startAt": "…", "endAt": "…", "maxPerDay": 2, "minIntervalMinutes": 60, "dailyBudgetMicros": 1000000, "monthlyBudgetMicros": 10000000, "perRunBudgetMicros": 500000, "approvedPaidTests": true }, "idempotencyKey": "…" }
```

- **Version.** `expectedVersion` is `version` from `marketing_policy_get`: the sum of the stored policy records' versions. Every save raises it.
- **Changes.** `changes` lists only the fields to change. A project without a policy proposes all required fields. `null` clears the quiet hours.
- **Mode.** Only `observe` or `assisted` (approval mode `human_each`: every post needs the owner's approval of its exact package). Over MCP the merged policy is never `autopilot` (`MCP_AUTOPILOT_NOT_ALLOWED`); a project on autopilot changes over MCP only by moving to `assisted`.
- **Channels.** Only Postiz channels assigned to the project (`POSTIZ_CHANNEL_NOT_ASSIGNED`).
- **Saving.** The save path is the policy form's. The new record replaces the active one, and the project's mode follows. Approvals of packages made under the old policy must be given again.
- **No policy needed.** The proposal does not need an active policy; it may be the project's first.

### `ai_models_update`

```json
{ "expectedVersion": 0, "changes": { "verifiedModels": ["…"], "modelRoutes": { "fast": "…", "standard": "…", "quality": "…", "escalation": "…" }, "taskRoutes": { }, "imageGeneration": { "model": "gpt-image-…", "maxCostMicrosPerImage": 40000, "pricingVerifiedAt": "…" }, "defaultProvider": "openai", "anthropicTierRoutes": null, "providerBudgets": { }, "fallback": { "onProviderBudgetStop": "none" } }, "idempotencyKey": "…" }
```

- **Version.** `expectedVersion` is the version of the project's own AI configuration; it is 0 while the project uses only the global settings.
- **Global and project settings stay apart.**
  - Providers, keys and the system and organization AI profiles are global, managed in the administration.
  - The project selects among them. A project without its own settings starts from what it uses now.
  - From then on, the project's settings override the profile's fields for this project.
- **Verified models only.** A model must already be verified in the effective configuration or listed in the reviewed Anthropic catalog (`MODEL_NOT_VERIFIED:<model>`).
- **Prices.** Text and embedding prices come from the configured rate cards or that catalog, never from the request. Routed models need a price (`MODEL_PRICE_NOT_VERIFIED:<model>`).
- **Image ceiling.** The per-image cost ceiling and its price verification date are the owner's own values. The request proposes them, and the approval shows them.
- **The forms' validation** runs as well, for example `ROUTED_MODEL_NOT_VERIFIED` and `IMAGE_MODEL_NOT_VERIFIED`.
- **No keys.** The tool takes no key. A project may start its own settings only when a granted central connection supplies its OpenAI key and no environment image key is in use (`AI_KEY_SETUP_REQUIRED`); otherwise the settings would replace the environment keys. A first save also writes the provider fields as shown, so the profile's default provider and model registry are kept. A missing key is added in Orbit (Administration → Connections, or Settings → AI).
- **Budgets.** Provider budgets can change only with the owner's approval of the exact amounts.

### `integrations_configure`

| `action` | Fields | Effect |
|---|---|---|
| `postiz_claim_channels` | `connectionId`, `channelIds` | Gives free channels of the organization's Postiz connection to this project. The project's binding is created when needed and mirrors its channels. Proposer must be an organization owner or system administrator (`ORGANIZATION_OWNER_REQUIRED`). Another project's channel is never taken (`CHANNEL_ASSIGNED_ELSEWHERE`). Needs `ORBIT_CONNECTIONS_CUTOVER` to include `postiz`. |
| `postiz_assign_channels` | `connectorId`, `expectedVersion`, `channelIds`, optional `postingTimes` (`[{channelId, time}]`) | Sets the channels of the project's own Postiz connection, through the same path as Orbit's channel dialog. Posting times must belong to assigned channels; X long posts stay only for accounts that stay assigned (both shown in the change). A bound connection's channels come from its organization (`USE_POSTIZ_CLAIM_CHANNELS`). |
| `attach_connection` | `connectionId`, optional `siteId` | Binds a central connection granted to the project (Matomo with its site, for example), like `connector-attach`. |
| `matomo_site` | `connectorId`, `expectedVersion`, `siteId` | Changes the Matomo site; the connection then needs a new read check. |

No action takes a credential.

### `knowledge_evaluate`

The steps, in order:

1. **`begin_index`** (optional `profile`): a new index generation from the current corpus. Free.
2. **`build_index`** (`indexId`): the paid embedding build.
3. **`evaluate`** (`indexId`, `datasetVersion`, 60 to 120 `cases`, `confirmQueriesMayBeSentToOpenAI: true`): the paid live evaluation. At least 48 cases need `expectedChunkIds`, and at least 12 negatives `forbiddenChunkIds` only (`EVALUATION_CASE_COVERAGE_REQUIRED`).
4. **`activate`** (`indexId`): only an index whose live evaluation passed (`INDEX_NOT_EVALUATED`).

- **Costs.** The proposal carries the estimated provider cost as its ceiling. The paid steps run under the active policy's paid mandate.
- **When the gate opens.** `LIVE_RAG_EVAL_REQUIRED` clears only when all of these hold:
  - the active index's evaluation is live and passed (recall@10 at least 0.9, no forbidden hit);
  - it is less than 30 days old and was made against the unchanged corpus;
  - it has settled build and evaluation receipts.

### `project_readiness_get`

Each blocker has these fields:

- `code`, `cause`, `fix`;
- `affects`: the actions it stops;
- `resolution`, one of:
  - `mcp`: a tool here fixes it with approval;
  - `orbit`: an owner step MCP cannot take, such as Google consent or a real test post;
  - `administration`;
  - `operator`: a deployment switch;
  - `unavailable`;
- `automatable` and `tools`: whether a tool can fix it, and which;
- `check`;
- `details`: the evaluation's reasons, for `LIVE_RAG_EVAL_REQUIRED`.

The tool never changes a check. A blocker clears only when its own check passes.

## Approval and safety

- **Exact approvals.** Every proposal stores the exact settings it changes (`approvalContext.changes`, `[{setting, from, to}]`); Orbit → Decisions shows them. At approval the change is computed again; if it would now differ, the approval is refused (`PROPOSED_CHANGE_OUTDATED`). Version conflicts are refused at proposal and at approval.
- **Idempotency.** A retry with the same `idempotencyKey` returns the same request (`deduplicated: true`) and never applies twice. The same key with other arguments is refused (`IDEMPOTENCY_KEY_CONFLICT`).
- **Permissions.** The usual checks apply: the grant's projects and modules, the member's current role, module activation, the feature flags and `ORBIT_MCP_PROPOSALS`. Changes need the project owner role; the approval is decided by an owner in Orbit.
- **Audit.** Every applied change writes the audit entry of its service (`policies.create`, `openai_configuration.update`, `connector.attached`, `connector.channels_assigned`, `postiz.channels_assigned`, `matomo.site_changed`, the knowledge index events) and `mcp.operation.executed`.
- **Secrets.** No response contains a key, token or encrypted value.
- **Nothing publishes.** No tool publishes, schedules or turns on autopilot. A Postiz write verification posts a real test post, so it stays an explicit owner step in Orbit (Marketing → Connections). `EXTERNAL_WRITES_DISABLED`, `EXECUTION_MODE_TEST` and `POSTIZ_DRAFTS_DISABLED` are deployment switches.

## Changed services

- **Policy save.** The policy save moved from `server.ts` into `marketing/policy/policy-admin.ts` (`savePolicy`). The policy form and MCP share it.
- **Readiness.** It now uses the effective AI configuration (`effectiveAiStatus`), so central profiles and granted keys count. If a stored key cannot be opened, it falls back to the project's own presence flags. A project on central keys no longer reports `VERIFIED_OPENAI_MODELS_REQUIRED` or image blockers wrongly. Channels of a bound Postiz connection count as assigned, which clears a wrong `POSTIZ_CHANNELS_NOT_ASSIGNED`.
- **Connections.** `connector-attach` and `connector-health` moved into `platform/connections/project-connections.ts`, without change.
- **Channel assignment.** `channel-assignment.ts` gains `organizationActor`, `projectChannelOptions` and `grantChannelsToProject`. The last widens one project's grant under the connection's lock and then mirrors it. The grant commits first, so a failure after it leaves the channels in the grant but not yet in the project; approving again completes it.
- **Postiz channels.** `assignedSocialChannels` (Postiz) lists the channels a policy may use.
- **Index build.** `queueIndexBuild` (knowledge) is shared by the `build-index` action and MCP.
- **Key requirement.** `saveOpenAiConfiguration` accepts a project without its own key when a granted connection supplies it (`grantedKey`).

## Switches and rollout

- **`ORBIT_MCP_PROJECT_ADMINISTRATION=true`** lists the tools; it is off by default. The proposal tools also need `ORBIT_MCP_PROPOSALS=true`.
- **Central connections:**
  - Postiz channel assignment and binding need `ORBIT_CONNECTIONS=true` and `ORBIT_CONNECTIONS_CUTOVER` including `postiz`.
  - A Matomo binding needs `matomo` in it.
- **Client scope.** The MCP client needs `orbit:propose` for proposals.
- **No migration.** No schema change.

## Limits

- **Google Drive.** Connecting Drive needs the owner's Google consent in a browser (Orbit → Settings → Integrations); a folder named like the project becomes the root on connect. Choosing another root also stays in Orbit: it calls Google inside its own transactions, which an approval cannot run.
- **Postiz write verification** stays in Orbit (a real test post). Without it, `postiz_live`/`postiz_schedule` stay blocked by design; `postiz_draft` needs only assigned channels and `ENABLE_POSTIZ_DRAFTS`.
- **Live RAG evaluation.** The client must supply 60 to 120 evaluation cases with chunk ids. `knowledge_evaluation_get` and the knowledge search tools provide them. Building and evaluating cost money under the policy's paid budget.
- **Granting central connections.** Grants of AI keys or Matomo to a project, and AI profiles, stay in the administration. MCP binds only what is granted, and hands out free Postiz channels to organization owners.
