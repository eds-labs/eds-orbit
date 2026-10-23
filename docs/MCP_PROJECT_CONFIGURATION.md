# Project configuration over MCP

The plan and decisions are in `plans/project-configuration-mcp.md`.

## Tools

| MCP tool | Scope | Who | Effect |
|---|---|---|---|
| `project_configuration_get` | `orbit:read` | Any project member with read access | Returns every enabled section of the configuration: the version, the values, and for each field whether it is `required`, `optional` or `not_used` and whether it can be edited. Never returns credentials or keys. |
| `project_configuration_update` | `orbit:propose` | Project owners | Saves an owner approval request in Orbit; nothing changes before the approval. |

### `project_configuration_get` response

- `version`: the configuration version, the sum of the section versions. Every write raises it.
- `sections.project`: name, timezone, default and other content languages, and profile links. Read-only here; owners change them in Orbit under Settings → Project.
- `sections.marketing`: the Marketing profile, including product, audience, positioning, the product and presale strategies, voice, guardrails, CTAs, official links, visual identity and brand terms. `notes.campaignTypes` lists the campaign types the profile enables.

### `project_configuration_update` arguments

```json
{
  "projectId": "…",
  "expectedVersion": 3,
  "changes": { "marketing": { "audience": "…", "positioning": "…" } },
  "idempotencyKey": "client-chosen key"
}
```

- `changes` lists only the fields to change. The rest of the profile is kept, and `visualIdentity` is merged field by field.
- **When proposing**, the server checks:
  - the version: a different version is refused with `CONFIGURATION_VERSION_CONFLICT`;
  - the complete merged profile against the same schema the editor uses: a missing required field gives `VALIDATION_FAILED: <field>`;
  - the official links: each needs a public, verified fact that states its exact URL.
- **At approval** (Orbit → Decisions), the same checks run again. A proposal made against a version that has changed since is refused.
- **After approval**, the existing save path runs:
  - It creates a new profile version and a history row, and writes the audit entry.
  - It sends drafts of the previous profile version back to `needs_review` and invalidates them.
  - The client reads the outcome with `orbit_action_status` / `orbit_get_action_result`, or with a new `project_configuration_get`.
- **Retries:** a retry with the same `idempotencyKey` returns the same request (`deduplicated: true`) and never applies twice. The same key with different arguments is refused (`IDEMPOTENCY_KEY_CONFLICT`).
- **No policy needed:** a configuration change spends nothing, so it needs no active Marketing policy.

## Campaign-type-dependent fields

- The Marketing profile has `campaignTypes` (`product`, `presale`).
- `productStrategy` is required only for product campaigns, and `presaleStrategy` only for presale campaigns.
- **Profiles saved before this change:** presale counts as enabled exactly when a presale strategy is stored. Existing profiles keep working without a data migration.
- **Presale campaigns** in a profile that does not enable them are refused (`CAMPAIGN_TYPE_NOT_ENABLED`). The mission form offers only the enabled types.
- **Disabling presale** keeps the stored presale strategy.
- **One rule everywhere.** It lives in `packages/schemas` (`enabledCampaignTypes`, `marketingProfileRequirements`) and serves the API, MCP, the save path and the form's field visibility.

## Switches

- `ORBIT_MCP_PROJECT_CONFIGURATION=true` lists both tools. The default is off.
- The update also needs the general proposal switch, `ORBIT_MCP_PROPOSALS=true`, which lists all MCP proposal tools.
- The MCP client's connection must hold `orbit:propose`. A connection with only `orbit:read` needs to be connected again with the wider scope.

## Limits

- Project settings (name, timezone, languages, links) are readable but not editable over MCP.
- A project without a Marketing profile can create one over MCP, with all required fields in one proposal (version 0). Its official links need verified public facts first.
