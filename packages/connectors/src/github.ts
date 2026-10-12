import {
  boundedFetch,
  ConnectorError,
  endpoint,
  providerDetail,
  type FetchLike,
} from "./http.ts";

const BASE = "https://api.github.com";
const MAX_BYTES = 2 * 1024 * 1024;
const NAME = /^[A-Za-z0-9._-]+$/;

export type GithubPull = { number: number; headSha: string; htmlUrl: string };
export type GithubClient = ReturnType<typeof createGithubClient>;

function invalid(): never {
  throw new ConnectorError("INVALID_TARGET");
}
/** Slash-separated ref or file path; every segment is validated and encoded for use in a URL. */
function segments(value: string, allowEmpty = false): string {
  if (value === "" && allowEmpty) return "";
  const parts = value.split("/");
  if (
    !parts.length ||
    parts.some(
      (p) => !p || p === "." || p === ".." || !/^[A-Za-z0-9._@+~-]+$/.test(p),
    )
  )
    invalid();
  return parts.map(encodeURIComponent).join("/");
}
function refParam(ref: string): string {
  segments(ref);
  return encodeURIComponent(ref);
}
function retryAfter(headers: Headers): number {
  const seconds = Number(headers.get("retry-after"));
  if (headers.get("retry-after") && Number.isFinite(seconds))
    return Math.max(1000, seconds * 1000);
  const reset = Number(headers.get("x-ratelimit-reset"));
  if (Number.isFinite(reset) && reset > 0)
    return Math.max(1000, reset * 1000 - Date.now());
  return 60_000;
}
async function readBounded(
  response: Response,
  outcome: "not_sent" | "unknown",
): Promise<string> {
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (reader)
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > MAX_BYTES) {
        await reader.cancel();
        throw new ConnectorError("RESPONSE_TOO_LARGE", outcome);
      }
      chunks.push(value);
    }
  return Buffer.concat(chunks).toString("utf8");
}

export function createGithubClient(options: {
  token: string;
  owner: string;
  repo: string;
  fetch?: FetchLike;
}) {
  if (!options.token || /[\r\n]/.test(options.token))
    throw new ConnectorError("INVALID_CREDENTIAL");
  if (!NAME.test(options.owner) || !NAME.test(options.repo)) invalid();
  const fetcher = options.fetch ?? boundedFetch;
  const root = `/repos/${options.owner}/${options.repo}`;

  async function call(
    method: string,
    path: string,
    opts: {
      body?: unknown;
      write?: boolean;
      nullOn404?: boolean;
      map?: (
        status: number,
        detail: string | undefined,
      ) => ConnectorError | undefined;
    } = {},
  ): Promise<{ status: number; json: any } | null> {
    const write = opts.write ?? method !== "GET";
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      let response: Response;
      try {
        response = await fetcher(new URL(BASE + path), {
          method,
          redirect: "manual",
          signal: controller.signal,
          headers: {
            Authorization: `Bearer ${options.token}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            ...(opts.body !== undefined
              ? { "Content-Type": "application/json" }
              : {}),
          },
          ...(opts.body !== undefined
            ? { body: JSON.stringify(opts.body) }
            : {}),
        });
      } catch (error) {
        if (error instanceof ConnectorError) throw error;
        throw new ConnectorError(
          "NETWORK_ERROR",
          write ? "unknown" : "not_sent",
          !write,
        );
      }
      const status = response.status;
      if (status === 404 && opts.nullOn404) {
        await response.body?.cancel().catch(() => {});
        return null;
      }
      if (status >= 300) {
        const raw = await providerDetail(response);
        // Matching uses the raw message; only the redacted form is ever stored on the error.
        const mapped = opts.map?.(status, raw);
        const detail = raw?.split(options.token).join("[redacted]");
        const limited =
          status === 429 ||
          (status === 403 &&
            (response.headers.get("x-ratelimit-remaining") === "0" ||
              response.headers.has("retry-after")));
        if (limited)
          throw new ConnectorError(
            "RATE_LIMITED",
            "rejected",
            true,
            status,
            detail,
            retryAfter(response.headers),
          );
        if (status === 401 || status === 403)
          throw new ConnectorError(
            "GITHUB_AUTH",
            "rejected",
            false,
            status,
            detail,
          );
        if (status === 404)
          throw new ConnectorError(
            "GITHUB_NOT_FOUND",
            "rejected",
            false,
            status,
            detail,
          );
        if (status >= 500 || status === 408 || status < 400)
          throw new ConnectorError(
            "GITHUB_UNAVAILABLE",
            write ? "unknown" : "not_sent",
            !write,
            status,
            detail,
          );
        throw mapped
          ? new ConnectorError(
              mapped.code,
              mapped.outcome,
              mapped.retryable,
              status,
              detail,
            )
          : new ConnectorError(
              "GITHUB_REJECTED",
              "rejected",
              false,
              status,
              detail,
            );
      }
      const text = await readBounded(response, write ? "unknown" : "not_sent");
      if (!text) return { status, json: undefined };
      try {
        return { status, json: JSON.parse(text) };
      } catch {
        throw new ConnectorError(
          "INVALID_PROVIDER_RESPONSE",
          write ? "unknown" : "rejected",
        );
      }
    } finally {
      clearTimeout(timer);
    }
  }
  const pull = (p: any): GithubPull => ({
    number: p.number,
    headSha: p.head.sha,
    htmlUrl: p.html_url,
  });

  return {
    async getRepo() {
      const { json } = (await call("GET", root))!;
      return {
        defaultBranch: String(json.default_branch),
        private: Boolean(json.private),
      };
    },
    async getBranchHead(branch: string): Promise<string | null> {
      const r = await call("GET", `${root}/git/ref/heads/${segments(branch)}`, {
        nullOn404: true,
      });
      return r ? String(r.json.object.sha) : null;
    },
    async listDirectory(path: string, ref: string) {
      const { json } = (await call(
        "GET",
        `${root}/contents/${segments(path, true)}?ref=${refParam(ref)}`,
      ))!;
      return (json as any[]).map((e) => ({
        name: String(e.name),
        path: String(e.path),
        sha: String(e.sha),
        type: String(e.type),
      }));
    },
    async getFile(path: string, ref: string) {
      const r = await call(
        "GET",
        `${root}/contents/${segments(path)}?ref=${refParam(ref)}`,
        { nullOn404: true },
      );
      if (!r) return null;
      return {
        sha: String(r.json.sha),
        text: Buffer.from(String(r.json.content ?? ""), "base64").toString(
          "utf8",
        ),
      };
    },
    async createBranch(branch: string, sha: string): Promise<void> {
      if (!/^[0-9a-f]{7,64}$/i.test(sha)) invalid();
      segments(branch);
      await call("POST", `${root}/git/refs`, {
        body: { ref: `refs/heads/${branch}`, sha },
        map: (status, detail) =>
          status === 422 && /already exists/i.test(detail ?? "")
            ? new ConnectorError(
                "GITHUB_REF_EXISTS",
                "rejected",
                false,
                status,
                detail,
              )
            : undefined,
      });
    },
    async deleteBranch(branch: string): Promise<void> {
      await call("DELETE", `${root}/git/refs/heads/${segments(branch)}`, {
        nullOn404: true,
      });
    },
    async compareCommits(base: string, head: string) {
      const { json } = (await call(
        "GET",
        `${root}/compare/${segments(base)}...${segments(head)}`,
      ))!;
      return {
        aheadBy: Number(json.ahead_by),
        commits: ((json.commits ?? []) as any[]).map((c) => ({
          sha: String(c.sha),
          authorLogin: c.author?.login ? String(c.author.login) : null,
          message: String(c.commit?.message ?? ""),
        })),
      };
    },
    async putFile(input: {
      path: string;
      branch: string;
      text: string;
      message: string;
      sha?: string;
    }) {
      segments(input.branch);
      const { json } = (await call(
        "PUT",
        `${root}/contents/${segments(input.path)}`,
        {
          body: {
            message: input.message,
            content: Buffer.from(input.text, "utf8").toString("base64"),
            branch: input.branch,
            ...(input.sha ? { sha: input.sha } : {}),
          },
        },
      ))!;
      return { commitSha: String(json.commit.sha) };
    },
    async findOpenPull(headBranch: string): Promise<GithubPull | null> {
      segments(headBranch);
      const { json } = (await call(
        "GET",
        `${root}/pulls?state=open&per_page=100&head=${encodeURIComponent(`${options.owner}:${headBranch}`)}`,
      ))!;
      return Array.isArray(json) && json.length ? pull(json[0]) : null;
    },
    async createPull(input: {
      title: string;
      head: string;
      base: string;
      body: string;
    }): Promise<GithubPull> {
      segments(input.head);
      segments(input.base);
      const { json } = (await call("POST", `${root}/pulls`, {
        body: {
          title: input.title,
          head: input.head,
          base: input.base,
          body: input.body,
        },
      }))!;
      return pull(json);
    },
    async getPull(number: number) {
      if (!Number.isInteger(number) || number < 1) invalid();
      const { json } = (await call("GET", `${root}/pulls/${number}`))!;
      return {
        state: json.state === "open" ? ("open" as const) : ("closed" as const),
        merged: Boolean(json.merged),
        headSha: String(json.head.sha),
        mergeCommitSha: json.merge_commit_sha
          ? String(json.merge_commit_sha)
          : null,
        htmlUrl: String(json.html_url),
      };
    },
    async checkRuns(sha: string) {
      if (!/^[0-9a-f]{7,64}$/i.test(sha)) invalid();
      const { json } = (await call(
        "GET",
        `${root}/commits/${sha}/check-runs?per_page=100`,
      ))!;
      const runs = (json.check_runs ?? []) as any[];
      let pending = 0,
        passed = 0;
      const failed: string[] = [];
      for (const run of runs) {
        if (run.status !== "completed") pending++;
        else if (["success", "neutral", "skipped"].includes(run.conclusion))
          passed++;
        else failed.push(String(run.name));
      }
      return {
        total: Number(json.total_count ?? runs.length),
        pending,
        failed,
        passed,
      };
    },
    async mergePull(number: number, sha: string) {
      if (
        !Number.isInteger(number) ||
        number < 1 ||
        !/^[0-9a-f]{7,64}$/i.test(sha)
      )
        invalid();
      const { json } = (await call("PUT", `${root}/pulls/${number}/merge`, {
        body: { sha, merge_method: "merge" },
        map: (status, detail) =>
          status === 409
            ? new ConnectorError(
                "GITHUB_HEAD_MOVED",
                "rejected",
                false,
                status,
                detail,
              )
            : status === 405
              ? new ConnectorError(
                  "GITHUB_NOT_MERGEABLE",
                  "rejected",
                  false,
                  status,
                  detail,
                )
              : undefined,
      }))!;
      return { mergeSha: String(json.sha) };
    },
    async closePull(number: number): Promise<void> {
      if (!Number.isInteger(number) || number < 1) invalid();
      await call("PATCH", `${root}/pulls/${number}`, {
        body: { state: "closed" },
      });
    },
  };
}

/** Public live-page fetch: HTTPS only, no credentials, no redirects, at most 2 MB. Any HTTP status is returned. */
export async function fetchPublicPage(
  url: string,
  fetcher: FetchLike = boundedFetch,
): Promise<{ status: number; text: string }> {
  const target = endpoint(url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    let response: Response;
    try {
      response = await fetcher(target, {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: { Accept: "text/html,*/*" },
      });
    } catch (error) {
      if (error instanceof ConnectorError) throw error;
      throw new ConnectorError("NETWORK_ERROR", "not_sent", true);
    }
    return {
      status: response.status,
      text: await readBounded(response, "not_sent"),
    };
  } finally {
    clearTimeout(timer);
  }
}
