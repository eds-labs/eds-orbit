# Project configuration over MCP and campaign-type-aware fields

Status: requested by Mario on 2026-10-23 and implemented locally on branch `claude/project-config-mcp`. This is the plan as it was carried out.

## Findings

- **Where the configuration lives.** It has two parts:
  - **Project settings** (`Project` row: name, timezone, content languages, links). Owners edit them through the `project-settings` action. They have no version number.
  - **Marketing profile** (`ProjectMarketingProfile`): versioned, with a history table. Saving it is a full replace through `saveMarketingProfile`, owners only. The save sets dependent drafts (`content` of the previous profile version) to `needs_review` and invalidates them.
- **The presale field.** `presaleStrategy` was required in the shared zod schema, so every project had to fill it, FamilyPlan included. Campaigns already distinguish `product` and `presale`.
- **MCP building blocks:**
  - `readOperation` / `approvedOperation` (`platform/tasks/operation-tools.ts`).
  - Owner approval through action requests: idempotency key, 24 h expiry, revalidation at approval.
  - Scopes follow the tool risk: reads need `orbit:read`, proposals need `orbit:propose`.
  - No MCP tool exposed or changed the configuration.
- **Gaps in the building blocks:**
  - Operation tools were gated by `ORBIT_MCP_TASKS`, the delegated work orders flag.
  - Action requests required an active marketing policy, which a project without marketing automation lacks.
  - Platform-owned operations failed the module activation check.

## Design

1. **Campaign types (generic).**
   - The profile gains `campaignTypes` (`product`, `presale`). A field is required exactly when an enabled type uses it: `productStrategy` for `product`, `presaleStrategy` for `presale`.
   - Profiles without the list keep what they could do: presale is enabled when a presale strategy is stored (uLiquid), otherwise product only. No data migration is needed.
   - Campaigns of a type the profile does not enable are refused (`CAMPAIGN_TYPE_NOT_ENABLED`).
   - The rule lives once, in `packages/schemas`, and serves the API, MCP and the form. It contains no project-specific case.
2. **Configuration sections.** Modules contribute `configurationSections`, each with read, validate and apply.
   - The platform contributes `project`, which is read-only over MCP.
   - Marketing contributes `marketing`, the editable profile.
   - The configuration version is the sum of the section versions. Every write raises it, so it serves as the optimistic lock (`expectedVersion`).
3. **MCP tools (platform-owned, so the names stay exact).**
   - `project_configuration_get` (`orbit:read`): all sections, the version, and each field marked `required`/`optional`/`not_used` plus editable. Never secrets.
   - `project_configuration_update` (`orbit:propose`, owners): takes `expectedVersion`, `changes` per section (partial; nested `visualIdentity` is merged) and `idempotencyKey`.
     - It is validated when proposed, saved as an owner approval request, and revalidated (version and schema) at approval.
     - It is then applied through the existing save path, which creates a new version, writes the history and audit, and invalidates dependent drafts.
   - New flag `ORBIT_MCP_PROJECT_CONFIGURATION` (default off) makes both tools visible. The update additionally needs the existing `ORBIT_MCP_PROPOSALS`.
   - Action types may declare that they need no marketing policy. The configuration change spends nothing.
4. **Web.**
   - Campaign types are a control in the profile form, which shows a strategy field only for the enabled types.
   - Presale campaign options appear only when presale is enabled.
   - The form sends the version it edited; a change made in the meantime (for example over MCP) gives a clear conflict message instead of being overwritten.
   - All texts go through the existing en/de text maps.

## Out of scope

- Changing project settings (name, languages, links) over MCP. They are readable; editing stays in Orbit. Reason: no version number, and the save path writes the control plane.
- Turning flags on in production; that needs separate approval.
