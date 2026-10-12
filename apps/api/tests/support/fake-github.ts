import { readFileSync } from "node:fs";
import type { FetchLike } from "../../../../packages/connectors/src/index.ts";

// Shared by the blog target tests (R81, R82).
// Synthetic token; the fake GitHub here is the only "GitHub" these tests reach.
export const TOKEN = "github_pat_synthetic_0123456789_ABCDEFGHIJ";
export const OWNER = "eds-labs";
export const REPO = "uliquid-desk-website-v2";
export const HEAD = "1".repeat(40);
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

/** An in-memory GitHub for one repository; it records every call. */
export function fakeGithub(
  options: {
    posts?: Record<string, string>;
    createStatus?: number;
    deleteStatus?: number;
    authFail?: boolean;
    // Every call answers with this status (e.g. 502), as a GitHub outage would.
    outage?: number;
    // The only token this GitHub accepts; anything else is a 401.
    token?: string;
  } = {},
) {
  const posts: Record<string, string> = options.posts ?? FIXTURE_POSTS;
  const created: string[] = [];
  const deleted: string[] = [];
  const calls: string[] = [];
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  const root = `/repos/${OWNER}/${REPO}`;
  const dir = `${root}/contents/content/blog/posts`;
  const fetch: FetchLike = async (input, init = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? "GET";
    calls.push(`${method} ${url.pathname}`);
    const bearer = new Headers(init.headers).get("authorization");
    if (options.authFail || bearer !== `Bearer ${options.token ?? TOKEN}`)
      return json(401, { message: "Bad credentials" });
    if (options.outage) return json(options.outage, { message: "Bad gateway" });
    if (method === "GET" && url.pathname === root)
      return json(200, { default_branch: "main", private: true });
    if (method === "GET" && url.pathname === `${root}/git/ref/heads/main`)
      return json(200, { object: { sha: HEAD } });
    if (method === "GET" && url.pathname === dir)
      return json(
        200,
        Object.keys(posts).map((name) => ({
          name,
          path: `content/blog/posts/${name}`,
          sha: "a".repeat(40),
          type: "file",
        })),
      );
    if (method === "GET" && url.pathname.startsWith(`${dir}/`)) {
      const name = decodeURIComponent(url.pathname.slice(dir.length + 1));
      if (!(name in posts)) return json(404, { message: "Not Found" });
      return json(200, {
        sha: "b".repeat(40),
        content: Buffer.from(posts[name]!, "utf8").toString("base64"),
      });
    }
    if (method === "POST" && url.pathname === `${root}/git/refs`) {
      const body = JSON.parse(String(init.body));
      if (options.createStatus)
        return json(options.createStatus, {
          message: "Resource not accessible by personal access token",
        });
      created.push(body.ref);
      return json(201, { ref: body.ref, object: { sha: body.sha } });
    }
    if (method === "DELETE" && url.pathname.startsWith(`${root}/git/refs/`)) {
      if (options.deleteStatus)
        return json(options.deleteStatus, { message: "Server Error" });
      deleted.push(url.pathname.slice(`${root}/git/refs/`.length));
      return new Response(null, { status: 204 });
    }
    return json(404, { message: "Not Found" });
  };
  return { fetch, created, deleted, calls };
}
