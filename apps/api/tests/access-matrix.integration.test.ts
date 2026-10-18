import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { authDb, closeDatabase } from "../../../packages/db/src/index.ts";
import { collections } from "../../../packages/schemas/src/index.ts";
import { makeAuth } from "../src/auth.ts";
import { CLIENT_IP_HEADER } from "../src/client-ip.ts";
import { buildServer } from "../src/server.ts";
import { registeredActionNames } from "../src/platform/modules/contributions.ts";

const enabled = Boolean(process.env.TEST_DATABASE_URL);
// Rerun with UPDATE_ACCESS_MATRIX=1 to rewrite the expectation after an
// intended access change; review the diff like any security change.
const update = process.env.UPDATE_ACCESS_MATRIX === "1";
const MATRIX_FILE = new URL("./fixtures/access-matrix.json", import.meta.url);

// Every route the feature flags can hide is offered, so the matrix covers all
// of them; nothing reaches a provider (test mode, no external writes).
Object.assign(process.env, {
  ORBIT_AGENTS: "true",
  ORBIT_CONTENT_PACKAGES: "true",
  ORBIT_TOOL_SEARCH: "true",
  ORBIT_MODULES: "true",
  ORBIT_MCP_OAUTH: "true",
  ORBIT_MODULE_ROLES: "true",
  ORBIT_PUBLIC_INGRESS: "true",
  // Support (WP5.1): routes exist; the test project never enables the module.
  ORBIT_SUPPORT: "true",
  // Platform files (WP4.6) with a bucket that is never reached here.
  ORBIT_FILES: "true",
  FILES_S3_ENDPOINT: "https://files.example.invalid",
  FILES_S3_BUCKET: "orbit-files-matrix",
  FILES_S3_ACCESS_KEY_ID: "synthetic-access-key",
  FILES_S3_SECRET_ACCESS_KEY: "synthetic-secret-key",
  FILES_ENCRYPTION_KEY: "0".repeat(64),
  // E-mail and member notifications (WP4.7); nothing is sent in test mode.
  ORBIT_EMAIL: "true",
  ORBIT_NOTIFICATIONS: "true",
  EXECUTION_MODE: "test",
  ENABLE_EXTERNAL_WRITES: "false",
});

const ROLES = ["anonymous", "outsider", "viewer", "editor", "owner"] as const;
type Role = (typeof ROLES)[number];

/**
 * Routes a caller without a session reaches; every other route answers 401.
 * The Telegram webhook is public too, but answers 401 without its secret.
 */
const PUBLIC_ROUTES = [
  // OAuth authorization server metadata (RFC 8414), public by design.
  "GET /.well-known/oauth-authorization-server/api/auth",
  "GET /api/google-drive/callback",
  "GET /api/health/postiz",
  "GET /api/health/ready",
  "GET /api/setup",
  "GET /health",
  "POST /api/setup",
  "POST /api/slack/{workspaceId}/{projectId}/interactions",
  // Signed provider webhooks (WP4.2a): the signature authenticates.
  "POST /api/hooks/{provider}/{workspaceId}/{projectId}/{connectionId}",
  // The support widget's public API (WP5.4): the key, its allowed origins and
  // a bearer session authenticate; a made-up key answers 404 for everybody.
  "GET /api/public/support/{publicKey}/conversations",
  "GET /api/public/support/{publicKey}/messages",
  "GET /api/public/support/{publicKey}/stream",
  "OPTIONS /api/public/support/{publicKey}/{*}",
  "POST /api/public/support/{publicKey}/conversations",
  "POST /api/public/support/{publicKey}/handoff",
  "POST /api/public/support/{publicKey}/identify",
  "POST /api/public/support/{publicKey}/messages",
  "POST /api/public/support/{publicKey}/session",
];
// The collection name is validated before the session: an unknown one is a 400
// for everybody and reveals nothing about the project.
const PRE_AUTH_VALIDATION = [
  "GET /api/projects/{projectId}/unknown_collection",
];

/**
 * The action names the dispatcher knows: every handler the platform and the
 * modules registered (WP2.1f; before, read from the server.ts if-chain). An
 * unknown name is probed too.
 */
function dispatcherActions() {
  return [...registeredActionNames(), "unknown-action"].sort();
}

/** What a response says about access, without details a test setup can change. */
function classify(status: number, code: string | undefined) {
  if (status === 401) return "unauthenticated";
  if (status === 403) return `forbidden:${code ?? "-"}`;
  if (status === 404)
    return code === "NOT_FOUND" ? "not_found" : `not_found:${code ?? "-"}`;
  if (status === 429) return "rate_limited";
  if (status >= 500) return `error:${code ?? status}`;
  return `allowed:${status}`;
}

describe.skipIf(!enabled)("Route × role access matrix", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  const users: string[] = [];
  const workspaces: string[] = [];
  const cookies: Partial<Record<Role, string>> = {};
  let workspaceId: string, projectId: string;
  const origin = process.env.APP_ORIGIN!;
  const actual: Record<string, Record<Role, string>> = {};
  // A fresh documentation address per request: no request shares a rate-limit bucket.
  const clientIp = () =>
    `198.18.${randomBytes(1)[0]}.${(randomBytes(1)[0]! % 254) + 1}`;

  async function signIn(role: Role, email: string, password: string) {
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      headers: { origin, [CLIENT_IP_HEADER]: clientIp() },
      payload: { email, password },
    });
    expect(response.statusCode).toBe(200);
    const set = response.headers["set-cookie"];
    cookies[role] = (Array.isArray(set) ? set : [set])
      .map((value) => value!.split(";")[0])
      .join("; ");
  }

  /** Concrete requests for one route template. */
  function expand(method: string, template: string) {
    const fill = (path: string) =>
      path
        .replaceAll("{projectId}", projectId)
        .replaceAll("{workspaceId}", workspaceId)
        .replace(/\{[A-Za-z]+Id\}|\{id\}/g, () => randomUUID());
    if (template.endsWith("/{collection}"))
      return [...collections, "unknown_collection"].map((name) => ({
        key: `${method} ${template.replace("{collection}", name)}`,
        url: fill(template.replace("{collection}", name)),
      }));
    if (template.endsWith("/{action}"))
      return dispatcherActions().map((name) => ({
        key: `${method} ${template.replace("{action}", name)}`,
        url: fill(template.replace("{action}", name)),
      }));
    return [{ key: `${method} ${template}`, url: fill(template) }];
  }

  async function call(role: Role, method: string, url: string) {
    const headers: Record<string, string> = {
      origin,
      [CLIENT_IP_HEADER]: clientIp(),
    };
    if (cookies[role]) headers.cookie = cookies[role]!;
    const request = app.inject({
      method: method as "GET",
      url,
      headers,
      ...(method === "GET" || method === "HEAD" ? {} : { payload: {} }),
    });
    // A streaming route must answer before it streams; never wait on one.
    const response = await Promise.race([
      request,
      new Promise<null>((done) => setTimeout(() => done(null), 15000)),
    ]);
    if (!response) return "timeout";
    // Health depends on whether a worker runs; only its reachability is access.
    if (
      /^\/(api\/)?health/.test(url) &&
      ![401, 403].includes(response.statusCode)
    )
      return "public";
    let code: string | undefined;
    try {
      code = response.json()?.error?.code;
    } catch {
      code = undefined;
    }
    return classify(response.statusCode, code);
  }

  beforeAll(async () => {
    app = await buildServer();
    await app.ready();
    const auth = makeAuth();
    const password = randomBytes(24).toString("base64url");
    const accounts: Partial<Record<Role, { id: string; email: string }>> = {};
    for (const role of ["owner", "editor", "viewer", "outsider"] as const) {
      const email = `${randomUUID()}@example.invalid`;
      const created = await auth.api.signUpEmail({
        body: { email, name: `Synthetic matrix ${role}`, password },
      });
      users.push(created.user.id);
      accounts[role] = { id: created.user.id, email };
    }
    const workspace = await authDb.workspace.create({
      data: {
        name: "Synthetic access matrix",
        members: {
          create: [
            { userId: accounts.owner!.id, role: "owner" },
            { userId: accounts.editor!.id, role: "viewer" },
            { userId: accounts.viewer!.id, role: "viewer" },
          ],
        },
      },
    });
    workspaces.push(workspace.id);
    workspaceId = workspace.id;
    projectId = (
      await authDb.project.create({
        data: {
          workspaceId,
          name: "Synthetic access matrix project",
          members: {
            create: [
              { userId: accounts.editor!.id, role: "editor" },
              { userId: accounts.viewer!.id, role: "viewer" },
            ],
          },
        },
      })
    ).id;
    // The outsider owns another workspace and project, nothing here.
    const elsewhere = await authDb.workspace.create({
      data: {
        name: "Synthetic outsider workspace",
        members: { create: { userId: accounts.outsider!.id, role: "owner" } },
        projects: { create: { name: "Synthetic outsider project" } },
      },
    });
    workspaces.push(elsewhere.id);
    for (const role of ["owner", "editor", "viewer", "outsider"] as const)
      await signIn(role, accounts[role]!.email, password);

    const spec = app.swagger() as {
      paths: Record<string, Record<string, unknown>>;
    };
    const requests = Object.entries(spec.paths)
      .flatMap(([template, methods]) =>
        Object.keys(methods)
          .map((m) => m.toUpperCase())
          .flatMap((method) =>
            expand(method, template).map((r) => ({ ...r, method })),
          ),
      )
      .sort((x, y) => x.key.localeCompare(y.key));
    // Least privileged first; the owner's writes (pause included) come last.
    for (const role of ROLES)
      for (const r of requests)
        (actual[r.key] ??= {} as Record<Role, string>)[role] = await call(
          role,
          r.method,
          r.url,
        );
  }, 600000);

  afterAll(async () => {
    await authDb.workspace.deleteMany({ where: { id: { in: workspaces } } });
    await authDb.user.deleteMany({ where: { id: { in: users } } });
    await app?.close();
    await closeDatabase();
  });

  it("matches the reviewed access matrix", () => {
    const sorted = Object.fromEntries(
      Object.keys(actual)
        .sort()
        .map((key) => [key, actual[key]]),
    );
    if (update) {
      writeFileSync(MATRIX_FILE, JSON.stringify(sorted, null, 2) + "\n");
      return;
    }
    const expected = JSON.parse(readFileSync(MATRIX_FILE, "utf8")) as Record<
      string,
      Record<Role, string>
    >;
    const missing = Object.keys(sorted).filter((key) => !(key in expected));
    const removed = Object.keys(expected).filter((key) => !(key in sorted));
    const changed = Object.keys(sorted)
      .filter((key) => key in expected)
      .flatMap((key) =>
        ROLES.filter((role) => expected[key]![role] !== sorted[key]![role]).map(
          (role) =>
            `${key} [${role}]: ${expected[key]![role]} -> ${sorted[key]![role]}`,
        ),
      );
    expect({ newRoutes: missing, removedRoutes: removed, changed }).toEqual({
      newRoutes: [],
      removedRoutes: [],
      changed: [],
    });
  });

  it("answers 401 to callers without a session, except on the public routes", () => {
    const open = Object.entries(actual)
      .filter(([, roles]) => roles.anonymous !== "unauthenticated")
      .map(([key]) => key)
      .sort();
    expect(open).toEqual([...PUBLIC_ROUTES, ...PRE_AUTH_VALIDATION].sort());
  });

  it("never lets a non-member reach a project route", () => {
    const reached = Object.entries(actual)
      .filter(
        ([key, roles]) =>
          key.includes("/api/projects/{projectId}") &&
          !PRE_AUTH_VALIDATION.includes(key) &&
          !["not_found", "unauthenticated"].includes(roles.outsider),
      )
      .map(([key, roles]) => `${key}: ${roles.outsider}`);
    expect(reached).toEqual([]);
  });

  it("never rate-limits, times out or fails with a server error", () => {
    const broken = Object.entries(actual).flatMap(([key, roles]) =>
      ROLES.filter((role) =>
        /^(rate_limited|timeout|error:)/.test(roles[role]),
      ).map((role) => `${key} [${role}]: ${roles[role]}`),
    );
    expect(broken).toEqual([]);
  });
});
