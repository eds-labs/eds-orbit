# Pinned Better Auth CIMD compatibility patches

These patches apply only to the pinned 1.7.10 packages. They implement the authentication-method list contract published by OpenAI while upstream https://github.com/better-auth/better-auth/issues/10660 remains unresolved. Reference: https://developers.openai.com/plugins/build/auth#client-registration.

- `@better-auth/cimd`: validates a bounded list, intersects it with the implemented public/signed methods, retains a consistent legacy preference, and requires signing keys whenever signed authentication is offered.
- `@better-auth/oauth-provider`: retains that validated top-level declaration in the existing opaque client metadata and returns a request-local client copy for an explicitly offered method on token/revocation/introspection endpoints. Managed/DCR clients and legacy singular-only CIMD documents retain their original pinned-method behavior. Nested metadata cannot declare the capability. The provider still performs every signature, assertion-replay, PKCE, resource, grant, consent and scope check.

Orbit treats changes to the method set as a security-relevant metadata change and revokes existing grants. A first reauthorization after rollout may therefore show the consent page again. A complete CIMD replacement also clears a withdrawn method list; an omitted field cannot leave the prior alternative active. Orbit compares both JSON-text and parsed-object metadata representations. No persisted per-request preference changes, migration or new dependency is involved.

`pnpm-workspace.yaml` and `pnpm-lock.yaml` bind the exact patches. The Dockerfile copies `patches/` before both dependency-install stages. On a Better Auth update, re-evaluate upstream support and remove these patches only after the OAuth flow, metadata-policy, gateway, legacy-client and negative regressions pass. Do not mechanically rebase a patch to a new dependency version.

Regression coverage: `mcp-cimd-methods.unit.test.ts`, `mcp-oauth-flow.integration.test.ts`, `mcp-oauth-cimd.integration.test.ts`, `mcp-2-gateway.integration.test.ts`. All use synthetic users and keys, not production tokens.
