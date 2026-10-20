# Support MCP discovery diagnosis and fix

Risk: high; local validation followed by the authorized direct-main code rollout.
Primary profile: backend-api; supplement: ai-agent-app. Bugfix workflow.

1. Reproduce the difference between stored consent and effective token scopes.
2. Add minimal content-free diagnostics to the existing profile read so a stale
   client catalog does not block diagnosis. Preserve the opaque profile id.
3. Correct the demonstrated discovery/auth defect, preserving the intersection
   of token, grant, project, current membership and module permission checks.
4. Run real HTTP/OAuth regression and negative tests, lint, typecheck and build.
5. Verify the exact deployment and current connection, including Support reads.

Threats: no token/secret or customer text may appear in diagnostics. Diagnostics
use the authenticated principal, never model-supplied claims. No new access,
provider calls, migrations, flag changes or customer sends. Existing exact owner
approval remains mandatory for all Support mutations.

Rollback: restore the preceding code image; no database transformation. Existing
persistent-data backups remain applicable. Monitor readiness and read-only MCP
results after deployment. Never retry an ambiguous customer delivery.

## Reproduction and correction

Live profile diagnosis on 2026-10-20 showed only `orbit:read` and
`orbit:propose` as effective Orbit scopes despite the displayed Support consent.
The HTTP/OAuth regression reproduces this with an older token after explicit
expanded consent: discovery previously returned 200 and omitted Support.

Keep consent separately in the principal for diagnostics only. Live UI testing
showed that a 403 on tools/list alone makes ChatGPT's refresh fail, while its
reconnect still requests only scopes from the older catalog.

Advertise Support tool descriptions and their scope metadata under all other
current project/module/role/grant/risk-scope checks, without reading customer
content. Scope-less calls return a tool-level RFC 6750 challenge in
mcp/www_authenticate. Recheck the requested project before a challenge and
retain strict execution authorization. An ungranted scope is never execution
permission; it requires explicit OAuth consent. Test disabled flags, restricted
grants, foreign projects, absent scope/consent and fresh tokens.
