# Universal Customer Context: integration plan

Risk: high for the runtime work (customer data, external calls, tenant
mapping); the contract change itself is medium (no runtime effect). Decision:
[ADR 0011](../adr/0011-universal-customer-context.md). Contract and guide:
[`docs/CUSTOMER_CONTEXT.md`](../CUSTOMER_CONTEXT.md). Three applications
change: Orbit, the n8n gateway and each product (first FamilyPlan and uLiquid
Desk). No DDL: integrations are `connectors` entities, the binding is an inbox
rule. No new dependency, no paid provider.

## Plan

### CC-1 Orbit platform (no product knowledge)

1. Flag `ORBIT_CUSTOMER_CONTEXT` (default `false`) in `packages/config`, Compose and `.env.example`.
2. Connection provider `customer_context`: fields `baseUrl` (HTTPS via `endpoint()`), `sourceSystem` (slug), `timeoutMs` (1,000–8,000, default 4,000); credential JSON `{ token, signingSecret }` encrypted in the vault, never returned.
3. Client `readCustomerContext(connection, subject)`: builds the v1 request, signs it, sends it through `boundedFetch` with an `AbortSignal` deadline, caps the body at 64 KB, interprets it with `interpretCustomerContextResponse`. Per-connection circuit breaker (5 consecutive failures → 60 s open) and concurrency cap (4). No retry.
4. Content-free audit `customer_context.read` `{ connectionId, ticketId, outcome, reason, durationMs }`.

### CC-2 Orbit Support

1. Inbox rule `customerContext: { connectionId } | null`, owner-only, validated against a `customer_context` connection of the same project.
2. Subject resolution: ticket channel `widget`, contact identity of the ticket's inbox; otherwise `identity_unverified` without a call.
3. Route `GET /api/projects/:projectId/support/tickets/:ticketId/customer-context` (permission `support.customer_context.read`, sensitive, owner and editor) and a ticket-panel card loaded asynchronously.
4. Read tool for the Orbit Assistant and MCP (`support_customer_context`, R0, `openWorld`, scope `orbit:support`).
5. Support AI drafts: a deterministic detector finds plan, feature and credit questions; only then the draft reads the context and adds it as citable evidence (`account:*`). A non-`ok` result becomes the instruction to say the status cannot be checked now and hands off. Drafts without such a question are unchanged.
6. Tests: success, credits exhausted, feature denied, unverified customer, other tenant, provider unreachable, timeouts, echo mismatch, disabled flag and module, permissions; OpenAPI regeneration.

### CC-3 n8n

One workflow per integration (public HTTPS), Header Auth with the integration token, signature check, forward to the product, response passed through unchanged, no stored execution data. Details: `docs/CUSTOMER_CONTEXT.md`.

### CC-4 FamilyPlan and CC-5 uLiquid Desk

Each product adds a read-only `POST /v1/customer-context/lookup` that resolves the user id it already signs for the widget, maps its own plans, features and quotas to v1, and passes the conformance checklist with the shared examples. Product deploys need their own approval (master spec H11); Desk keeps working when Orbit or n8n is down.

### Rollout

1. Local: fake provider in tests.
2. Staging or local stack: n8n workflow against a product test endpoint; integration test of the full chain.
3. Production, each step separately approved: flag on, integration created, one inbox bound; read-only acceptance with a test account; then further inboxes. **No production activation without a passed integration test.**

## Rollback

- Contract: documentation and schemas only; revert the commit.
- Runtime: unbind the inbox (immediate), delete the integration, or set `ORBIT_CUSTOMER_CONTEXT=false`. Nothing is stored, so there is nothing to clean up.

## Local verification

- `pnpm contract:customer-context` produces no diff; `pnpm vitest run packages/schemas/src/customer-context.test.ts`.
- Runtime work packages add their focused tests and the full `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`.
