# Developing a connector

A connector translates one documented provider contract. It does not grant permission to perform a side effect. Review the installed provider version and its primary API documentation before changing an adapter; retain separate evidence for offline transport tests, local workflow tests and an explicitly authorized real account test.

## Boundaries and placement

- Put typed provider transport/response parsing in `packages/connectors/src/<provider>.ts` and export it from `index.ts`. The current adapters use small provider-specific clients, not a universal interface that pretends every provider supports scheduling, deletion or idempotency.
- Use `http.ts`'s `HttpOptions`, injectable `FetchLike`, `jsonTransport`/`boundedFetch` and `ConnectorError`. Production transport requires HTTPS, validates and pins public DNS, rejects redirects/private targets, and bounds time/request/response size. Keep the fixed provider endpoint or validated allowlisted origin; never let a model select arbitrary destinations.
- Validate inputs and provider responses with explicit schemas. Report capability flags truthfully. Treat an accepted receipt separately from a reconciled published result, retaining the account and remote object ID.
- Put authorization, credential decryption, policy/mandate checks, durable intent creation, preflight and reconciliation in the API modules and worker, following `publisher.ts`, `postiz-verification.ts`, `slack.ts` or `matomo.ts`. Models receive no credentials or connector tool access. UI requests a validated action; it never calls a provider directly.

## Side-effect contract

Declare the affected account, exact payload/asset/link versions, action scope, expiry and expected cost before transmission. Recheck project role, current evidence/rights, pause, scheduling, quotas and package approval at handoff. A changed connector/account/version invalidates its earlier proof. Asset upload requires byte/hash/type checks and another current-package check before publishing.

Classify sanitized failures with `ConnectorError(code, outcome, retryable, status)`:

| Outcome | Meaning and executor behavior |
| --- | --- |
| `not_sent` | No known side-effect handoff; a bounded retry may be allowed after current policy checks. |
| `rejected` | Provider explicitly rejected the request; use documented semantics and the bounded retry policy, such as a rate limit. Do not invent success. |
| `unknown` | A timeout, interrupted response or ambiguous write may have executed. Persist uncertainty and reconcile; never blindly resend under a new job/key. |

Mark side-effecting transport calls with `sideEffect=true`. Preserve unknown state before recovery, distinguish receipt from publication, and poll only by a documented bounded read. Never promise global exactly-once delivery when the provider has no verified idempotency contract. Cancellation must prove the entire affected scope; the current Postiz group-delete transport capability is deliberately not exposed by the product because membership is not provable.

## Read adapters and inbound decisions

For analytics retain source/account/site IDs, metric definition, date/timezone, currency and attribution/limitations. Missing values remain null, partial reads remain partial and corrections version/invalidate derived insights. Do external HTTP work outside database transactions and recheck the connector's version/authority before attaching a result.

Inbound approval endpoints require the provider's verified raw-body signature, bounded timestamp, persisted replay prevention, explicit identity mapping, expiring mandate and exact current package binding. Slack's signed route has a narrow Origin exception; ordinary application mutations still require same-origin authenticated requests. An inbound message can never expand policy or grant infrastructure access.

## Verification and delivery

1. Add pure transport contract tests with injected fetch: exact request shape, response bounds, credentials absent from errors, unexpected fields/states, timeout/429/5xx and receipt-versus-result semantics. Use synthetic tokens/data.
2. Add real PostgreSQL workflow tests for project/role denial, stale connector/approval, pause, concurrent handoff, withdrawal during upload, replay, unknown-state recovery and bounded attempts. Use actual worker/Redis coverage when adding a queue action. Mocks prove local behavior only.
3. Add actionable UI states and complete the validated API schema; regenerate OpenAPI/client with `pnpm api:generate`. Update `CONNECTOR_CAPABILITIES.md`, operator setup and traceability. Run typecheck, relevant tests and secret/dependency checks; browser-test new controls.
4. Keep live capability disabled until the owner authorizes an exact sandbox account/payload/budget and a real test records the observed result. Application credentials must be supplied separately; Codex/ChatGPT connector access is not inherited. Do not send an unsolicited test post, Slack message, mail or ad.

A missing provider account may block live acceptance after the complete adapter/workflow is implemented. Missing code, tests or supported semantics are internal limitations and must be named as such.
