import { describe, it, expect } from "vitest";
import {
  createGithubClient,
  fetchPublicPage,
  ConnectorError,
} from "./index.ts";

type Call = { url: URL; init: RequestInit };
function fake(responses: Array<Response | Error | (() => Response)>): {
  fetch: (u: string | URL, i?: RequestInit) => Promise<Response>;
  calls: Call[];
} {
  const calls: Call[] = [];
  return {
    calls,
    fetch: async (u, i = {}) => {
      calls.push({ url: new URL(u), init: i });
      const next = responses.shift()!;
      if (next instanceof Error) throw next;
      return typeof next === "function" ? next() : next;
    },
  };
}
const json = (
  value: unknown,
  status = 200,
  headers: Record<string, string> = {},
) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
const client = (responses: Array<Response | Error>) => {
  const f = fake(responses);
  return {
    f,
    gh: createGithubClient({
      token: "t",
      owner: "eds-labs",
      repo: "site",
      fetch: f.fetch,
    }),
  };
};
const body = (c: Call) => JSON.parse(String(c.init.body));
const fails = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as ConnectorError;
  }
  throw new Error("expected failure");
};

describe("GitHub client requests", () => {
  it("sends headers and reads the repo", async () => {
    const { f, gh } = client([
      json({ default_branch: "main", private: false }),
    ]);
    expect(await gh.getRepo()).toEqual({
      defaultBranch: "main",
      private: false,
    });
    const c = f.calls[0]!;
    expect(c.url.href).toBe("https://api.github.com/repos/eds-labs/site");
    expect(c.init.method ?? "GET").toBe("GET");
    const h = new Headers(c.init.headers);
    expect(h.get("authorization")).toBe("Bearer t");
    expect(h.get("accept")).toBe("application/vnd.github+json");
    expect(h.get("x-github-api-version")).toBe("2022-11-28");
  });

  it("branch head: sha or null on 404", async () => {
    const { f, gh } = client([
      json({ object: { sha: "abc" } }),
      json({ message: "Not Found" }, 404),
    ]);
    expect(await gh.getBranchHead("feat/x")).toBe("abc");
    expect(f.calls[0]!.url.pathname).toBe(
      "/repos/eds-labs/site/git/ref/heads/feat/x",
    );
    expect(await gh.getBranchHead("nope")).toBeNull();
  });

  it("lists a directory and reads a file with base64 decoding", async () => {
    const { f, gh } = client([
      json([
        {
          name: "a.json",
          path: "content/a.json",
          sha: "s1",
          type: "file",
          extra: 1,
        },
      ]),
      json({
        sha: "s2",
        content: Buffer.from("héllo\n").toString("base64") + "\n",
      }),
      json({ message: "Not Found" }, 404),
    ]);
    expect(await gh.listDirectory("content/blog", "main")).toEqual([
      { name: "a.json", path: "content/a.json", sha: "s1", type: "file" },
    ]);
    expect(f.calls[0]!.url.pathname).toBe(
      "/repos/eds-labs/site/contents/content/blog",
    );
    expect(f.calls[0]!.url.searchParams.get("ref")).toBe("main");
    expect(await gh.getFile("content/blog/a.json", "main")).toEqual({
      sha: "s2",
      text: "héllo\n",
    });
    expect(await gh.getFile("content/blog/b.json", "main")).toBeNull();
  });

  it("creates and deletes branches", async () => {
    const { f, gh } = client([
      json({}, 201),
      json({ message: "Reference already exists" }, 422),
      new Response(null, { status: 204 }),
      json({ message: "Reference does not exist" }, 404),
    ]);
    await gh.createBranch("orbit/post", "a1b2c3d");
    expect(f.calls[0]!.init.method).toBe("POST");
    expect(f.calls[0]!.url.pathname).toBe("/repos/eds-labs/site/git/refs");
    expect(body(f.calls[0]!)).toEqual({
      ref: "refs/heads/orbit/post",
      sha: "a1b2c3d",
    });
    const e = await fails(gh.createBranch("orbit/post", "a1b2c3d"));
    expect(e).toMatchObject({ code: "GITHUB_REF_EXISTS", outcome: "rejected" });
    await gh.deleteBranch("orbit/post");
    expect(f.calls[2]!.init.method).toBe("DELETE");
    expect(f.calls[2]!.url.pathname).toBe(
      "/repos/eds-labs/site/git/refs/heads/orbit/post",
    );
    await gh.deleteBranch("orbit/post");
  });

  it("compares commits", async () => {
    const { f, gh } = client([
      json({
        ahead_by: 2,
        commits: [
          { sha: "c1", author: { login: "bot" }, commit: { message: "m1" } },
          { sha: "c2", author: null, commit: { message: "m2" } },
        ],
        files: [{ filename: "content/blog/posts/a.json" }],
      }),
    ]);
    expect(await gh.compareCommits("main", "orbit/post")).toEqual({
      aheadBy: 2,
      commits: [
        { sha: "c1", authorLogin: "bot", message: "m1" },
        { sha: "c2", authorLogin: null, message: "m2" },
      ],
      files: ["content/blog/posts/a.json"],
    });
    expect(f.calls[0]!.url.pathname).toBe(
      "/repos/eds-labs/site/compare/main...orbit/post",
    );
  });

  it("puts a file with base64 content, branch and optional sha", async () => {
    const { f, gh } = client([
      json({ commit: { sha: "k1" } }, 201),
      json({ commit: { sha: "k2" } }),
    ]);
    expect(
      await gh.putFile({
        path: "content/blog/a.json",
        branch: "b",
        text: "hé",
        message: "msg",
      }),
    ).toEqual({ commitSha: "k1" });
    expect(f.calls[0]!.init.method).toBe("PUT");
    expect(f.calls[0]!.url.pathname).toBe(
      "/repos/eds-labs/site/contents/content/blog/a.json",
    );
    expect(body(f.calls[0]!)).toEqual({
      message: "msg",
      content: Buffer.from("hé").toString("base64"),
      branch: "b",
    });
    await gh.putFile({
      path: "a.json",
      branch: "b",
      text: "x",
      message: "m",
      sha: "old",
    });
    expect(body(f.calls[1]!).sha).toBe("old");
  });

  it("finds, creates and reads pulls", async () => {
    const { f, gh } = client([
      json([
        {
          number: 7,
          head: { sha: "h" },
          html_url: "https://github.com/eds-labs/site/pull/7",
        },
      ]),
      json([]),
      json({ number: 8, head: { sha: "h8" }, html_url: "u8" }, 201),
      json({
        state: "closed",
        merged: true,
        head: { sha: "h" },
        merge_commit_sha: "m",
        html_url: "u",
      }),
      json({
        state: "open",
        merged: false,
        head: { sha: "h" },
        merge_commit_sha: null,
        html_url: "u",
      }),
    ]);
    expect(await gh.findOpenPull("orbit/post")).toEqual({
      number: 7,
      headSha: "h",
      htmlUrl: "https://github.com/eds-labs/site/pull/7",
    });
    expect(f.calls[0]!.url.searchParams.get("head")).toBe(
      "eds-labs:orbit/post",
    );
    expect(f.calls[0]!.url.searchParams.get("state")).toBe("open");
    expect(await gh.findOpenPull("x")).toBeNull();
    expect(
      await gh.createPull({
        title: "t",
        head: "orbit/post",
        base: "main",
        body: "b",
      }),
    ).toEqual({ number: 8, headSha: "h8", htmlUrl: "u8" });
    expect(body(f.calls[2]!)).toEqual({
      title: "t",
      head: "orbit/post",
      base: "main",
      body: "b",
    });
    expect(await gh.getPull(7)).toEqual({
      state: "closed",
      merged: true,
      headSha: "h",
      mergeCommitSha: "m",
      htmlUrl: "u",
    });
    expect((await gh.getPull(7)).mergeCommitSha).toBeNull();
  });

  it("summarizes check runs", async () => {
    const { f, gh } = client([
      json({
        total_count: 5,
        check_runs: [
          { name: "build", status: "completed", conclusion: "success" },
          { name: "lint", status: "completed", conclusion: "neutral" },
          { name: "skip", status: "completed", conclusion: "skipped" },
          { name: "test", status: "completed", conclusion: "failure" },
          { name: "deploy", status: "in_progress", conclusion: null },
        ],
      }),
    ]);
    expect(await gh.checkRuns("abcdef1")).toEqual({
      total: 5,
      pending: 1,
      failed: ["test"],
      passed: 3,
    });
    expect(f.calls[0]!.url.pathname).toBe(
      "/repos/eds-labs/site/commits/abcdef1/check-runs",
    );
    expect(f.calls[0]!.url.searchParams.get("per_page")).toBe("100");
  });

  it("pages through check runs so a later failure is never missed", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({
      name: `ok${i}`,
      status: "completed",
      conclusion: "success",
    }));
    const page2 = [
      ...Array.from({ length: 49 }, (_, i) => ({
        name: `ok-b${i}`,
        status: "completed",
        conclusion: "success",
      })),
      { name: "late-fail", status: "completed", conclusion: "failure" },
    ];
    const { f, gh } = client([
      json({ total_count: 150, check_runs: page1 }),
      json({ total_count: 150, check_runs: page2 }),
    ]);
    expect(await gh.checkRuns("abcdef1")).toEqual({
      total: 150,
      pending: 0,
      failed: ["late-fail"],
      passed: 149,
    });
    expect(f.calls[1]!.url.searchParams.get("page")).toBe("2");
  });

  it("counts unreadable check runs as pending", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({
      name: `ok${i}`,
      status: "completed",
      conclusion: "success",
    }));
    const { gh } = client([
      json({ total_count: 150, check_runs: page1 }),
      json({ total_count: 150, check_runs: [] }),
    ]);
    expect(await gh.checkRuns("abcdef1")).toMatchObject({
      pending: 50,
      passed: 100,
      failed: [],
    });
  });

  it("maps unexpected 2xx shapes to INVALID_PROVIDER_RESPONSE", async () => {
    const { gh } = client([
      json({}),
      json({ a: 1 }),
      json({ commit: {} }, 201),
      json({}),
      new Response("", { status: 200 }),
    ]);
    expect(
      await fails(
        gh.putFile({ path: "a.json", branch: "b", text: "x", message: "m" }),
      ),
    ).toMatchObject({ code: "INVALID_PROVIDER_RESPONSE", outcome: "unknown" });
    expect(await fails(gh.listDirectory("content", "main"))).toMatchObject({
      code: "INVALID_PROVIDER_RESPONSE",
      outcome: "rejected",
    });
    expect(
      await fails(
        gh.putFile({ path: "a.json", branch: "b", text: "x", message: "m" }),
      ),
    ).toMatchObject({ code: "INVALID_PROVIDER_RESPONSE", outcome: "unknown" });
    expect(await fails(gh.mergePull(7, "abcdef1"))).toMatchObject({
      code: "INVALID_PROVIDER_RESPONSE",
      outcome: "unknown",
    });
    expect(await fails(gh.getPull(7))).toMatchObject({
      code: "INVALID_PROVIDER_RESPONSE",
      outcome: "rejected",
    });
  });

  it("treats deleting a missing branch (404 or 422) as success", async () => {
    const { gh } = client([
      json({ message: "Reference does not exist" }, 422),
      json({ message: "Not Found" }, 404),
      json({ message: "Validation Failed" }, 422),
    ]);
    await gh.deleteBranch("gone");
    await gh.deleteBranch("gone");
    expect(await fails(gh.deleteBranch("gone"))).toMatchObject({
      code: "GITHUB_REJECTED",
    });
  });

  it("merges only with sha and merge method; closes pulls", async () => {
    const { f, gh } = client([
      json({ sha: "ms", merged: true }),
      json({}),
      json({ message: "Head branch was modified" }, 409),
      json({ message: "Not mergeable" }, 405),
    ]);
    expect(await gh.mergePull(7, "abcdef1")).toEqual({ mergeSha: "ms" });
    expect(f.calls[0]!.init.method).toBe("PUT");
    expect(f.calls[0]!.url.pathname).toBe("/repos/eds-labs/site/pulls/7/merge");
    expect(body(f.calls[0]!)).toEqual({
      sha: "abcdef1",
      merge_method: "merge",
    });
    await gh.closePull(7);
    expect(f.calls[1]!.init.method).toBe("PATCH");
    expect(body(f.calls[1]!)).toEqual({ state: "closed" });
    expect(await fails(gh.mergePull(7, "abcdef1"))).toMatchObject({
      code: "GITHUB_HEAD_MOVED",
      outcome: "rejected",
    });
    expect(await fails(gh.mergePull(7, "abcdef1"))).toMatchObject({
      code: "GITHUB_NOT_MERGEABLE",
      outcome: "rejected",
    });
  });
});

describe("GitHub error mapping", () => {
  it("maps auth, rate limit, not found", async () => {
    const reset = String(Math.floor(Date.now() / 1000) + 60);
    const { gh } = client([
      json({ message: "Bad credentials" }, 401),
      json({ message: "Forbidden" }, 403),
      json({ message: "limit" }, 403, {
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": reset,
      }),
      json({ message: "slow" }, 429, { "retry-after": "5" }),
      json({ message: "nf" }, 404),
    ]);
    expect(await fails(gh.getRepo())).toMatchObject({
      code: "GITHUB_AUTH",
      outcome: "rejected",
      status: 401,
    });
    expect(await fails(gh.getRepo())).toMatchObject({
      code: "GITHUB_AUTH",
      outcome: "rejected",
    });
    const rl = await fails(gh.getRepo());
    expect(rl).toMatchObject({ code: "RATE_LIMITED", retryable: true });
    expect(rl.retryAfterMs).toBeGreaterThan(50_000);
    expect(rl.retryAfterMs).toBeLessThanOrEqual(61_000);
    expect(await fails(gh.getRepo())).toMatchObject({
      code: "RATE_LIMITED",
      retryAfterMs: 5000,
    });
    expect(await fails(gh.getRepo())).toMatchObject({
      code: "GITHUB_NOT_FOUND",
      outcome: "rejected",
    });
  });

  it("5xx and network: reads not_sent retryable, writes unknown", async () => {
    const { gh } = client([
      json({}, 502),
      new Error("boom"),
      json({}, 500),
      new Error("boom"),
    ]);
    expect(await fails(gh.getRepo())).toMatchObject({
      outcome: "not_sent",
      retryable: true,
    });
    expect(await fails(gh.getRepo())).toMatchObject({
      code: "NETWORK_ERROR",
      outcome: "not_sent",
      retryable: true,
    });
    expect(await fails(gh.closePull(1))).toMatchObject({
      outcome: "unknown",
      retryable: false,
    });
    expect(await fails(gh.closePull(1))).toMatchObject({
      code: "NETWORK_ERROR",
      outcome: "unknown",
    });
  });

  it("never leaks the token", async () => {
    const f = fake([json({ message: "value abc123XYZ end" }, 422)]);
    const gh = createGithubClient({
      token: "abc123XYZ",
      owner: "o",
      repo: "r",
      fetch: f.fetch,
    });
    const e = await fails(
      gh.createPull({ title: "t", head: "h", base: "b", body: "x" }),
    );
    expect(JSON.stringify({ m: e.message, d: e.detail })).not.toContain(
      "abc123XYZ",
    );
  });
});

describe("GitHub input validation", () => {
  it("rejects bad owner/repo, token, branch and path", async () => {
    const make =
      (o: Partial<{ token: string; owner: string; repo: string }>) => () =>
        createGithubClient({ token: "t", owner: "o", repo: "r", ...o });
    expect(make({ owner: "a/b" })).toThrow(
      expect.objectContaining({ code: "INVALID_TARGET" }),
    );
    expect(make({ repo: "r r" })).toThrow(
      expect.objectContaining({ code: "INVALID_TARGET" }),
    );
    expect(make({ repo: "" })).toThrow(
      expect.objectContaining({ code: "INVALID_TARGET" }),
    );
    expect(make({ token: "" })).toThrow(
      expect.objectContaining({ code: "INVALID_CREDENTIAL" }),
    );
    expect(make({ token: "a\nb" })).toThrow(
      expect.objectContaining({ code: "INVALID_CREDENTIAL" }),
    );
    const { f, gh } = client([]);
    expect(await fails(gh.getBranchHead("a/../b"))).toMatchObject({
      code: "INVALID_TARGET",
    });
    expect(await fails(gh.getBranchHead("a b"))).toMatchObject({
      code: "INVALID_TARGET",
    });
    expect(await fails(gh.getFile("a/../../x", "main"))).toMatchObject({
      code: "INVALID_TARGET",
    });
    expect(await fails(gh.getFile("a?x=1", "main"))).toMatchObject({
      code: "INVALID_TARGET",
    });
    expect(f.calls).toHaveLength(0);
  });
});

describe("fetchPublicPage", () => {
  it("returns status and text without auth, including 404", async () => {
    const f = fake([
      new Response("hello", { status: 200 }),
      new Response("nope", { status: 404 }),
    ]);
    expect(
      await fetchPublicPage("https://uliquid.example/blog/a", f.fetch),
    ).toEqual({ status: 200, text: "hello" });
    expect(
      await fetchPublicPage("https://uliquid.example/blog/b", f.fetch),
    ).toEqual({ status: 404, text: "nope" });
    expect(
      new Headers(f.calls[0]!.init.headers).get("authorization"),
    ).toBeNull();
    expect(f.calls[0]!.init.redirect).toBe("manual");
  });
  it("rejects http, oversize and transport errors", async () => {
    const f = fake([
      new Response("x".repeat(2 * 1024 * 1024 + 1)),
      new Error("down"),
    ]);
    expect(
      await fails(fetchPublicPage("http://x.example/", f.fetch)),
    ).toMatchObject({ code: "INVALID_ENDPOINT" });
    expect(
      await fails(fetchPublicPage("https://x.example/", f.fetch)),
    ).toMatchObject({ code: "RESPONSE_TOO_LARGE" });
    expect(
      await fails(fetchPublicPage("https://x.example/", f.fetch)),
    ).toMatchObject({ code: "NETWORK_ERROR", outcome: "not_sent" });
  });
});
