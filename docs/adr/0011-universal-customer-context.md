# ADR 0011: Universal Customer Context (`customer_context.read`)

## Status

Accepted by Mario, 2026-10-21 ("Universal Customer Context – Architecture & Contract"). Answers open question Q-09 and replaces the product-specific `ProductDataProvider` sketch of Support extension E5 (`plans/orbit-modularization/06-support-readiness.md` §6). The contract is published as v1 in `packages/schemas/contracts/customer-context/v1/`; the integration guide is `docs/CUSTOMER_CONTEXT.md` and the work plan `docs/plans/CUSTOMER_CONTEXT_INTEGRATION.md`. This ADR changes no runtime behaviour.

## Context

Support agents and the Support AI need live facts about the customer of a ticket: which plan, whether the subscription is active or cancelled, whether a feature is enabled and why not, and whether credits or limits are used up and when they reset. The facts live in the products (first FamilyPlan and uLiquid Desk, later any EDS or customer SaaS product).

Constraints:

- **No product logic in Orbit.** Orbit must not know FamilyPlan or Desk fields, and it must stay usable for any SaaS product.
- **No CRM and no copy** of the products' customer databases.
- **No payment, card, trading, wallet or household data** in Orbit.
- **No live customer data without a verified identity.** The only verified identity Orbit has is the widget's HMAC-signed user id (`SupportContactIdentity`, `docs/SUPPORT_WIDGET.md`). E-mail addresses are claims.
- **Unknown is not zero.** A missing credit balance must never read as "no credits left".
- **Desk does not depend on Orbit** (master spec H05/H11, risk R-16), and Orbit holds no Desk keys.
- Mario chose n8n as the integration layer: Orbit ↔ n8n ↔ products. The contract must still work without n8n.

Reusable mechanisms already in Orbit: project-scoped RLS (`scoped`), the connection vault (`connectors` entities with AES-GCM `encryptedCredential`), the SSRF-safe `boundedFetch` with its outcome taxonomy, constant-time comparison and content-free audit, the tool registry with `readOperation` (R0, `openWorld`, `orbit:support`), and zod 4 with `z.toJSONSchema`.

## Decision

1. **One product-neutral capability, `customer_context.read`.** Read-only. Orbit is the consumer; a *provider* is anything that implements the provider OpenAPI. Orbit never interprets product semantics: plans, entitlement keys and usage keys are opaque strings with display labels.
2. **Provider contract v1** (`openapi.json`, OpenAPI 3.1): `POST {baseUrl}/v1/customer-context/lookup`.
   - The request carries the opaque `integrationId`, the verified `subject` (`external_user_id` plus `verification.method = widget_hmac`), `purpose = support`, `acceptVersions` and an optional `include`. It carries no e-mail, name or Orbit tenant id.
   - A found customer is `200` with a `CustomerContext`; everything else is RFC 9457 `application/problem+json` with a fixed `code` → status map: `invalid_request`/`unsupported_version` 400, `unauthenticated` 401, `access_denied` 403, `customer_not_found` 404, `identity_not_verified` 422, `rate_limited` 429, `service_unavailable` 503, `upstream_timeout` 504.
3. **`CustomerContext` v1 is a strict allowlist** (every object `additionalProperties: false`): source system and integration, the echoed external reference and an account status, a subscription (status, plan, validity dates, cancellation state), effective entitlements (state, source, denial reason, expiry), usage limits (limit, used, remaining, unlimited, period, reset date) and freshness (generated, data as of, max age, per-section availability).
   - Every value that can be unknown is **present and nullable**. `null` means unknown, never 0; `unlimited` is explicit.
   - A section is `null` exactly when its availability is not `available` (`unavailable`, `not_applicable`, `not_requested`).
   - Bounds: 64 KB per body, at most 100 entitlements and 50 usage items, bounded strings.
4. **zod is the source of truth** (`packages/schemas/src/customer-context.ts`). The JSON Schemas (draft 2020-12) and the OpenAPI document are generated (`pnpm contract:customer-context`) and a contract test fails when they drift. No new dependency.
5. **Authentication of every lookup:** a per-integration bearer token **and** `X-Orbit-Signature: v1=HMAC-SHA256(signingSecret, X-Orbit-Timestamp + "." + rawBody)` with a ±300 s window and `X-Orbit-Request-Id`. Both secrets are per integration, stored only in the Orbit vault and in the provider's (n8n's) credential store. Transport is public HTTPS through `boundedFetch` (Mario, 2026-10-21): no redirects, no private addresses, no exception to the SSRF guard.
6. **Mapping tenant ↔ integration ↔ customer.**
   - An *integration* is a project-scoped connection (provider `customer_context`) with base URL, source system slug, timeout and the encrypted token and signing secret. RLS keeps it inside its project.
   - A Support inbox is bound to at most one integration (`SupportInbox.rules.customerContext`). Binding is owner-only.
   - Orbit sends a subject only when the ticket came through the widget of that inbox and the contact has a `SupportContactIdentity` of the same inbox. Anything else is `identity_unverified` locally, without a call. E-mail is never a lookup key.
   - Orbit rejects a response whose `source.integrationId` or `customer.externalRef.id` differs from the request (`invalid_response`).
7. **Products emit v1 natively; n8n only authenticates and routes** (Mario, 2026-10-21). n8n verifies Orbit's token and signature, forwards to the product's own v1 endpoint with the product's credential (kept in n8n), and passes the answer through unchanged. A product can also be configured as the provider directly.
8. **Synchronous live lookup with bounded cost.** Orbit's deadline is 4 s by default (1–8 s per integration), n8n leaves 2.5 s for the product, the interactive path has no retry. A per-integration circuit breaker and concurrency cap protect the providers. Orbit stores no payload: no table, no cache beyond the request. The audit records only connection id, ticket id, outcome, duration and schema version.
9. **Orbit-internal result** (`customerContextResult`): `ok`, `not_found`, `identity_unverified`, `forbidden` (permission, module, flag, no integration, provider denial) and `unavailable` with a reason (`timeout`, `network`, `provider_error`, `invalid_response`, `misconfigured`, `circuit_open`, `rate_limited`). Agents and the UI must say "cannot be checked right now" for every non-`ok` result and must not guess a cause.
10. **Versioning.** The URL carries the major version (`/v1/`), the body `schemaVersion` the minor. A minor version only adds optional fields or enum values; Orbit announces what it accepts (`acceptVersions`) and providers answer with one of those. Fields Orbit does not know are rejected (allowlist over tolerant reading). Breaking changes get `/v2/`.

## Alternatives

- **Product adapters inside Orbit** (the E5 sketch `product: "desk" | "familyplan"`): puts product logic and product credentials into Orbit. Rejected.
- **Field mapping in n8n** (products expose their own APIs, n8n maps to v1): less product work, but domain knowledge and the allowlist would live in workflow code without tests. Rejected by Mario; still possible for a product that cannot change, with the same contract.
- **Push sync / replica** (products push customer state into Orbit tables): a CRM copy with retention and erasure duties. Rejected.
- **E-mail as lookup key:** e-mail is a claim in Orbit. Rejected.
- **Tolerant reader** (ignore unknown fields): would let undeclared personal data reach Orbit silently. Rejected.
- **Hand-written JSON Schema with ajv:** a new dependency and two sources of truth. Rejected in favour of zod plus generation.

## Consequences

- FamilyPlan and Desk each add one read-only endpoint that resolves the same user id they already sign for the widget. Their deploys need their own approval (H11).
- Orbit implements one connection provider, one client, one Support binding, one read tool and one UI card (work packages in `docs/plans/CUSTOMER_CONTEXT_INTEGRATION.md`), behind a default-off flag.
- E-mail-only customers get no live context until a verified identity exists for them; that is intended.
- Customer context reaching a model is account data without direct identifiers (Q-12a option B: no name, no e-mail, no external id); it is only fetched when the ticket asks about plan, features or limits.
- A new product needs no Orbit code: it implements v1 and an owner configures an integration.
