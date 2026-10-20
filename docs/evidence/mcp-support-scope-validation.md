# Support OAuth scope contract validation (2026-10-20)

Base: `4450a86a60eaf38769186d660226bb234b1c3dd5`. Plan/risk/rollback: `docs/plans/MCP_SUPPORT_SCOPE_INTEROP.md`.

- Pre-fix real HTTP regression: 4 passed, 1 failed exactly because top-level `securitySchemes` was undefined.
- Final focused gateway and principal matrix: 227 tests in 3 files passed. Both MCP revisions publish identical canonical and compatibility declarations. A narrow token cannot read tickets; the challenge retains identity/refresh scopes, and a newly authorized token plus its refresh can read the synthetic ticket. Foreign project, feature/module and grant restrictions remain.
- Lint, root/web TypeScript, production build, Coolify Compose, secrets and framework checks passed.
- Complete suite: 2,798 passed, 1 failed across 261 files (537.67 s). The failure is `agent-runner.integration.test.ts`, "requeues the agent tasks the pause held back when the project resumes (I7b)": a paused job stays blocked instead of queued. A separate complete-file repeat gives 19 passed / 1 failed. Running the same file with the MCP adapter restored to the unchanged base gives the identical failure. It is not claimed fixed or green and no unrelated runner code is included.
- No new dependencies, schema/data migrations, production flags/secrets, customer actions or paid calls. No REST contract changed, so no REST/OpenAPI generation; no browser UI source changed, so general browser E2E was not run. Actual OAuth/PKCE and both MCP wire paths were tested.

Deployment, catalog refresh and real ChatGPT ticket acceptance are separate runtime checks. Ignored `.runtime/mcp-support-scope-validation.json` and the associated logs hold execution evidence. Successful Marketing/profile reads do not establish Support acceptance. Do not promote a saved grant into authority for an unscoped token.
