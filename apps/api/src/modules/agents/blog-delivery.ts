import { createHash } from "node:crypto";
import {
  authDb,
  scoped,
  type DbTx,
} from "../../../../../packages/db/src/index.ts";
import { blogGithubEnabled } from "../../../../../packages/config/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import {
  ConnectorError,
  fetchPublicPage,
  postFileBytes,
  type GithubClient,
} from "../../../../../packages/connectors/src/index.ts";
import {
  audit,
  create,
  data,
  DomainError,
  entity,
  hash,
  list,
  update,
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
  type BlogTarget,
  type BlogTargetDeps,
} from "../blog-target.ts";
import { preflight } from "../policy.ts";
import { enqueue } from "../workflow.ts";
import { notify } from "./notifications.ts";

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
// Live preflight codes that do not apply to an article (R83). The merge goes
// live, so every other live gate (observe mode, synthetic content, external
// writes, RAG evaluation, the manual calendar block, ...) stays a blocker.
const NOT_FOR_ARTICLES = new Set([
  // The run slot's mission window: an article is released within BLOG_RELEASE_WINDOW_DAYS instead.
  "MISSION_EXPIRED",
  // Quiet hours govern a post's slot time; the release time is no post time.
  "QUIET_HOURS",
  // The mission's publish rights: the owner's release replaces them for an article.
  "MISSION_TEST_WRITE_NOT_AUTHORIZED",
  "MISSION_LIVE_WRITE_NOT_AUTHORIZED",
  // Postiz as content provider; an article's provider is the write-verified github connector.
  "LIVE_CONTENT_PROVIDER_CAPABILITY_NOT_CONFIGURED",
  // Postiz publisher and channel verification; checked here as BLOG_TARGET_NOT_VERIFIED.
  "PUBLISHER_WRITE_VERIFICATION_REQUIRED",
  "CHANNEL_WRITE_VERIFICATION_REQUIRED",
  "CHANNEL_MEDIA_VERIFICATION_REQUIRED",
]);

type Row = Awaited<ReturnType<typeof entity>>;

/**
 * The live preflight of an article (R83): the checks of a live write, the
 * owner's release standing in for the approval, without the codes that do
 * not apply to an article. Used by the booking and before every worker step
 * up to the merge, so a live gate that closes in between stops the delivery.
 */
async function liveBlockers(tx: DbTx, scope: Scope, contentId: string) {
  const checked = await preflight(tx, scope, contentId, {
    // The live checks: the merge publishes the article (R83).
    test: false,
    at: new Date(),
    // The owner's release is the approval (as for a package approval).
    ignoreApproval: true,
  });
  return checked.blockers.filter((code) => !NOT_FOR_ARTICLES.has(code));
}

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
    // The run slot the article was written for, kept for the owner's view.
    requestedSlotAt?: string | null;
  },
): Promise<Row> {
  assertBlogGithubEnabled();
  const target = await verifiedTarget(tx, scope, input.connectorId);
  const c = data(input.content);
  const { post, problems } = blogPostOf(c, input.date);
  if (problems.length) throw new DomainError("BLOG_POST_INVALID", 409);
  const blockers = await liveBlockers(tx, scope, input.content.id);
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
    requestedSlotAt: input.requestedSlotAt ?? null,
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
    // Only the slug is used here; it comes from the title, not from the date.
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

// ---------------------------------------------------------------------------
// Worker steps (R83, spec §7 "Worker steps", §8)
// ---------------------------------------------------------------------------

export type BlogDeliveryDeps = BlogTargetDeps & { now?: () => Date };

// The 30-minute windows of the checks and of the live check (spec §7).
const POLL_MS = 60_000;
const CHECKS_TIMEOUT_MS = 30 * 60_000;
const LIVE_TIMEOUT_MS = 30 * 60_000;
// A step marks the row as in flight for this long; shorter than the worker lease (180 s).
const IN_FLIGHT_MS = 170_000;
// Transient GitHub answers in a row before the delivery stops (one per minute).
const MAX_TRANSIENT_RETRIES = 30;
// The sweep starts no more jobs for a delivery that already had this many.
const MAX_DELIVERY_JOBS = 200;
// Deliveries older than this are no longer started again by the sweep.
const REQUEUE_DAYS = 30;
const PENDING_JOB = ["queued", "running", "retry_scheduled"];

// States the worker moves on from, by their step; `queued` holds steps 1 and 2.
const ACTIVE: BlogDeliveryStatus[] = [
  "queued",
  "branch_ready",
  "committed",
  "pr_open",
  "checks_passed",
  "merged",
  "outcome_unknown",
];
// Side states that stop the delivery and tell the owner (`blog_delivery_stopped`).
const STOPPED: BlogDeliveryStatus[] = [
  "checks_failed",
  "checks_timeout",
  "live_unverified",
  "blocked_dependency",
  "failed",
];
// A delivery whose pull request may be merged: a cancel is refused.
const MERGED: BlogDeliveryStatus[] = ["merged", "live", "live_unverified"];

// GitHub answers that say nothing about the delivery: tried again in a minute.
const TRANSIENT = new Set([
  "GITHUB_UNAVAILABLE",
  "NETWORK_ERROR",
  "REQUEST_TIMEOUT",
  "DNS_TIMEOUT",
  "INVALID_PROVIDER_RESPONSE",
  "RESPONSE_TOO_LARGE",
]);

type D = Record<string, any>;
type Outcome = {
  // The new state; absent keeps the state of the step (also after outcome_unknown).
  status?: BlogDeliveryStatus;
  error?: string | null;
  fields?: Record<string, unknown>;
  next?: { step: number; at: Date; kind: "step" | "poll" | "retry" };
  // Flag off or project paused right before the merge: no change and no job.
  hold?: boolean;
};

const commitMessage = (d: D) => `Add blog post: ${String(d.title)}`;
const stepStatus = (d: D): BlogDeliveryStatus =>
  d.status === "outcome_unknown" ? d.resumeFrom : d.status;

/** The step a state runs (1 preflight … 7 live check); null for an end or side state. */
function stepOf(d: D): number | null {
  switch (stepStatus(d)) {
    case "queued":
      return d.preflightAt ? 2 : 1;
    case "branch_ready":
      return 3;
    case "committed":
      return 4;
    case "pr_open":
      return 5;
    case "checks_passed":
      return 6;
    case "merged":
      return 7;
    default:
      return null;
  }
}

const lockRow = (tx: DbTx, scope: Scope, id: string) =>
  tx.$queryRaw`SELECT id FROM "Entity" WHERE id=${id}::uuid AND "projectId"=${scope.projectId}::uuid FOR UPDATE`;

const findRow = (tx: DbTx, scope: Scope, id: string) =>
  tx.entity.findFirst({
    where: {
      id,
      kind: BLOG_DELIVERY_KIND,
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
    },
  });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Locks and reads a delivery; null for an unknown or malformed id. */
async function lockedRow(tx: DbTx, scope: Scope, id: string) {
  if (!UUID.test(id)) return null;
  await lockRow(tx, scope, id);
  return findRow(tx, scope, id);
}

const projectPaused = async (tx: DbTx, scope: Scope) =>
  (
    await tx.project.findUniqueOrThrow({
      where: { id: scope.projectId },
      select: { paused: true },
    })
  ).paused;

/** The decoded text of an HTML page: the entities a title may carry (R83). */
export function decodeHtmlEntities(text: string) {
  return text.replace(
    /&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi,
    (match, entity: string) => {
      const name = entity.toLowerCase();
      if (name.startsWith("#x") || name.startsWith("#")) {
        const code = name.startsWith("#x")
          ? parseInt(name.slice(2), 16)
          : parseInt(name.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code <= 0x10ffff
          ? String.fromCodePoint(code)
          : match;
      }
      return (
        { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " }[name] ??
        match
      );
    },
  );
}
const squash = (text: string) => text.replace(/\s+/g, " ").trim();

/**
 * The checks before every step up to the merge (R83, controller ruling):
 * the reviewed body unchanged since the release (`CONTENT_CHANGED`), the
 * booked file intact, the connector still write-verified and every live
 * gate of the release open. Returns the stop, or the target and token.
 */
async function gates(
  tx: DbTx,
  scope: Scope,
  d: D,
): Promise<
  | { stop: { status: BlogDeliveryStatus; error: string } }
  | { target: BlogTarget; token: string }
> {
  const content = await tx.entity.findFirst({
    where: {
      id: String(d.contentId),
      kind: "content",
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
    },
  });
  if (!content || hash(data(content).body) !== d.bodyHash)
    return { stop: { status: "failed", error: "CONTENT_CHANGED" } };
  if (
    typeof d.fileBytes !== "string" ||
    createHash("sha256").update(d.fileBytes).digest("hex") !== d.fileSha256
  )
    return { stop: { status: "failed", error: "BLOG_FILE_CHANGED" } };
  const loaded = await loadBlogTarget(tx, scope, String(d.connectorId)).catch(
    (error) => {
      if (
        error instanceof DomainError &&
        error.code === "BLOG_TARGET_NOT_CONFIGURED"
      )
        return null;
      throw error;
    },
  );
  if (loaded?.target.status !== "write_verified")
    return {
      stop: { status: "blocked_dependency", error: "BLOG_TARGET_NOT_VERIFIED" },
    };
  const blockers = await liveBlockers(tx, scope, String(d.contentId));
  if (blockers.length)
    return {
      stop: {
        status: "blocked_dependency",
        error: blockers.join(",").slice(0, 200),
      },
    };
  return loaded;
}

/** Records a stop or end state with its audit and notice (in the caller's transaction). */
async function settle(
  tx: DbTx,
  scope: Scope,
  row: Row,
  values: D,
): Promise<Row> {
  const saved = await update(tx, scope, row, values);
  const status = values.status as BlogDeliveryStatus;
  if (status !== data(row).status)
    await audit(tx, scope, `blog_delivery.${status}`, row.id, {
      from: data(row).status,
      error: values.error ?? null,
    });
  if (status === "live") await notify(tx, scope, "blog_live", row.id);
  else if (STOPPED.includes(status) && status !== data(row).status)
    await notify(
      tx,
      scope,
      "blog_delivery_stopped",
      `${row.id}:${status}:${saved.version}`,
    );
  return saved;
}

/** Number of worker jobs a delivery had, so every new poll or retry gets a key of its own. */
const jobsOf = (tx: DbTx, scope: Scope, id: string) =>
  tx.entity.findMany({
    where: {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      kind: "jobs",
      AND: [
        { data: { path: ["topic"], equals: BLOG_DELIVERY_TOPIC } },
        { data: { path: ["resourceId"], equals: id } },
      ],
    },
  });

/**
 * Enqueues the next job of a delivery. A step's first job has the key
 * `blog:<id>:step:<n>`; polls and retries add `:poll:<k>` / `:retry:<k>`
 * (k = the delivery's job count), since `enqueue` dedupes by key. A step key
 * whose job already ran gets a retry key, so the chain never stops on it.
 */
async function schedule(
  tx: DbTx,
  scope: Scope,
  id: string,
  next: NonNullable<Outcome["next"]>,
) {
  const jobs = await jobsOf(tx, scope, id);
  const base = `blog:${id}:step:${next.step}`;
  let key = next.kind === "step" ? base : `${base}:${next.kind}:${jobs.length}`;
  const same = jobs.find((job) => data(job).idempotencyKey === key);
  if (same && !PENDING_JOB.includes(data(same).status))
    key = `${base}:retry:${jobs.length}`;
  return enqueue(tx, scope, BLOG_DELIVERY_TOPIC, id, key, next.at);
}

/**
 * Who released the article, for the pull request body: the owner's display
 * name, else "Mario" (R83). Read from the auth store outside any transaction.
 */
async function releaserName(userId: unknown) {
  if (typeof userId !== "string" || !UUID.test(userId)) return "Mario";
  const user = await authDb.user
    .findUnique({ where: { id: userId }, select: { name: true } })
    .catch(() => null);
  const name = squash(String(user?.name ?? ""));
  return name && name.length <= 100 ? name : "Mario";
}

async function pullBody(id: string, d: D) {
  const date = berlinDate(new Date(String(d.releasedAt ?? Date.now())));
  return [
    `Adds the blog post "${String(d.title)}".`,
    "",
    `- Slug: \`${String(d.slug)}\``,
    `- File: \`${String(d.path)}\``,
    `- Live URL after the deploy: ${String(d.liveUrl)}`,
    `- Orbit delivery: ${id}`,
    "",
    `Released by ${await releaserName(d.releasedBy)} in Orbit on ${date}.`,
    "",
    "Orbit merges this pull request itself once the checks are green (R83).",
  ].join("\n");
}

/**
 * Whether the article branch holds only Orbit's work (R83): `head` is the
 * base head or behind it, or ahead of it by exactly Orbit's recorded commit
 * (`headSha`). A commit Orbit wrote but could not record (a crash after the
 * put) is taken only when it is exactly Orbit's commit: one commit on top of
 * the base, Orbit's message, the post file as its only change, with the
 * booked bytes. Anything else is foreign.
 */
async function branchOwnership(
  client: GithubClient,
  d: D,
  base: string,
  head: string,
): Promise<{ ours: true; headSha: string | null } | { ours: false }> {
  if (head === base) return { ours: true, headSha: null };
  const compared = await client.compareCommits(base, head);
  if (!compared.commits.length) return { ours: true, headSha: null };
  if (compared.commits.length !== 1) return { ours: false };
  const only = compared.commits[0]!;
  if (only.sha !== head) return { ours: false };
  if (d.headSha)
    return only.sha === d.headSha
      ? { ours: true, headSha: head }
      : { ours: false };
  if (
    only.message !== commitMessage(d) ||
    compared.files?.length !== 1 ||
    compared.files[0] !== d.path
  )
    return { ours: false };
  const file = await client.getFile(String(d.path), head);
  return file?.text === d.fileBytes
    ? { ours: true, headSha: head }
    : { ours: false };
}

type StepContext = {
  scope: Scope;
  id: string;
  d: D;
  version: number;
  target: BlogTarget | null;
  client: GithubClient | null;
  at: Date;
  deps?: BlogDeliveryDeps;
};

const failed = (error: string): Outcome => ({ status: "failed", error });
const blocked = (error: string): Outcome => ({
  status: "blocked_dependency",
  error,
});
const nextStep = (step: number, at: Date, delayMs = 0): Outcome["next"] => ({
  step,
  at: new Date(at.valueOf() + delayMs),
  kind: "step",
});

/** The base head, or GITHUB_TARGET_MISSING when the repository or branch is gone. */
async function baseHead(c: StepContext) {
  const head = await c.client!.getBranchHead(c.target!.baseBranch);
  if (!head) throw new DomainError("GITHUB_TARGET_MISSING", 409);
  return head;
}

/** Creates the article branch at `base`, or reads it when it appeared meanwhile. */
async function ensureBranch(c: StepContext, base: string) {
  const branch = String(c.d.branch);
  try {
    await c.client!.createBranch(branch, base);
    return base;
  } catch (error) {
    if (!(
      error instanceof ConnectorError && error.code === "GITHUB_REF_EXISTS"
    ))
      throw error;
    const head = await c.client!.getBranchHead(branch);
    if (!head) throw error;
    return head;
  }
}

/** Step 1: the path must be absent on the base branch (the DB gates ran before). */
async function stepPreflight(c: StepContext): Promise<Outcome> {
  await baseHead(c);
  if (await c.client!.getFile(String(c.d.path), c.target!.baseBranch))
    return failed("BLOG_SLUG_EXISTS");
  return {
    fields: { preflightAt: c.at.toISOString() },
    next: nextStep(2, c.at),
  };
}

/** Step 2: the branch `blog/<slug>` at the base head, or Orbit's own branch reused. */
async function stepBranch(c: StepContext): Promise<Outcome> {
  const base = await baseHead(c);
  let head = await c.client!.getBranchHead(String(c.d.branch));
  if (!head) head = await ensureBranch(c, base);
  if (head !== base) {
    const own = await branchOwnership(c.client!, c.d, base, head);
    if (!own.ours) return failed("BLOG_BRANCH_FOREIGN");
  }
  return {
    status: "branch_ready",
    fields: { branchBase: base },
    next: nextStep(3, c.at),
  };
}

/** Step 3: the post file on the branch (skipped when Orbit's commit is there), `headSha` stored. */
async function stepCommit(c: StepContext): Promise<Outcome> {
  const base = await baseHead(c);
  if (await c.client!.getFile(String(c.d.path), c.target!.baseBranch))
    return failed("BLOG_SLUG_EXISTS");
  let head = await c.client!.getBranchHead(String(c.d.branch));
  if (!head) head = await ensureBranch(c, base);
  const own = await branchOwnership(c.client!, c.d, base, head);
  if (!own.ours) return failed("BLOG_BRANCH_FOREIGN");
  const headSha =
    own.headSha ??
    (
      await c.client!.putFile({
        path: String(c.d.path),
        branch: String(c.d.branch),
        text: String(c.d.fileBytes),
        message: commitMessage(c.d),
      })
    ).commitSha;
  return {
    status: "committed",
    fields: { headSha },
    next: nextStep(4, c.at),
  };
}

/** Step 4: the open pull request of the branch reused, else created. */
async function stepPull(c: StepContext): Promise<Outcome> {
  const base = await baseHead(c);
  const head = await c.client!.getBranchHead(String(c.d.branch));
  if (!head) return failed("BLOG_BRANCH_MISSING");
  const own = await branchOwnership(c.client!, c.d, base, head);
  if (!own.ours || own.headSha !== c.d.headSha)
    return failed("BLOG_BRANCH_FOREIGN");
  let pull = await c.client!.findOpenPull(String(c.d.branch));
  if (!pull)
    try {
      pull = await c.client!.createPull({
        title: `Blog: ${String(c.d.title)}`,
        head: String(c.d.branch),
        base: c.target!.baseBranch,
        body: await pullBody(c.id, c.d),
      });
    } catch (error) {
      // A pull request created meanwhile (422): read it instead.
      if (!(
        error instanceof ConnectorError && error.code === "GITHUB_REJECTED"
      ))
        throw error;
      pull = await c.client!.findOpenPull(String(c.d.branch));
      if (!pull) throw error;
    }
  if (pull.headSha !== c.d.headSha) return failed("BLOG_HEAD_MOVED");
  return {
    status: "pr_open",
    fields: {
      prNumber: pull.number,
      prUrl: pull.htmlUrl,
      checksSince: c.at.toISOString(),
    },
    next: nextStep(5, c.at, POLL_MS),
  };
}

/** The pull request merged (by Orbit or by someone): recorded, the live check follows. */
const mergedOutcome = (c: StepContext, mergeSha: string | null): Outcome => ({
  status: "merged",
  fields: { mergeSha, mergedAt: c.at.toISOString() },
  next: nextStep(7, c.at, POLL_MS),
});

/** Step 5: the check runs of Orbit's head, polled every minute for 30 minutes. */
async function stepChecks(c: StepContext): Promise<Outcome> {
  const pull = await c.client!.getPull(Number(c.d.prNumber));
  if (pull.merged) return mergedOutcome(c, pull.mergeCommitSha);
  if (pull.state !== "open") return failed("BLOG_PR_CLOSED");
  if (pull.headSha !== c.d.headSha) return failed("BLOG_HEAD_MOVED");
  const checks = await c.client!.checkRuns(String(c.d.headSha));
  if (checks.failed.length)
    return {
      status: "checks_failed",
      error: "CHECKS_FAILED",
      fields: { failedChecks: checks.failed.slice(0, 20) },
    };
  // No check run yet counts as pending, never as passed (R83).
  if (checks.total === 0 || checks.pending > 0) {
    const since = Date.parse(String(c.d.checksSince ?? c.at.toISOString()));
    if (c.at.valueOf() - since >= CHECKS_TIMEOUT_MS)
      return { status: "checks_timeout", error: "CHECKS_TIMEOUT" };
    return {
      next: { step: 5, at: new Date(c.at.valueOf() + POLL_MS), kind: "poll" },
    };
  }
  return { status: "checks_passed", next: nextStep(6, c.at) };
}

/**
 * Step 6: the merge with `sha: headSha` (R83). Right before the call it
 * reads the pull request and the checks again and re-checks, in the
 * database, the flag, the pause, the content and the live gates. A pull
 * request found merged (a crash after the merge) is recorded, never merged
 * again.
 */
async function stepMerge(c: StepContext): Promise<Outcome> {
  const number = Number(c.d.prNumber);
  const pull = await c.client!.getPull(number);
  if (pull.merged) return mergedOutcome(c, pull.mergeCommitSha);
  if (pull.state !== "open") return failed("BLOG_PR_CLOSED");
  if (pull.headSha !== c.d.headSha) return failed("BLOG_HEAD_MOVED");
  const checks = await c.client!.checkRuns(String(c.d.headSha));
  if (checks.failed.length)
    return {
      status: "checks_failed",
      error: "CHECKS_FAILED",
      fields: { failedChecks: checks.failed.slice(0, 20) },
    };
  if (checks.total === 0 || checks.pending > 0)
    // A check was started again: back to polling.
    return {
      status: "pr_open",
      next: { step: 5, at: new Date(c.at.valueOf() + POLL_MS), kind: "poll" },
    };
  const recheck = await scoped(
    c.scope.workspaceId,
    c.scope.projectId,
    async (tx) => {
      if (!blogGithubEnabled() || (await projectPaused(tx, c.scope)))
        return { hold: true } as Outcome;
      const row = await findRow(tx, c.scope, c.id);
      if (!row || row.version !== c.version) return { hold: true } as Outcome;
      const gate = await gates(tx, c.scope, data(row));
      return "stop" in gate ? (gate.stop as Outcome) : null;
    },
  );
  if (recheck) return recheck;
  try {
    const merged = await c.client!.mergePull(number, String(c.d.headSha));
    return mergedOutcome(c, merged.mergeSha);
  } catch (error) {
    if (
      !(error instanceof ConnectorError) ||
      !["GITHUB_HEAD_MOVED", "GITHUB_NOT_MERGEABLE"].includes(error.code)
    )
      throw error;
    // A merge that happened anyway (another run) is recorded as such.
    const after = await c.client!.getPull(number);
    if (after.merged && after.headSha === c.d.headSha)
      return mergedOutcome(c, after.mergeCommitSha);
    return failed(
      error.code === "GITHUB_HEAD_MOVED"
        ? "BLOG_HEAD_MOVED"
        : "BLOG_NOT_MERGEABLE",
    );
  }
}

/**
 * Step 7: the branch deleted (only while it still points at Orbit's merged
 * head), then the live page fetched every minute for 30 minutes: status 200
 * and the decoded page text contains the title → live.
 */
async function stepLive(c: StepContext): Promise<Outcome> {
  const fields: Record<string, unknown> = {};
  if (!c.d.branchDeletedAt && c.client)
    try {
      const head = await c.client.getBranchHead(String(c.d.branch));
      if (head === c.d.headSha) await c.client.deleteBranch(String(c.d.branch));
      if (head === null || head === c.d.headSha)
        fields.branchDeletedAt = c.at.toISOString();
    } catch {
      // The merge stands; the branch is deleted on the next live check or by hand.
    }
  const page = await fetchPublicPage(String(c.d.liveUrl), c.deps?.fetch).catch(
    () => null,
  );
  const title = squash(String(c.d.title));
  if (
    page?.status === 200 &&
    title &&
    squash(decodeHtmlEntities(page.text)).includes(title)
  )
    return {
      status: "live",
      fields: { ...fields, liveAt: c.at.toISOString() },
    };
  const mergedAt = Date.parse(String(c.d.mergedAt ?? c.at.toISOString()));
  if (c.at.valueOf() - mergedAt >= LIVE_TIMEOUT_MS)
    return { status: "live_unverified", error: "BLOG_NOT_LIVE", fields };
  return {
    fields,
    next: { step: 7, at: new Date(c.at.valueOf() + POLL_MS), kind: "poll" },
  };
}

const STEPS: Record<number, (c: StepContext) => Promise<Outcome>> = {
  1: stepPreflight,
  2: stepBranch,
  3: stepCommit,
  4: stepPull,
  5: stepChecks,
  6: stepMerge,
  7: stepLive,
};

/** A GitHub answer as the step's outcome (spec §8); null for an error that is not GitHub's. */
function errorOutcome(
  error: unknown,
  c: StepContext,
  step: number,
): Outcome | null {
  if (error instanceof DomainError && error.code === "GITHUB_TARGET_MISSING")
    return blocked("GITHUB_TARGET_MISSING");
  if (!(error instanceof ConnectorError)) return null;
  if (isAuth(error)) return blocked("GITHUB_TOKEN_INVALID");
  if (error.code === "RATE_LIMITED")
    return {
      next: {
        step,
        at: new Date(c.at.valueOf() + (error.retryAfterMs ?? POLL_MS)),
        kind: "retry",
      },
    };
  if (error.code === "GITHUB_NOT_FOUND")
    return blocked("GITHUB_TARGET_MISSING");
  if (TRANSIENT.has(error.code) || error.outcome === "unknown") {
    const retries = Number(c.d.transientRetries ?? 0) + 1;
    if (retries >= MAX_TRANSIENT_RETRIES) return blocked(error.code);
    return {
      fields: { transientRetries: retries },
      next: { step, at: new Date(c.at.valueOf() + POLL_MS), kind: "retry" },
    };
  }
  return failed(error.code.slice(0, 100));
}

/**
 * The `blog_github_pr` job (R83, spec §7): one step for the delivery's
 * state, then the next job. Network calls run outside any transaction: the
 * row is read and marked in flight in one `scoped` call (attempts + 1), the
 * step talks to GitHub, and the outcome is a versioned update in another.
 *
 * - Flag off or project paused: no change and no new job; the sweep starts
 *   the delivery again (`requeueBlogDeliveries`).
 * - Up to the merge every step checks the content, the file, the connector
 *   and the live gates first (`gates`); a closed gate stops the delivery.
 * - Each step reads GitHub before it writes, so a step that runs again after
 *   a crash (`outcome_unknown`, lease recovery) continues instead of writing
 *   a second branch, commit or pull request.
 * - A token refusal blocks it (`GITHUB_TOKEN_INVALID`, connector back to
 *   `configured`), a rate limit waits for the reset without a state change,
 *   a transient answer is tried again in a minute.
 */
export async function advanceBlogDelivery(
  scope: Scope,
  deliveryId: string,
  deps?: BlogDeliveryDeps,
): Promise<void> {
  const at = deps?.now?.() ?? new Date();
  const begun = await scoped(scope.workspaceId, scope.projectId, async (tx) => {
    const row = await lockedRow(tx, scope, deliveryId);
    if (!row) return null;
    const d = data(row);
    const step = stepOf(d);
    if (step === null) return null;
    if (!blogGithubEnabled() || (await projectPaused(tx, scope))) return null;
    // Another run (or a cancel) is inside a step of this delivery.
    if (d.inFlight && Date.parse(String(d.inFlight.until)) > at.valueOf())
      return null;
    let loaded: { target: BlogTarget; token: string } | null = null;
    if (step <= 6) {
      const gate = await gates(tx, scope, d);
      if ("stop" in gate) {
        await settle(tx, scope, row, {
          ...d,
          ...gate.stop,
          inFlight: null,
          resumeFrom: null,
        });
        return null;
      }
      loaded = gate;
    } else
      loaded = await loadBlogTarget(tx, scope, String(d.connectorId)).catch(
        () => null,
      );
    const marked = await update(tx, scope, row, {
      ...d,
      // A resumed step takes its state back; the marker guards it again (a
      // cancel waits, a new crash marks it unknown again).
      ...(d.status === "outcome_unknown"
        ? { status: stepStatus(d), resumeFrom: null, error: null }
        : {}),
      inFlight: {
        step,
        since: at.toISOString(),
        until: new Date(at.valueOf() + IN_FLIGHT_MS).toISOString(),
      },
      attempts: Number(d.attempts ?? 0) + 1,
    });
    return { step, version: marked.version, d: data(marked), loaded };
  });
  if (!begun) return;
  const { step, loaded } = begun;
  const context: StepContext = {
    scope,
    id: deliveryId,
    d: begun.d,
    version: begun.version,
    target: loaded?.target ?? null,
    client: loaded ? githubFor(loaded.token, loaded.target, deps) : null,
    at,
    deps,
  };
  let outcome: Outcome;
  try {
    outcome = loaded
      ? await guarded(scope, loaded.target.connectorId, () =>
          STEPS[step]!(context),
        )
      : await STEPS[step]!(context);
  } catch (error) {
    const mapped = errorOutcome(error, context, step);
    if (!mapped) {
      // Orbit's own error (database): the marker goes, the job is retried.
      await finish(scope, context, { hold: true }).catch(() => {});
      throw error;
    }
    outcome = mapped;
  }
  await finish(scope, context, outcome);
}

/**
 * Records a step's outcome (versioned): the state, its fields, the next job
 * and the notice. A row that changed meanwhile (a cancel, another run) keeps
 * its state, except that a merge that happened is always recorded.
 */
async function finish(scope: Scope, c: StepContext, outcome: Outcome) {
  await scoped(scope.workspaceId, scope.projectId, async (tx) => {
    const row = await lockedRow(tx, scope, c.id);
    if (!row) return;
    const d = data(row);
    if (
      row.version !== c.version &&
      (outcome.status !== "merged" || MERGED.includes(d.status))
    )
      return;
    if (outcome.hold) {
      await update(tx, scope, row, { ...d, inFlight: null });
      return;
    }
    const status = outcome.status ?? stepStatus(c.d);
    const stopped = STOPPED.includes(status) || status === "live";
    const saved = await settle(tx, scope, row, {
      ...d,
      ...outcome.fields,
      status,
      error: outcome.error ?? null,
      inFlight: null,
      resumeFrom: null,
      // A step that got through resets the count of transient answers.
      ...(outcome.fields && "transientRetries" in outcome.fields
        ? {}
        : { transientRetries: 0 }),
    });
    if (outcome.next && !stopped)
      await schedule(tx, scope, saved.id, outcome.next);
  });
}

/**
 * Worker crash recovery (R83): a `blog_github_pr` job whose lease ran out
 * inside a step may or may not have written to GitHub. The delivery becomes
 * `outcome_unknown` and keeps the state it was in (`resumeFrom`); the next
 * run repeats that step, which reads GitHub first.
 */
export async function markBlogDeliveryOutcomeUnknown(
  tx: DbTx,
  scope: Scope,
  deliveryId: string,
) {
  const row = await lockedRow(tx, scope, deliveryId);
  if (!row) return;
  const d = data(row);
  if (!d.inFlight || typeof d.inFlight.step !== "number") return;
  if (!ACTIVE.includes(d.status) || d.status === "outcome_unknown") return;
  await update(tx, scope, row, {
    ...d,
    status: "outcome_unknown",
    resumeFrom: d.status,
    error: "BLOG_DELIVERY_OUTCOME_UNKNOWN",
    inFlight: null,
  });
  await audit(tx, scope, "blog_delivery.outcome_unknown", row.id, {
    resumeFrom: d.status,
    step: d.inFlight.step,
  });
}

/**
 * Sweep pass (R83): a delivery in an active state without a pending job
 * (held back by the flag or a pause, or its job ended on an error) gets a
 * new job, `blog:<id>:resume:<k>`. Nothing while the flag is off or the
 * project is paused; at most MAX_DELIVERY_JOBS jobs per delivery.
 */
export async function requeueBlogDeliveries(tx: DbTx, scope: Scope) {
  const result = { requeued: 0 };
  if (!blogGithubEnabled() || (await projectPaused(tx, scope))) return result;
  const rows = await tx.entity.findMany({
    where: {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      kind: BLOG_DELIVERY_KIND,
      createdAt: { gte: new Date(Date.now() - REQUEUE_DAYS * 86400000) },
      OR: ACTIVE.map((status) => ({
        data: { path: ["status"], equals: status },
      })),
    },
    orderBy: { createdAt: "asc" },
  });
  for (const row of rows) {
    const jobs = await jobsOf(tx, scope, row.id);
    if (jobs.some((job) => PENDING_JOB.includes(data(job).status))) continue;
    if (jobs.length >= MAX_DELIVERY_JOBS) continue;
    await enqueue(
      tx,
      scope,
      BLOG_DELIVERY_TOPIC,
      row.id,
      `blog:${row.id}:resume:${jobs.length}`,
    );
    result.requeued++;
  }
  return result;
}

/** A delivery as the owner sees it: everything but the file bytes and the internal markers. */
export function publicBlogDelivery(row: Row) {
  const { fileBytes: _bytes, inFlight: _inFlight, ...rest } = data(row);
  return {
    id: row.id,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...rest,
  };
}

/** The project's blog deliveries, newest first (R83). */
export async function listBlogDeliveries(tx: DbTx, scope: Scope) {
  return (await list(tx, scope, BLOG_DELIVERY_KIND)).map(publicBlogDelivery);
}

/**
 * The owner's "Auslieferung abbrechen" (R83, spec §7 "Cancel"): only before
 * the merge. Closes the pull request and deletes the branch when it holds
 * only Orbit's work, then records `canceled` (the slug is free again). A
 * pull request found merged is recorded as merged and the cancel refused
 * (`BLOG_ALREADY_MERGED`); a step in flight refuses it for now
 * (`BLOG_DELIVERY_BUSY`).
 */
export async function cancelBlogDelivery(
  scope: Scope,
  deliveryId: string,
  deps?: BlogDeliveryDeps,
) {
  if (scope.role !== "owner") throw new DomainError("OWNER_REQUIRED", 403);
  assertBlogGithubEnabled();
  const at = new Date();
  const begun = await scoped(scope.workspaceId, scope.projectId, async (tx) => {
    const row = await lockedRow(tx, scope, deliveryId);
    if (!row) throw new DomainError("NOT_FOUND", 404);
    const d = data(row);
    if (
      MERGED.includes(d.status) ||
      (d.status === "outcome_unknown" && d.resumeFrom === "merged")
    )
      throw new DomainError("BLOG_ALREADY_MERGED", 409);
    if (d.status === "canceled") return { done: row, row: null, loaded: null };
    if (d.inFlight && Date.parse(String(d.inFlight.until)) > at.valueOf())
      throw new DomainError("BLOG_DELIVERY_BUSY", 409);
    const loaded = await loadBlogTarget(tx, scope, String(d.connectorId)).catch(
      () => null,
    );
    const marked = await update(tx, scope, row, {
      ...d,
      inFlight: {
        step: "cancel",
        since: at.toISOString(),
        until: new Date(at.valueOf() + IN_FLIGHT_MS).toISOString(),
      },
    });
    return { done: null, row: marked, loaded };
  });
  if (begun.done) return publicBlogDelivery(begun.done);
  const started = begun.row!;
  const d = data(started);
  const cleanup = { pullClosed: false, branchDeleted: false };
  let mergedPull: { mergeCommitSha: string | null } | null = null;
  const clearMarker = () =>
    scoped(scope.workspaceId, scope.projectId, async (tx) => {
      const row = await lockedRow(tx, scope, deliveryId);
      if (row && row.version === started.version)
        await update(tx, scope, row, { ...data(row), inFlight: null });
    });
  if (begun.loaded) {
    const { target, token } = begun.loaded;
    const client = githubFor(token, target, deps);
    try {
      await guarded(scope, target.connectorId, async () => {
        const branch = String(d.branch);
        const head = await client.getBranchHead(branch);
        const base = await client.getBranchHead(target.baseBranch);
        // Only a branch with nothing but Orbit's work is closed and deleted.
        const own =
          head && base ? await branchOwnership(client, d, base, head) : null;
        const number: number | null =
          d.prNumber ??
          (own?.ours
            ? ((await client.findOpenPull(branch))?.number ?? null)
            : null);
        if (number) {
          const pull = await client.getPull(number);
          if (pull.merged) {
            mergedPull = pull;
            return;
          }
          if (pull.state === "open") {
            await client.closePull(number);
            cleanup.pullClosed = true;
          }
        }
        if (own?.ours) {
          await client.deleteBranch(branch);
          cleanup.branchDeleted = true;
        }
      });
    } catch (error) {
      await clearMarker().catch(() => {});
      if (!(error instanceof ConnectorError)) throw error;
      if (isAuth(error)) throw new DomainError("GITHUB_TOKEN_INVALID", 409);
      throw new DomainError("BLOG_TARGET_UNREACHABLE", 503);
    }
  }
  const ended = await scoped(scope.workspaceId, scope.projectId, async (tx) => {
    const row = await lockedRow(tx, scope, deliveryId);
    if (!row) throw new DomainError("NOT_FOUND", 404);
    const current = data(row);
    if (mergedPull) {
      const pull = mergedPull as { mergeCommitSha: string | null };
      if (!MERGED.includes(current.status)) {
        const saved = await settle(tx, scope, row, {
          ...current,
          status: "merged",
          error: null,
          resumeFrom: null,
          inFlight: null,
          mergeSha: pull.mergeCommitSha,
          mergedAt: at.toISOString(),
        });
        await schedule(tx, scope, saved.id, {
          step: 7,
          at: new Date(at.valueOf() + POLL_MS),
          kind: "step",
        });
      }
      // Recorded first; the refusal is thrown after the commit.
      return null;
    }
    if (MERGED.includes(current.status)) return null;
    const saved = await settle(tx, scope, row, {
      ...current,
      status: "canceled",
      inFlight: null,
      resumeFrom: null,
      canceledFrom: current.status,
      canceledAt: at.toISOString(),
      canceledBy: scope.userId,
      cleanup,
    });
    return publicBlogDelivery(saved);
  });
  if (!ended) throw new DomainError("BLOG_ALREADY_MERGED", 409);
  return ended;
}
