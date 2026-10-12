# Blog delivery as GitHub pull request — design

Status: draft for Mario's review (2026-10-12). Builds on Orbit Agents ([design](2026-10-09-orbit-agents-design.md), rulings R1–R80), the draft delivery (R73) and the owner release (R70). Resolves master contract acceptance **A16** ("one real publishing path verified in the target project", `docs/EDS_ORBIT_UNIFIED_CODEX_MASTER_v3.md:290`) for the uLiquid website.

## 1. Goal

Orbit writes a monthly blog article for `https://uliquid.vip/blog/`, Mario releases it in Orbit, and Orbit publishes it without anyone committing by hand: it opens a pull request on `eds-labs/uliquid-desk-website-v2` that adds `content/blog/posts/<slug>.json`, waits for the green `check` workflow, merges, and confirms the article is live. Hostinger deploys every push to `main`.

Success means the monthly ChatGPT job plus manual commit and push is replaced by one Orbit assignment and one release click per article, with Orbit's facts, budget, review and checks, and that no article reaches `main` without Mario's release and a green website build.

Prerequisite (done 2026-10-12, website PR #1, `dae0b4e`): the website stores one validated JSON file per post (`docs/BLOG_PUBLISHING.md` in the website repo) and runs `npm run check` in GitHub Actions on every pull request.

## 2. Decisions (Mario, 2026-10-12)

| #   | Question                | Decision                                                                                                                                                        |
| --- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1  | How far Orbit goes      | After Mario's release Orbit opens the PR, waits for green CI and merges itself. One release, no GitHub click.                                                   |
| B2  | GitHub credential       | Fine-grained personal access token limited to `eds-labs/uliquid-desk-website-v2`, permissions Contents and Pull requests read & write, expiry at most one year. |
| B3  | Topics                  | A standing blog assignment (for example monthly); research and strategy pick the topic, Mario may give a topic frame.                                           |
| B4  | Article format in Orbit | Approach A: the copywriter writes a restricted Markdown article plus metadata; a deterministic target profile maps it to the website's JSON.                    |
| B5  | Release authority       | Only the owner releases a blog article. Agent review authority (`ORBIT_AGENT_REVIEW_AUTHORITY`) never publishes a blog article on its own.                      |
| B6  | Scope of v1             | uLiquid only, new articles only, English, no article images (the site's shared social image is used).                                                           |

## 3. Terms

- **Blog target**: a `github` connector plus a target profile. It names the repository, base branch, posts path, public site URL and profile id.
- **Target profile** `uliquid-blog-json-v1`: the code that validates an Orbit article, maps it to the website's post JSON, and fixes author, link allowlist and limits. It mirrors `content/blog/blog-posts.mjs` of the website.
- **Blog delivery**: one `Entity(kind="blog_deliveries")` row per released article. It holds the state machine of section 7.

## 4. Architecture

```
assignment (contentType blog, delivery github_pr)
  └─ run: research → strategy (1 brief) → copywriter → review
        └─ draft waits for owner ("Wartet auf deine Freigabe", preview from target profile)
              └─ owner release → blog_deliveries row (queued) + job topic blog_github_pr
                    └─ worker: slug check → branch → commit → PR → checks → merge → live check
```

New units, each with one job:

| Unit                | Location                                                       | Responsibility                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| GitHub client       | `packages/connectors/src/github.ts`                            | Minimal REST calls over `http.ts` (`boundedFetch`, HTTPS only, no redirects, timeouts): get ref, get content, list directory, create ref, delete ref, put file, create pull, get pull, list check runs for a ref, merge pull (with `sha`), close pull. Maps errors to `ConnectorError` (401/403 → `rejected`, 404, 409/422 conflict, network → `unknown`). Base URL fixed to `https://api.github.com`. |
| Target profile      | `packages/connectors/src/blog-targets/uliquid-blog-json-v1.ts` | `parseArticle` (restricted Markdown → sections), `toPostJson` (adds slug, readTime, author, dates), `validatePost` (website rules, section 6), `linkAllowlist(existingSlugs)`. Pure functions, no I/O.                                                                                                                                                                                                 |
| Blog target service | `apps/api/src/modules/blog-target.ts`                          | Loads the connector, decrypts the token, lists published posts for strategy, renders the preview, verifies the connector (section 5).                                                                                                                                                                                                                                                                  |
| Blog delivery       | `apps/api/src/modules/agents/blog-delivery.ts`                 | Books a delivery at release, runs the worker steps idempotently, reconciles after a crash, cancels. Same shape as `draft-delivery.ts` (R73).                                                                                                                                                                                                                                                           |
| Worker topic        | `apps/worker/src/main.ts`                                      | Queue class and dispatch for `blog_github_pr`, lease and crash recovery like `postiz_draft`.                                                                                                                                                                                                                                                                                                           |

Existing code that changes: `assignments.ts` (delivery union gains `github_pr`, allowed only for `contentType: "blog"`, mandate check `BLOG_GITHUB_DISABLED`), the hand-copied delivery unions (`chat-tools.ts`, `owner-release.ts`, `agent-activity.ts`, web `assignments.tsx`, `assignment-card.tsx`, `agent-activity.tsx`), `assignment-runs.ts` (blog strategy input), `specialists/strategy.ts`, `specialists/copywriter.ts`, `specialists/review.ts` (no auto-settle to publish for blog; Drive save stays), `owner-release.ts` (blog branch), `veto.ts` (`scheduleApproved` keeps returning early for blog), `action-readiness.ts` (`blog_live`), `notifications.ts` (new kinds), connector route provider enum (`server.ts`), web management connector form, `packages/ai` (article output fields), config flag.

Feature flag `ORBIT_BLOG_GITHUB` (`z.enum(["false","true"]).default("false")` in `packages/config/src/index.ts`, `.env.example`, `docker-compose.yml`, `docs/OPERATIONS.md`). Off: the `github` provider cannot be created, `github_pr` is refused, queued deliveries do not start. No database migration: all new data are Entity kinds (ADR 0008 addendum).

## 5. GitHub connector

- Created through the existing connector action with `provider: "github"` and config `{ owner, repo, baseBranch: "main", postsPath: "content/blog/posts", siteUrl: "https://uliquid.vip", blogPathPrefix: "/blog/", profile: "uliquid-blog-json-v1" }`. The token is stored as `encryptedCredential` (AES-256-GCM, `CREDENTIAL_KEY`) and never returned (`publicEntity`).
- `owner`/`repo` must match `^[A-Za-z0-9._-]+$`; `siteUrl` must be HTTPS. Only the owner role creates or changes it.
- Verification, same states as Postiz (`configured` → `read_verified` → `write_verified`):
  - **read**: `GET /repos/{owner}/{repo}`, the base branch ref and the posts directory listing succeed, and every listed post passes the profile's validation (proves profile and site agree).
  - **write**: create ref `refs/heads/orbit/verify-<short id>` at the base head, then delete it. `main` is never touched. A failed delete is reported and retried on the next verification.
- 401/403 at any later call sets the connector back to `configured` and raises the owner notice `github_token_invalid` ("GitHub-Token erneuern").
- The token's expiry is not readable through the API; the connector form records the expiry date Mario enters, and Orbit raises a notice 14 days before it.

## 6. Article generation and target profile

**Run plan.** Unchanged for blog: research → strategy → one copywriter → review, no analytics (`buildWorkPlan`). With delivery `github_pr` the strategy input replaces `channelHistory` with `publishedArticles`: slug, title, category, keywords and `publishedAt` of every file in the posts directory, read through the connector at run start (one directory listing plus one content read per post; current size two posts). Strategy writes exactly one brief: topic, search intent, target keywords, outline, fact keys. Its slug (derived from the topic title) must not be in `publishedArticles`.

**Copywriter output.** The draft keeps `title`, `body`, `claims`. For blog the output additionally carries `article: { seoTitle, description, excerpt, category, keywords[], relatedLinks[] }`. The draft instruction states the format:

- Body is restricted Markdown: `## ` section headings, plain paragraphs, and at most one `- ` list at the end of a section. No `#`/`###` headings, no inline links, emphasis, images, code, tables or HTML.
- 1200–1800 words, 5–8 sections, English, the project's tone.
- `relatedLinks`: 2–4 entries chosen from the allowlist in the contract (label free, `href` from the list).

**Mapping (`toPostJson`).** Sections come from the body; `slug` from the title (kebab-case, ASCII, max 80 characters); `readTime` = `ceil(words / 220)` minutes as `"N min read"`; `author` "Mario Euchner" and `authorTitle` "Founder & Product Lead" from the profile; `publishedAt` = `updatedAt` = the Europe/Berlin date of the commit. The mapper rejects, never silently strips, anything outside the allowed Markdown.

**Validation (`validatePost`)** mirrors the website (`content/blog/blog-posts.mjs`): required fields, no unknown fields, kebab-case slug equal to the file name, real calendar dates with `updatedAt >= publishedAt`, `readTime` pattern, length limits (title 120, seoTitle 70, description 200, category 40, excerpt 320, heading 120), keywords 1–12 unique, sections ≥ 1 with unique headings and 1–20 paragraphs, list 1–20 items, related links ≤ 8 internal paths with trailing slash, and no "guaranteed returns", "investment advice" or "autonomous asset manager". Orbit adds stricter checks of its own: 2–4 related links from the allowlist, 5–8 sections, 1000–2200 words.

**Link allowlist** (profile constant plus existing posts): `/platform/`, `/features/`, `/features/dashboard-portfolio/`, `/features/market-intelligence/`, `/features/trading-desk/`, `/features/ai-workbench/`, `/features/automation-bots/`, `/features/bot-vaults/`, `/pricing/`, `/resources/`, `/risk-disclosure/`, `/faq/`, `/about/`, and `/blog/<slug>/` of every published post.

**Facts.** `checkClaims` runs unchanged on the body: product statements need verified facts, explanatory passages are style claims. Review checks topic overlap against `publishedArticles` and judges the article; a failed `validatePost` is a deterministic problem (revise once, then `needs_owner` with the reasons).

**Model and budget.** `draft_blog` stays on the quality route. Production today: `gpt-6.1-sol`, reasoning effort low, output ceiling 4,000 (`docs/ORBIT_ULIQUID_PRODUCTION_GOAL.md:932`); reasoning tokens count against it, so the ceiling rises to 8,000 (route change in production with Mario's approval at rollout; the code default rises from 1,800 to 8,000). Estimate at the stored rate card (Sol: input 2.00, output 10.00 USD per 1M tokens): article call ≤ 0.08 USD output plus ≈ 0.04 input; with research, strategy, review and one revision about 0.30–0.50 USD per run. Suggested assignment budget: 5 USD per month.

## 7. Release and delivery

**Release.** Blog drafts appear in "Wartet auf deine Freigabe" with a preview rendered from `toPostJson`: title, meta, sections, list, related links, target URL `siteUrl + /blog/<slug>/` and validation status. "Freigeben" is disabled with the reason while validation fails or the slug exists. The release (owner only, existing route `POST /assignment-drafts/:id/release`) records the human content review bound to the body hash (as today) and, for delivery `github_pr`, books one `blog_deliveries` row in the same transaction:

```
{ contentId, assignmentId, runId, connectorId, slug, path, fileSha256, fileBytes,
  branch: "blog/<slug>", status, prNumber?, headSha?, mergeSha?, liveUrl, attempts, error? }
```

`fileBytes` is the exact JSON (`JSON.stringify(post, null, 2) + "\n"`) at release; it is never regenerated. Releasing again returns the same delivery.

**States.** `queued → branch_ready → committed → pr_open → checks_passed → merged → live`, side states `checks_failed`, `checks_timeout`, `live_unverified`, `blocked_dependency` (flag off, connector not write-verified, token invalid), `outcome_unknown`, `canceled`, `failed`.

**Worker steps** (topic `blog_github_pr`, one step per job, each step reads GitHub before it writes, so a retry after a crash continues instead of duplicating):

1. **Preflight**: flag on, connector `write_verified`, content unchanged since release (body hash), `path` absent on the base branch (else `failed` with `BLOG_SLUG_EXISTS`).
2. **Branch**: if `blog/<slug>` exists and its head is the base head or Orbit's own commit, reuse it; else create it at the base head. A branch with foreign commits → `failed` `BLOG_BRANCH_FOREIGN`.
3. **Commit**: if the file on the branch equals `fileBytes`, skip; else put the file (message `Add blog post: <title>`). Store `headSha`.
4. **Pull request**: reuse an open PR with head `blog/<slug>`; else create it (title `Blog: <title>`, body with summary, release reference and the line "Released by Mario in Orbit on <date>").
5. **Checks**: poll the check runs of `headSha` every 60 s. All completed and successful → `checks_passed`. Any failure → `checks_failed` (PR stays open, owner notice, no automatic retry). Nothing completed after 30 minutes → `checks_timeout` (same handling).
6. **Merge**: `PUT /pulls/{n}/merge` with `sha: headSha` and merge method `merge`. A head that moved → `failed` `BLOG_HEAD_MOVED`, no merge. Store `mergeSha`, delete the branch.
7. **Live check**: `GET liveUrl` every 60 s for up to 30 minutes through `boundedFetch`; status 200 and the HTML-decoded page contains the title → `live` (owner notice `blog_live` with the link); otherwise `live_unverified` (notice; the merge stands).

**Cancel.** Owner action "Auslieferung abbrechen" while not yet merged: close the PR, delete the branch, state `canceled`. After the merge only a revert helps (section 9).

**Notices** (`notifications.ts`, Telegram and Orbit): `needs_owner` for blog ("Artikel wartet auf Freigabe"), `blog_live`, `blog_delivery_stopped` (with code), `github_token_invalid`, `github_token_expiring`. Telegram still approves nothing.

**Readiness.** `blog_live` in `action-readiness.ts` is ready when the flag is on and a `github` connector is `write_verified`; otherwise it names the missing piece instead of `BLOG_TARGET_NOT_CONFIGURED`.

## 8. Error handling summary

| Situation                                                       | Result                                                                               |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Slug exists at release or preflight                             | Release refused / `failed BLOG_SLUG_EXISTS`; nothing written                         |
| Draft changed after release                                     | `failed CONTENT_CHANGED`; nothing written                                            |
| Crash or timeout mid-step                                       | `outcome_unknown`, worker lease recovery re-runs the step, which reads GitHub first  |
| Foreign commit on the branch or moved head                      | No merge; `failed` with code and notice                                              |
| CI red or no result in 30 minutes                               | `checks_failed` / `checks_timeout`; PR open; notice; owner cancels or fixes manually |
| 401/403                                                         | `blocked_dependency`; connector back to `configured`; `github_token_invalid`         |
| 404 on repo or base branch                                      | `blocked_dependency` `GITHUB_TARGET_MISSING`                                         |
| GitHub rate limit (403 with `x-ratelimit-remaining: 0`, or 429) | Retry after the reset time, no state change                                          |
| Not live 30 minutes after merge                                 | `live_unverified`; notice; merge stands                                              |
| Flag turned off                                                 | Queued and in-flight deliveries pause before their next step                         |

## 9. Rollback

- **One article**: revert the merge commit in GitHub, or remove the post file through a pull request; Hostinger redeploys. Documented in the website's `docs/BLOG_PUBLISHING.md` and Orbit's `docs/OPERATIONS.md`. An Orbit "withdraw article" action is out of scope.
- **The feature**: set `ORBIT_BLOG_GITHUB=false`. No migration to undo; `blog_deliveries` rows stay as history. Assignments with delivery `github_pr` are refused at run start with `BLOG_GITHUB_DISABLED` and keep their confirmation.
- **Credential**: revoke the token in GitHub; Orbit notices on the next call.

## 10. Security and privacy

- Token scope is one repository and two permissions; Orbit stores it encrypted, never logs it, never returns it, and sends it only to `api.github.com`.
- Orbit writes only `content/blog/posts/<slug>.json` on branches `blog/*` and `orbit/verify-*`, and merges only its own commit. It never pushes to `main` directly, never force-pushes, never edits other files.
- Article text contains no personal data beyond the fixed author name.
- New external provider (GitHub REST API, free) is approved by decision B2.

## 11. Tests

- **Unit** (`packages/connectors`): GitHub client against a fake fetch for every call and every error mapping (401, 403 rate limit, 404, 409, 422, network); target profile: Markdown parsing, every rejection, slug and readTime derivation, allowlist; **parity**: the website's two post files (copied as fixtures with their source commit) pass `validatePost`, and the website's 13 rejection cases are rejected with the same field.
- **Integration** (`apps/api/tests/blog-github-delivery.integration.test.ts`, real test DB, fake GitHub server): release to `live`; crash after each step and resume without duplicates; checks failed and timeout; slug exists; content changed after release; foreign commit on the branch; 401 and connector downgrade; cancel before merge; flag off pauses; owner-only release; agent review authority does not release a blog.
- **Web**: preview rendering and the disabled release with reason (component test).
- **Live eval** (Mario's approval, about 0.30–0.50 USD with the eval key): two blog runs against production-like facts, checking format, length, validation and claims pass rate.
- **First production delivery, accompanied**: Mario enters the token; connector read and write verification; one manual run; release; watch PR, CI, merge and the live page.

## 12. Out of scope

Article images, updating or withdrawing existing articles from Orbit, EDS-Labs (bilingual DE/EN, second profile), scheduled publication at a time other than the release, GitHub App authentication, a generic CMS interface.

## 13. Rollout

1. Merge with `ORBIT_BLOG_GITHUB=false`; deploy.
2. Mario creates the fine-grained token; Orbit connector created and verified (read, write).
3. Approval: production route `draft_blog` output ceiling 4,000 → 8,000.
4. Live eval (approval for its cost).
5. Flag on; Mario confirms the blog assignment card (monthly, 5 USD, delivery `github_pr`).
6. First run accompanied; then normal operation.

## 14. Risks and open points

- **Fact coverage**: long articles make more product statements than posts; with few verified facts the copywriter may hit `FACT_NOT_VERIFIED`/`EVIDENCE_INVALID` repeatedly. Mitigation: brief names the fact keys; the GitBook knowledge source planned for social helps here too.
- **Profile drift**: if the website's schema changes, Orbit's profile must follow. Mitigation: read verification validates every existing post with the profile, and the website CI is the final gate.
- **Hostinger deploy**: Orbit cannot see the deploy itself; the live check is the only signal.
- **Token expiry**: one year at most; notice 14 days ahead.
