import { randomBytes } from "node:crypto";
import { z } from "zod";
import { scoped, type DbTx } from "../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../packages/schemas/src/index.ts";
import {
  blogGithubEnabled,
  loadConfig,
} from "../../../../packages/config/src/index.ts";
import {
  ConnectorError,
  createGithubClient,
  PROFILE_ID,
  validatePost,
  type FetchLike,
  type GithubClient,
} from "../../../../packages/connectors/src/index.ts";
import {
  audit,
  data,
  decrypt,
  DomainError,
  entity,
  exception,
  list,
  update,
} from "../shared.ts";
import { notify } from "./agents/notifications.ts";

/**
 * The GitHub blog target (R81): the `github` connector that points at the
 * website repository, its verification (`configured` → `read_verified` →
 * `write_verified`, as for Postiz), the list of published articles and the
 * token notices. Network calls never run inside a database transaction: the
 * connector is read in one `scoped` call and the outcome written in another.
 */
export type BlogTarget = {
  connectorId: string;
  owner: string;
  repo: string;
  baseBranch: string;
  postsPath: string;
  siteUrl: string;
  blogPathPrefix: string;
  profile: typeof PROFILE_ID;
  status: string;
};
export type BlogTargetDeps = { fetch?: FetchLike };
export type PublishedArticle = {
  slug: string;
  title: string;
  category: string;
  keywords: string[];
  publishedAt: string;
};

/** Days before `tokenExpiresAt` at which the owner is told to renew the token. */
export const TOKEN_EXPIRY_NOTICE_DAYS = 14;

const NAME = /^[A-Za-z0-9._-]+$/;
const PATH_SEGMENT = /^(?!\.{1,2}$)[A-Za-z0-9._-]+$/;
const repoPath = z
  .string()
  .max(200)
  .refine((v) => v.split("/").every((p) => PATH_SEGMENT.test(p)));

/** Input of the connector action for `provider: "github"`; the token is `credential`. */
export const githubConnectorInput = z
  .object({
    provider: z.literal("github"),
    owner: z.string().max(100).regex(NAME),
    repo: z.string().max(100).regex(NAME),
    baseBranch: repoPath.default("main"),
    postsPath: repoPath.default("content/blog/posts"),
    siteUrl: z
      .url()
      .max(200)
      .refine((v) => new URL(v).protocol === "https:", "HTTPS_REQUIRED"),
    blogPathPrefix: z
      .string()
      .regex(/^\/(?:[a-z0-9-]+\/)*$/)
      .default("/blog/"),
    profile: z.literal(PROFILE_ID),
    tokenExpiresAt: z.iso.date(),
    credential: z.string().min(10).max(1000),
  })
  .strict();

export function assertBlogGithubEnabled() {
  if (!blogGithubEnabled()) throw new DomainError("BLOG_GITHUB_DISABLED", 409);
}

function toTarget(id: string, d: Record<string, any>): BlogTarget {
  return {
    connectorId: id,
    owner: String(d.owner),
    repo: String(d.repo),
    baseBranch: String(d.baseBranch ?? "main"),
    postsPath: String(d.postsPath ?? "content/blog/posts"),
    siteUrl: String(d.siteUrl),
    blogPathPrefix: String(d.blogPathPrefix ?? "/blog/"),
    profile: PROFILE_ID,
    status: String(d.status),
  };
}

/** The connector as a blog target with its decrypted token; `BLOG_TARGET_NOT_CONFIGURED` if absent or not github. */
export async function loadBlogTarget(
  tx: DbTx,
  scope: Scope,
  connectorId: string,
): Promise<{ target: BlogTarget; token: string }> {
  const row = await entity(tx, scope, "connectors", connectorId).catch(
    () => null,
  );
  const d = data(row);
  if (!row || d.provider !== "github" || !d.encryptedCredential)
    throw new DomainError("BLOG_TARGET_NOT_CONFIGURED", 409);
  return {
    target: toTarget(row.id, d),
    token: decrypt(d.encryptedCredential, loadConfig().CREDENTIAL_KEY),
  };
}

export function githubFor(
  token: string,
  target: BlogTarget,
  deps?: BlogTargetDeps,
): GithubClient {
  return createGithubClient({
    token,
    owner: target.owner,
    repo: target.repo,
    fetch: deps?.fetch,
  });
}

/** A target and its token read in their own transaction; the caller talks to GitHub afterwards. */
const readTarget = (scope: Scope, connectorId: string) =>
  scoped(scope.workspaceId, scope.projectId, async (tx) => {
    const loaded = await loadBlogTarget(tx, scope, connectorId);
    const row = await entity(tx, scope, "connectors", connectorId);
    return { ...loaded, version: row.version, row: data(row) };
  });

const isAuth = (error: unknown) =>
  error instanceof ConnectorError && error.code === "GITHUB_AUTH";

/**
 * A 401/403 at any call after verification (R81): the connector goes back to
 * `configured` and the owner gets `github_token_invalid` once per connector
 * version (a second call on an already downgraded connector changes nothing).
 */
export async function markTokenInvalid(
  tx: DbTx,
  scope: Scope,
  connectorId: string,
): Promise<void> {
  const row = await entity(tx, scope, "connectors", connectorId);
  const d = data(row);
  if (d.provider !== "github") return;
  let current = row;
  if (d.status !== "configured" || !d.tokenInvalidAt) {
    current = await update(tx, scope, row, {
      ...d,
      status: "configured",
      tokenInvalidAt: new Date().toISOString(),
    });
    await audit(tx, scope, "github.token_invalid", row.id, {
      previousStatus: d.status,
    });
    await exception(tx, scope, "GITHUB_TOKEN_INVALID", row.id);
  }
  await notify(
    tx,
    scope,
    "github_token_invalid",
    `${row.id}:${current.version}`,
  );
}

/** Runs `work` against GitHub; an auth refusal marks the token invalid before it is rethrown. */
async function guarded<T>(
  scope: Scope,
  connectorId: string,
  work: () => Promise<T>,
): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (isAuth(error))
      await scoped(scope.workspaceId, scope.projectId, (tx) =>
        markTokenInvalid(tx, scope, connectorId),
      );
    throw error;
  }
}

type PostFile = {
  name: string;
  slug: string;
  post?: unknown;
  problems: string[];
};

/** Every `.json` file in the posts directory of the base branch with its validation problems. */
async function readPosts(
  client: GithubClient,
  target: BlogTarget,
): Promise<PostFile[]> {
  const entries = await client.listDirectory(
    target.postsPath,
    target.baseBranch,
  );
  const files: PostFile[] = [];
  for (const item of entries) {
    if (item.type !== "file" || !item.name.endsWith(".json")) continue;
    const slug = item.name.slice(0, -".json".length);
    const file = await client.getFile(item.path, target.baseBranch);
    if (!file) {
      files.push({ name: item.name, slug, problems: ["file not readable"] });
      continue;
    }
    let post: unknown;
    try {
      post = JSON.parse(file.text);
    } catch {
      files.push({ name: item.name, slug, problems: ["invalid JSON"] });
      continue;
    }
    files.push({
      name: item.name,
      slug,
      post,
      problems: validatePost(post, slug),
    });
  }
  return files;
}

/**
 * The published articles (slug, title, category, keywords, publishedAt) of the
 * posts directory, newest first. Files that fail the profile's validation are
 * skipped here; verification is where they are reported.
 */
export async function listPublishedArticles(
  scope: Scope,
  connectorId: string,
  deps?: BlogTargetDeps,
): Promise<PublishedArticle[]> {
  assertBlogGithubEnabled();
  const { target, token } = await readTarget(scope, connectorId);
  const client = githubFor(token, target, deps);
  const files = await guarded(scope, connectorId, () =>
    readPosts(client, target),
  );
  return files
    .filter((file) => !file.problems.length)
    .map((file) => {
      const p = file.post as Record<string, any>;
      return {
        slug: String(p.slug),
        title: String(p.title),
        category: String(p.category),
        keywords: (p.keywords as unknown[]).map(String),
        publishedAt: String(p.publishedAt),
      };
    })
    .sort(
      (a, b) =>
        b.publishedAt.localeCompare(a.publishedAt) ||
        a.slug.localeCompare(b.slug),
    );
}

const problemCode = (error: unknown) =>
  error instanceof ConnectorError ? error.code : "UNEXPECTED";

/**
 * Verifies the connector (R81). Read: repository, base branch, posts
 * directory, and every post passes the profile's validation. Write: a branch
 * `orbit/verify-<8 hex>` is created at the base head and deleted again; the
 * base branch is never written. A branch that could not be deleted is reported
 * (`VERIFY_BRANCH_NOT_DELETED`), kept on the connector and deleted first on the
 * next verification. The connector status is stored as the result.
 */
export async function verifyBlogTarget(
  scope: Scope,
  connectorId: string,
  deps?: BlogTargetDeps,
): Promise<{
  status: "configured" | "read_verified" | "write_verified";
  problems: string[];
}> {
  assertBlogGithubEnabled();
  const { target, token, version, row } = await readTarget(scope, connectorId);
  const client = githubFor(token, target, deps);
  const problems: string[] = [];
  let pending = ((row.pendingVerifyBranches ?? []) as unknown[]).map(String);
  let readOk = false;
  let writeOk = false;
  let head: string | null = null;
  try {
    await client.getRepo();
    head = await client.getBranchHead(target.baseBranch);
    if (!head) problems.push("GITHUB_BASE_BRANCH_NOT_FOUND");
    else {
      for (const file of await readPosts(client, target))
        for (const problem of file.problems)
          problems.push(`${file.name}: ${problem}`);
      readOk = !problems.length;
    }
  } catch (error) {
    problems.push(problemCode(error));
  }
  if (readOk && head) {
    // Leftovers of an earlier verification go first (R81).
    const left: string[] = [];
    for (const branch of pending)
      try {
        await client.deleteBranch(branch);
      } catch {
        left.push(branch);
      }
    pending = left;
    const branch = `orbit/verify-${randomBytes(4).toString("hex")}`;
    try {
      await client.createBranch(branch, head);
      writeOk = true;
      try {
        await client.deleteBranch(branch);
      } catch {
        pending.push(branch);
        problems.push("VERIFY_BRANCH_NOT_DELETED");
      }
    } catch (error) {
      problems.push(problemCode(error));
    }
    if (pending.length && !problems.includes("VERIFY_BRANCH_NOT_DELETED"))
      problems.push("VERIFY_BRANCH_NOT_DELETED");
  }
  // A read that failed or found invalid posts leaves the connector at "configured".
  const status = writeOk
    ? ("write_verified" as const)
    : readOk
      ? ("read_verified" as const)
      : ("configured" as const);
  await scoped(scope.workspaceId, scope.projectId, async (tx) => {
    const current = await entity(tx, scope, "connectors", connectorId);
    // The connector changed while GitHub was asked: the result belongs to the old one.
    if (current.version !== version)
      throw new DomainError("VERSION_CONFLICT", 409);
    const d = data(current);
    await update(tx, scope, current, {
      ...d,
      status,
      verifiedAt: new Date().toISOString(),
      verificationProblems: problems.slice(0, 50),
      pendingVerifyBranches: pending,
      ...(readOk ? { tokenInvalidAt: null } : {}),
    });
    await audit(tx, scope, "github.verified", connectorId, {
      status,
      problems: problems.length,
    });
  });
  return { status, problems };
}

/** The `tokenExpiresAt` date as the start of that day (UTC); NaN when absent or invalid. */
const expiryOf = (d: Record<string, any>) =>
  Date.parse(`${String(d.tokenExpiresAt ?? "")}T00:00:00.000Z`);

/**
 * Daily sweep (R81): `github_token_expiring` once per connector and expiry
 * date, from 14 days before `tokenExpiresAt`. The token's expiry is not
 * readable through the API; the owner records it in the connector form.
 */
export async function planGithubTokenNotices(
  tx: DbTx,
  scope: Scope,
  at = new Date(),
) {
  if (!blogGithubEnabled()) return;
  for (const row of await list(tx, scope, "connectors")) {
    const d = data(row);
    if (d.provider !== "github") continue;
    const expiry = expiryOf(d);
    if (!Number.isFinite(expiry)) continue;
    if (expiry - at.valueOf() > TOKEN_EXPIRY_NOTICE_DAYS * 86400000) continue;
    await notify(
      tx,
      scope,
      "github_token_expiring",
      `${row.id}:${d.tokenExpiresAt}`,
    );
  }
}

/** The next time a token notice becomes due, so the sweep wakes up for it. */
export async function nextGithubTokenNoticeAt(tx: DbTx, scope: Scope) {
  if (!blogGithubEnabled()) return null;
  let next = Infinity;
  for (const row of await list(tx, scope, "connectors")) {
    const d = data(row);
    if (d.provider !== "github") continue;
    const due = expiryOf(d) - TOKEN_EXPIRY_NOTICE_DAYS * 86400000;
    if (Number.isFinite(due)) next = Math.min(next, due);
  }
  return Number.isFinite(next) ? new Date(next) : null;
}
