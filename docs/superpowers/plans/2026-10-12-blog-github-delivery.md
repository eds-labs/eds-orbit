# Blog Delivery as GitHub Pull Request Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A blog assignment with delivery `github_pr` writes an article, waits for the owner's release, then opens a pull request on the uLiquid website repo adding `content/blog/posts/<slug>.json`, merges it after green CI and confirms the article is live.

**Architecture:** A pure target profile (`uliquid-blog-json-v1`) maps the copywriter's restricted Markdown plus metadata to the website's post JSON and validates it with the website's rules. A minimal GitHub REST client in `packages/connectors` is used by a blog target service (connector, verification, published-article list) and by a worker-driven delivery state machine (`blog_deliveries` entities, topic `blog_github_pr`) modelled on the Postiz draft delivery (R73). Everything is behind `ORBIT_BLOG_GITHUB`.

**Tech Stack:** TypeScript (Node 22, ESM), Fastify API, BullMQ worker, Prisma Entity table, zod, Vitest, React (web).

**Spec:** `docs/superpowers/specs/2026-10-12-blog-github-delivery-design.md` (decisions B1–B6). Website contract: BLOG_PUBLISHING.md in the website repository and `content/blog/blog-posts.mjs` in `eds-labs/uliquid-desk-website-v2` at commit `dae0b4e`.

## Global Constraints

- Flag `ORBIT_BLOG_GITHUB`: `z.enum(["false","true"]).default("false")`; off means no `github` connector creation, `github_pr` refused (`BLOG_GITHUB_DISABLED`), queued deliveries do not advance.
- No database migration; new data are Entity kinds `blog_deliveries` (and the existing `connectors`).
- GitHub base URL fixed to `https://api.github.com`; headers `Authorization: Bearer <token>`, `Accept: application/vnd.github+json`, `X-GitHub-Api-Version: 2022-11-28`; transport `boundedFetch` only.
- Orbit writes only `content/blog/posts/<slug>.json`, only on branches `blog/<slug>` and `orbit/verify-<8 hex>`; never pushes to the base branch, never force-pushes; merges only with `sha` = its own commit.
- Token stored as `encryptedCredential` (AES-256-GCM, `CREDENTIAL_KEY`), never logged or returned.
- Only the owner releases a blog article; `agentReviewAccepted` is false for content with `delivery: "github_pr"`.
- Profile constants: author `Mario Euchner`, authorTitle `Founder & Product Lead`, readTime `ceil(words / 220)` as `"N min read"`, dates = Europe/Berlin date of the release (the file bytes are fixed at release), file bytes `JSON.stringify(post, null, 2) + "\n"`.
- Website limits: title 120, seoTitle 70, description 200, category 40, excerpt 320, heading 120; keywords 1–12 unique; paragraphs 1–20; list 1–20; relatedLinks ≤ 8 matching `^\/(?:[a-z0-9-]+\/)*(?:#[a-z0-9-]+)?$`; forbidden `/guaranteed returns|investment advice|autonomous asset manager/i`.
- Orbit-stricter limits: 2–4 related links from the allowlist, 5–8 sections, 1000–2200 words; prompt target 1200–1800 words.
- Polling: checks and live page every 60 s, give up after 30 minutes (`checks_timeout`, `live_unverified`).
- Code comments cite rulings as `(R81)`…; docs and comments in English.

## Review Focus

- Titles with punctuation, apostrophes, umlauts or digits ("uLiquid's AI: 2026 Guide!", "Über Märkte") must give a stable ASCII kebab slug; a title that slugs to nothing is rejected with `BLOG_SLUG_INVALID`, not committed as `.json`. → Task 1.
- Bodies with CRLF line endings, trailing spaces and several blank lines between paragraphs must parse exactly like the clean LF form. → Task 1.
- Two drafts released for the same slug before either is merged: the second release is refused with `BLOG_SLUG_BOOKED`. → Task 7.
- An unrelated push to the website's `main` between branch creation and merge must not block the merge (head unchanged), and an empty check-run list right after the push must count as pending, never as passed. → Task 8.
- Titles containing `&`, `<` or quotes must still be found on the live page (HTML entities decoded) so a real publish does not end as `live_unverified`. → Task 8.

---

### Task 1: Target profile `uliquid-blog-json-v1`

**Files:**

- Create: `packages/connectors/src/blog-targets/uliquid-blog-json-v1.ts`
- Create: `packages/connectors/src/blog-targets/fixtures/market-intelligence-context-not-signal.json`, `.../ai-assisted-trading-keeps-decisions-with-the-user.json` (copied verbatim from the website at `dae0b4e`; add a `README.md` naming the source commit)
- Modify: `packages/connectors/src/index.ts` (export the profile)
- Test: `packages/connectors/src/blog-targets/uliquid-blog-json-v1.test.ts`

**Interfaces:**

- Produces:
  - `type ArticleMeta = { seoTitle: string; description: string; excerpt: string; category: string; keywords: string[]; relatedLinks: { label: string; href: string }[] }`
  - `type BlogPostJson` (the website's 14 fields, same names and order as the website file)
  - `type Section = { heading: string; paragraphs: string[]; list?: string[] }`
  - `parseArticleBody(body: string): Section[]` — throws `ProfileError(code: "BLOG_BODY_FORMAT", detail)`
  - `slugify(title: string): string` — throws `ProfileError("BLOG_SLUG_INVALID")` when empty
  - `readTime(sections: Section[]): string`
  - `toPostJson(input: { title: string; body: string; article: ArticleMeta; date: string }): BlogPostJson`
  - `validatePost(post: unknown, expectedSlug?: string): string[]` (website rules, same messages' field prefixes as the website: `"slug: …"`, `"sections[0].heading: …"`)
  - `checkOrbitRules(post: BlogPostJson, allowlist: string[]): string[]` (stricter Orbit rules)
  - `linkAllowlist(existingSlugs: string[]): string[]`
  - `postFileBytes(post: BlogPostJson): string`
  - `const PROFILE_ID = "uliquid-blog-json-v1"`, `class ProfileError extends Error { code; detail? }`

- [ ] **Step 1: Write failing tests**

````ts
test("website posts pass the profile unchanged", () => {
  for (const file of FIXTURES)
    expect(validatePost(read(file), basename(file, ".json"))).toEqual([]);
});
test("website rejection cases are rejected with the same field", () => {
  // the 13 cases of the website's tests/blog.test.mjs, same mutations
  expect(
    rejects((p) => {
      delete p.title;
    }),
  ).toMatch(/^title: is required/m);
  expect(
    rejects((p) => {
      p.relatedLinks[0].href = "/platform";
    }),
  ).toMatch(/^relatedLinks\[0\]\.href:/m);
  // …remaining 11 cases verbatim from the website test
});
test("parses restricted markdown", () => {
  expect(
    parseArticleBody("## A\n\nOne.\n\nTwo.\n\n- x\n- y\n\n## B\n\nThree."),
  ).toEqual([
    { heading: "A", paragraphs: ["One.", "Two."], list: ["x", "y"] },
    { heading: "B", paragraphs: ["Three."] },
  ]);
});
test("CRLF, trailing spaces and extra blank lines parse like clean LF", () => {
  expect(parseArticleBody("## A  \r\n\r\n\r\nOne.  \r\n\r\n- x\r\n")).toEqual(
    parseArticleBody("## A\n\nOne.\n\n- x"),
  );
});
test.each([
  ["# Title\n\nx", "h1"],
  ["## A\n\n### B", "h3"],
  ["## A\n\nSee [docs](https://x.y).", "link"],
  ["## A\n\n**bold**", "emphasis"],
  ["## A\n\n![i](a.png)", "image"],
  ["## A\n\n<b>x</b>", "html"],
  ["## A\n\n- x\n\nAfter list.", "text after list"],
  ["Intro without heading.\n\n## A\n\nx", "text before first heading"],
  ["## A\n\n```\ncode\n```", "code"],
  ["## A\n\n| a | b |", "table"],
])("rejects %j (%s)", (body) => {
  expect(() => parseArticleBody(body)).toThrow(
    expect.objectContaining({ code: "BLOG_BODY_FORMAT" }),
  );
});
test("slugify", () => {
  expect(slugify("uLiquid's AI: 2026 Guide!")).toBe("uliquids-ai-2026-guide");
  expect(slugify("Über Märkte & Risiko")).toBe("uber-markte-risiko");
  expect(slugify("A".repeat(200)).length).toBeLessThanOrEqual(80);
  expect(() => slugify("!!!")).toThrow(
    expect.objectContaining({ code: "BLOG_SLUG_INVALID" }),
  );
});
test("toPostJson fills derived fields", () => {
  const post = toPostJson({
    title: "Market Context",
    body: SAMPLE_BODY_1320_WORDS,
    article: META,
    date: "2026-10-12",
  });
  expect(post).toMatchObject({
    slug: "market-context",
    readTime: "6 min read",
    author: "Mario Euchner",
    authorTitle: "Founder & Product Lead",
    publishedAt: "2026-10-12",
    updatedAt: "2026-10-12",
  });
  expect(validatePost(post, "market-context")).toEqual([]);
  expect(postFileBytes(post).endsWith("}\n")).toBe(true);
});
test("orbit rules", () => {
  const allow = linkAllowlist(["market-intelligence-context-not-signal"]);
  expect(allow).toContain("/blog/market-intelligence-context-not-signal/");
  expect(
    checkOrbitRules({ ...POST, relatedLinks: [LINK("/platform/")] }, allow),
  ).toContain("relatedLinks: needs 2 to 4 entries");
  expect(
    checkOrbitRules(
      { ...POST, relatedLinks: [LINK("/platform/"), LINK("/careers/")] },
      allow,
    ),
  ).toContain('relatedLinks[1].href: "/careers/" is not in the allowlist');
  expect(checkOrbitRules(POST_WITH_4_SECTIONS, allow)).toContain(
    "sections: needs 5 to 8 sections",
  );
  expect(checkOrbitRules(POST_WITH_900_WORDS, allow)).toContain(
    "body: needs 1000 to 2200 words (has 900)",
  );
});
````

- [ ] **Step 2: Run** `pnpm exec vitest run packages/connectors/src/blog-targets` — Expected: FAIL (module not found).
- [ ] **Step 3: Implement the profile.** Validation is a TypeScript port of the website's `content/blog/blog-posts.mjs` (same rules, same message texts). Slug: NFKD, strip combining marks, lowercase, drop apostrophes, non-`[a-z0-9]` runs → `-`, trim `-`, cut to 80 at a hyphen boundary. Word count: whitespace-split words of headings, paragraphs and list items. Allowlist base: `/platform/`, `/features/`, `/features/dashboard-portfolio/`, `/features/market-intelligence/`, `/features/trading-desk/`, `/features/ai-workbench/`, `/features/automation-bots/`, `/features/bot-vaults/`, `/pricing/`, `/resources/`, `/risk-disclosure/`, `/faq/`, `/about/`.
- [ ] **Step 4: Run** the same command — Expected: PASS.
- [ ] **Step 5: Commit** `feat(connectors): add uliquid blog target profile (R81)`.

### Task 2: GitHub client

**Files:**

- Create: `packages/connectors/src/github.ts`
- Modify: `packages/connectors/src/index.ts`
- Test: `packages/connectors/src/github.test.ts`

**Interfaces:**

- Consumes: `boundedFetch`, `ConnectorError`, `providerDetail`, `FetchLike` from `http.ts`.
- Produces: `createGithubClient(options: { token: string; owner: string; repo: string; fetch?: FetchLike }): GithubClient` with
  - `getRepo(): Promise<{ defaultBranch: string; private: boolean }>`
  - `getBranchHead(branch: string): Promise<string | null>` (null on 404)
  - `listDirectory(path: string, ref: string): Promise<{ name: string; path: string; sha: string; type: string }[]>`
  - `getFile(path: string, ref: string): Promise<{ sha: string; text: string } | null>` (base64 decoded, null on 404)
  - `createBranch(branch: string, sha: string): Promise<void>` (422 "Reference already exists" → `ConnectorError("GITHUB_REF_EXISTS","rejected")`)
  - `deleteBranch(branch: string): Promise<void>` (404 is success)
  - `compareCommits(base: string, head: string): Promise<{ aheadBy: number; commits: { sha: string; authorLogin: string | null; message: string }[] }>`
  - `putFile(input: { path: string; branch: string; text: string; message: string; sha?: string }): Promise<{ commitSha: string }>`
  - `findOpenPull(headBranch: string): Promise<{ number: number; headSha: string; htmlUrl: string } | null>`
  - `createPull(input: { title: string; head: string; base: string; body: string }): Promise<{ number: number; headSha: string; htmlUrl: string }>`
  - `getPull(number: number): Promise<{ state: "open" | "closed"; merged: boolean; headSha: string; mergeCommitSha: string | null; htmlUrl: string }>`
  - `checkRuns(sha: string): Promise<{ total: number; pending: number; failed: string[]; passed: number }>`
  - `mergePull(number: number, sha: string): Promise<{ mergeSha: string }>` (409 head moved → `GITHUB_HEAD_MOVED`, 405 not mergeable → `GITHUB_NOT_MERGEABLE`)
  - `closePull(number: number): Promise<void>`
- Also produces: `fetchPublicPage(url: string, fetch?: FetchLike): Promise<{ status: number; text: string }>` (HTTPS only, ≤ 2 MB, no redirects).
- Error mapping (all methods): 401 and 403 without rate-limit → `GITHUB_AUTH` (`rejected`); 403 with `x-ratelimit-remaining: 0` or 429 → `RATE_LIMITED` with `retryAfterMs` from `x-ratelimit-reset`/`retry-after`; 404 (where not null-mapped) → `GITHUB_NOT_FOUND`; 5xx and network on writes → outcome `unknown`, on reads `not_sent` retryable.

- [ ] **Step 1: Write failing tests** with a recording fake fetch: each method sends the documented method, path (`/repos/eds-labs/site/...`), headers (`Authorization: Bearer t`, `X-GitHub-Api-Version: 2022-11-28`) and body (e.g. `putFile` sends base64 content, `branch`, optional `sha`; `mergePull` sends `{ sha, merge_method: "merge" }`); null mappings on 404; every error mapping above; `checkRuns` counts `status !== "completed"` as pending and conclusions other than `success|neutral|skipped` as failed (by name); `owner`/`repo` outside `^[A-Za-z0-9._-]+$` throw `INVALID_TARGET`; the token never appears in thrown `detail`.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/connectors/src/github.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.** Own request helper on `boundedFetch` (needs response headers for rate limits, so not `jsonTransport`); 15 s timeout; `per_page=100` on list calls.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `feat(connectors): add minimal GitHub client (R81)`.

### Task 3: Flag, GitHub connector, verification and readiness

**Files:**

- Modify: `packages/config/src/index.ts` (flag), `.env.example`, `docker-compose.yml`
- Create: `apps/api/src/modules/blog-target.ts`
- Modify: `apps/api/src/server.ts` (connector action provider enum + github fields; route `POST /api/projects/:projectId/connectors/:id/verify-github`)
- Modify: `apps/api/src/modules/action-readiness.ts:177-181`, `apps/web/src/lib/readiness-text.ts`
- Modify: `apps/api/src/modules/agents/notifications.ts` (kinds `github_token_invalid`, `github_token_expiring`, `blog_live`, `blog_delivery_stopped`) and its text rendering in `notification-sender.ts`
- Test: `apps/api/tests/blog-target.integration.test.ts`

**Interfaces:**

- Consumes: Task 1 (`validatePost`, `PROFILE_ID`), Task 2 (`createGithubClient`).
- Produces:
  - `blogGithubEnabled(): boolean` (in `packages/config`, alongside the other flags)
  - `type BlogTarget = { connectorId: string; owner: string; repo: string; baseBranch: string; postsPath: string; siteUrl: string; blogPathPrefix: string; profile: "uliquid-blog-json-v1"; status: string }`
  - `loadBlogTarget(tx: DbTx, scope: Scope, connectorId: string): Promise<{ target: BlogTarget; token: string }>` (throws `BLOG_TARGET_NOT_CONFIGURED` if absent or not `github`)
  - `githubFor(token: string, target: BlogTarget, deps?: { fetch?: FetchLike }): GithubClient`
  - `listPublishedArticles(scope: Scope, connectorId: string, deps?): Promise<{ slug: string; title: string; category: string; keywords: string[]; publishedAt: string }[]>`
  - `verifyBlogTarget(scope: Scope, connectorId: string, deps?): Promise<{ status: "read_verified" | "write_verified"; problems: string[] }>`
  - `markTokenInvalid(tx: DbTx, scope: Scope, connectorId: string): Promise<void>` (status → `configured`, notice `github_token_invalid` once per connector version)
- Connector input for `provider: "github"`: `{ owner, repo, baseBranch (default "main"), postsPath (default "content/blog/posts"), siteUrl (https), blogPathPrefix (default "/blog/"), profile: "uliquid-blog-json-v1", tokenExpiresAt: ISO date, credential }`; refused with `BLOG_GITHUB_DISABLED` when the flag is off; owner role only.

- [ ] **Step 1: Write failing integration tests** (fake GitHub via `deps.fetch`):
  - creating a `github` connector stores `encryptedCredential`, response has no credential, status `configured`; flag off → 409 `BLOG_GITHUB_DISABLED`; editor role → 403.
  - `verifyBlogTarget`: repo + branch + directory + both fixture posts valid → creates and deletes `orbit/verify-xxxxxxxx`, status `write_verified`; an invalid post in the directory → status stays `configured`, problems list names the file; branch create 403 → `read_verified` with problem `GITHUB_AUTH`; failed delete → `write_verified` plus problem `VERIFY_BRANCH_NOT_DELETED`.
  - `listPublishedArticles` returns the fixture fields sorted newest first.
  - readiness `blog_live`: flag off → `not_configured` `BLOG_GITHUB_DISABLED`; no connector → `BLOG_TARGET_NOT_CONFIGURED`; connector `read_verified` → `GITHUB_WRITE_VERIFICATION_REQUIRED`; `write_verified` → `ready`.
  - `markTokenInvalid` downgrades and raises one notice; the daily sweep raises `github_token_expiring` when `tokenExpiresAt` is within 14 days, once per connector.
- [ ] **Step 2: Run** `pnpm exec vitest run apps/api/tests/blog-target.integration.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** flag, connector branch, service, verify route (owner only), readiness, notices (German and English texts in the existing style: "GitHub-Token erneuern", "Artikel ist live: <url>", "Auslieferung gestoppt: <code>"). Hook `github_token_expiring` into the existing daily notification sweep.
- [ ] **Step 4: Run** — Expected: PASS. Also `pnpm typecheck`.
- [ ] **Step 5: Commit** `feat(api): add GitHub blog target connector and readiness (R81)`.

### Task 4: Delivery `github_pr` on assignments

**Files:**

- Modify: `apps/api/src/modules/agents/assignments.ts` (`delivery` enum, superRefine, `Delivery`, `deliveryOf`, `confirmedDelivery`, `assertWithinMandate`)
- Modify (hand-copied unions): `apps/api/src/modules/agents/chat-tools.ts:43`, `agents/owner-release.ts:64`, `agents/agent-activity.ts:62`, `agents/tools/assignment-tools.ts`, `apps/web/src/components/assignments.tsx:74,89`, `assignment-card.tsx:31`, `agent-activity.tsx:44`
- Test: `apps/api/src/modules/agents/assignments.test.ts` (or the existing assignment integration test file)

**Interfaces:**

- Consumes: `blogGithubEnabled`, `loadBlogTarget` (Task 3).
- Produces: `type Delivery = "publish" | "postiz_draft" | "github_pr"`; `deliveryOf`/`confirmedDelivery` return `"github_pr"` for it; error codes `BLOG_GITHUB_DISABLED`, `BLOG_TARGET_NOT_VERIFIED`.

- [ ] **Step 1: Write failing tests:**
  - `github_pr` with `contentType` other than `blog` → issue on `delivery` "Only blog articles can be delivered as GitHub pull requests".
  - `github_pr` needs `channels` = exactly one id → issue on `channels` "A GitHub delivery has exactly one blog target".
  - mandate: flag off → `BLOG_GITHUB_DISABLED`; channel not a `github` connector or not `write_verified` → `BLOG_TARGET_NOT_VERIFIED`; the policy's channel list is not required to contain the connector id (connector channels are owner-created), but `contentTypes` must contain `blog` (`SCOPE_NOT_ALLOWED` otherwise); `image`, `banner`, `format`, `sharedAcrossChannels` are refused for `github_pr` blog as today for blog.
  - `confirmedDelivery` returns `"github_pr"` from a confirmation recorded with it; the assignment hash covers it.
  - a confirmed `github_pr` assignment whose run starts while the flag is off ends the run at start with `BLOG_GITHUB_DISABLED` and keeps its confirmation.
- [ ] **Step 2: Run** the test file — Expected: FAIL.
- [ ] **Step 3: Implement**, and extend every hand-copied union; the web assignment card labels it "GitHub-PR (Website)" / "GitHub pull request (website)".
- [ ] **Step 4: Run** tests and `pnpm typecheck` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(agents): add github_pr delivery for blog assignments (R81)`.

### Task 5: Article generation (strategy input, copywriter output, token ceiling)

**Files:**

- Modify: `packages/ai/src/index.ts` (optional `article` output, `ARTICLE_DRAFT_INSTRUCTION`, JSON schema, param `article?: true`)
- Modify: `packages/ai/src/routing.ts:46` (`draft_blog: 8000`) and `packages/ai/src/routing.test.ts:16`
- Modify: `apps/api/src/modules/generation.ts` (contract `blogTarget` for missions of `github_pr` assignments; request `article: true`; store `article` on content; validation via Task 1 as deterministic problem)
- Modify: `apps/api/src/modules/agents/assignment-runs.ts` / `agents/specialists/strategy.ts` (input `publishedArticles` instead of `channelHistory` for `github_pr`; exactly one brief; brief slug not in published list → dropped with `BLOG_SLUG_EXISTS`)
- Test: `packages/ai/src/index.test.ts`, `apps/api/tests/blog-generation.integration.test.ts`

**Interfaces:**

- Consumes: Task 1 (`toPostJson`, `validatePost`, `checkOrbitRules`, `linkAllowlist`, `slugify`), Task 3 (`listPublishedArticles`), Task 4 (`deliveryOf`).
- Produces: content field `article: ArticleMeta` on blog content of `github_pr` missions; contract field `blogTarget: { profile, allowlist: string[], publishedArticles: {slug,title}[], words: { min: 1200, max: 1800 }, sections: { min: 5, max: 8 } }`; helper `blogPostOf(content: Record<string, any>, date: string): { post: BlogPostJson; problems: string[] }` in `apps/api/src/modules/blog-target.ts`.

- [ ] **Step 1: Write failing tests:**
  - ai: with `article: true` the request's JSON schema requires `article` with the six fields and the instruction is appended; output without `article` → throws `ARTICLE`; output with `article` when not asked → throws `ARTICLE`.
  - routing: default `draft_blog` ceiling 8000.
  - integration (stub model returning fixed JSON): a `github_pr` blog run's strategy receives `publishedArticles` (from the fake GitHub) and no `channelHistory`; a brief whose slug exists is dropped with `BLOG_SLUG_EXISTS`; the copywriter's contract carries `blogTarget` with the allowlist; the stored content has `article`; a body with a Markdown link becomes a deterministic problem `BLOG_BODY_FORMAT` for the review; `blogPostOf` returns a valid post for the stub article.
- [ ] **Step 2: Run** both test files — Expected: FAIL.
- [ ] **Step 3: Implement.** `ARTICLE_DRAFT_INSTRUCTION` states the restricted Markdown (only `## ` headings, plain paragraphs, at most one `- ` list ending a section, no links/emphasis/images/code/tables/HTML), 1200–1800 words in 5–8 sections, English, `relatedLinks` 2–4 from `blogTarget.allowlist`, and the field limits from Global Constraints.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `feat(agents): generate website-ready blog articles (R82)`.

### Task 6: Review and owner list for blog articles

**Files:**

- Modify: `apps/api/src/modules/agents/agent-review.ts` (`agentReviewAccepted` false for `delivery: "github_pr"`)
- Modify: `apps/api/src/modules/agents/specialists/review.ts` (blog article problems from `blogPostOf` are deterministic problems; review input gets `publishedArticles` for overlap; an `approve` of a `github_pr` draft settles as left for the owner with notice `needs_owner`; Drive save unchanged)
- Modify: `apps/api/src/modules/agents/assignment-overview.ts:~300` (`draftsAwaitingOwner` includes `type === "blog"` drafts of `github_pr` assignments with `preview: { post, problems, liveUrl, slugTaken }`)
- Test: `apps/api/tests/blog-review.integration.test.ts`

**Interfaces:**

- Consumes: `blogPostOf` (Task 5), `listPublishedArticles` (Task 3).
- Produces: `AwaitingOwnerDraft.preview?: { post: BlogPostJson; problems: string[]; liveUrl: string; slugTaken: boolean }` (API row and web type).

- [ ] **Step 1: Write failing tests:** agent approve with `ORBIT_AGENT_REVIEW_AUTHORITY=true` leaves a `github_pr` blog draft `needs_review` and raises `needs_owner`; a draft with a validation problem is revised once, then left for the owner with the problems as reasons; `GET /assignment-drafts` lists the blog draft with `preview.post.slug`, `preview.liveUrl = "https://uliquid.vip/blog/<slug>/"`, `slugTaken` true when the fake repo has the file; social drafts unchanged.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement.** The draft list reads the published list once per request (not per draft) and degrades to `slugTaken: false` with problem `BLOG_TARGET_UNREACHABLE` when GitHub is unreachable.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `feat(agents): owner-only release of blog articles (R81)`.

### Task 7: Release books a blog delivery

**Files:**

- Create: `apps/api/src/modules/agents/blog-delivery.ts` (booking part)
- Modify: `apps/api/src/modules/agents/owner-release.ts` (blog branch; `ReleaseResult.delivery` gains `"github_pr"`, field `blogDeliveryId`)
- Modify: `apps/api/src/server.ts` release route (outside the transaction, for blog drafts: `assertSlugFree` against GitHub before `scoped(...)`)
- Test: `apps/api/tests/blog-github-delivery.integration.test.ts` (booking cases)

**Interfaces:**

- Consumes: `blogPostOf` (Task 5), `loadBlogTarget`/`githubFor` (Task 3), `enqueue` (`workflow.ts:31`).
- Produces:
  - `BLOG_DELIVERY_TOPIC = "blog_github_pr"`, kind `"blog_deliveries"`
  - `type BlogDeliveryStatus = "queued" | "branch_ready" | "committed" | "pr_open" | "checks_passed" | "merged" | "live" | "checks_failed" | "checks_timeout" | "live_unverified" | "blocked_dependency" | "outcome_unknown" | "canceled" | "failed"`
  - `bookBlogDelivery(tx: DbTx, scope: Scope, input: { content: Row; runId: string; assignmentId: string; connectorId: string; date: string }): Promise<Row>` — row fields exactly as spec §7 (`contentId, assignmentId, runId, connectorId, slug, path, fileSha256, fileBytes, branch, status, prNumber, headSha, mergeSha, liveUrl, attempts, error, bodyHash, title, checksSince, mergedAt`), enqueues the first step with key `blog:<deliveryId>:step:1`.
  - `assertSlugFree(scope: Scope, contentId: string, deps?): Promise<void>` — throws `BLOG_SLUG_EXISTS` (409).

- [ ] **Step 1: Write failing tests:** owner release of a valid blog draft → result `{ delivery: "github_pr", blogDeliveryId }`, a `queued` row with `fileBytes` equal to `postFileBytes(post)` and `branch: "blog/<slug>"`, one job; releasing again returns the same delivery; slug present in repo → 409 `BLOG_SLUG_EXISTS`, no row; a second draft with the same slug while the first delivery is active → 409 `BLOG_SLUG_BOOKED`; draft with problems → 409 `BLOG_POST_INVALID`; flag off → 409 `BLOG_GITHUB_DISABLED`; editor → 403.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement** (`date` = Europe/Berlin date of the release; the file bytes are fixed then and the worker recomputes nothing).
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `feat(agents): book blog deliveries on owner release (R83)`.

### Task 8: Delivery worker and state machine

**Files:**

- Modify: `apps/api/src/modules/agents/blog-delivery.ts` (steps, cancel, recovery)
- Modify: `apps/worker/src/main.ts` (queue class `"blog_github_pr"`, dispatch, lease recovery → `markBlogDeliveryOutcomeUnknown`)
- Modify: `apps/api/src/server.ts` (route `POST /api/projects/:projectId/blog-deliveries/:id/cancel`, owner only; `GET /api/projects/:projectId/blog-deliveries`)
- Test: `apps/api/tests/blog-github-delivery.integration.test.ts`

**Interfaces:**

- Consumes: Task 2 client, Task 3 `markTokenInvalid`, Task 7 rows.
- Produces: `advanceBlogDelivery(scope: Scope, deliveryId: string, deps?: { fetch?: FetchLike; now?: () => Date }): Promise<void>`, `cancelBlogDelivery(scope, deliveryId, deps?)`, `markBlogDeliveryOutcomeUnknown(tx, scope, deliveryId)`.

Each call performs the one step for the row's status (spec §7 steps 1–7), records the new status, and enqueues the next call with key `blog:<id>:step:<n>` (`availableAt` +60 s while polling). Before each step: flag off or project paused → no change and no new job (the sweep re-enqueues on resume); `outcome_unknown` rows re-run their step, which reads GitHub first. GitHub `GITHUB_AUTH` → `blocked_dependency` + `markTokenInvalid`; `RATE_LIMITED` → re-enqueue at `retryAfterMs`, no status change; `GITHUB_NOT_FOUND` on repo/base → `blocked_dependency` `GITHUB_TARGET_MISSING`. Terminal and stop states raise `blog_live` or `blog_delivery_stopped`.

- [ ] **Step 1: Write failing tests** (fake GitHub server object with state: refs, files, pulls, check runs, merge behaviour; fake page server):
  - happy path to `live`: branch created at base head, file put with the exact `fileBytes`, PR title `Blog: <title>`, body contains "Released by Mario in Orbit on", merge sent with `sha: headSha`, branch deleted, live page polled, notice `blog_live` with the URL.
  - crash after each step (set the row back to the previous status after the fake write succeeded) → the retry reuses branch/file/PR; exactly one branch, one commit, one PR.
  - foreign commit on `blog/<slug>` (compare shows a commit not authored by Orbit's commit sha) → `failed` `BLOG_BRANCH_FOREIGN`, no merge.
  - merge returns 409 → `failed` `BLOG_HEAD_MOVED`.
  - check run failed → `checks_failed`, PR open, notice; no further job.
  - check runs empty for the first polls, then success → still `pr_open` while empty, then `checks_passed`.
  - no completed checks for 30 minutes (`now` advanced) → `checks_timeout`.
  - unrelated commit on base `main` after branch creation → merge still sent with Orbit's `headSha` and succeeds.
  - content body hash changed after release → `failed` `CONTENT_CHANGED`, nothing written.
  - file appears on base before commit → `failed` `BLOG_SLUG_EXISTS`.
  - 401 → `blocked_dependency`, connector `configured`, notice `github_token_invalid`.
  - rate limit 403 with remaining 0 → job re-enqueued at reset, status unchanged.
  - live page 404 for 30 minutes → `live_unverified`; title `Risk & Reward <Basics>` found via `Risk &amp; Reward &lt;Basics&gt;` → `live`.
  - flag off mid-flight → no change, no new job.
  - cancel at `pr_open` → PR closed, branch deleted, `canceled`; cancel after `merged` → 409 `BLOG_ALREADY_MERGED`.
  - lease expiry of a running job → `outcome_unknown`, next run continues correctly.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement.** Branch ownership check: `compareCommits(baseHead, branchHead)` must list only commits whose sha is `row.headSha` (or no commits). Live check: decode `&amp; &lt; &gt; &quot; &#39; &#x27;` before searching the title.
- [ ] **Step 4: Run** the file and `pnpm test:unit` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(worker): deliver released blog articles as GitHub pull requests (R83)`.

### Task 9: Web — connector form, preview, delivery status

**Files:**

- Modify: `apps/web/src/components/management.tsx` (provider `github` fields: owner, repo, base branch, posts path, site URL, token, token expiry; "Verbindung prüfen" calls verify route)
- Create: `apps/web/src/components/blog-preview.tsx` (renders `preview.post`: title, meta line, description, sections, list, related links, target URL, problems)
- Modify: `apps/web/src/components/assignments.tsx` (awaiting-owner list renders `BlogPreview` for blog drafts; "Freigeben" disabled with the first problem or "Slug existiert bereits" when `slugTaken`)
- Modify: `apps/web/src/components/agent-activity.tsx` (blog deliveries: status label, PR link, live link, "Auslieferung abbrechen" before `merged`)
- Test: `apps/web/src/components/blog-preview.test.tsx`, additions to existing `assignments`/`agent-activity` component tests

**Interfaces:**

- Consumes: `AwaitingOwnerDraft.preview` (Task 6), `GET /blog-deliveries` and cancel route (Task 8), verify route (Task 3).

- [ ] **Step 1: Write failing component tests:** preview shows all section headings and related links; problems listed and release button disabled with the first problem text; `slugTaken` disables with "Slug existiert bereits"; delivery row `pr_open` shows PR link and cancel button, `merged`/`live` hide cancel, `live` shows the live link; German and English labels.
- [ ] **Step 2: Run** `pnpm exec vitest run apps/web/src/components/blog-preview.test.tsx` — Expected: FAIL.
- [ ] **Step 3: Implement** in the existing component style.
- [ ] **Step 4: Run** web tests and `pnpm typecheck` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): blog preview, GitHub connector and delivery status (R81)`.

### Task 10: Documentation and full check

**Files:**

- Modify: `docs/superpowers/plans/2026-10-09-orbit-agents-rulings.md` (R81 target profile, connector and owner-only release; R82 generation; R83 delivery state machine — format `- **R<n>**: (2026-10-12, context) decision — why — cost if wrong`)
- Modify: `docs/OPERATIONS.md` (flag, token creation steps with exact permissions, verification, rollback of an article and of the feature, notices)
- Modify: `docs/IMPLEMENTATION_STATUS.md` (new dated section on top), `docs/REQUIREMENTS_TRACEABILITY.md` (A16 row: live path implemented, verified in production pending rollout; new acceptance IDs `BG1`–`BG8` mapped to the tests of Tasks 1–9; totals line)
- Modify: `docs/CONNECTOR_CAPABILITIES.md`, `docs/PRODUCT_DECISIONS.md:15` (blog target chosen: GitHub PR to the website repo)

- [ ] **Step 1: Write the docs.**
- [ ] **Step 2: Run** `pnpm check` and `pnpm framework:check` — Expected: all pass (lint, typecheck, unit, integration, framework).
- [ ] **Step 3: Commit** `docs: blog GitHub delivery rulings, operations and traceability (R81-R83)`.

## Rollout (after merge, each with Mario's approval; not part of the implementation tasks)

1. Deploy with `ORBIT_BLOG_GITHUB=false`.
2. Mario creates the fine-grained token (repo `eds-labs/uliquid-desk-website-v2`; Contents and Pull requests read & write; expiry ≤ 1 year) and enters it; set flag on; create and verify the connector (read, write).
3. Production route `draft_blog` output ceiling 4,000 → 8,000.
4. Live eval of two blog runs (≈ 0.30–0.50 USD each, eval key).
5. Mario confirms the blog assignment card (monthly, 5 USD, delivery `github_pr`).
6. First run accompanied: release, PR, CI, merge, live page.
