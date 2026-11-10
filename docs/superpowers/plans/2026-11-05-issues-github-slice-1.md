# Issue center ↔ GitHub, slice 1 (WP3.10a) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An owner creates a GitHub issue from a share-reviewed Orbit issue (or links an existing one) in an allow-listed private repository, with exactly-once creation and a stored `IssueExternalRef`.

**Architecture:** A platform GitHub App client and `github_app` connection provider (ADR 0014 grants) mint per-call, per-repository installation tokens. The issues module owns the allow-list (settings), a pure body builder, a request entity plus worker job with reconcile-before-retry, routes, one ActionRequest proposal and the web UI. No schema migration.

**Tech Stack:** TypeScript, Fastify, Prisma (`entity` store, `IssueExternalRef`), worker jobs (`enqueue`), zod, vitest, React (Next.js web).

**Spec:** `docs/superpowers/specs/2026-11-05-issues-github-design.md`

## Global Constraints

- Flag `ORBIT_ISSUES_GITHUB` (`"false"|"true"`, default `"false"`); all new issues routes answer 404 `ISSUES_GITHUB_DISABLED` while off; effective only with `ORBIT_ISSUES` and `ORBIT_CONNECTIONS`.
- Every new action requires `issues.github` (owner-only, sensitive; unchanged). Proposal decider role: `owner`.
- Token permission maps, exactly: create `{ issues: "write", metadata: "read" }`; link/refresh/repo check `{ issues: "read", metadata: "read" }`; always `repositories: [<one name>]`.
- GitHub base `https://api.github.com` only; `redirect: "error"`; timeout 20 s; response body ≤ 1 MB before parsing; header `X-GitHub-Api-Version: 2026-03-10` (as knowledge).
- Private, non-archived repositories only, checked when saving the allow-list and before every write. Allow-list max 20 entries.
- GitHub text = `shareableFields(issue)` + Orbit link only, then `redact(…, { profile: "strict" })`; any hit refuses with `ISSUES_GITHUB_REDACTION_HIT` (counts only). Never reports, diagnostics, environment, release, ticket ids, names, AI triage.
- No schema migration, no new production dependency (`node:crypto` for RS256).
- `scripts/boundaries.json`: issues imports platform only; platform names no module. Do not touch `apps/api/src/modules/knowledge/github.ts`.
- Code and docs English; UI labels en + de.
- Delivery: commits on `claude/jolly-haslett-d18222`; push to `main` only with Mario's OK.

## Review Focus

1. A job retried after a timeout must not create a second GitHub issue (marker reconcile) — Task 4 test `reconciles after an unclear create`.
2. A PEM pasted into the single-line admin password field (newlines lost) must still work — Task 1 test `normalizePem restores a flattened key`.
3. Old stored issues settings without `github`, and components whose `repository` points to a former work key, must keep loading — Task 2 tests.
4. Issue edited (share review cleared) or grant revoked between click and job → `failed`, nothing sent — Task 4 tests.
5. A pasted GitHub URL of a pull request, another host or a repo outside the allow-list must be refused without any fetch — Task 3 + Task 5 tests.

---

### Task 1: Platform GitHub App client, connection provider and flag

**Files:**
- Create: `apps/api/src/platform/connections/github-app.ts`
- Modify: `apps/api/src/platform/modules/platform-contributions.ts` (add `[GITHUB_APP_PROVIDER]: githubAppConnectionProvider` next to `n8n`)
- Modify: `packages/config/src/index.ts` (after `ORBIT_ISSUES`: `ORBIT_ISSUES_GITHUB: z.enum(["false","true"]).default("false")` with a comment), `.env.example`, `docker-compose.yml`, `docker-compose.pve.yml` (`ORBIT_ISSUES_GITHUB: ${ORBIT_ISSUES_GITHUB:-false}` next to `ORBIT_ISSUES`)
- Modify: `apps/web/src/platform/administration/connections-ui.tsx` (secret hint: add "GitHub App: JSON with appId, appSlug, installationId and privateKey" in en/de)
- Test: `apps/api/tests/github-app.test.ts`

**Interfaces:**
- Produces (all exported from `github-app.ts`):
  - `GITHUB_APP_PROVIDER = "github_app"`, `GITHUB_ISSUES_PURPOSE = "issues"`
  - `type GithubAppSecret = { appId: string; appSlug: string; installationId: string; privateKey: string }`
  - `parseGithubAppSecret(raw: string): GithubAppSecret` — zod `appId`/`installationId` `/^\d{1,20}$/`, `appSlug` `/^[a-z0-9-]{1,100}$/`, `privateKey` 100–20000 chars → `normalizePem`; invalid → `DomainError("GITHUB_APP_INVALID", 409)`
  - `normalizePem(raw: string): string`
  - `githubAppJwt(app: GithubAppSecret, now?: Date): string`
  - `type GithubPermissions = Partial<Record<"issues" | "metadata", "read" | "write">>`
  - `installationToken(app: GithubAppSecret, req: { repositories: string[]; permissions: GithubPermissions }): Promise<string>` (`repositories` = repo names without owner)
  - `githubFetch<T = unknown>(path: string, token: string, init?: RequestInit): Promise<T>`
  - `getRepository(app, fullName: string): Promise<{ fullName: string; private: boolean; archived: boolean }>` (uses an `issues: read` token)
  - `installationRepositories(app: GithubAppSecret): Promise<Array<{ fullName: string; private: boolean; archived: boolean }>>`
  - `setGithubFetchForTests(next: FetchLike | null): void` (`FetchLike`, `boundedFetch` from `packages/connectors/src/index.ts`, as in `platform/automation/workflows.ts`)
  - `githubAppConnectionProvider: ConnectionProvider` — `scopes: ["system","workspace"]`, `purposes: [GITHUB_ISSUES_PURPOSE]`, label `{ en: "GitHub App", de: "GitHub-App" }`, `check(connection, credential)` → `{ status: "read_verified", capabilities: ["github_issues"], account: <login> }`
  - Error codes: 401/404/410 → `GITHUB_RECONNECT_REQUIRED`; 403/429 → `GITHUB_ACCESS_OR_RATE_LIMIT`; 422 → `GITHUB_VALIDATION_FAILED`; 5xx, network, timeout → `GITHUB_UNAVAILABLE`; body > 1 MB → `GITHUB_RESPONSE_TOO_LARGE`; all `DomainError(code, 409)`. Export `class GithubSendError extends DomainError` with `sent: boolean` so callers can tell "maybe sent" (network/timeout/5xx after the request left) from definite refusals.

- [ ] **Step 1: Write failing tests** in `apps/api/tests/github-app.test.ts` with a generated RSA key (`generateKeyPairSync("rsa", { modulusLength: 2048 })`) and a recording fake transport:
  - `normalizePem restores a flattened key`: PEM with newlines replaced by spaces, and with literal `\n`, both → `createPrivateKey()` succeeds and equals the original export.
  - `parseGithubAppSecret refuses missing fields and non-JSON` → code `GITHUB_APP_INVALID`; the error message never contains the key.
  - `githubAppJwt signs RS256 with iat −60 s and exp +9 min, iss = appId` (verify with the public key).
  - `installationToken asks for exactly one repository and the given permissions`: recorded request is `POST https://api.github.com/app/installations/{id}/access_tokens`, body `{"repositories":["web"],"permissions":{"issues":"write","metadata":"read"}}`, `Authorization: Bearer <jwt>`.
  - `githubFetch maps statuses`: 401→`GITHUB_RECONNECT_REQUIRED`, 403/429→`GITHUB_ACCESS_OR_RATE_LIMIT`, 422→`GITHUB_VALIDATION_FAILED`, 503→`GITHUB_UNAVAILABLE` with `sent: true`, thrown transport error→`GITHUB_UNAVAILABLE` `sent: true`, 1 MB + 1 byte → `GITHUB_RESPONSE_TOO_LARGE`; request uses `redirect: "error"` and the API version header.
  - `githubFetch refuses paths that are not API paths` (`"https://evil.example/x"`, `"//evil"`) before any transport call.
  - `installationRepositories pages and caps at 500`.
  - `check reports read_verified with the account login`.
- [ ] **Step 2: Run** `pnpm vitest run apps/api/tests/github-app.test.ts` (with the worktree env per README) — Expected: FAIL, module not found.
- [ ] **Step 3: Implement** `github-app.ts` with the interfaces above (`createSign("RSA-SHA256")`, base64url JWT; path must match `/^\/[A-Za-z0-9/_.?=&%-]*$/`). Register the provider; add the flag and compose/env/hint lines.
- [ ] **Step 4: Run** the test file and `pnpm typecheck` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(platform): GitHub App client and connection provider (WP3.10a)`.

### Task 2: Issues settings — repository allow-list and GitHub status

**Files:**
- Modify: `apps/api/src/modules/issues/settings.ts` (schema + defaults; `components[].repository` doc comment → key of `github.repositories`)
- Modify: `apps/api/src/modules/issues/gate.ts` (add `issuesGithubSwitchedOn()` and `requireIssuesGithub()` → 404 `ISSUES_GITHUB_DISABLED`)
- Create: `apps/api/src/modules/issues/github-connection.ts`
- Modify: `apps/api/src/modules/issues/routes.ts` (settings save path; `GET /github/status`)
- Test: `apps/api/tests/issues-module.test.ts` (schema), `apps/api/tests/issues-github.integration.test.ts` (new; same setup as `issues-routes.integration.test.ts`, plus a system `github_app` connection via `createConnection` with a test key, a grant to the project with purposes `["issues"]`, and `setGithubFetchForTests`)

**Interfaces:**
- Consumes: Task 1 exports.
- Produces:
  - settings key `github: { repositories: Array<{ key: string; fullName: string }> }` (key = existing `key` regex, `fullName` = `/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/`, max 20, unique keys and unique fullNames); default `{ repositories: [] }`
  - `githubApp(tx: DbTx, scope: Scope): Promise<{ connectionId: string; app: GithubAppSecret }>` — `resolveConnection(tx, scope, { provider: GITHUB_APP_PROVIDER, purpose: GITHUB_ISSUES_PURPOSE })` + `connectionSecret`; none → `DomainError("ISSUES_GITHUB_NOT_CONNECTED", 409)`
  - `allowedRepository(settings: IssuesSettings, key: string): { key: string; fullName: string }` → else `ISSUES_GITHUB_REPOSITORY_NOT_ALLOWED` (409)
  - `componentRepository(settings, components: string[]): string | null` — first component whose `repository` is an allow-list key
  - `githubStatus(tx, scope)` → `{ connected: boolean, account?: string, repositories: settings.github.repositories, available?: Array<{fullName, private, archived}> }` (available only when connected; GitHub errors → `connected: true, error: code`)
  - Saving settings: when `github.repositories` differs from the stored value, the route also requires `issues.github` (403 otherwise) and checks every new `fullName` via `installationRepositories` (unknown, public or archived → `ISSUES_GITHUB_REPOSITORY_NOT_ALLOWED`). The external read happens before the settings transaction.

- [ ] **Step 1: Write failing tests:**
  - module test `old settings without github parse with an empty allow-list`: `issuesSettingsSchema.parse(defaultIssuesSettings())` has `github.repositories = []`; duplicate keys or fullNames, 21 entries → throw.
  - integration `GET /issues/github/status`: flag off → 404 `ISSUES_GITHUB_DISABLED`; editor → 403; owner without grant → `{ connected: false }`; with grant → lists fake repos.
  - integration `saving the allow-list`: public repo → 409 `ISSUES_GITHUB_REPOSITORY_NOT_ALLOWED`; unknown repo → same; private repo → 200; a component with `repository: "web"` resolves via `componentRepository`, one pointing to an unknown key → `null`.
- [ ] **Step 2: Run** both files — Expected: FAIL.
- [ ] **Step 3: Implement** the schema, gate helpers, `github-connection.ts` and the routes.
- [ ] **Step 4: Run** both files — Expected: PASS.
- [ ] **Step 5: Commit** `feat(issues): GitHub repository allow-list and status (WP3.10a)`.

### Task 3: Body builder and GitHub URL parser (pure)

**Files:**
- Create: `apps/api/src/modules/issues/github-body.ts`
- Test: `apps/api/tests/issues-github-body.test.ts`

**Interfaces:**
- Consumes: `shareableFields` return type from `apps/api/src/modules/issues/issues.ts`, `redact` from `apps/api/src/platform/privacy/redact.ts`.
- Produces:
  - `githubIssueText(fields: ReturnType<typeof shareableFields>, input: { requestId: string; orbitUrl: string }): { title: string; body: string; hits: Record<string, number> }` — `hits` = summed `redact(..., { profile: "strict" }).counts` of title and body (only detectors with count > 0); `title`/`body` are the unredacted text. `DomainError` takes no details, so callers decide: `assertNoHits(text)` throws `DomainError("ISSUES_GITHUB_REDACTION_HIT", 409)`; the preview returns `hits` instead
  - `issueOrbitUrl(projectId: string, issueId: string): string` = `new URL(\`/p/${projectId}/issues/list?issue=${issueId}\`, loadConfig().APP_ORIGIN).href` (pattern of `support/mcp-read.ts`)
  - `REQUEST_MARKER = (requestId: string) => \`<!-- orbit-ref:${requestId} -->\``
  - `parseGithubIssueUrl(url: string): { fullName: string; number: number }` — only `https://github.com/{owner}/{repo}/issues/{n}` (no query/fragment beyond ignoring a trailing `#…`), else `ISSUES_GITHUB_URL_INVALID`
  - `githubExternalId(fullName, number) = \`${fullName}#${number}\``

Body layout (exact):
```
<!-- orbit-ref:{requestId} -->
Orbit-Issue: {key}

**Type:** {type} · **Severity:** {severity or "—"} · **Components:** {components joined ", " or "—"}

{summary}

### Acceptance criteria
- {criterion}          (section omitted when empty)

[Open in Orbit]({orbitUrl})
```
Title: `[{key}] {title}` truncated to 256 chars.

- [ ] **Step 1: Write failing tests:**
  - `builds the exact layout` for a fixture issue (compare full string).
  - canaries, each placed in summary or a criterion: `kunde.weber@example.org`, `+49 170 1234567`, `DE89370400440532013000`, `0x52908400098527886E0F7030069857D2E4169EE7`, `ghp_` + 36 chars → non-empty `hits`; `assertNoHits` throws `ISSUES_GITHUB_REDACTION_HIT` and the error's JSON contains none of them.
  - `parseGithubIssueUrl` accepts `https://github.com/eds-labs/orbit/issues/12`; refuses `/pull/12`, `http://`, `https://github.com.evil.example/...`, `https://gist.github.com/...`, missing number.
  - `title is truncated to 256 characters`.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement** `github-body.ts`.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `feat(issues): redacted GitHub issue text (WP3.10a)`.

### Task 4: Create request, preview and worker job with reconcile

**Files:**
- Create: `apps/api/src/modules/issues/github.ts`
- Modify: `apps/api/src/modules/issues/jobs.ts` (register `ISSUES_GITHUB` queue class), `contributions.ts` (add `"issues.github.linked"` and `"issues.github.unlinked"` to `ISSUES_EVENTS`), `routes.ts`, `queries.ts` (detail adds `githubRequests`: latest 10 request entities of the issue with `status`, `repository`, `code`, `requestedAt`)
- Test: `apps/api/tests/issues-github.integration.test.ts`

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces:
  - `ISSUES_GITHUB = "issues_github"` (queue class), entity kind `REQUEST_KIND = "issues_github_request"`
  - Request entity data: `{ issueId, repositoryKey, fullName, requestId, status: "queued"|"sending"|"done"|"failed"|"outcome_unknown", attempts, requestedAt, requestedBy, issueVersion, code?, externalId? }`
  - `previewGithubIssue(tx, scope, issueId: string, repositoryKey: string): Promise<{ title: string; body: string; repository: string; hits: Record<string, number> }>` (when `hits` is non-empty the UI shows the detector names and no confirm button) (uses a placeholder request id `00000000-0000-0000-0000-000000000000`)
  - `requestGithubIssue(tx, scope, issueId: string, repositoryKey: string, actor: IssueActor): Promise<{ requestId: string; status: "queued" }>` — checks in spec §5.2 "Request" order; enqueue `enqueue(tx, scope, ISSUES_GITHUB, entityId, \`issues-github:${entityId}\`)`; `IssueEvent` `github_requested`; audit `issues.github.requested`
  - `runGithubCreate(scope: Scope, requestEntityId: string): Promise<void>` — job steps 1–6 of spec §5.2; external calls outside `scoped(...)`; on `GithubSendError` with `sent: true` keep `sending` and rethrow; when the job is on its last attempt (`job.attempts + 1 >= job.maxAttempts`) set `outcome_unknown` instead of rethrowing
  - `reconcileGithubRequest(scope, requestEntityId, actor): Promise<{ status: "done" | "outcome_unknown" }>` — list `GET /repos/{fullName}/issues?creator={appSlug}%5Bbot%5D&state=all&since={requestedAt}&per_page=100` (≤ 3 pages), match `REQUEST_MARKER`, link if found; never creates
  - Routes (`issues.github`, `requireIssuesGithub`): `POST /issues/:id/github/preview` `{ repository }`, `POST /issues/:id/github` `{ repository }`, `POST /github/requests/:id/reconcile`

- [ ] **Step 1: Write failing integration tests** (fake transport records calls; run the job via `registeredJobs()` like `issues-routes.integration.test.ts`):
  - `creates one GitHub issue and links it`: confirmed + share-reviewed issue, owner `POST /github` → `queued`; job → one `POST /repos/o/web/issues`, ref `{ system: "github", externalId: "o/web#7", state: "open" }`, request `done`, one `IssueEvent github_linked`, audit `issues.github.linked`, one domain event.
  - `reconciles after an unclear create`: first POST throws a transport error → request `sending`, job rethrows; second run lists issues, finds the marker → links `o/web#7`, total POST count 1.
  - `marks outcome_unknown on the last attempt and reconcile links later`.
  - `a definite 422 fails without retry` → `failed`, `code: "GITHUB_VALIDATION_FAILED"`, no second POST.
  - `refuses without share review / unconfirmed / duplicate status / already linked in this repository` (409 codes per spec §7).
  - `fails in the job when the issue was edited, the grant revoked or the repo became public` → `failed` with `ISSUES_SHARE_REVIEW_REQUIRED` / `ISSUES_GITHUB_NOT_CONNECTED` / `ISSUES_GITHUB_REPOSITORY_PUBLIC`; zero POSTs.
  - `preview returns the exact text and writes nothing`; editor → 403; flag off → 404.
  - privacy canary: a ticket-linked report containing `kunde.weber@example.org` never appears in any recorded request body.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement** `github.ts`, job registration, events, routes, detail query.
- [ ] **Step 4: Run** the integration file plus `issues-routes`, `issues-services` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(issues): create GitHub issues exactly once (WP3.10a)`.

### Task 5: Link existing, refresh, unlink

**Files:**
- Modify: `apps/api/src/modules/issues/github.ts`, `routes.ts`
- Test: `apps/api/tests/issues-github.integration.test.ts`

**Interfaces:**
- Produces:
  - `linkGithubIssue(scope, issueId, url: string, actor): Promise<ExternalRefView>` — parse (Task 3) → allow-list by `fullName` → read `GET /repos/{fullName}/issues/{n}` with an `issues: read` token → refuse when `pull_request` present (`ISSUES_GITHUB_URL_INVALID`) → create ref (`state` = GitHub `state`); unique violation → `ISSUES_GITHUB_ALREADY_LINKED`
  - `refreshGithubRefs(scope, issueId, actor): Promise<ExternalRefView[]>` — 429-style refusal `ISSUES_GITHUB_REFRESH_TOO_SOON` when any github ref of the issue has `syncedAt` < 60 s ago; stores `state` as `open` | `closed:<state_reason>`; never changes the Orbit issue
  - `unlinkGithubRef(tx, scope, issueId, refId, actor): Promise<void>` — deletes only `system = "github"` refs of that issue; `IssueEvent github_unlinked`; audit; domain event `issues.github.unlinked`
  - Routes: `POST /issues/:id/github/link` `{ url }`, `POST /issues/:id/github/refresh`, `DELETE /issues/:id/github/:refId`

- [ ] **Step 1: Write failing tests:** link happy path; PR URL refused; repo not in allow-list refused with zero transport calls; second Orbit issue linking the same GitHub issue → 409; refresh updates `closed:completed`; refresh twice within 60 s → `ISSUES_GITHUB_REFRESH_TOO_SOON`; unlink removes the ref and leaves non-github refs; editor → 403 on all three.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `feat(issues): link, refresh and unlink GitHub issues (WP3.10a)`.

### Task 6: Assistant and MCP proposal

**Files:**
- Modify: `apps/api/src/modules/issues/tools.ts` (new `issuesProposeGithubIssue`, add to `proposals`; one sentence in `issuesInstructions`)
- Test: `apps/api/tests/issues-mcp.integration.test.ts`

**Interfaces:**
- Consumes: `requestGithubIssue`, `previewGithubIssue` (Task 4).
- Produces: `approvedOperation({ riskClass: "W0", ...proposal, deciderRole: "owner", name: "issues_propose_github_issue", input: { number: int ≥ 1, repository: repo key }, permission: ISSUES_GITHUB, summary → { operation: { kind: "issue_github", number, repository } }, validate → flag + request checks incl. preview (redaction), run → requestGithubIssue })`. The approval summary includes the preview title and body.

- [ ] **Step 1: Write failing tests:** proposal without share review → validation error `ISSUES_SHARE_REVIEW_REQUIRED`; valid proposal creates an ActionRequest and no request entity; an editor cannot decide it; owner approval → request entity `queued`; flag off → tool absent or refused (`ISSUES_GITHUB_DISABLED`); MCP output contains no diagnostics.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — Expected: PASS; also `apps/api/tests/issues-module.test.ts` (tool list snapshot, update if it enumerates tools).
- [ ] **Step 5: Commit** `feat(issues): propose GitHub issues through approvals (WP3.10a)`.

### Task 7: Web — detail block and settings section

**Files:**
- Modify: `apps/web/src/modules/issues/api.ts` (types `GithubStatus`, `GithubRequestView`; `IssueSettings.github`; calls for the routes of Tasks 2, 4, 5), `detail.tsx` (GitHub block), `settings.tsx` (GitHub section; `autoRelease` stays disabled), `labels.ts` (en/de)
- Test: `apps/web/src/modules/issues/issues.test.tsx`

**Interfaces:**
- Consumes: routes of Tasks 2, 4, 5; detail response fields `externalRefs` (existing) and `githubRequests` (Task 4).
- Produces: `GithubBlock({ issue, canManage })` in `detail.tsx`; `GithubSettings({ draft, onChange, status })` in `settings.tsx`.

UI rules: buttons only when `canManage` (`issues.github` in the member's permissions as other owner-only actions do); create flow = repository select (default `componentRepository`) → preview modal (exact text) → confirm; missing share review → disabled button with hint and the existing share-review control; request states `queued`/`sending` "Wird angelegt", `failed` with the code text, `outcome_unknown` with "Abgleichen"; settings picker disables public/archived repos with the reason; nothing is shown while the flag is off (status route 404).

German labels (exact): "GitHub-Issue erstellen", "Vorschau", "Erstellen", "Verknüpfen", "Aktualisieren", "Lösen", "Abgleichen", "Wird angelegt", "Erst zum Teilen freigeben", "Nur private Repositories", "Keine GitHub-Verbindung freigegeben".

- [ ] **Step 1: Write failing tests:** renders linked ref `o/web#7` with state; non-owner sees no buttons; missing share review disables create; `outcome_unknown` shows "Abgleichen"; settings disables a public repo.
- [ ] **Step 2: Run** `pnpm vitest run apps/web/src/modules/issues/issues.test.tsx` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): GitHub block and settings for issues (WP3.10a)`.

### Task 8: Docs, generated client, full checks

**Files:**
- Create: `docs/integrations/github-app.md` (spec §10 steps 2–7, permissions table, PEM entry, revoke/uninstall)
- Modify: `docs/ISSUES.md` (GitHub section; permission row no longer "reserved"), `docs/IMPLEMENTATION_STATUS.md`, `docs/REQUIREMENTS_TRACEABILITY.md` (IC-16: GitHub slice 1 built, flag off; Sentry/monitoring/vector still not built), `docs/plans/issue-center-phase-3.md` (WP3.10 → 10a/10b/10c with link to the spec)
- Regenerate: OpenAPI/client via `pnpm api:generate`

- [ ] **Step 1:** `node scripts/test-db-for-worktree.ts`, then `pnpm api:generate`; review the diff (only the new issues routes).
- [ ] **Step 2:** Run `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, `node scripts/source-check.mjs` (boundaries) — Expected: all pass, no new boundary baseline entries.
- [ ] **Step 3:** Write the docs; `git diff --check`.
- [ ] **Step 4: Commit** `docs(issues): GitHub App slice 1 guide and status (WP3.10a)`.
- [ ] **Step 5:** Report to Mario with the AGENTS.md closing format; ask before any push to `main` (no migration, flag off).
