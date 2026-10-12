import { createHash } from "node:crypto";
import { scoped, type DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import {
  ConnectorError,
  postFileBytes,
} from "../../../../../packages/connectors/src/index.ts";
import {
  audit,
  create,
  data,
  DomainError,
  entity,
  hash,
} from "../../shared.ts";
import {
  assertBlogGithubEnabled,
  berlinDate,
  blogLiveUrl,
  blogPostOf,
  githubFor,
  guarded,
  isAuth,
  loadBlogTarget,
  type BlogTargetDeps,
} from "../blog-target.ts";
import { preflight } from "../policy.ts";
import { enqueue } from "../workflow.ts";

/**
 * Delivery "GitHub pull request" of website articles (R83, spec §7). The
 * owner's release of a github_pr blog draft books one `blog_deliveries` row
 * here, in the release transaction: the exact file the worker commits
 * (`fileBytes`, fixed at release and never regenerated), its path, branch
 * and live address, and the first worker step. The worker (topic
 * `blog_github_pr`, one step per job) opens the pull request, waits for the
 * checks, merges and checks the live page.
 *
 * Nothing here applies the social slot rules: an article is not posted at a
 * slot, so no publication, no Postiz draft, no veto window and no slot
 * booking. The binding slug is `slugify(title)` (`blogPostOf`), never the
 * brief's: it must be free in the repository (`assertSlugFree`, read before
 * the transaction) and not booked by another delivery (`BLOG_SLUG_BOOKED`).
 */
export const BLOG_DELIVERY_TOPIC = "blog_github_pr";
export const BLOG_DELIVERY_KIND = "blog_deliveries";

export type BlogDeliveryStatus =
  | "queued"
  | "branch_ready"
  | "committed"
  | "pr_open"
  | "checks_passed"
  | "merged"
  | "live"
  | "checks_failed"
  | "checks_timeout"
  | "live_unverified"
  | "blocked_dependency"
  | "outcome_unknown"
  | "canceled"
  | "failed";

// A delivery in one of these states holds its slug no longer.
const ENDED: BlogDeliveryStatus[] = ["failed", "canceled"];
// Preflight codes of a slot or a publication step: an article is released
// whenever the owner decides (within the release window) and is published
// by the merge, not by a mission's publish right.
const NOT_FOR_ARTICLES = new Set([
  "MISSION_EXPIRED",
  "MISSION_TEST_WRITE_NOT_AUTHORIZED",
  "QUIET_HOURS",
  "MANUAL_CALENDAR_BLOCK",
]);

type Row = Awaited<ReturnType<typeof entity>>;

/** The delivery of a content that is not failed or canceled, if any (the oldest). */
export async function activeBlogDelivery(
  tx: DbTx,
  scope: Scope,
  contentId: string,
) {
  const rows = await tx.entity.findMany({
    where: {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      kind: BLOG_DELIVERY_KIND,
      data: { path: ["contentId"], equals: contentId },
    },
    orderBy: { createdAt: "asc" },
  });
  return rows.find((row) => !ENDED.includes(data(row).status)) ?? null;
}

/** The blog target's connector, or `BLOG_TARGET_NOT_VERIFIED` without verified write access. */
async function verifiedTarget(tx: DbTx, scope: Scope, connectorId: string) {
  const loaded = await loadBlogTarget(tx, scope, connectorId).catch((error) => {
    if (
      error instanceof DomainError &&
      error.code === "BLOG_TARGET_NOT_CONFIGURED"
    )
      return null;
    throw error;
  });
  if (loaded?.target.status !== "write_verified")
    throw new DomainError("BLOG_TARGET_NOT_VERIFIED", 409);
  return loaded.target;
}

/**
 * Books the delivery of one released article (R83): flag, verified target,
 * a post without problems for `date` (Europe/Berlin), the deterministic
 * blockers except the slot and publication codes, and a slug no other
 * active delivery holds. Creates the `queued` row and enqueues step 1
 * (`blog:<deliveryId>:step:1`). Throws a DomainError for any refusal; the
 * caller's transaction rolls back.
 */
export async function bookBlogDelivery(
  tx: DbTx,
  scope: Scope,
  input: {
    content: Row;
    runId: string;
    assignmentId: string;
    connectorId: string;
    date: string;
  },
): Promise<Row> {
  assertBlogGithubEnabled();
  const target = await verifiedTarget(tx, scope, input.connectorId);
  const c = data(input.content);
  const { post, problems } = blogPostOf(c, input.date);
  if (problems.length) throw new DomainError("BLOG_POST_INVALID", 409);
  const checked = await preflight(tx, scope, input.content.id, {
    test: true,
    at: new Date(),
    ignoreApproval: true,
  });
  const blockers = checked.blockers.filter(
    (code) => !NOT_FOR_ARTICLES.has(code),
  );
  if (blockers.length) throw new DomainError(blockers.join(","), 409);
  // Another article on its way to the same file (R83).
  const booked = await tx.entity.findMany({
    where: {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      kind: BLOG_DELIVERY_KIND,
      data: { path: ["slug"], equals: post.slug },
    },
  });
  if (
    booked.some(
      (row) =>
        data(row).contentId !== input.content.id &&
        !ENDED.includes(data(row).status),
    )
  )
    throw new DomainError("BLOG_SLUG_BOOKED", 409);
  const fileBytes = postFileBytes(post);
  const row = await create(tx, scope, BLOG_DELIVERY_KIND, {
    contentId: input.content.id,
    assignmentId: input.assignmentId,
    runId: input.runId,
    connectorId: input.connectorId,
    slug: post.slug,
    title: post.title,
    path: `${target.postsPath}/${post.slug}.json`,
    fileSha256: createHash("sha256").update(fileBytes).digest("hex"),
    fileBytes,
    branch: `blog/${post.slug}`,
    status: "queued" satisfies BlogDeliveryStatus,
    prNumber: null,
    headSha: null,
    mergeSha: null,
    liveUrl: blogLiveUrl(target, post.slug),
    attempts: 0,
    error: null,
    // The body the owner reviewed; the worker stops with CONTENT_CHANGED otherwise.
    bodyHash: c.humanReviewedBodyHash ?? hash(c.body),
    checksSince: null,
    mergedAt: null,
    releasedBy: scope.userId,
    releasedAt: new Date().toISOString(),
  });
  await audit(tx, scope, "blog_delivery.booked", row.id, {
    contentId: input.content.id,
    slug: post.slug,
    fileSha256: data(row).fileSha256,
  });
  await enqueue(
    tx,
    scope,
    BLOG_DELIVERY_TOPIC,
    row.id,
    `blog:${row.id}:step:1`,
  );
  return row;
}

/**
 * The slug check against the repository before the release (R83): reads the
 * draft and its blog target in one transaction, then asks GitHub outside of
 * it whether the post's file exists on the base branch (`BLOG_SLUG_EXISTS`).
 * Only for a github_pr article that still waits for the owner; anything else
 * (a social draft, an editor, a released article, an unverified target, a
 * post without a slug) is left to the release, which refuses it itself. The
 * flag is checked before any network call. An unreachable GitHub refuses
 * with `BLOG_TARGET_UNREACHABLE`, a refused token with
 * `GITHUB_TOKEN_INVALID` (the connector goes back to `configured`).
 */
export async function assertSlugFree(
  scope: Scope,
  contentId: string,
  deps?: BlogTargetDeps,
): Promise<void> {
  if (scope.role !== "owner") return;
  const read = await scoped(scope.workspaceId, scope.projectId, async (tx) => {
    const row = await tx.entity.findFirst({
      where: {
        id: contentId,
        kind: "content",
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
      },
    });
    const c = data(row);
    if (!row || c.type !== "blog" || c.delivery !== "github_pr") return null;
    if (c.status !== "needs_review" || c.supersededBy) return null;
    if (await activeBlogDelivery(tx, scope, contentId)) return null;
    assertBlogGithubEnabled();
    const { post } = blogPostOf(c, berlinDate());
    if (!post.slug) return null;
    const loaded = await loadBlogTarget(tx, scope, String(c.channel)).catch(
      (error) => {
        if (
          error instanceof DomainError &&
          error.code === "BLOG_TARGET_NOT_CONFIGURED"
        )
          return null;
        throw error;
      },
    );
    if (loaded?.target.status !== "write_verified") return null;
    return { ...loaded, slug: post.slug };
  });
  if (!read) return;
  const { target, token, slug } = read;
  const client = githubFor(token, target, deps);
  let file: Awaited<ReturnType<typeof client.getFile>>;
  try {
    file = await guarded(scope, target.connectorId, () =>
      client.getFile(`${target.postsPath}/${slug}.json`, target.baseBranch),
    );
  } catch (error) {
    // Only GitHub's answers are mapped; Orbit's own errors keep their codes.
    if (!(error instanceof ConnectorError)) throw error;
    if (isAuth(error)) throw new DomainError("GITHUB_TOKEN_INVALID", 409);
    throw new DomainError("BLOG_TARGET_UNREACHABLE", 503);
  }
  if (file) throw new DomainError("BLOG_SLUG_EXISTS", 409);
}
