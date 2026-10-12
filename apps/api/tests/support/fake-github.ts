import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { FetchLike } from "../../../../packages/connectors/src/index.ts";

// Shared by the blog target and delivery tests (R81, R82, R83).
// Synthetic token; the fake GitHub here is the only "GitHub" these tests reach.
export const TOKEN = "github_pat_synthetic_0123456789_ABCDEFGHIJ";
export const OWNER = "eds-labs";
export const REPO = "uliquid-desk-website-v2";
export const HEAD = "1".repeat(40);
export const POSTS_DIR = "content/blog/posts";
const FIXTURES = new URL(
  "../../../../packages/connectors/src/blog-targets/fixtures/",
  import.meta.url,
);
const fixture = (name: string) =>
  readFileSync(new URL(`${name}.json`, FIXTURES), "utf8");
export const FIXTURE_POSTS = {
  "market-intelligence-context-not-signal.json": fixture(
    "market-intelligence-context-not-signal",
  ),
  "ai-assisted-trading-keeps-decisions-with-the-user.json": fixture(
    "ai-assisted-trading-keeps-decisions-with-the-user",
  ),
};

export type FakeCheckRun = {
  name: string;
  status: "queued" | "in_progress" | "completed";
  conclusion?: string | null;
};
type Commit = {
  parents: string[];
  tree: Record<string, string>;
  message: string;
};
type Pull = {
  number: number;
  head: string;
  base: string;
  title: string;
  body: string;
  state: "open" | "closed";
  merged: boolean;
  mergeSha: string | null;
  lastHead: string;
};
export type FakeGithubOptions = {
  posts?: Record<string, string>;
  createStatus?: number;
  deleteStatus?: number;
  authFail?: boolean;
  // Every call answers with this status (e.g. 502), as a GitHub outage would.
  outage?: number;
  // The only token this GitHub accepts; anything else is a 401.
  token?: string;
  // Check runs of a commit; `poll` counts the reads of that commit (0 first).
  checks?: (
    sha: string,
    poll: number,
  ) => FakeCheckRun[] | Promise<FakeCheckRun[]>;
  // The merge answers with this status instead of merging (e.g. 405).
  mergeStatus?: number;
  // A call this returns true for is answered with a primary rate limit (403, remaining 0).
  rateLimit?: (method: string, path: string) => boolean;
  // The public site's answer; the default serves the post file of `main` as a page.
  page?: (url: URL) => { status: number; body: string } | undefined;
};

const escapeHtml = (text: string) =>
  text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

/**
 * An in-memory GitHub for one repository and the public site it deploys to;
 * it records every call. Branches, commits, files, pull requests, check runs
 * and merges are kept as state, so a retried step sees what an earlier one
 * wrote. `options` stays mutable: a test changes it between steps.
 */
export function fakeGithub(options: FakeGithubOptions = {}) {
  const posts: Record<string, string> = options.posts ?? FIXTURE_POSTS;
  const created: string[] = [];
  const createdRefs: Array<{ ref: string; sha: string }> = [];
  const deleted: string[] = [];
  const calls: string[] = [];
  const puts: Array<{
    path: string;
    branch: string;
    message: string;
    text: string;
  }> = [];
  const pulls: Pull[] = [];
  const merges: Array<{ number: number; sha: string; method: string }> = [];
  const closed: number[] = [];
  const pageCalls: string[] = [];
  const checkReads = new Map<string, number>();
  const commits = new Map<string, Commit>([
    [
      HEAD,
      {
        parents: [],
        message: "Initial site",
        tree: Object.fromEntries(
          Object.entries(posts).map(([name, text]) => [
            `${POSTS_DIR}/${name}`,
            text,
          ]),
        ),
      },
    ],
  ]);
  const refs = new Map<string, string>([["main", HEAD]]);
  let counter = 0;
  const newSha = () =>
    createHash("sha1").update(`fake-commit-${++counter}`).digest("hex");
  const resolve = (ref: string) =>
    refs.get(ref) ?? (commits.has(ref) ? ref : undefined);
  const ancestors = (sha: string) => {
    const seen = new Set<string>();
    const stack = [sha];
    while (stack.length) {
      const next = stack.pop()!;
      if (seen.has(next)) continue;
      seen.add(next);
      stack.push(...(commits.get(next)?.parents ?? []));
    }
    return seen;
  };
  /** Commits of `head` that `base` lacks, oldest first, and their merge base. */
  const compare = (base: string, head: string) => {
    const inBase = ancestors(base);
    const order: string[] = [];
    let mergeBase: string | null = null;
    const queue = [head];
    const seen = new Set<string>();
    while (queue.length) {
      const sha = queue.shift()!;
      if (seen.has(sha)) continue;
      seen.add(sha);
      if (inBase.has(sha)) {
        mergeBase ??= sha;
        continue;
      }
      order.push(sha);
      queue.push(...(commits.get(sha)?.parents ?? []));
    }
    const before = mergeBase ? commits.get(mergeBase)!.tree : {};
    const after = commits.get(head)!.tree;
    const files = [...new Set([...Object.keys(before), ...Object.keys(after)])]
      .filter((path) => before[path] !== after[path])
      .sort();
    return { ahead: order.reverse(), files, changes: { before, after } };
  };
  /** A commit on `branch` changing `files` (also used by tests for pushes that are not Orbit's). */
  const pushCommit = (
    branch: string,
    files: Record<string, string>,
    message = "Manual change",
  ) => {
    const parent = refs.get(branch)!;
    const sha = newSha();
    commits.set(sha, {
      parents: [parent],
      message,
      tree: { ...commits.get(parent)!.tree, ...files },
    });
    refs.set(branch, sha);
    return sha;
  };
  const treeOf = (ref: string) => {
    const sha = resolve(ref);
    return sha ? commits.get(sha)!.tree : undefined;
  };
  const pullHead = (pull: Pull) => {
    if (pull.state === "open" && refs.has(pull.head))
      pull.lastHead = refs.get(pull.head)!;
    return pull.lastHead;
  };
  const pullJson = (pull: Pull) => ({
    number: pull.number,
    state: pull.state,
    merged: pull.merged,
    merge_commit_sha: pull.mergeSha,
    title: pull.title,
    body: pull.body,
    head: { ref: pull.head, sha: pullHead(pull) },
    base: { ref: pull.base },
    html_url: `https://github.com/${OWNER}/${REPO}/pull/${pull.number}`,
  });
  /** Merges a pull request at `head` into its base (a merge commit). */
  const mergeOf = (pull: Pull, head: string) => {
    const base = refs.get(pull.base)!;
    const { files, changes } = compare(base, head);
    const tree = { ...commits.get(base)!.tree };
    for (const file of files)
      if (file in changes.after) tree[file] = changes.after[file]!;
      else delete tree[file];
    const sha = newSha();
    commits.set(sha, {
      parents: [base, head],
      message: `Merge pull request #${pull.number}`,
      tree,
    });
    refs.set(pull.base, sha);
    pull.state = "closed";
    pull.merged = true;
    pull.mergeSha = sha;
    return sha;
  };
  const json = (
    status: number,
    body: unknown,
    headers: Record<string, string> = {},
  ) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", ...headers },
    });
  const root = `/repos/${OWNER}/${REPO}`;
  const contents = `${root}/contents/`;
  const sitePage = (url: URL) => {
    pageCalls.push(url.pathname);
    const custom = options.page?.(url);
    if (custom) return new Response(custom.body, { status: custom.status });
    const slug = url.pathname.match(/^\/blog\/([a-z0-9-]+)\/$/)?.[1];
    const file = slug ? treeOf("main")![`${POSTS_DIR}/${slug}.json`] : null;
    if (!file) return new Response("Not found", { status: 404 });
    const title = String(JSON.parse(file).title ?? "");
    return new Response(
      `<!doctype html><html><head><title>${escapeHtml(title)} | uLiquid</title></head><body><h1>${escapeHtml(title)}</h1></body></html>`,
      { status: 200, headers: { "content-type": "text/html" } },
    );
  };
  const fetch: FetchLike = async (input, init = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? "GET";
    if (url.hostname !== "api.github.com") return sitePage(url);
    calls.push(`${method} ${url.pathname}`);
    const bearer = new Headers(init.headers).get("authorization");
    if (options.authFail || bearer !== `Bearer ${options.token ?? TOKEN}`)
      return json(401, { message: "Bad credentials" });
    if (options.outage) return json(options.outage, { message: "Bad gateway" });
    if (options.rateLimit?.(method, url.pathname))
      return json(
        403,
        { message: "API rate limit exceeded" },
        {
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": String(Math.ceil(Date.now() / 1000) + 120),
        },
      );
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    const path = url.pathname;
    if (method === "GET" && path === root)
      return json(200, { default_branch: "main", private: true });
    if (method === "GET" && path.startsWith(`${root}/git/ref/heads/`)) {
      const branch = decodeURIComponent(
        path.slice(`${root}/git/ref/heads/`.length),
      );
      const sha = refs.get(branch);
      return sha
        ? json(200, { object: { sha } })
        : json(404, { message: "Not Found" });
    }
    if (method === "GET" && path.startsWith(contents)) {
      const file = decodeURIComponent(path.slice(contents.length));
      const tree = treeOf(url.searchParams.get("ref") ?? "main");
      if (!tree) return json(404, { message: "No commit found for the ref" });
      if (file === POSTS_DIR)
        return json(
          200,
          Object.keys(tree)
            .filter(
              (p) =>
                p.startsWith(`${POSTS_DIR}/`) &&
                !p.slice(POSTS_DIR.length + 1).includes("/"),
            )
            .sort()
            .map((p) => ({
              name: p.slice(POSTS_DIR.length + 1),
              path: p,
              sha: "a".repeat(40),
              type: "file",
            })),
        );
      if (!(file in tree)) return json(404, { message: "Not Found" });
      return json(200, {
        sha: "b".repeat(40),
        content: Buffer.from(tree[file]!, "utf8").toString("base64"),
      });
    }
    if (method === "PUT" && path.startsWith(contents)) {
      const file = decodeURIComponent(path.slice(contents.length));
      const tree = treeOf(body.branch);
      if (!tree) return json(404, { message: "Branch not found" });
      if (file in tree && !body.sha)
        return json(422, {
          message: 'Invalid request.\n\n"sha" wasn\'t supplied.',
        });
      const text = Buffer.from(String(body.content), "base64").toString("utf8");
      puts.push({
        path: file,
        branch: body.branch,
        message: body.message,
        text,
      });
      const sha = pushCommit(body.branch, { [file]: text }, body.message);
      return json(201, { commit: { sha }, content: { path: file } });
    }
    if (method === "POST" && path === `${root}/git/refs`) {
      if (options.createStatus)
        return json(options.createStatus, {
          message: "Resource not accessible by personal access token",
        });
      const branch = String(body.ref).slice("refs/heads/".length);
      if (refs.has(branch))
        return json(422, { message: "Reference already exists" });
      if (!commits.has(body.sha))
        return json(422, { message: "Object does not exist" });
      created.push(body.ref);
      createdRefs.push({ ref: body.ref, sha: body.sha });
      refs.set(branch, body.sha);
      return json(201, { ref: body.ref, object: { sha: body.sha } });
    }
    if (method === "DELETE" && path.startsWith(`${root}/git/refs/`)) {
      if (options.deleteStatus)
        return json(options.deleteStatus, { message: "Server Error" });
      const ref = path.slice(`${root}/git/refs/`.length);
      deleted.push(ref);
      const branch = decodeURIComponent(ref.slice("heads/".length));
      if (!refs.has(branch))
        return json(422, { message: "Reference does not exist" });
      refs.delete(branch);
      return new Response(null, { status: 204 });
    }
    if (method === "GET" && path.startsWith(`${root}/compare/`)) {
      const [base, head] = decodeURIComponent(
        path.slice(`${root}/compare/`.length),
      ).split("...");
      const b = resolve(base!);
      const h = resolve(head!);
      if (!b || !h) return json(404, { message: "Not Found" });
      const { ahead, files } = compare(b, h);
      return json(200, {
        ahead_by: ahead.length,
        commits: ahead.map((sha) => ({
          sha,
          author: null,
          commit: { message: commits.get(sha)!.message },
        })),
        files: files.map((filename) => ({ filename })),
      });
    }
    if (method === "GET" && path === `${root}/pulls`) {
      const head = url.searchParams.get("head") ?? "";
      const state = url.searchParams.get("state") ?? "open";
      return json(
        200,
        pulls
          .filter(
            (pull) =>
              `${OWNER}:${pull.head}` === head &&
              (state === "all" || pull.state === state),
          )
          .map(pullJson),
      );
    }
    if (method === "POST" && path === `${root}/pulls`) {
      if (!refs.has(body.head))
        return json(422, { message: "Validation Failed" });
      if (
        pulls.some((pull) => pull.head === body.head && pull.state === "open")
      )
        return json(422, { message: "A pull request already exists" });
      const pull: Pull = {
        number: pulls.length + 1,
        head: body.head,
        base: body.base,
        title: body.title,
        body: body.body,
        state: "open",
        merged: false,
        mergeSha: null,
        lastHead: refs.get(body.head)!,
      };
      pulls.push(pull);
      return json(201, pullJson(pull));
    }
    const pullMatch = path.match(new RegExp(`^${root}/pulls/(\\d+)(/merge)?$`));
    if (pullMatch) {
      const pull = pulls.find((p) => p.number === Number(pullMatch[1]));
      if (!pull) return json(404, { message: "Not Found" });
      if (method === "GET" && !pullMatch[2]) return json(200, pullJson(pull));
      if (method === "PATCH" && !pullMatch[2]) {
        if (body.state === "closed" && pull.state === "open") {
          pullHead(pull);
          pull.state = "closed";
          closed.push(pull.number);
        }
        return json(200, pullJson(pull));
      }
      if (method === "PUT" && pullMatch[2]) {
        merges.push({
          number: pull.number,
          sha: body.sha,
          method: body.merge_method,
        });
        if (options.mergeStatus)
          return json(options.mergeStatus, {
            message: "Pull Request is not mergeable",
          });
        if (pull.state !== "open")
          return json(405, { message: "Pull Request is not mergeable" });
        const head = pullHead(pull);
        if (body.sha !== head)
          return json(409, {
            message:
              "Head branch was modified. Review and try the merge again.",
          });
        const sha = mergeOf(pull, head);
        return json(200, { sha, merged: true });
      }
    }
    const checkMatch = path.match(
      new RegExp(`^${root}/commits/([0-9a-f]+)/check-runs$`),
    );
    if (method === "GET" && checkMatch) {
      const sha = checkMatch[1]!;
      const poll = checkReads.get(sha) ?? 0;
      checkReads.set(sha, poll + 1);
      const runs = (await options.checks?.(sha, poll)) ?? [
        { name: "check", status: "completed", conclusion: "success" },
      ];
      return json(200, {
        total_count: runs.length,
        check_runs: runs.map((run) => ({ conclusion: null, ...run })),
      });
    }
    return json(404, { message: "Not Found" });
  };
  return {
    fetch,
    created,
    createdRefs,
    deleted,
    calls,
    puts,
    pulls,
    merges,
    closed,
    pageCalls,
    refs,
    options,
    pushCommit,
    /** A merge by hand in GitHub (not through Orbit). */
    mergeByHand: (number: number) => {
      const pull = pulls.find((p) => p.number === number)!;
      return mergeOf(pull, pullHead(pull));
    },
    /** The files of a branch or commit. */
    tree: (ref: string) => treeOf(ref),
    /** Every call that writes to GitHub. */
    writes: () => calls.filter((call) => !call.startsWith("GET ")),
  };
}
