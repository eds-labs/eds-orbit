# Support OAuth scope discovery interoperability

Risk: high. Backend API bugfix; authorized direct-main / Coolify delivery. No migration, dependency, secret, feature-flag or data changes.

## Evidence and plan

Mario reports successful Marketing reads but a reconnect loop for `support_list_tickets`, with `orbit:support` granted but absent from effective token scopes. Orbit currently advertises security schemes only in `_meta.securitySchemes`. OpenAI documents that field as a backward-compatibility mirror and expects a top-level `securitySchemes` declaration. The pinned MCP SDK 2.3.1 drops an arbitrary top-level field passed to `registerTool`, so adding a configuration property alone would not repair the wire contract.

1. Add a failing real HTTP/OAuth regression for identical top-level and mirror schemes in both supported protocol revisions.
2. Publish the catalog with the SDK's documented low-level tools/list handler. Reuse the same authorized definitions, schemas, annotations and metadata. Keep SDK tool execution and validation unchanged.
3. Preserve the current token scopes in a Support step-up challenge, including offline_access, so reauthorization can keep refresh access. Drive a synthetic challenge -> consent -> exchange -> ticket read -> refresh -> ticket read flow.
4. Verify all permission/tenant/feature refusals, run project checks, then push the authorized fix and verify deployed revision/readiness. Real ChatGPT acceptance stays pending until a real ticket call succeeds.

## Security / operations / rollback

Only descriptions change, never token/grant scope intersection, role/module/project checks, quotas or owner approvals. Unscoped content calls remain refused before customer data access. An OAuth client must request and receive explicit consent for Support. Never promote stored grant scopes into token authority. Synthetic tests only; no customer messages or paid providers. No database/backup operation is needed because no schema/data migration exists. Revert this commit and redeploy for code rollback; retain the previous CIMD method fixes. Monitor readiness and the actual ticket read separately; no production-log permission bypass.

References: https://developers.openai.com/plugins/build/auth#triggering-authentication-ui and https://developers.openai.com/plugins/reference#_meta-fields-on-tool-descriptor.

## Validation

227 focused tests and the non-test project checks pass. The full suite passes 2,798 of 2,799 tests; the sole agent-resume failure also occurs with the unchanged baseline adapter. See `docs/evidence/mcp-support-scope-validation.md`. This known failure is not changed or reported as passing.
