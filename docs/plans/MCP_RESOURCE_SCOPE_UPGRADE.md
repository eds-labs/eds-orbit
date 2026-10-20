# MCP persisted resource scope upgrade

Risk: high; production OAuth resource configuration repair through the existing authorized main/Coolify workflow. No table/schema migration, secret, new dependency, customer write or paid provider call.

## Evidence and plan

The actual failing ChatGPT authorization asks for `openid email offline_access orbit:propose orbit:read orbit:support`. Better Auth additionally intersects these scopes with the persisted OAuthResource.allowedScopes. Its default resourceSeedMode is insertOnly, so redeploying new source scope declarations never updates the older resource row. Fresh-resource tests did not exercise upgrades from the original resource policy. The previous wire-descriptor changes do not repair this persisted ceiling.

1. Reproduce using a unique synthetic pre-existing resource with legacy scopes, preserving its disabled flag, TTL and custom claims.
2. Set the supported Better Auth resourceSeedMode to merge. Only the configured canonical Orbit resource and its explicitly configured allowedScopes are managed; preserve unspecified disabled/DPoP/signing/TTL/admin fields and all other resources.
3. Verify actual OAuth code exchange, effective profile scopes and refresh/ticket reads on the upgraded fixture. Unconsented/narrow tokens, foreign projects and revoked/disabled resources remain refused.
4. Run targeted security/OAuth regressions and standard project checks; deliver and verify exact deployment. Resume the existing read-only ChatGPT ticket request through its ordinary reauthorization. No new recipient/project permission is granted.

## Operations / rollback

This changes the existing resource's configured scope ceiling on startup, not any user's granted or token scopes. Explicit consent and token/grant intersection remain mandatory. No direct production DB access or permission bypass. Because the permitted resource configuration is persisted, a code rollback alone does not revert the ceiling: revert with an explicit prior allowedScopes configuration using merge and redeploy, or apply an operator-approved resource policy rollback through the supported admin API. Do not delete the resource or grants. Access remains guarded by active consent, role, tenant, module and feature checks. Monitor readiness and actual ticket list/timeline separately. Backups are not modified; there is no destructive data operation.
