# Ads A2 — Provider Seam, Meta Transport and `packages/money` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The provider seam that every later Ads step calls: provider-neutral failure and throttle types, a Meta Marketing API client that is pinned, signed and safe by construction, exact money conversion between Meta's units and Orbit's micros, and a fake Meta Graph for tests. Finance's arithmetic moves to an internal package without changing Finance.

**Architecture:** `apps/api/src/modules/ads/providers/` holds `types.ts` (seam), `registry.ts` and `meta/` (`version.ts`, `transport.ts`, `graph.ts`, `errors.ts`, `usage.ts`, `money.ts`, `provider.ts`). The client sends every request through `boundedFetchWith` from `packages/connectors` (HTTPS only, public addresses only, no redirects followed, response cap). Tests replace the transport through a test-only hook with an in-memory fake Graph, the pattern Social's Meta tests use (`setSocialFetchForTests`, `apps/api/tests/social-adapter-facebook.test.ts:11-27`). `packages/money` holds decimals-based arithmetic with its own error type. `finance/money.ts` keeps its signatures, currency set and `DomainError` codes as a thin wrapper.

**Tech Stack:** TypeScript, Node 24 (`node:crypto`), zod 4, Vitest. No new dependency.

**Spec:** programme plan [`2026-11-07-ads-module.md`](2026-11-07-ads-module.md) (§2.6 Meta rows "Version", "Validation and errors", "Money", "Rate limits"; §4.1; §11 credentials; §12.1 row A2; §13.1–§13.2), [ADR 0025](../../adr/0025-ads-module.md) points 2, 3 and 8 (A-D10, A-D19). Depends on A1 ([`2026-11-08-ads-a1-module-skeleton.md`](2026-11-08-ads-a1-module-skeleton.md)). Task 6 needs the A0 spike results ([`2026-11-07-ads-a0-spike.md`](2026-11-07-ads-a0-spike.md) §7, groups G2 and G4).

## Global Constraints

- Risk **medium**: no schema change and no flag. It touches Finance, which is live in production, through a refactor that must not change behaviour. Environment local only. Workflow `.agentic/workflows/feature.md`; Task 1 also follows `refactor.md`.
- Branch from `origin/main` after A1 is merged; push to `main` only after Mario's go (`AGENTS.md`, "Main delivery workflow").
- `META_ADS_API_VERSION = "v27.0"` (A-D19). At A2 start, re-check Meta's current Marketing API version and record it in the plan §2.6 "Version" row. Never use Social's `META_GRAPH_VERSION` (`social/accounts/meta.ts:23`).
- No Meta, Google or OpenAI call from code or tests; tests never open a socket.
- No provider base-URL override in production code: the Graph origin is a constant. The only seam is `setMetaAdsFetchForTests`, which throws outside tests. This replaces the spec's guarded base-URL override (§13.2), because `boundedFetch` refuses loopback addresses by design and the repository's provider tests use in-memory transports.
- Tokens and app secrets appear only in the `authorization` header and in the HMAC input. They never appear in URLs, error messages, `ProviderFailure` objects, logs or fixtures. Provider user messages are truncated to 300 characters and passed through the same token-word redaction as `providerDetail` (`packages/connectors/src/http.ts:73-82`).
- Money: BigInt micros; a conversion that is not exact throws and never rounds silently (A-D10). `packages/money` stays provider-neutral (decimals as a parameter); Meta's currency offsets are Meta's own table and live in the Meta adapter (Task 3). This is how A2 realizes A-D10's "extend the currency table"; Finance keeps its own currency set.
- English in code, comments and docs.

## Review Focus

1. **Write that times out or gets a 5xx.** Expect: `outcome: "unknown"`, `retryable: false`, never "transient retry". Pinned in Task 2 (classifier rows) and Task 4 (client with a POST timeout).
2. **Follow-up page link to another host** (`paging.next` pointing elsewhere). Expect: never requested; the client pages only by `cursors.after` against the pinned Graph origin. Pinned in Task 4.
3. **Amount that does not fit the currency** (EUR budget of 15.005 or 12,345 micros). Expect: `ADS_AMOUNT_NOT_REPRESENTABLE`, nothing sent. Pinned in Task 3.
4. **Unknown or malformed usage headers.** Expect: ignored, no exception, the request result still returned. Pinned in Task 2.
5. **Finance amounts after the move** (same inputs, same micros, same `DomainError` code and status 422). Pinned in Task 1 by the unchanged `finance-money.test.ts`, `finance-fx.test.ts` and the finance suites.

---

### Task 1: `packages/money` and the Finance wrapper

**Files:**
- Create: `packages/money/src/index.ts`, `packages/money/src/index.test.ts` (no `package.json`; imported by relative path like `packages/module-contracts`; `infra/Dockerfile:22` already copies `packages/`)
- Modify: `apps/api/src/modules/finance/money.ts` (keeps `CURRENCY_DECIMALS`, `Currency`, `isCurrency` and every exported signature; delegates arithmetic to the package; maps `MoneyError` to `DomainError(code, 422)`, the status every current Finance money error uses)
- Modify: `scripts/boundaries.json` (zone `"package:money": ["packages/money/"]`; not in `serverPackages`)
- Modify: `apps/api/tests/finance-money.test.ts` (one added assertion only)

**Interfaces:**
- Produces from `packages/money/src/index.ts`:
  - `class MoneyError extends Error { readonly code: string }` (message = code)
  - `MICROS_PER_UNIT = 1_000_000n`
  - moved, with `decimals: number` instead of a currency: `parseAmount(text: string, decimals: number): bigint`, `roundHalfEven(micros: bigint, decimals: number): bigint`, `convert(micros: bigint, rate: string, toDecimals: number): bigint`, `formatMicros(micros: bigint, decimals: number): string`, `splitByBasisPoints(total: bigint, parts: { key: string; bp: number }[], decimals: number): { key: string; micros: bigint }[]`; same algorithms and codes as today (`AMOUNT_INVALID`, `CURRENCY_DECIMALS_INVALID`, `RATE_INVALID`, `ALLOCATION_INVALID`)
  - new: `minorToMicros(minor: bigint, decimals: number): bigint`; `microsToMinor(micros: bigint, decimals: number): bigint` (throws `AMOUNT_NOT_REPRESENTABLE`); `decimalToMicros(text: string): bigint` (strict `^\d+(\.\d{1,6})?$`, else `AMOUNT_INVALID`); `microsToDecimal(micros: bigint, decimals: number): string` (exactly `decimals` fraction digits; throws `AMOUNT_NOT_REPRESENTABLE`)
- `finance/money.ts` keeps `parseAmount(text, currency)`, `formatMicros(micros, currency)` and the rest unchanged for its 17 importers.

- [ ] **Step 1: Write the failing tests** in `packages/money/src/index.test.ts` (with the `code()` helper of `finance-money.test.ts`):

```ts
expect(minorToMicros(1234n, 2)).toBe(12_340_000n);
expect(minorToMicros(1234n, 0)).toBe(1_234_000_000n);
expect(microsToMinor(12_340_000n, 2)).toBe(1234n);
expect(code(() => microsToMinor(12_345n, 2))).toBe("AMOUNT_NOT_REPRESENTABLE");
expect(decimalToMicros("12.34")).toBe(12_340_000n);
expect(decimalToMicros("0.000001")).toBe(1n);
for (const bad of ["1.0000001", "1e3", "-5", "1,5", ""]) expect(code(() => decimalToMicros(bad))).toBe("AMOUNT_INVALID");
expect(microsToDecimal(12_340_000n, 2)).toBe("12.34");
expect(microsToDecimal(1_234_000_000n, 0)).toBe("1234");
expect(code(() => microsToDecimal(12_345n, 2))).toBe("AMOUNT_NOT_REPRESENTABLE");
expect(parseAmount("1.234,56", 2)).toBe(1_234_560_000n); // one case per moved function, same results as Finance today
```

In `finance-money.test.ts` add: `expect(() => parseAmount("abc", "EUR")).toThrow(DomainError)`, with code `AMOUNT_INVALID` and status 422.

- [ ] **Step 2: Run and see them fail** — `pnpm exec vitest run packages/money apps/api/tests/finance-money.test.ts` → FAIL (package missing).
- [ ] **Step 3: Implement** the package by moving the bodies of `finance/money.ts` (decimals instead of currency lookups), then reduce `finance/money.ts` to its currency table, `isCurrency`, the decimals lookup and wrappers that call the package and rethrow `MoneyError` as `DomainError(error.code, 422)`.
- [ ] **Step 4: Verify** — the two files PASS; `apps/api/tests/finance-fx.test.ts` and every `apps/api/tests/finance-*` suite PASS unchanged; `node scripts/source-check.mjs` PASS.
- [ ] **Step 5: Commit** — `git commit -m "refactor(money): move Finance arithmetic to packages/money without behaviour change"`

### Task 2: Seam types, Meta usage headers and error classification

**Files:**
- Create: `apps/api/src/modules/ads/providers/types.ts`, `providers/meta/usage.ts`, `providers/meta/errors.ts`
- Test: `apps/api/tests/ads-meta-errors.test.ts`

**Interfaces:**
- Produces in `types.ts`:

```ts
export type AdsProviderId = "meta" | "openai" | "google";
export type FailureKind = "rate_limited" | "auth" | "permission" | "validation" | "transient" | "unknown";
export type FailureOutcome = "not_sent" | "rejected" | "unknown";
export type ProviderFailure = {
  kind: FailureKind; code: string; outcome: FailureOutcome; retryable: boolean;
  retryAfterMs?: number; httpStatus?: number; providerCode?: number; providerSubcode?: number;
  traceId?: string; fieldPaths: string[]; userTitle?: string; userMessage?: string;
};
export type FailureInput = { write: boolean; httpStatus?: number; body?: unknown; headers?: Headers; transport?: ConnectorError };
export type ThrottleHint = { buckets: { bucket: string; usagePct: number; regainMs?: number }[]; accessTier?: "limited" | "full" };
export type ProviderManifest = { apiVersion: string; currencyUnit: "minor" | "micros"; validateOnly: boolean };
export interface AdsProvider {
  id: AdsProviderId; manifest: ProviderManifest;
  errors: { classify(input: FailureInput): ProviderFailure };
  usage: { parse(headers: Headers): ThrottleHint };
}   // connect (A3), read (A4) and write (A7) join this interface in their steps
export class AdsProviderError extends Error { constructor(readonly failure: ProviderFailure) }   // message = failure.code
```

- `parseMetaUsage(headers: Headers): ThrottleHint` in `usage.ts`:
  - `x-business-use-case-usage` (`{ <id>: [{ type, call_count, total_cputime, total_time, estimated_time_to_regain_access, ads_api_access_tier }] }`) → bucket `meta_<type>`, `usagePct` = max of the three percentages, `regainMs` = minutes × 60 000 when > 0.
  - `x-ad-account-usage` (`acc_id_util_pct`, `reset_time_duration` in seconds) → `meta_ad_account`.
  - `x-app-usage` → `meta_app`.
  - `x-fb-ads-insights-throttle` (`app_id_util_pct`, `acc_id_util_pct`) → `meta_insights_throttle`.
  - `accessTier`: `development_access` or a value starting with `limited` → `"limited"`; `standard_access` or a value starting with `full` → `"full"`; anything else omitted. A0 Q3 confirms the real values; Task 6 pins them.
  - A header that is not valid JSON is skipped; the function never throws.
- `classifyMetaFailure(input: FailureInput): ProviderFailure` in `errors.ts`, rules in this order (Graph error = `body.error` with `code`, `error_subcode`, `is_transient`, `error_user_title`, `error_user_msg`, `fbtrace_id`, `error_data.blame_field_specs`):

| # | Condition | kind | code | outcome | retryable, delay |
| --- | --- | --- | --- | --- | --- |
| 1 | `transport` set (a `ConnectorError`) | transient | `ADS_PROVIDER_UNAVAILABLE` | `transport.outcome` | only when `not_sent` |
| 2 | code 190 or 102, or HTTP 401 without a code | auth | `ADS_META_TOKEN_INVALID` | rejected | no |
| 3 | code 10 or 200–299, or code or subcode 1713092, 1815694, 2708008 (re-checked 2026-11-08) | permission | `ADS_META_PERMISSION_MISSING` | rejected | no |
| 4 | code 613 with subcode 4841018 | rate_limited | `ADS_META_CONCURRENT_EDIT` | rejected | yes, 30 s |
| 5 | code 368, or code or subcode 1404078, 2859015 (re-checked 2026-11-08) | rate_limited | `ADS_META_TEMPORARILY_BLOCKED` | rejected | yes, 1 h |
| 6 | code 4, 17, 32, 341, 613 or 80000–80014, or HTTP 429 | rate_limited | `ADS_META_RATE_LIMITED` | rejected | yes; the largest `regainMs` of `parseMetaUsage(headers)`, else 60 s |
| 7 | code 100, or `blame_field_specs` present | validation | `ADS_PROVIDER_VALIDATION` | rejected | no; `fieldPaths` = each blame spec joined with `.`; user title and message kept |
| 8 | code 1, 2 or 5000, any negative code, code or subcode 3910001, `is_transient: true`, or HTTP ≥ 500 (re-checked 2026-11-08) | transient | `ADS_PROVIDER_UNAVAILABLE` | write: `unknown`; read: `rejected` | write: no; read: yes, 5 s |
| 9 | any other HTTP 4xx with a Graph error | validation | `ADS_PROVIDER_REJECTED` | rejected | no |
| 10 | non-2xx without a Graph error, or a 2xx body that fails the expected schema | unknown | `ADS_PROVIDER_RESPONSE_INVALID` | write: `unknown`; read: `rejected` | write: no; read: yes, 5 s |

  Every failure carries `httpStatus`, `providerCode`, `providerSubcode` and `traceId` when present. Re-check the code list against Meta's error reference at A2 start; differences go into the plan's §2.6 "Rate limits" row and this table.

- [ ] **Step 1: Write the failing tests** — one table-driven test per row above (with `write: true` and `write: false` for rows 1, 8 and 10); a rate-limit case whose `x-business-use-case-usage` says `estimated_time_to_regain_access: 7` → `retryAfterMs: 420_000`; a usage test per header with a sample value and the expected bucket; a malformed header (`"{"`) → `{ buckets: [] }` without throwing; a user message containing `access_token=EAAB…` is redacted, and one of 1 000 characters is cut to 300.
- [ ] **Step 2: Run and see them fail** — `pnpm exec vitest run apps/api/tests/ads-meta-errors.test.ts` → FAIL.
- [ ] **Step 3: Implement** the three files.
- [ ] **Step 4: Verify** — PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(ads): provider seam types, Meta usage headers and error classification"`

### Task 3: Meta currency units

**Files:**
- Create: `apps/api/src/modules/ads/providers/meta/money.ts`
- Test: `apps/api/tests/ads-meta-money.test.ts`

**Interfaces:**
- Consumes: `minorToMicros`, `microsToMinor`, `decimalToMicros`, `microsToDecimal` (Task 1).
- Produces:
  - `META_CURRENCY_OFFSETS: Readonly<Record<string, number>>`, copied from Meta's currency page (https://developers.facebook.com/docs/marketing-api/currencies) with the read date in a comment.
  - `metaDecimals(currency: string): number` (offset 100 → 2, offset 1 → 0; any other offset → its base-10 exponent; unknown currency → `DomainError("ADS_CURRENCY_UNSUPPORTED", 422)`).
  - `metaMinorToMicros(value: string | number, currency: string): bigint`, for budgets, `amount_spent` and the `spend_cap` as read (integer only, else `ADS_PROVIDER_RESPONSE_INVALID`).
  - `microsToMetaMinor(micros: bigint, currency: string): string`, for budgets as written (`ADS_AMOUNT_NOT_REPRESENTABLE` 422 when not exact).
  - `metaMajorToMicros(text: string): bigint`, for insights `spend`.
  - `microsToMetaMajor(micros: bigint, currency: string): string`, for the account `spend_cap` as written: major units, Meta's read/write asymmetry (§2.6 "Money").

- [ ] **Step 1: Write the failing tests:** `metaMinorToMicros("1500", "EUR") === 15_000_000n`; `metaMinorToMicros("1500", "JPY") === 1_500_000_000n`; `microsToMetaMinor(15_000_000n, "EUR") === "1500"`; `microsToMetaMinor(15_005_000n, "EUR")` throws `ADS_AMOUNT_NOT_REPRESENTABLE`; `microsToMetaMajor(100_000_000n, "USD") === "100.00"`; `microsToMetaMajor(1_500_000_000n, "JPY") === "1500"`; `metaMajorToMicros("12.34") === 12_340_000n`; `metaDecimals("XYZ")` throws `ADS_CURRENCY_UNSUPPORTED`; `metaMinorToMicros("12.5", "EUR")` throws `ADS_PROVIDER_RESPONSE_INVALID`. Every currency in the table converts `metaMinorToMicros(microsToMetaMinor(x))` back to `x` for `x = 10n ** 6n * 7n`. Confirm against the page that EUR and USD have offset 100 and JPY offset 1, and adjust the expectations to the page if it differs.
- [ ] **Step 2: Run and see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify** — PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(ads): exact Meta currency units"`

### Task 4: Meta Graph client and the fake Graph

**Files:**
- Create: `apps/api/src/modules/ads/providers/meta/{version.ts, transport.ts, graph.ts}`
- Create: `apps/api/tests/support/fake-meta-graph.ts`
- Test: `apps/api/tests/ads-meta-graph.test.ts`

**Interfaces:**
- Consumes: `classifyMetaFailure`, `parseMetaUsage`, `AdsProviderError`, `ThrottleHint` (Task 2).
- Produces:
  - `META_ADS_API_VERSION = "v27.0"`, ``META_ADS_GRAPH = `https://graph.facebook.com/${META_ADS_API_VERSION}` `` (`version.ts`).
  - `metaAdsFetch: FetchLike` = `boundedFetchWith({ maxResponseBytes: 8 * 1024 * 1024 })` (insights pages exceed the 2 MB default), with a 20 s `AbortSignal.timeout` unless the caller passes a signal; `setMetaAdsFetchForTests(fetch: FetchLike | null): void`, which throws `Error("test only")` unless `process.env.VITEST === "true" || process.env.NODE_ENV === "test"` (`transport.ts`).
  - In `graph.ts`:
    - `appSecretProof(accessToken: string, appSecret: string): string` (HMAC-SHA256 hex, `node:crypto`).
    - `createMetaGraphClient(credentials: { accessToken: string; appSecret: string }): MetaGraphClient`, where `MetaGraphClient` is:
      - `get<T>(path: string, params: Record<string, string>, schema: z.ZodType<T>): Promise<{ data: T; usage: ThrottleHint; traceId?: string }>`
      - `post<T>(path: string, form: Record<string, string>, schema: z.ZodType<T>): Promise<{ data: T; usage: ThrottleHint; traceId?: string }>`
      - `page<T>(path: string, params: Record<string, string>, item: z.ZodType<T>, after?: string): Promise<{ items: T[]; after?: string; usage: ThrottleHint }>` (`after` is undefined on the last page; the caller persists it, A4)
  - Rules:
    - `path` must match `^/[A-Za-z0-9_]+(/[A-Za-z0-9_]+)*$`.
    - `params` and `form` must not contain `access_token` or `appsecret_proof`. Both violations throw a plain `Error` (a programming error).
    - GET puts `appsecret_proof` in the query. POST sends `application/x-www-form-urlencoded` with the form fields and `appsecret_proof`.
    - Both send `authorization: Bearer <token>`.
    - A non-2xx answer, a transport error or a 2xx body that fails the schema throws `AdsProviderError` with `classifyMetaFailure` (a schema failure is row 10 of Task 2, with `httpStatus` 200).
    - `paging.next` is never requested.
- Fake (`fake-meta-graph.ts`):
  - `createFakeMetaGraph(): { fetch: FetchLike; on(method: "GET" | "POST", path: string, reply: FakeReply | FakeHandler): void; requests: FakeRequest[] }`
    - `path` is given without the version.
    - A request outside `/v27.0/` or to an unregistered route throws, so the test fails loudly.
  - `FakeRequest = { method; path; query: URLSearchParams; form?: URLSearchParams; authorization: string | null }`
  - `FakeReply = { status?: number; json?: unknown; headers?: Record<string, string> } | { throw: ConnectorError }`
  - Helpers:
    - `graphError(status, code, extra?: { subcode?; transient?; userTitle?; userMessage?; blame?: string[][] })`
    - `usageHeaders({ type?, callCount?, regainMinutes?, tier? })`
    - `sequence(...replies)` (the last reply repeats; async report polling and page series use it)
    - `afterCommit(apply: () => void, reply)` (runs `apply`, then answers, e.g. with 500: "the write took effect, the answer was lost")

- [ ] **Step 1: Write the failing tests** (credentials `{ accessToken: "test-access-token-0001", appSecret: "test-app-secret-0123456789" }`):
  - `sends the token only in the authorization header` — the URL does not contain the token, and the header is `Bearer test-access-token-0001`.
  - `signs every call` — `appsecret_proof` equals `a220b78fcb7c0e661a88e7a04803dff413c58eb8f7506d633c6f9d600f3083f4`.
  - `calls the pinned version` — every recorded URL starts with `https://graph.facebook.com/v27.0/`.
  - `posts a form with the proof in the body` — content type form-urlencoded, body has `appsecret_proof`, no `access_token` anywhere.
  - `refuses reserved or unsafe input` — `params: { access_token: "x" }`, path `/act_1/../me` and path `/act_1?x=1` throw before any request.
  - `pages by cursor and never follows next links` — page 1 answers `paging: { cursors: { after: "c2" }, next: "https://evil.example/x" }`; the second request is `GET /v27.0/act_1/campaigns?…&after=c2`; page 2 without `next` returns `after: undefined`; no request goes to another host.
  - `classifies a Graph error` — `graphError(400, 100, { blame: [["special_ad_categories"]] })` → `AdsProviderError` with `kind: "validation"` and `fieldPaths: ["special_ad_categories"]`; `JSON.stringify(error.failure)` and `error.message` contain neither the token nor the app secret.
  - `treats a lost write as unknown` — a POST answered with `{ throw: new ConnectorError("REQUEST_TIMEOUT", "unknown") }` → `outcome: "unknown"`, `retryable: false`; a GET with outcome `not_sent` → `retryable: true`; `afterCommit(…, { status: 500 })` on a POST → `outcome: "unknown"`.
  - `rejects a 2xx body that fails the schema` → `ADS_PROVIDER_RESPONSE_INVALID`.
  - `returns usage with each answer` — `usageHeaders({ type: "ads_management", callCount: 80 })` → bucket `meta_ads_management` at 80.
  - `refuses the test hook outside tests` — with `VITEST` and `NODE_ENV` unset (restored afterwards), `setMetaAdsFetchForTests` throws.
- [ ] **Step 2: Run and see them fail** — `pnpm exec vitest run apps/api/tests/ads-meta-graph.test.ts` → FAIL.
- [ ] **Step 3: Implement** the three files and the fake.
- [ ] **Step 4: Verify** — PASS; `rg -n "graph.facebook.com" apps/api/src/modules/ads` shows only `version.ts`.
- [ ] **Step 5: Commit** — `git commit -m "feat(ads): pinned, signed Meta Graph client and a fake Graph for tests"`

### Task 5: Meta provider and registry

**Files:**
- Create: `apps/api/src/modules/ads/providers/meta/provider.ts`, `providers/registry.ts`
- Test: `apps/api/tests/ads-providers.test.ts`

**Interfaces:**
- Produces:
  - `metaAdsProvider: AdsProvider = { id: "meta", manifest: { apiVersion: META_ADS_API_VERSION, currencyUnit: "minor", validateOnly: true }, errors: { classify: classifyMetaFailure }, usage: { parse: parseMetaUsage } }`
  - `adsProvider(id: AdsProviderId): AdsProvider | null` (`meta` only; `openai` after gate O0, `google` after gate G0)
  - `adsProviderIds(): AdsProviderId[]` → `["meta"]`

- [ ] **Step 1: Write the failing tests:**
  - `adsProvider("meta")` is `metaAdsProvider`;
  - `adsProvider("openai")` and `adsProvider("google")` are `null`;
  - `metaAdsProvider.manifest.apiVersion === META_ADS_API_VERSION`.
- [ ] **Step 2: Run and see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify** — PASS; `node scripts/source-check.mjs` PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(ads): provider registry with the Meta provider"`

### Task 6: Recorded fixtures and the contract test (after A0 G2/G4)

**Files:**
- Create: `apps/api/tests/fixtures/ads/meta/*.json` (sanitized from `~/orbit-ads-spike/`: R1 `me`, R3 `adaccounts` two pages, R5 sandbox account, V2 missing-category error, a rate-limit or usage header set, W3 image upload answer), `apps/api/tests/fixtures/ads/meta/SOURCES.md` (fixture → A0 call, recording date, what was replaced)
- Test: `apps/api/tests/ads-meta-contract.test.ts`

**Interfaces:**
- Consumes: the fake (Task 4), `classifyMetaFailure`, `parseMetaUsage` (Task 2), Meta money helpers (Task 3).

Sanitizing rules:
- ids become synthetic (`act_1000000001`, page `2000000001`, business `3000000001`);
- names and texts become neutral;
- no token, `fbtrace_id`, e-mail address or personal name.
Mario reviews the fixture diff before the commit (A0 §8).

- [ ] **Step 1: Write the failing contract tests:**
  - the V2 fixture classifies as `validation` with a field path containing `special_ad_categories`;
  - the usage fixture yields the access tier A0 Q3 recorded (and Task 2's tier mapping is corrected if Q3 differs);
  - the account fixture's `amount_spent` and `spend_cap` convert exactly with its `currency` (Q11);
  - paging over the two `adaccounts` pages through the fake returns all items and ends with `after: undefined`;
  - a scan of the fixture folder finds no `EAA[A-Za-z0-9]{20,}`, no `@`-address and only synthetic `act_` ids.
- [ ] **Step 2: Run and see them fail** (fixtures missing).
- [ ] **Step 3: Add the sanitized fixtures and `SOURCES.md`.**
- [ ] **Step 4: Verify** — PASS.
- [ ] **Step 5: Commit** — `git commit -m "test(ads): Meta contract tests on sanitized A0 recordings"`

### Task 7: Documentation and full check

**Files:**
- Modify: `docs/ADS.md` (section "Meta transport": version policy and upgrade checklist, the error table of Task 2, usage buckets, money rules including the `spend_cap` asymmetry, the test hook), `docs/IMPLEMENTATION_STATUS.md`, `docs/REQUIREMENTS_TRACEABILITY.md` (Ads rows for the official-API-only rule and money), the line naming `finance/money.ts` in `docs/REQUIREMENTS_TRACEABILITY.md` (now also `packages/money`), `docs/superpowers/plans/2026-11-07-ads-module.md` (§12.1 row A2 done, §2.6 rows re-checked in Tasks 2–4)

- [ ] **Step 1: Write the docs.**
- [ ] **Step 2: Run the full required checks** — `pnpm lint && pnpm typecheck && pnpm test && pnpm build`; all green, integration suites executed.
- [ ] **Step 3: Review the diff** against `.agentic/quality-gates/definition-of-done.md`, `review-checklist.md` and `security-checklist.md` (token handling, test hook guard, no network in tests).
- [ ] **Step 4: Commit** — `git commit -m "docs(ads): A2 provider seam, Meta transport and money"`

## Done when

- Every Graph call goes through one client: pinned to `v27.0`, signed with `appsecret_proof`, token in the header only, paging by cursor only, every failure classified per the table.
- Meta amounts convert to micros and back exactly, or the call is refused.
- Finance behaves exactly as before (unchanged tests green).
- The fake Graph covers success, Graph errors, rate limits with headers, timeouts, lost writes, schema mismatches and paging; Task 6 runs on sanitized A0 recordings.
- **Rollback:** revert the commits. Nothing persists and no flag changes; the Finance wrapper keeps its public signatures, so a revert of Task 1 alone is safe.
