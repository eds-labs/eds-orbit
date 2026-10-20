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
