# n8n integration layer: customer context (phase 1)

Versioned n8n workflows that answer Orbit's `customer_context.read` lookups
([ADR 0011](../../../docs/adr/0011-universal-customer-context.md), contract
v1 in `packages/schemas/contracts/customer-context/v1/`) from uLiquid Desk and
FamilyPlan. Operations runbook (install check, hardening, secrets, backups,
updates, recovery): [`docs/deployment/N8N_CUSTOMER_CONTEXT.md`](../../../docs/deployment/N8N_CUSTOMER_CONTEXT.md).

```
Orbit (verified widget user)                 n8n                                    product
POST {base}/v1/customer-context/lookup  ──▶  A Gateway: bearer + HMAC + timestamp ──▶ B Desk adapter ──▶ GET  Desk Customer Context API
Authorization, X-Orbit-Signature              integration → adapter (allowlist)      C FamilyPlan   ──▶ POST support-customer-context
                                     ◀──      strict v1 check of every answer   ◀──    adapter: map to v1, only allowlisted fields
```

- **A Gateway** (`workflows/gateway.json`): one public webhook,
  `POST /webhook/orbit-cc/v1/customer-context/lookup` (Orbit base URL
  `https://<n8n>/webhook/orbit-cc`). Checks the integration's bearer token
  (SHA-256, constant time), the HMAC signature over the raw body, the
  ±300 s timestamp and the request id; every refusal before a valid signature
  is the same `401`. Then it validates the request against v1, routes the
  integration to its bound adapter (fixed allowlist) and validates the
  adapter's answer again: a context that is not strictly v1, or that names
  another integration or customer, becomes `503 service_unavailable`.
- **B uLiquid Desk** (`workflows/adapter-uliquid-desk.json`): reads Desk's
  existing Customer Context API (`GET /integrations/v1/customers/:id/context`,
  Desk token `dctx_…`) and maps subscription, feature entitlements and AI
  credits (balance plus daily/monthly limits) to v1.
- **C FamilyPlan** (`workflows/adapter-familyplan.json`): calls FamilyPlan's
  read-only Edge Function `support-customer-context` (familyplan PR, own
  service token) and maps the most favourable access over the account's
  families, the feature entitlements and the family counts to v1.

Both adapters are sub-workflows that only the gateway may call
(`callerPolicy: workflowsFromAList`). The product budget is 2.5 s; Orbit
waits at most its integration timeout (default 4 s).

## Rules this layer keeps

- No database coupling: products are only reached through their own APIs.
- No product secret in Orbit: Desk and FamilyPlan tokens exist only in n8n.
  Orbit holds only its per-integration token and signing secret.
- No unprotected webhook: token **and** signature, constant-time checks, no
  hint which part failed, no customer data before authentication.
- No cross-tenant lookups: an integration id (an Orbit connection of one
  project) is bound to exactly one adapter; a token or signature of one
  integration does not work for another. Adapters refuse ids that cannot
  belong to their product without calling it.
- No stored customer data: execution data is off per workflow and per
  instance; nothing is logged.
- Unknown stays unknown: missing numbers become `null`, never `0`; a product
  error is a problem code, never a guessed state.

## Files

| Path | Content |
|---|---|
| `src/shared.js` | v1 request validation, strict v1 output check, problem details, helpers |
| `src/gateway.js` | integration config, authentication, routing |
| `src/desk.js`, `src/familyplan.js` | product adapters: call, map, error mapping |
| `build.mjs` | generates `workflows/*.json` (Code nodes = `shared.js` + module + entry) |
| `workflows/` | importable, generated workflow definitions; never edit in n8n |
| `fixtures/` | Desk answers generated with Desk's own builder (Desk `f92364b`); FamilyPlan answers per its contract |
| `tests/` | unit and contract tests (Vitest, part of `pnpm test`) |
| `e2e/` | product stand-ins and a throwaway local n8n for the end-to-end test |
| `deploy/` | n8n env template and a Coolify Compose reference |

## Configuration (n8n environment)

| Variable | Content |
|---|---|
| `CC_GATEWAY_INTEGRATIONS` | JSON array `[{integrationId, adapter, tokenSha256, signingSecret}]`, one entry per Orbit integration; `adapter` is `uliquid-desk` or `familyplan` |
| `CC_DESK_BASE_URL`, `CC_DESK_TOKEN` | `https://api.desk.uliquid.vip`, Desk client token |
| `CC_FAMILYPLAN_FUNCTION_URL`, `CC_FAMILYPLAN_TOKEN` | FamilyPlan function URL, FamilyPlan service token |
| `NODE_FUNCTION_ALLOW_BUILTIN=crypto`, `N8N_BLOCK_ENV_ACCESS_IN_NODE=false` | needed by the Code nodes |

Product URLs must be HTTPS (plain HTTP only for loopback test stubs). All
secrets are locked Coolify variables; see `deploy/n8n.env.example`.

## Change, build, import

1. Change `src/`, bump `VERSION` in `build.mjs`, run
   `node integrations/n8n/customer-context/build.mjs` and the tests.
2. Import the three files in order adapters → gateway (`n8n import:workflow
   --input=…`), publish them (`n8n publish:workflow --id=…`) and restart n8n.
   n8n 2.x activates a published version asynchronously: wait until the
   Orbit connection check passes before relying on the new version.
3. The workflow ids are fixed (`CcGatewayOrbit0001`, `CcAdapterUliquidDesk01`,
   `CcAdapterFamilyPlan001`), so a re-import replaces the previous version and
   keeps the webhook URL.

## Tests

- `pnpm vitest run integrations` — gateway authentication, both adapters
  against Orbit's zod contract, error mapping, the generated workflows (drift,
  settings, no secrets) and their Code nodes run outside n8n.
- End to end (Orbit API and database → real n8n with these workflows →
  product stand-ins; Desk fixtures, real FamilyPlan handler):

  ```sh
  node scripts/test-db-for-worktree.ts        # once, with the local stack running
  CUSTOMER_CONTEXT_E2E_N8N=1 N8N_BIN=/path/to/n8n \
  FAMILYPLAN_HANDLER=/path/to/familyplan/supabase/functions/support-customer-context/handler.ts \
  pnpm vitest run apps/api/tests/customer-context-n8n.integration.test.ts
  ```

  `e2e/start-n8n.sh` starts a fresh n8n (SQLite, loopback) per run; it never
  touches another instance. Without `FAMILYPLAN_HANDLER` the FamilyPlan stand-in
  answers from the fixtures.
