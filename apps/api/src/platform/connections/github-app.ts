import { createPrivateKey, createSign } from "node:crypto";
import { z } from "zod";
import {
  boundedFetch,
  ConnectorError,
  type FetchLike,
} from "../../../../../packages/connectors/src/index.ts";
import { DomainError } from "../shared.ts";
import type { ConnectionProvider } from "./connections.ts";

// GitHub App client (spec 2026-11-05 §5.1): the platform part of a GitHub
// connection. The secret is one JSON string {appId, appSlug, installationId,
// privateKey}; every call mints a short-lived installation token that is
// limited to one repository and the permissions the call needs. Nothing here
// names a module.

export const GITHUB_APP_PROVIDER = "github_app";
export const GITHUB_ISSUES_PURPOSE = "issues";

const ROOT = "https://api.github.com";
const API_VERSION = "2026-03-10";
const TIMEOUT_MS = 20_000;
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_REPOSITORIES = 500;
const PAGE_SIZE = 100;

let fetcher: FetchLike = boundedFetch;
/** Tests replace the transport; null restores the bounded one. */
export function setGithubFetchForTests(next: FetchLike | null) {
  fetcher = next ?? boundedFetch;
}

export type GithubAppSecret = {
  appId: string;
  appSlug: string;
  installationId: string;
  privateKey: string;
};
export type GithubPermissions = Partial<
  Record<"issues" | "metadata", "read" | "write">
>;
export type GithubRepository = {
  fullName: string;
  private: boolean;
  archived: boolean;
};

/**
 * `sent` tells a caller whether the request may have reached GitHub (network
 * error or timeout after the send, 5xx, an oversized answer to a write) or was
 * definitely refused or never left (4xx, refused path, DNS/endpoint problems).
 */
export class GithubSendError extends DomainError {
  constructor(
    code: string,
    public sent: boolean,
  ) {
    super(code, 409);
  }
}

/**
 * Rebuilds a valid PEM from the forms a single-line secret field produces:
 * newlines replaced by spaces or written as a literal `\n`.
 */
export function normalizePem(raw: string): string {
  const text = raw.replaceAll("\\n", "\n").replaceAll("\r", "");
  const match = /-----BEGIN ([A-Z0-9 ]+)-----([\s\S]*?)-----END \1-----/.exec(
    text,
  );
  if (!match) throw new DomainError("GITHUB_APP_INVALID", 409);
  const body = match[2]!.replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(body))
    throw new DomainError("GITHUB_APP_INVALID", 409);
  const lines = body.match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${match[1]}-----\n${lines.join("\n")}\n-----END ${match[1]}-----\n`;
}

const secretShape = z
  .object({
    appId: z.string().regex(/^\d{1,20}$/),
    appSlug: z.string().regex(/^[a-z0-9-]{1,100}$/),
    installationId: z.string().regex(/^\d{1,20}$/),
    privateKey: z.string().min(100).max(20000),
  })
  .strict();

/** The connection secret; every failure is the same content-free code. */
export function parseGithubAppSecret(raw: string): GithubAppSecret {
  try {
    const parsed = secretShape.parse(JSON.parse(raw));
    const privateKey = normalizePem(parsed.privateKey);
    createPrivateKey(privateKey);
    return { ...parsed, privateKey };
  } catch {
    throw new DomainError("GITHUB_APP_INVALID", 409);
  }
}

const b64 = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");

/** An RS256 App JWT: issued 60 s in the past (clock skew), valid 9 minutes. */
export function githubAppJwt(app: GithubAppSecret, now = new Date()): string {
  const t = Math.floor(now.getTime() / 1000);
  const payload = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({ iat: t - 60, exp: t + 540, iss: app.appId })}`;
  const signature = createSign("RSA-SHA256")
    .update(payload)
    .sign(createPrivateKey(app.privateKey))
    .toString("base64url");
  return `${payload}.${signature}`;
}

const API_PATH = /^\/[A-Za-z0-9/_.?=&%-]*$/;

function statusCode(status: number) {
  if (status === 401 || status === 404 || status === 410)
    return "GITHUB_RECONNECT_REQUIRED";
  if (status === 403 || status === 429) return "GITHUB_ACCESS_OR_RATE_LIMIT";
  if (status === 422) return "GITHUB_VALIDATION_FAILED";
  if (status >= 500) return "GITHUB_UNAVAILABLE";
  return "GITHUB_REQUEST_FAILED";
}
// Failures before any byte left: the request was never sent.
const NEVER_SENT = new Set([
  "INVALID_ENDPOINT",
  "PRIVATE_ENDPOINT",
  "DNS_FAILED",
  "DNS_TIMEOUT",
]);

/**
 * One bounded GitHub API call (no redirects, 20 s, body at most 1 MB). The
 * path must be an API path; the host is fixed.
 */
export async function githubFetch<T = unknown>(
  path: string,
  token: string,
  init: RequestInit = {},
): Promise<T> {
  if (!API_PATH.test(path) || path.startsWith("//"))
    throw new GithubSendError("GITHUB_REQUEST_FAILED", false);
  const write = (init.method ?? "GET").toUpperCase() !== "GET";
  let response: Response;
  try {
    response = await fetcher(ROOT + path, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": API_VERSION,
        Authorization: `Bearer ${token}`,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...(init.headers as Record<string, string> | undefined),
      },
    });
  } catch (error) {
    if (error instanceof ConnectorError && error.code === "RESPONSE_TOO_LARGE")
      throw new GithubSendError("GITHUB_RESPONSE_TOO_LARGE", write);
    const never = error instanceof ConnectorError && NEVER_SENT.has(error.code);
    throw new GithubSendError("GITHUB_UNAVAILABLE", !never);
  }
  if (!response.ok)
    throw new GithubSendError(statusCode(response.status), response.status >= 500);
  let text: string;
  try {
    text = await response.text();
  } catch {
    throw new GithubSendError("GITHUB_UNAVAILABLE", true);
  }
  // A write may already have happened when its answer is unusable.
  if (Buffer.byteLength(text) > MAX_BODY_BYTES)
    throw new GithubSendError("GITHUB_RESPONSE_TOO_LARGE", write);
  try {
    return (text ? JSON.parse(text) : null) as T;
  } catch {
    throw new GithubSendError("GITHUB_REQUEST_FAILED", write);
  }
}

const REPO_NAME = /^(?!\.{1,2}$)[A-Za-z0-9_.-]{1,100}$/;

async function mintToken(
  app: GithubAppSecret,
  body: { repositories?: string[]; permissions: GithubPermissions },
): Promise<string> {
  const result = await githubFetch<{ token?: unknown }>(
    `/app/installations/${app.installationId}/access_tokens`,
    githubAppJwt(app),
    { method: "POST", body: JSON.stringify(body) },
  );
  if (typeof result?.token !== "string" || !result.token)
    throw new GithubSendError("GITHUB_REQUEST_FAILED", false);
  return result.token;
}

/**
 * A token for the installation, limited to exactly one repository (name
 * without owner) and the given permissions.
 */
export async function installationToken(
  app: GithubAppSecret,
  req: { repositories: [string]; permissions: GithubPermissions },
): Promise<string> {
  const names: unknown = req.repositories;
  if (
    !Array.isArray(names) ||
    names.length !== 1 ||
    typeof names[0] !== "string" ||
    !REPO_NAME.test(names[0])
  )
    throw new DomainError("GITHUB_APP_INVALID", 409);
  return mintToken(app, {
    repositories: [names[0]],
    permissions: req.permissions,
  });
}

const repositoryShape = z.object({
  full_name: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  private: z.boolean(),
  archived: z.boolean().default(false),
});
const toRepository = (row: unknown): GithubRepository => {
  const parsed = repositoryShape.safeParse(row);
  if (!parsed.success) throw new GithubSendError("GITHUB_REQUEST_FAILED", false);
  return {
    fullName: parsed.data.full_name,
    private: parsed.data.private,
    archived: parsed.data.archived,
  };
};

/** One repository, read with a token limited to it. */
export async function getRepository(
  app: GithubAppSecret,
  fullName: string,
): Promise<GithubRepository> {
  const match = /^([A-Za-z0-9_.-]+)\/((?!\.{1,2}$)[A-Za-z0-9_.-]+)$/.exec(fullName);
  if (!match) throw new GithubSendError("GITHUB_VALIDATION_FAILED", false);
  const token = await installationToken(app, {
    repositories: [match[2]!],
    permissions: { issues: "read", metadata: "read" },
  });
  return toRepository(
    await githubFetch(`/repos/${match[1]}/${match[2]}`, token),
  );
}

/** The repositories the installation can see (at most 500). */
export async function installationRepositories(
  app: GithubAppSecret,
): Promise<GithubRepository[]> {
  // Listing needs the whole installation, so this token names no repository.
  const token = await mintToken(app, { permissions: { metadata: "read" } });
  const found: GithubRepository[] = [];
  for (let page = 1; found.length < MAX_REPOSITORIES; page += 1) {
    const result = await githubFetch<{ repositories?: unknown[] }>(
      `/installation/repositories?per_page=${PAGE_SIZE}&page=${page}`,
      token,
    );
    const rows = result?.repositories ?? [];
    found.push(...rows.map(toRepository));
    if (rows.length < PAGE_SIZE) break;
  }
  return found.slice(0, MAX_REPOSITORIES);
}

/**
 * The GitHub App connection: the secret is the JSON {appId, appSlug,
 * installationId, privateKey}. The check reads the installation with the App
 * JWT (GET /app/installations/{id}), which proves key, app and installation
 * together and yields the account login; no token is minted and nothing is
 * written. The installation's `app_slug` must be the configured `appSlug`:
 * the job finds its own issues by `creator={appSlug}[bot]`, so a wrong slug
 * would make every reconcile look empty.
 */
export const githubAppConnectionProvider: ConnectionProvider = {
  scopes: ["system", "workspace"],
  purposes: [GITHUB_ISSUES_PURPOSE],
  label: { en: "GitHub App", de: "GitHub-App" },
  async check(_connection, credential) {
    const app = parseGithubAppSecret(credential);
    const installation = await githubFetch<{
      account?: { login?: unknown };
      app_slug?: unknown;
    }>(`/app/installations/${app.installationId}`, githubAppJwt(app));
    const slug = installation?.app_slug;
    if (typeof slug !== "string" || slug.toLowerCase() !== app.appSlug.toLowerCase())
      throw new DomainError("GITHUB_APP_INVALID", 409);
    const login = installation?.account?.login;
    if (typeof login !== "string" || !login)
      throw new DomainError("GITHUB_REQUEST_FAILED", 409);
    return {
      status: "read_verified",
      capabilities: ["github_issues"],
      account: login,
    };
  },
};
