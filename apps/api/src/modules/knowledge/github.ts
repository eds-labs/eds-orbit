import { actorScope } from "../../platform/tenancy/member-scope.ts";
import { createPrivateKey, createSign, randomBytes } from "node:crypto";
import { z } from "zod";
import { scoped } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import type {
  KnowledgeDraft,
  KnowledgeSnapshot,
} from "../../../../../packages/schemas/src/knowledge-workspace.ts";
import { loadConfig } from "../../../../../packages/config/src/index.ts";
import {
  create,
  data,
  decrypt,
  encrypt,
  entity,
  hash,
  list,
  update,
  DomainError,
} from "../../shared.ts";

export const githubConfiguration = z
  .object({
    appId: z.string().regex(/^\d+$/),
    slug: z.string().regex(/^[a-z0-9-]+$/),
    clientId: z.string().min(5).max(200),
    clientSecret: z.string().min(10).max(300),
    privateKey: z.string().min(100).max(20000),
  })
  .strict();
const installation = z.object({
  id: z.number().int().positive(),
  account: z.object({ login: z.string() }),
});
const repository = z.object({
  id: z.number().int().positive(),
  full_name: z.string(),
  default_branch: z.string(),
  private: z.boolean(),
});
const root = "https://api.github.com";
const callback = (s: Scope) =>
  `${loadConfig().APP_ORIGIN}/api/projects/${s.projectId}/knowledge/github/callback`;
export const githubError = (status: number) =>
  status === 429 || status === 403
    ? "GITHUB_ACCESS_OR_RATE_LIMIT"
    : status === 401 || status === 404
      ? "GITHUB_RECONNECT_REQUIRED"
      : "GITHUB_REQUEST_FAILED";
async function json(path: string, token: string, init: RequestInit = {}) {
  const response = await fetch(root + path, {
    ...init,
    redirect: "error",
    signal: AbortSignal.timeout(20000),
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2026-03-10",
      Authorization: `Bearer ${token}`,
      ...init.headers,
    },
  });
  if (!response.ok) throw new DomainError(githubError(response.status), 409);
  // GitHub JSON is bounded before parsing, including the base64 blob representation.
  const body = await response.text();
  if (body.length > 8_000_000)
    throw new DomainError("GITHUB_RESPONSE_TOO_LARGE", 409);
  return JSON.parse(body);
}
async function settings(s: Scope) {
  return scoped(s.workspaceId, s.projectId, async (tx) => {
    const row = (await list(tx, s, "knowledge_github_config"))[0];
    if (!row) throw new DomainError("GITHUB_NOT_CONFIGURED", 409);
    return {
      ...githubConfiguration.parse(
        JSON.parse(
          decrypt(data(row).encryptedCredential, loadConfig().CREDENTIAL_KEY),
        ),
      ),
      version: row.version,
    };
  });
}
export async function configureGithub(s: Scope, input: unknown) {
  const c = githubConfiguration.parse(input);
  try {
    const key = createPrivateKey(c.privateKey);
    if (
      key.asymmetricKeyType !== "rsa" ||
      (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048
    )
      throw new Error("RSA required");
    createSign("RSA-SHA256").update("validate").sign(key);
  } catch {
    throw new DomainError("GITHUB_INVALID_PRIVATE_KEY");
  }
  return scoped(s.workspaceId, s.projectId, async (tx) => {
    const old = (await list(tx, s, "knowledge_github_config"))[0];
    const value = {
      encryptedCredential: encrypt(
        JSON.stringify(c),
        loadConfig().CREDENTIAL_KEY,
      ),
    };
    if (old) await update(tx, s, old, value);
    else await create(tx, s, "knowledge_github_config", value);
    return { configured: true };
  });
}
export async function githubStatus(s: Scope) {
  return scoped(s.workspaceId, s.projectId, async (tx) => {
    const c = (await list(tx, s, "knowledge_github_config"))[0];
    const connections = await list(tx, s, "knowledge_github_connections");
    return {
      configured: Boolean(c),
      connections: connections.map((x) => ({
        id: x.id,
        version: x.version,
        account: data(x).account,
        installationId: data(x).installationId,
      })),
      installUrl: c
        ? `https://github.com/apps/${githubConfiguration.parse(JSON.parse(decrypt(data(c).encryptedCredential, loadConfig().CREDENTIAL_KEY))).slug}/installations/new`
        : null,
    };
  });
}
export async function beginGithub(s: Scope, input: unknown = {}) {
  const { draftId } = z.object({ draftId: z.uuid().optional() }).parse(input);
  if (draftId)
    await scoped(s.workspaceId, s.projectId, (tx) =>
      entity(tx, s, "knowledge_drafts", draftId),
    );
  const c = await settings(s);
  const state = randomBytes(32).toString("base64url");
  await scoped(s.workspaceId, s.projectId, async (tx) => {
    await create(tx, s, "knowledge_github_oauth", {
      stateHash: hash(state),
      userId: s.userId,
      draftId: draftId ?? null,
      configVersion: c.version,
      expiresAt: Date.now() + 600000,
      used: false,
    });
  });
  const url = new URL("https://github.com/login/oauth/authorize");
  url.search = new URLSearchParams({
    client_id: c.clientId,
    redirect_uri: callback(s),
    state,
  }).toString();
  return { url: url.toString() };
}
export async function finishGithub(s: Scope, state: string, code: string) {
  const c = await settings(s);
  const draftId = await scoped(s.workspaceId, s.projectId, async (tx) => {
    const row = (await list(tx, s, "knowledge_github_oauth")).find(
      (x) => data(x).stateHash === hash(state),
    );
    if (
      !row ||
      data(row).used ||
      data(row).userId !== s.userId ||
      data(row).expiresAt < Date.now() ||
      data(row).configVersion !== c.version
    )
      throw new DomainError("GITHUB_STATE_INVALID", 403);
    await update(tx, s, row, { ...data(row), used: true });
    return data(row).draftId as string | null;
  });
  const response = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(20000),
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: c.clientId,
      client_secret: c.clientSecret,
      code,
      redirect_uri: callback(s),
    }),
  });
  if (!response.ok) throw new DomainError("GITHUB_OAUTH_FAILED", 409);
  const token = z
    .object({ access_token: z.string().min(10) })
    .safeParse(await response.json());
  if (!token.success) throw new DomainError("GITHUB_OAUTH_FAILED", 409);
  const installs = z
    .object({ installations: z.array(installation) })
    .parse(
      await json("/user/installations?per_page=100", token.data.access_token),
    );
  const actor = await actorScope(s.workspaceId, s.projectId, s.userId);
  if (actor?.role !== "owner") throw new DomainError("OWNER_REQUIRED", 403);
  await scoped(s.workspaceId, s.projectId, async (tx) => {
    for (const i of installs.installations) {
      const old = (await list(tx, s, "knowledge_github_connections")).find(
        (x) => data(x).installationId === i.id,
      );
      const value = {
        installationId: i.id,
        account: i.account.login,
        configVersion: c.version,
        actorId: s.userId,
        encryptedCredential: encrypt(
          token.data.access_token,
          loadConfig().CREDENTIAL_KEY,
        ),
      };
      if (old) await update(tx, s, old, value);
      else await create(tx, s, "knowledge_github_connections", value);
    }
  });
  return draftId;
}
export async function githubRepositories(s: Scope, connectionId: string) {
  const c = await settings(s);
  const row = await scoped(s.workspaceId, s.projectId, (tx) =>
    entity(tx, s, "knowledge_github_connections", connectionId),
  );
  const d = data(row);
  if (d.configVersion !== c.version)
    throw new DomainError("GITHUB_RECONNECT_REQUIRED", 409);
  const token = decrypt(d.encryptedCredential, loadConfig().CREDENTIAL_KEY);
  const repositories = [];
  for (let page = 1; page <= 10; page++) {
    const response = z
      .object({ repositories: z.array(repository) })
      .parse(
        await json(
          `/user/installations/${d.installationId}/repositories?per_page=100&page=${page}`,
          token,
        ),
      );
    repositories.push(...response.repositories);
    if (response.repositories.length < 100) break;
  }
  return { items: repositories };
}
export async function githubToken(s: Scope, d: KnowledgeDraft) {
  const c = await settings(s);
  const repos = await githubRepositories(s, d.connectionId!);
  const repo = repos.items.find(
    (x) => x.id === d.repositoryId && x.full_name === d.repository,
  );
  if (!repo) throw new DomainError("GITHUB_REPOSITORY_FORBIDDEN", 403);
  const row = await scoped(s.workspaceId, s.projectId, (tx) =>
    entity(tx, s, "knowledge_github_connections", d.connectionId!),
  );
  const now = Math.floor(Date.now() / 1000);
  const encode = (v: unknown) =>
    Buffer.from(JSON.stringify(v)).toString("base64url");
  const payload = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iat: now - 30, exp: now + 300, iss: c.appId })}`;
  const jwt =
    payload +
    "." +
    createSign("RSA-SHA256").update(payload).sign(c.privateKey, "base64url");
  const token = z.object({ token: z.string() }).parse(
    await json(
      `/app/installations/${data(row).installationId}/access_tokens`,
      jwt,
      {
        method: "POST",
        body: JSON.stringify({
          repository_ids: [repo.id],
          permissions: { contents: "read", metadata: "read" },
        }),
      },
    ),
  );
  return { token: token.token, repository: repo };
}
const excluded =
  /(^|\/)(node_modules|vendor|dist|build|out|\.git|\.next|coverage|\.env[^/]*|[^/]*(?:secret|credential|private[-_]?key)[^/]*)(\/|$)|\.(?:pem|key|p12|pfx|lock)$/i;
export function allowedRepositoryPath(path: string, paths: string[]) {
  return (
    !excluded.test(path) &&
    !path.split("/").includes("..") &&
    /\.(md|mdx|txt|html|tsx?|jsx?|swift|kt|java|py|sql|json|ya?ml)$/i.test(
      path,
    ) &&
    paths.some((p) => (p.endsWith("/") ? path.startsWith(p) : path === p))
  );
}
export function containsCredentials(text: string) {
  return /-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,})|(?:api[_-]?key|password|client[_-]?secret|access[_-]?token)\s*[:=]\s*["'][^"']{8,}["']/i.test(
    text,
  );
}
export async function readRepository(
  s: Scope,
  d: KnowledgeDraft,
): Promise<KnowledgeSnapshot> {
  const { token, repository: repo } = await githubToken(s, d);
  const prefix = `/repos/${repo.full_name}`;
  const commit = z
    .object({ sha: z.string().regex(/^[a-f0-9]{40}$/) })
    .parse(
      await json(
        `${prefix}/commits/${encodeURIComponent(d.branch || repo.default_branch)}`,
        token,
      ),
    ).sha;
  const tree = z
    .object({
      truncated: z.boolean(),
      tree: z.array(
        z.object({
          path: z.string(),
          type: z.string(),
          sha: z.string(),
          size: z.number().optional(),
        }),
      ),
    })
    .parse(await json(`${prefix}/git/trees/${commit}?recursive=1`, token));
  const selected = tree.tree.filter(
    (x) => x.type === "blob" && allowedRepositoryPath(x.path, d.paths),
  );
  let bytes = 0,
    skipped = 0;
  const files: KnowledgeSnapshot["files"] = [];
  const unreadablePaths: string[] = [];
  for (const file of selected) {
    if (
      files.length >= 30 ||
      (file.size ?? 100001) > 100000 ||
      bytes + (file.size ?? 100001) > 100000
    ) {
      skipped++;
      unreadablePaths.push(file.path);
      continue;
    }
    const blob = z
      .object({ content: z.string(), encoding: z.literal("base64") })
      .parse(await json(`${prefix}/git/blobs/${file.sha}`, token));
    const buffer = Buffer.from(blob.content.replace(/\n/g, ""), "base64");
    const text = buffer.toString("utf8");
    if (
      buffer.length > 100000 ||
      bytes + buffer.length > 100000 ||
      text.includes("\u0000") ||
      containsCredentials(text)
    ) {
      skipped++;
      unreadablePaths.push(file.path);
      continue;
    }
    bytes += buffer.length;
    files.push({
      path: file.path,
      text,
      hash: hash(text),
      url: `https://github.com/${repo.full_name}/blob/${commit}/${file.path.split("/").map(encodeURIComponent).join("/")}`,
    });
  }
  return {
    commit,
    files,
    partial: tree.truncated || skipped > 0,
    skipped,
    unreadablePaths,
  };
}
