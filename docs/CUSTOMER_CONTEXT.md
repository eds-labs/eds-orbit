# Customer context (`customer_context.read`)

Live, read-only facts about a Support customer's subscription, feature entitlements and usage limits, read from the product the customer uses. Decision record: [ADR 0011](adr/0011-universal-customer-context.md). Work plan: [`plans/CUSTOMER_CONTEXT_INTEGRATION.md`](plans/CUSTOMER_CONTEXT_INTEGRATION.md).

## Contract files

| File | Content |
|---|---|
| `packages/schemas/src/customer-context.ts` | zod source of truth, limits, problem codes, `interpretCustomerContextResponse` |
| `packages/schemas/contracts/customer-context/v1/openapi.json` | Provider API (OpenAPI 3.1) with all examples |
| `…/v1/customer-context-request.schema.json` | Request body (JSON Schema 2020-12) |
| `…/v1/customer-context.schema.json` | Response body |
| `…/v1/problem.schema.json` | Error body (RFC 9457) |
| `…/v1/examples/*.json` | Valid examples; `examples/invalid/*.json` must be rejected |

After changing the zod source run `pnpm contract:customer-context`; `packages/schemas/src/customer-context.test.ts` fails while generated files are stale. The JSON Schemas carry the structure; three rules live only in zod and must be checked by providers' own tests too: a section is `null` exactly when its availability is not `available`; keys are unique per list; an `unlimited: true` quota has `limit` and `remaining` `null`.

## Architecture

```
 Orbit (consumer)                    n8n (gateway, optional)            Product (provider)
 ───────────────                     ───────────────────────            ──────────────────
 Support ticket (widget, verified)
   → contact identity of the inbox
   → inbox binding → integration
   → signed POST /v1/customer-context/lookup ──► verify token + HMAC
                                                 route by integration ──► POST /v1/customer-context/lookup
                                                                          resolve user id, allowlist
                                     ◄── pass through unchanged ◄──────── 200 CustomerContext | problem
   ← check schema, echo, availability
   → agent card / AI draft evidence (never stored)
```

- **Orbit** decides *whether* to ask (flag, module, permission, binding, verified identity) and *what it means* (`ok`, `not_found`, `identity_unverified`, `forbidden`, `unavailable`).
- **n8n** holds the product credentials and forwards. It changes no field.
- **The product** owns its domain: it maps its plans, features and quotas to the neutral v1 shape and leaves out everything else.

A product can be configured as the provider directly; the contract is the same.

## Identity and tenant mapping

| Orbit | Meaning |
|---|---|
| Workspace + Project | Tenant boundary (RLS). An integration exists in exactly one project. |
| Integration | Connection with provider `customer_context`: `baseUrl` (HTTPS), `sourceSystem` (slug), `timeoutMs`, encrypted `{ token, signingSecret }`. |
| Inbox binding | `SupportInbox.rules.customerContext = { connectionId }`. Owner-only, one integration per inbox, same project. |
| Subject | `SupportContactIdentity(inboxId, channel "widget", externalUserId)` of the ticket's inbox; created only after the widget's HMAC check. |

Orbit asks only for a ticket that came through the widget of the bound inbox and whose contact has an identity of that inbox. E-mail tickets, anonymous widget visitors and identities from other inboxes are `identity_unverified` without a call. The product must resolve `subject.id` exactly like the user id it signs for the widget.

## Authentication

Every request carries, per integration:

```
Authorization: Bearer <token>
X-Orbit-Timestamp: 1792574100
X-Orbit-Request-Id: 0b9c2f4e-8a1d-4c3b-9e7f-6a5b4c3d2e10
X-Orbit-Signature: v1=<hex HMAC-SHA256(signingSecret, X-Orbit-Timestamp + "." + rawBody)>
```

A provider must check the token, recompute the HMAC over the **raw** request body, compare in constant time, reject timestamps more than 300 s off, and require `X-Orbit-Request-Id` to equal `requestId`. Failures answer `401 unauthenticated` with no detail. Rotate by creating a new integration and switching the inbox binding.

## n8n gateway workflow (per integration)

1. **Webhook** node: `POST`, path ending in `/v1/customer-context/lookup`, authentication *Header Auth* with the integration token, option *Raw Body* on, response mode *Using "Respond to Webhook" node*.
2. **Code** node: verify the signature and timestamp (needs `crypto`, e.g. `NODE_FUNCTION_ALLOW_BUILTIN=crypto`):

   ```js
   const crypto = require("crypto");
   const raw = Buffer.from($input.first().binary.data.data, "base64");
   const ts = $input.first().json.headers["x-orbit-timestamp"];
   const sig = $input.first().json.headers["x-orbit-signature"] ?? "";
   const expected = "v1=" + crypto.createHmac("sha256", $env.ORBIT_CC_SIGNING_SECRET).update(`${ts}.${raw}`).digest("hex");
   const fresh = Math.abs(Date.now() / 1000 - Number(ts)) <= 300;
   const ok = fresh && sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
   return [{ json: { ok, body: ok ? JSON.parse(raw.toString("utf8")) : null } }];
   ```
3. **IF** `ok` is false → **Respond to Webhook** `401` with `problem-unauthenticated` (no detail).
4. **HTTP Request** node: `POST` the unchanged body to the product's v1 endpoint with the product credential, timeout 2,500 ms, "Never error" on HTTP status, full response.
5. **Respond to Webhook**: the product's status code, `content-type` and body unchanged. On a product timeout answer `504 upstream_timeout`; on a network error `503 service_unavailable`.

The workflow must not log request or response bodies (disable execution data saving for successful and failed runs, or prune it immediately). Keep one workflow per integration so a token can only reach its own product.

## Configuration in Orbit

1. Set `ORBIT_CUSTOMER_CONTEXT=true` for the API and worker (default `false`; Compose passes it through).
2. Connectors → **Customer context** → *Add integration* (owner): name, HTTPS base URL (for n8n the webhook URL without `/v1/customer-context/lookup`), source system slug, timeout (1,000–8,000 ms, default 4,000), bearer token (≥ 16 characters) and signing secret (≥ 32 characters). The action is `customer-context-connect`; both secrets are stored encrypted together and never returned. Updating an integration needs both secrets again and a new check.
3. *Check connection* (`connector-health`): Orbit sends one signed lookup of the reserved subject `orbit-connection-check`. A provider that answers per contract (normally `404 customer_not_found`) becomes `read_verified`; anything else is refused with `CUSTOMER_CONTEXT_CHECK_<REASON>`. Only verified integrations are read.
4. Support → Settings → Inbox → *Customer account from*: bind the inbox (owner).
5. Agents see the "Customer account" card on widget tickets of that inbox; AI drafts use it for account questions (`docs/SUPPORT.md`).

Removing an integration (`customer-context-disconnect`) makes bound inboxes fail closed (`forbidden`, `no_integration`). The circuit breaker opens per integration and process after five consecutive failures, for 60 s; at most four lookups run at once per integration.

## Provider conformance checklist

- [ ] Implements `POST /v1/customer-context/lookup` exactly as `openapi.json`.
- [ ] Verifies token, signature, timestamp window and request id; `401` otherwise.
- [ ] Resolves `subject.id` as the user id it signs for the Orbit widget; nothing else (no e-mail lookup).
- [ ] Answers `404 customer_not_found` for the reserved subject `orbit-connection-check` (Orbit's connection check).
- [ ] Answers only `customer_not_found`, `identity_not_verified`, `access_denied`, `rate_limited`, `service_unavailable`, `upstream_timeout`, `invalid_request`, `unsupported_version` as problems, with the listed statuses.
- [ ] Echoes `integrationId` in `source.integrationId` and `subject.id` in `customer.externalRef.id`.
- [ ] Sends every field of v1; unknown values as `null`, never `0` or omitted; `unlimited` explicit.
- [ ] Sets each section's availability truthfully; `null` section ⇔ not `available`; respects `include` (`not_requested`).
- [ ] Sends no other field. In particular no payment method, card, IBAN, invoice, wallet, trading position or balance, household or family member, address, phone, e-mail or birth date.
- [ ] Answers within 2.5 s (the product) or 3.5 s (gateway total); body ≤ 64 KB.
- [ ] Validates its responses against `customer-context.schema.json` and the three zod-only rules in its own tests, using the examples in `v1/examples/`.

## Orbit results and what agents say

| Provider answer | Orbit result | Agent behaviour |
|---|---|---|
| `200` valid, echo matches | `ok` | Facts may be used; unknown values are stated as unknown. |
| `404 customer_not_found` | `not_found` | "No account found for this verified user." No guess. |
| `422 identity_not_verified` | `identity_unverified` (`provider_rejected`) | "The account cannot be checked." |
| `403 access_denied` | `forbidden` (`provider_denied`) | "The account cannot be checked." |
| `401`, `400`, bare `404`/`403` | `unavailable` (`misconfigured`) | "The status cannot be checked right now." |
| `429` | `unavailable` (`rate_limited`) | same |
| `503`, other `5xx` | `unavailable` (`provider_error`) | same |
| `504`, deadline exceeded | `unavailable` (`timeout`) | same |
| invalid body, wrong echo, unknown fields | `unavailable` (`invalid_response`) | same |
| no verified identity (local) | `identity_unverified` (`no_verified_identity`) | Ask the customer to sign in through the app's widget. |
| flag, module, permission, no binding (local) | `forbidden` | No account section. |

## Timeouts and limits

| Limit | Value |
|---|---|
| Orbit deadline per lookup | 4,000 ms default; 1,000–8,000 ms per integration |
| Gateway → product | 2,500 ms |
| Retries on the interactive path | none |
| Body size | 64 KB |
| Signature window | ±300 s |
| Entitlements / usage items | ≤ 100 / ≤ 50 |

## Privacy

- Orbit stores no payload. Only the audit `support.customer_context.read` with ticket id, connection id, origin, outcome, reason, duration and schema version.
- The model receives plan, status, entitlement and usage values with neutral ids, never the external user id, a name or an e-mail (Q-12a option B).
- Contact export and erasure (`privacy.ts`) are unaffected because nothing is stored.
