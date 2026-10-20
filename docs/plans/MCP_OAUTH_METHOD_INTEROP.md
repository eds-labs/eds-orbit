# MCP OAuth client method interoperability

Risk: high; local auth protocol patch, then the authorized main/Coolify delivery workflow. No migration, scope expansion, secret change or new dependency.

## Evidence and plan

The installed Better Auth 1.7.10 CIMD parser ignores the plural authentication-method list. OpenAI publishes both `none` and `private_key_jwt`. A production probe with a deliberately invalid code receives `invalid_client: client registered for private_key_jwt cannot use none` before code validation. This is a confirmed interoperability gap, not proof of the particular method used by Mario's failing ChatGPT call. Upstream issue: https://github.com/better-auth/better-auth/issues/10660. Contract: https://developers.openai.com/plugins/build/auth#client-registration.

1. Reproduce with synthetic real OAuth/PKCE exchanges and refreshes for both declared methods.
2. Backport a bounded CIMD-only method-list implementation through pinned pnpm patches. Preserve the original transport, provenance, metadata validation, signature checks, replay prevention, PKCE, consent and token/grant intersection. A request-local returned client copy selects only an explicitly declared supported method; never mutate the persisted preference per request.
3. Negative tests: wrong signature, wrong verifier, public-only and signed-only clients, malformed/empty lists, undeclared secret auth, forged nested metadata, revoked grants and cross-project isolation. Changes to the declared list invalidate existing grants.
4. Run focused/full tests, lint, typecheck, build, Compose and secret/framework checks. Verify the install patch is reproducible.
5. Verify exact deployed revision and repeat the harmless invalid-code probe; success means it reaches `invalid_grant`, never that a token is minted. Real ChatGPT ticket acceptance remains separate.

## Security / rollback

Only methods offered by both the CIMD client and the existing authorization server are accepted. Legacy singular-only clients retain their pinned method. No symmetric method becomes available to CIMD clients. Signed requests still verify keys and one-time assertions; public code exchange still requires PKCE. No customer action or paid call is a smoke test. Revert the patch commit and redeploy for rollback; no database restoration is needed. No production logs are accessed outside the token's permissions.

A same-second revoke/regrant refresh refusal was reproduced separately. It is the existing conservative timestamp boundary, and is not weakened by this patch.

## Local verification

All 2,799 tests in 261 files passed; the 68-test focused regression, lint, typecheck, build, Compose, secret/framework checks and fresh pinned-pnpm frozen offline installs passed. See `docs/evidence/mcp-oauth-interop-validation.md`.

## Final review follow-up

Before rollout completed, the metadata-removal regression exposed two additional policy edges: omitted CIMD metadata was retained by an undefined update, and Better Auth callbacks can return parsed JSON objects rather than JSON text. The initial deployment was cancelled. The compatibility patch now explicitly clears withdrawn CIMD capabilities, and Orbit compares either representation. Real refresh/removal regressions cover both complete removal and reduction to the public-only set, including grant revocation. The final complete suite passed 2,799 tests after these changes.
