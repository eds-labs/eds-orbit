import { randomBytes, randomUUID } from "node:crypto";
import { expect } from "vitest";
import { authDb, scoped, type DbTx } from "../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../packages/schemas/src/index.ts";
import { makeAuth } from "../../src/auth.ts";
import { CLIENT_IP_HEADER } from "../../src/client-ip.ts";
import type { buildServer } from "../../src/server.ts";
import { createConnection, grantConnection } from "../../src/platform/administration/connections.ts";

type App = Awaited<ReturnType<typeof buildServer>>;
export type AdsProject = Awaited<ReturnType<typeof createAdsProject>>;

/** The ads module's Meta developer app (ADR 0025): synthetic values, never a real app. */
export const ADS_META_APP = { appId: "2234567890", appSecret: "ads-app-secret-0123456789", configId: "8876543210" };

/**
 * A synthetic project for the ads module: an owner, an editor and a viewer
 * with sessions (cookies) and the module row enabled. Pass the built
 * `app` to get cookies; without it only the scopes exist. No test reaches
 * a provider.
 */
export async function createAdsProject(options: { name?: string; app?: App; enabled?: boolean } = {}) {
  const name = options.name ?? "Synthetic ads";
  const origin = process.env.APP_ORIGIN!;
  const users: string[] = [];
  const ids = { owner: "", editor: "", viewer: "" };
  const cookies = { owner: "", editor: "", viewer: "" };
  for (const who of ["owner", "editor", "viewer"] as const) {
    const email = `${randomUUID()}@example.invalid`;
    const password = randomBytes(24).toString("base64url");
    const created = await makeAuth().api.signUpEmail({ body: { email, name: `Synthetic ads ${who}`, password } });
    ids[who] = created.user.id;
    users.push(created.user.id);
    if (options.app) {
      const ip = `198.18.${randomBytes(1)[0]}.${(randomBytes(1)[0]! % 254) + 1}`;
      const response = await options.app.inject({
        method: "POST",
        url: "/api/auth/sign-in/email",
        headers: { origin, [CLIENT_IP_HEADER]: ip },
        payload: { email, password },
      });
      if (response.statusCode !== 200) throw new Error(`Synthetic ads sign-in failed for ${who}`);
      const set = response.headers["set-cookie"];
      cookies[who] = (Array.isArray(set) ? set : [set]).map((v) => v!.split(";")[0]).join("; ");
    }
  }
  const workspace = await authDb.workspace.create({
    data: {
      name,
      members: { create: [
        { userId: ids.owner, role: "owner" },
        { userId: ids.editor, role: "viewer" },
        { userId: ids.viewer, role: "viewer" },
      ] },
    },
  });
  const project = await authDb.project.create({ data: { workspaceId: workspace.id, name } });
  for (const [who, role] of [["editor", "editor"], ["viewer", "viewer"]] as const)
    await authDb.projectMember.create({
      data: { workspaceId: workspace.id, projectId: project.id, userId: ids[who], role },
    });
  const owner: Scope = { workspaceId: workspace.id, projectId: project.id, userId: ids.owner, role: "owner" };
  const editor: Scope = { ...owner, userId: ids.editor, role: "editor" };
  const viewer: Scope = { ...owner, userId: ids.viewer, role: "viewer" };
  const run = <T>(fn: (tx: DbTx) => Promise<T>) => scoped(workspace.id, project.id, fn);
  await run((tx) =>
    tx.projectModule.upsert({
      where: { workspaceId_projectId_moduleId: { workspaceId: workspace.id, projectId: project.id, moduleId: "ads" } },
      create: { workspaceId: workspace.id, projectId: project.id, moduleId: "ads", enabled: options.enabled ?? true, moduleVersion: "0.1.0", changedBy: ids.owner },
      update: { enabled: options.enabled ?? true },
    }),
  );
  return {
    workspaceId: workspace.id,
    projectId: project.id,
    owner,
    editor,
    viewer,
    ids,
    cookies,
    run,
    /** A request to the project's API as the given member. */
    call: (who: keyof typeof ids, method: "GET" | "POST" | "PUT" | "PATCH", url: string, payload?: object) => {
      if (!options.app) throw new Error("createAdsProject needs `app` for HTTP calls");
      return options.app.inject({
        method,
        url: `/api/projects/${project.id}${url}`,
        headers: {
          origin,
          cookie: cookies[who],
          [CLIENT_IP_HEADER]: `198.18.${randomBytes(1)[0]}.${(randomBytes(1)[0]! % 254) + 1}`,
        },
        ...(payload ? { payload } : {}),
      });
    },
    async cleanup() {
      await authDb.workspace.deleteMany({ where: { id: workspace.id } });
      await authDb.user.deleteMany({ where: { id: { in: users } } });
    },
  };
}

/**
 * The Meta app created by a synthetic administrator and granted to the
 * project's organization and the project, as the administration does it.
 * `organizationGrant` / `projectGrant` allow testing the partial states.
 */
export async function grantAdsMetaApp(
  project: AdsProject,
  secret: object | string = ADS_META_APP,
  grants: { organization?: boolean; project?: boolean } = {},
) {
  const admin = { userId: `admin-${randomUUID()}`, role: "admin" as const };
  const connection = await createConnection(admin, {
    provider: "ads.app.meta",
    label: "Synthetic ads.app.meta",
    config: {},
    secret: typeof secret === "string" ? secret : JSON.stringify(secret),
  });
  const targets = [
    ...(grants.organization === false ? [] : [undefined]),
    ...(grants.project === false ? [] : [project.projectId]),
  ];
  for (const projectId of targets)
    await grantConnection(admin, connection.id, {
      workspaceId: project.workspaceId,
      ...(projectId ? { projectId } : {}),
      purposes: ["ads_oauth"],
      modules: ["ads"],
    });
  return {
    connectionId: connection.id,
    cleanup: () => authDb.connection.deleteMany({ where: { id: connection.id } }),
  };
}

/** A token-shaped value unique to one test; scan responses and logs for it. */
export function fakeToken(label: string): string {
  return `EAAB${label}${randomBytes(8).toString("hex")}`;
}

/** Fails if any secret appears in the haystack (strings, or any JSON-serializable value). */
export function expectNoSecret(haystack: unknown, secrets: string[]): void {
  const text = typeof haystack === "string" ? haystack : JSON.stringify(haystack) ?? "";
  for (const secret of secrets) {
    expect(secret.length).toBeGreaterThan(0);
    expect(text.includes(secret), "a secret leaked into the output").toBe(false);
  }
}
