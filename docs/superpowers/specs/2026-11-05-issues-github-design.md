# Issue center ↔ GitHub, slice 1 (WP3.10a) — design

- **Date:** 2026-11-05
- **Status:** design approved by Mario in chat (2026-11-05); spec awaiting review
- **Baseline:** `origin/main` 2e85b31a
- **Parents:** [ADR 0018](../../adr/0018-issue-center.md), [issue center plan §2.7 and WP3.10](../../plans/issue-center-phase-3.md), [ADR 0014](../../adr/0014-central-connections-ai-knowledge.md) (connections and grants), [ISSUES.md](../../ISSUES.md)
- **Risk / environment:** medium (new external integration; redacted issue data leaves Orbit) / local first, production only after the approvals in §10

## 1. Goal

An owner can turn a confirmed, share-reviewed Orbit issue into a GitHub issue in an allow-listed private repository, or link an existing GitHub issue. The link appears on the Orbit issue with its GitHub state. Nothing flows back automatically yet.

Success criteria:
1. One click by the owner (or an approved assistant/MCP proposal) creates exactly one GitHub issue, also after timeouts and retries.
2. The GitHub issue contains only the issue's shareable fields, redacted again, and a link back to Orbit.
3. The link is stored as an `IssueExternalRef` (`system = "github"`) and shown in the issue detail with its state.
4. Without the flag, the grant or an allow-listed repository nothing changes for any project.

## 2. Decisions (Mario, 2026-11-05)

| ID | Decision |
|---|---|
| G-1 | A new, separate GitHub App ("Orbit Issues") that Mario creates. The knowledge GitHub App stays unchanged; convergence is a later decision. |
| G-2 | Only the owner creates or links GitHub issues (`issues.github`, unchanged: owner-only, sensitive). |
| G-3 | The owner's click in the UI executes directly and is audited; assistant and MCP proposals go through an ActionRequest. |
| G-4 | Only private repositories; public ones are refused when saving the allow-list and again before each write. |
| G-5 | Slice 2 (later) receives PR/check webhooks through one repository webhook per repo on the project's existing hook URL, without a migration. Not part of this slice. |
| G-6 | This spec covers slice 1 only. Slices 2 and 3 get their own spec and approval. |

## 3. Scope

**In:** `github_app` connection provider (platform), installation token minting, issues settings `github.repositories`, create GitHub issue (UI and proposal), link an existing GitHub issue by URL, refresh GitHub state on demand, unlink, flag, docs, tests.

**Out (later slices):** webhooks of any kind, PR and check linking, `IssueDelivery` with `source = "github"`, deployment and release detection, enabling `sync.autoRelease`, inbound GitHub issues as reports (report source `github` stays reserved), GitHub comments, labels, assignees, closing GitHub issues from Orbit, changing the Orbit status from GitHub state.

## 4. Reconciled starting point

- `issues.github` permission exists and is unused (`apps/api/src/modules/issues/permissions.ts`).
- `IssueExternalRef` exists in the core migration with `system`, `externalId`, `url`, `state`, `syncedAt` and the unique key `(projectId, system, externalId)`. Merge (`merge.ts`) already moves refs to the target issue; the detail query (`queries.ts`) already returns them.
- The share review gate exists: `shareableFields(issue)` (`issues.ts`) throws `ISSUES_SHARE_REVIEW_REQUIRED` unless `shareReviewedAt` is set; editing title, summary or acceptance criteria clears it.
- Settings live in the module's `ProjectModule` JSON; `readModuleSettings` fills keys an older stored version lacks from the defaults, so a new `github` key needs no data migration.
- Platform connection providers are registered in `apps/api/src/platform/modules/platform-contributions.ts` (`connections.providers`, e.g. `n8n`); system connections are created in the administration and reach projects only through grants (ADR 0014). `resolveConnection` + `connectionSecret` read them inside a project transaction.
- The knowledge module's GitHub code (`modules/knowledge/github.ts`) mints App JWTs and installation tokens, but issues must not import it (`scripts/boundaries.json`). The reusable client therefore moves into the platform as new code; knowledge stays untouched.
- The work module's `repositories[]` cannot be read by issues (no declared contract). `components[].repository` in the issues settings currently claims to reference work repository keys, but nothing resolves it.

**No schema migration is needed for this slice** (no Coolify schema-hash approval). Pending create requests use the generic project `entity` store, like webhook messages and source connectors do.

## 5. Architecture

```
Owner click ─┐                                 ┌─ platform/connections/github-app.ts
Assistant/MCP proposal → ActionRequest ─┴→ issues/github.ts ─ enqueue ─→ worker job issues_github
                                             │  (tx: validate,       │  (outside tx: token, reconcile,
                                             │   request entity)     │   POST issue; tx: IssueExternalRef)
                                             └─ settings.github.repositories (allow-list)
```

### 5.1 Platform: `apps/api/src/platform/connections/github-app.ts` (new)

- **Connection provider `github_app`**, registered in `platform-contributions.ts` (always, like `n8n`; it is usable only through a grant, and the issues routes are flag-gated).
  - `scopes: ["system", "workspace"]`, `purposes: ["issues"]` (later `coding`, `knowledge`).
  - Secret (one JSON string, like the social apps, because the administration form sends only `baseUrl` plus one secret): `{ appId, appSlug, installationId, privateKey }`. The PEM key is accepted with real newlines, `\n` escapes or spaces in place of newlines (a password field drops newlines) and normalized. One connection = one App installation on one GitHub account. Sealed `ConnectionSecret`, entered by Mario in the administration; never logged, returned or shown.
  - `check`: mints an App JWT, reads `GET /app/installations/{installationId}` → `read_verified` with capabilities `["github_issues"]` and the non-secret `account` login; failures map to `GITHUB_RECONNECT_REQUIRED` / `GITHUB_ACCESS_OR_RATE_LIMIT` / `GITHUB_REQUEST_FAILED`.
- **Client functions** (pure platform, no module names):
  - `githubAppJwt(app, now)` — RS256, `iat = now − 60 s`, `exp = now + 9 min`.
  - `installationToken(app, { repositories: [name], permissions })` — `POST /app/installations/{id}/access_tokens` with an explicit repository list and permission map. Callers pass the minimum; slice 1 uses `{ issues: "write", metadata: "read" }`. Tokens are used for one operation and never stored.
  - `githubFetch(path, token, init)` — `https://api.github.com` only, `redirect: "error"`, 20 s timeout, `X-GitHub-Api-Version` as in knowledge, body capped at 1 MB before parsing, error mapping as above plus `GITHUB_VALIDATION_FAILED` (422) and `GITHUB_UNAVAILABLE` (5xx, network, timeout).
  - `installationRepositories(app)` — `GET /installation/repositories` (paged, max 500), returns `{ fullName, private, archived }`.
- An injectable transport (as in the Google Drive mock tests) so no test calls GitHub.

### 5.2 Issues module

**Settings** (`issues/settings.ts`): new key

```ts
github: {
  /** Repositories GitHub issues may be created in or linked from (private only, G-4). */
  repositories: Array<{ key: string /* repo key */, fullName: "owner/name" }>, // max 20, unique keys and names
}
// default: { repositories: [] }
```

`components[].repository` is redefined as a key of `github.repositories` (the component's default repository). Stored values without a match are ignored (no default). Saving the allow-list requires `issues.github` in addition to `issues.settings` for the `github` key; the server checks every `fullName` against `installationRepositories` and refuses unknown, public or archived repositories (`ISSUES_GITHUB_REPOSITORY_NOT_ALLOWED`).

**Body builder** (`issues/github.ts`, pure, unit-tested):
- Input: `shareableFields(issue)` (key, title, summary, type, severity, components, acceptance criteria) and the Orbit deep link of the issue (the list view with `?issue=<id>`, as `detail.tsx` links today; the server-side URL builder is fixed in the implementation plan).
- Title: `[ISS-12] <title>` (max 256 chars).
- Body (English, Markdown): hidden marker `<!-- orbit-ref:<requestId> -->`, a line `Orbit-Issue: ISS-12`, type/severity/components, the summary, acceptance criteria as a list, the Orbit link.
- Title and body pass `redact(..., { profile: "strict" })`. If any detector hits, the request is refused with `ISSUES_GITHUB_REDACTION_HIT` and the detector counts (not the text). The owner fixes the issue fields and reviews it again. Nothing is silently rewritten.
- Never included: reports, symptoms of reports, diagnostics, environment/release details, ticket ids or links, reporter or customer names, AI triage output, internal comments.

**Request** (`requestGithubIssue(tx, scope, issueId, repoKey, actor)`), shared by the route and the proposal:
1. Flag on, `issues.github` (route) or approved ActionRequest (proposal).
2. Issue status is not `new`, `triage`, `needs_info` or `duplicate`; `shareableFields` passes; no existing `github` ref for this issue in this repository (`ISSUES_GITHUB_ALREADY_LINKED`).
3. Repository key is in the allow-list; a granted `github_app` connection with purpose `issues` exists (`ISSUES_GITHUB_NOT_CONNECTED`).
4. The body builds without a redaction hit.
5. Writes an entity `issues_github_request` `{ issueId, repository, requestId, status: "queued", attempts: 0, requestedAt, requestedBy, issueVersion }`, an `IssueEvent` `github_requested`, an audit entry, and enqueues `issues_github` (kind `create`, resource = request entity). Returns the request (the UI shows "wird angelegt").

A preview route returns the exact title and body (or the redaction hit) without writing anything; the UI shows it before the confirm button.

**Worker job** `issues_github` (`issues/jobs.ts`, kind `create`):
1. Tx: load the request; `done`/`failed` → return. Re-check flag, issue (`shareableFields`, version unchanged since the request or still reviewed), allow-list, connection. A failed re-check → `failed` with its code. Otherwise read the connection secret, set `status = "sending"`, `attempts += 1` and rebuild the body.
2. Outside the tx: mint an installation token for exactly this repository with `{ issues: "write", metadata: "read" }`; `GET /repos/{o}/{r}` must say `private: true` (else `failed`, `ISSUES_GITHUB_REPOSITORY_PUBLIC`).
3. **Reconcile before any repeated write:** if `attempts > 1`, list `GET /repos/{o}/{r}/issues?creator={appSlug}[bot]&state=all&since={requestedAt}` and search for the marker. If found, continue with step 5 using that issue.
4. `POST /repos/{o}/{r}/issues` with title and body.
5. Tx: validate `html_url` (`https://github.com/{o}/{r}/issues/{n}` of the same repository), create `IssueExternalRef { system: "github", externalId: "{o}/{r}#{n}", url, state: "open", syncedAt }`, set the request `done`, write `IssueEvent` `github_linked`, audit `issues.github.linked`, publish domain event `issues.github.linked` (ids and keys only).
6. Errors: definite GitHub refusals (401, 403, 404, 410, 422) → `failed` with the code, no retry. Network errors, timeouts and 5xx after sending → keep `sending` and throw so the job retries (platform backoff); the next attempt reconciles first. After the last attempt the request becomes `outcome_unknown`; the UI offers "Abgleichen" (reconcile only, never a blind re-create).

**Link existing** (`POST …/issues/:id/github/link`, `{ url }`): parse `https://github.com/{o}/{r}/issues/{n}` only (no fetching of other URLs), repository in the allow-list, read it with an installation token (`issues: read`), refuse pull requests (`pull_request` present) → `IssueExternalRef` as above with the read state. The unique key prevents linking one GitHub issue to two Orbit issues (`ISSUES_GITHUB_ALREADY_LINKED`).

**Refresh** (`POST …/issues/:id/github/refresh`): reads each `github` ref's state (`open`/`closed`, `state_reason`) and updates `state` and `syncedAt`; at most once per minute per issue. It never changes the Orbit issue.

**Unlink** (`DELETE …/issues/:id/github/:refId`): removes the ref only (GitHub untouched), `IssueEvent` `github_unlinked`, audit.

**Proposal** (`issues/tools.ts`): `issues_propose_github_issue { number, repository }`, MCP scope `orbit:issues`, permission `issues.github`, risk class as the existing proposals; `validate` runs the request checks 1–4 (including the redaction check), `run` calls `requestGithubIssue`. The approval card shows the repository and the exact title/body preview.

**Routes** (all under the existing issues base, gated by `ORBIT_ISSUES_GITHUB`, otherwise 404 `ISSUES_GITHUB_DISABLED`):

| Route | Permission |
|---|---|
| `GET …/github/status` (connection state, allow-list, installation repositories for the settings picker) | `issues.github` |
| `POST …/issues/:id/github/preview` | `issues.github` |
| `POST …/issues/:id/github` (create) | `issues.github` |
| `POST …/issues/:id/github/link` | `issues.github` |
| `POST …/issues/:id/github/refresh` | `issues.github` |
| `DELETE …/issues/:id/github/:refId` | `issues.github` |
| `POST …/github/requests/:id/reconcile` | `issues.github` |

Readers see existing refs (URL, state) in the detail as today; only the actions need `issues.github`.

### 5.3 Web (`apps/web/src/modules/issues/`)

- **Detail:** a "GitHub" block listing linked issues (`owner/repo#n`, state, last refresh), pending/failed/unknown requests with their code, and for owners: "GitHub-Issue erstellen" (repository select defaulting to the first component's repository → preview → confirm), "Verknüpfen" (URL field), "Aktualisieren", "Lösen". When share review is missing the button explains why and links to the share review.
- **Settings:** a "GitHub" section: connection status (none / granted / check failed), repository picker from the installation (public and archived ones disabled with the reason), saved allow-list, component repository select. The `autoRelease` checkbox stays disabled.
- Labels in `labels.ts` (en/de). No new navigation entries.

### 5.4 Flag and configuration

- `ORBIT_ISSUES_GITHUB` (`"false"`/`"true"`, default `false`) in `packages/config`, `docker-compose.yml`, `docker-compose.pve.yml`. Effective only with `ORBIT_ISSUES` and `ORBIT_CONNECTIONS` on.
- No new environment secret: the App key lives in the connection.

## 6. Security and privacy

- **Data egress:** only the share-reviewed fields, re-redacted in strict mode; refusal on any detector hit; canary tests (§8).
- **Least privilege:** each token is for one repository with `issues: write` + `metadata: read` (create) or `issues: read` (link/refresh); the App itself is created with Issues read/write and Metadata read only, webhook inactive.
- **Allow-list twice:** on saving and before each call; private repositories only.
- **No URL fetching** from user input beyond the parsed `github.com/{o}/{r}/issues/{n}` pattern, mapped to `api.github.com`.
- **Tenancy:** the connection is usable only through an active project grant (ADR 0014 RLS); a revoked grant stops the next job attempt (`ISSUES_GITHUB_NOT_CONNECTED`).
- **No duplicates:** reconcile-before-retry with the request marker; `IssueExternalRef` unique key.
- **Audit:** request, link, unlink, failure; never the token, key or body text.
- The assistant/MCP never creates directly; the external client's confirmation is not Orbit authorization (ActionRequest).

## 7. Error codes

`ISSUES_GITHUB_DISABLED`, `ISSUES_GITHUB_NOT_CONNECTED`, `ISSUES_GITHUB_REPOSITORY_NOT_ALLOWED`, `ISSUES_GITHUB_REPOSITORY_PUBLIC`, `ISSUES_GITHUB_REDACTION_HIT`, `ISSUES_GITHUB_ALREADY_LINKED`, `ISSUES_GITHUB_URL_INVALID`, `ISSUES_SHARE_REVIEW_REQUIRED` (existing), `ISSUES_NOT_CONFIRMED` (existing), plus the platform's `GITHUB_*` codes.

**As built (2026-11-05):** besides the list above, the code uses `ISSUES_GITHUB_REQUEST_STATE` (a new create while a request is unsettled, or reconcile on a request that is not `outcome_unknown`), `ISSUES_GITHUB_NOT_FOUND` (reconcile settled `failed` after a complete empty listing at least 2 minutes after the send), `ISSUES_GITHUB_RECONCILE_INCOMPLETE`, `ISSUES_GITHUB_REFRESH_TOO_SOON` (429), `ISSUES_GITHUB_TEXT_CHANGED` (proposal text bound at approval) and `JOB_OUTCOME_UNKNOWN`. There is no separate archived-repository code: archived repositories use `ISSUES_GITHUB_REPOSITORY_NOT_ALLOWED`. The platform codes are `GITHUB_APP_INVALID`, `GITHUB_RECONNECT_REQUIRED`, `GITHUB_ACCESS_OR_RATE_LIMIT`, `GITHUB_VALIDATION_FAILED`, `GITHUB_UNAVAILABLE`, `GITHUB_RESPONSE_TOO_LARGE` and `GITHUB_REQUEST_FAILED`. The stored ref state is only `open` or `closed`; the close reason is shown after a refresh but not stored.

## 8. Tests

- **Unit:** JWT claims and expiry; token request body asserts exactly the repository and permission map; `githubFetch` error mapping (401/403/404/410/422/429/5xx/timeout), size cap, no redirects; body builder (fields, marker, link, length limits); redaction canaries (customer e-mail, name, phone, IBAN, wallet address, token in summary/criteria → refusal, never in the request); URL parser (issues only, no PRs, no other hosts); settings schema (old stored settings without `github` still parse; unique keys; max 20).
- **Integration** (GitHub via test transport): create happy path → one ref, one event, one audit, one domain event; retry after a timeout reconciles via the marker and creates nothing twice; definite 422 → `failed`, no retry; after max attempts → `outcome_unknown`, reconcile route links the found issue; public repo at send time → `failed`; grant revoked between request and job → `failed`; issue edited after request (share review cleared) → `failed`; link existing (allow-list, PR refused, duplicate refused); refresh rate limit; unlink; proposal: validate refuses without share review, run requires approval.
- **Permissions / access matrix:** owner allowed; editor, viewer, outsider refused; module disabled; `ORBIT_ISSUES_GITHUB` off → 404; member module role narrowed. Fixture changes are reviewed as security changes.
- **Web unit:** detail block states (none, pending, linked, failed, unknown, missing share review, non-owner), settings picker (public disabled).
- **Checks:** `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm api:generate` (review the OpenAPI diff), worktree test DB via `node scripts/test-db-for-worktree.ts`. E2E stays mocked/skipped; live acceptance is manual (§10).

## 9. Documentation

`docs/integrations/github-app.md` (new: creating the App, permissions, webhook inactive, installing on selected private repositories, entering the key, granting, revoking), `docs/ISSUES.md` (GitHub section), `docs/IMPLEMENTATION_STATUS.md`, `docs/REQUIREMENTS_TRACEABILITY.md` (IC-16 → partially built), `docs/plans/issue-center-phase-3.md` (WP3.10 split into 10a/10b/10c), `.env.example`/compose flag documentation.

## 10. Rollout and rollback

1. Push to `main` with Mario's OK (no migration; flag off → no behaviour change).
2. Mario creates the GitHub App "Orbit Issues": Repository permissions Issues read/write, Metadata read; webhook inactive; installable only on his account; installs it on selected **private** repositories.
3. Mario creates the system connection `github_app` in the administration and enters its secret JSON (App id, slug, installation id, private key) himself; check → `read_verified`.
4. Grant to the organization and the project with purpose `issues`.
5. Mario sets `ORBIT_ISSUES_GITHUB=true` in Coolify (with `ORBIT_ISSUES=true`) and redeploys.
6. In the project's issue settings the owner picks the repositories and the components' default repositories.
7. Live acceptance in a private test repository: preview, create, check the GitHub body, refresh, link an existing issue, unlink; close the test issue in GitHub manually.

**Rollback:** flag off (routes 404, job refuses); revoke the grant; uninstall the App in GitHub. Existing refs remain as harmless links; no data migration to undo.

## 11. Later slices (not approved by this spec)

- **10b — PRs and checks:** repository webhooks (G-5) on a project connection with secret, `pull_request`, `check_suite`/`check_run`; message ids from signed body fields (GitHub does not sign `X-GitHub-Delivery`); matching `Fixes ISS-n` / `Orbit-Issue: ISS-n` / branch `iss-n-*`; `IssueDelivery` `source = "github"`; App permissions plus Pull requests read, Checks read.
- **10c — Release detection:** `deployment_status` or the `issues.delivery.v1` automation contract, compare API (needs Contents read), S4 exact signal, enabling `sync.autoRelease`.
