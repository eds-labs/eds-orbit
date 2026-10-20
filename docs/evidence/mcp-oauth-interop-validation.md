# MCP OAuth authentication-method interoperability validation

Date: 2026-10-20. Base: `e6a7062868f83306b59709b6438264ab48a3c209`. Runtime: Node 24.18.0. Local test database and Redis namespace isolated for this worktree.

## Reproduction

- A harmless production POST using ChatGPT's public client ID and an intentionally nonexistent code returned `400 invalid_client`, description `client registered for private_key_jwt cannot use none`.
- Public OpenAI CIMD metadata declares `none` and `private_key_jwt`. The installed Better Auth 1.7.10 parser ignored the plural list.
- Before the compatibility patch, the added real OAuth method-list regressions failed. After it, both public PKCE and signed client exchange/refresh succeed.
- This reproduces an interoperability defect, not the exact failed request from Mario's ChatGPT session. That end-to-end acceptance is still required. The obsolete Codex plugin binding is a separate issue.

## Passed checks

- Initial focused regression: 68 tests, four files. Final metadata-policy regression: 30 tests, including method-list removal and grant revocation.
- Complete suite: **2,799 tests, 261 files**, 478.37 seconds.
- Lint/source guards and import boundaries.
- Root and web TypeScript checks.
- Production build.
- Coolify Compose validation.
- Secret-pattern scan and framework validation.
- Fresh frozen-lockfile offline installs with pnpm 11.19.0: development and production-only dependencies; each loaded the patched CIMD parser correctly.
- Staged diff whitespace validation. Unified patch context uses its required leading space before upstream tab indentation; the targeted `.gitattributes` rule accounts for that format.

## Security review

Request-local method selection applies only to `cimd` provenance and a validated capability explicitly persisted from the top-level document. It does not change the stored preference. Legacy singular-only and managed/DCR clients keep their original behavior. Unknown/symmetric alternatives are not enabled. Wrong signature, assertion replay, wrong verifier, public-only and signed-only restrictions, malformed/empty method lists, and forged nested metadata are covered. Both ES256 and RS256 signed flows work; exact ChatGPT scopes work across revocation and re-consent outside the existing same-second replay boundary. Method-set changes revoke grants. Actual metadata refresh tests cover both reducing and completely removing the list; withdrawn capabilities are cleared rather than retained by an undefined update. JSON-text and parsed-object metadata representations are compared. Existing RLS, access matrices and queue dispatch checks pass in the full suite.

No migration, new dependency, production secret/flag change, customer write or paid provider call was involved. No raw production logs were obtained beyond connector permissions. The browser UI was not changed; authorization/redirect/token flows were tested through the real HTTP/OAuth stack. No additional browser E2E suite or local container image build was run; the existing production build and fresh install checks passed, with Coolify deployment to be verified separately.

## Delivery and rollback

The initial automatic deployment of `dad8325` was cancelled before rollout completed so the final metadata-removal hardening could be included. The final complete suite and static/build checks were repeated after that hardening.

Use the authorized direct-main workflow. Confirm the exact Coolify revision and readiness after its automatic deployment, then repeat the invalid-code probe: a client whose metadata offers `none` must reach `invalid_grant` without issuing a token. Real ticket reads through the intended ChatGPT connection remain the acceptance check. Revert this commit and redeploy for rollback; no database restoration is needed.
