import { randomBytes, randomUUID } from "node:crypto";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { authDb, closeDatabase } from "../../../packages/db/src/index.ts";
import { makeAuth } from "../src/auth.ts";
import { buildServer } from "../src/server.ts";
import { loadConfig } from "../../../packages/config/src/index.ts";
import { ORBIT_WORKSPACE_CLAIM } from "../src/platform/mcp-auth/plugins.ts";
import {
  activeGrantForToken,
  listGrants,
  revokeGrant,
} from "../src/platform/mcp-auth/grants.ts";
import {
  cimdFetchFor,
  createFlowDriver,
  jwtPayload,
  metadata,
  origin,
  withFlags as baseWithFlags,
  type Flow,
  type Json,
} from "./mcp-oauth-flow-helpers.ts";

// Track M WP-M1, Task 5: revoking and listing MCP grants and the lookup the
// gateway calls per request. Real flows through the Fastify app with
// ORBIT_MCP_OAUTH=true; clients are served in-process (cimdFetch seam).
// Four sessions (owner, member, editor, outsider) share the file's sign-ins.

const enabled = Boolean(process.env.TEST_DATABASE_URL);
const clientUrl = (name: string) => `https://client.test/revoke-${name}.json`;
const names = [
  "own",
  "window",
  "control",
  "owner",
  "editor",
  "outsider",
  "lookup",
  "list",
  "two",
] as const;
const CLIENT = Object.fromEntries(
  names.map((n) => [n, clientUrl(n)]),
) as Record<(typeof names)[number], string>;
const clientIds = Object.values(CLIENT);
const cimdFetch = cimdFetchFor(
  Object.fromEntries(clientIds.map((id) => [id, metadata(id)])),
);
const withFlags = (flags: Parameters<typeof baseWithFlags>[0]) =>
  baseWithFlags(flags, cimdFetch);

describe.skipIf(!enabled)("MCP grants, flag off", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  beforeAll(async () => {
    ({ app } = await withFlags({ ORBIT_MCP_OAUTH: "false" }));
  });
  afterAll(async () => {
    await app?.close();
  });

  it("the grant routes do not exist while the flag is off", async () => {
    const id = randomUUID();
    for (const [method, url] of [
      ["GET", "/api/mcp-grants"],
      ["GET", `/api/workspaces/${id}/mcp-grants`],
      ["DELETE", `/api/mcp-grants/${id}`],
      ["PATCH", `/api/mcp-grants/${id}`],
    ] as const) {
      const r = await app.inject({ method, url, headers: { origin } });
      expect(r.statusCode).toBe(404);
    }
  });
});

describe.skipIf(!enabled)("MCP grants: revoke, list, lookup", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  let config: ReturnType<typeof loadConfig>;
  const cookies: Record<"owner" | "member" | "editor" | "outsider", string> =
    {} as never;
  let cookie: string;
  const ids = {} as Record<"owner" | "member" | "editor" | "outsider", string>;
  let workspaceId: string, otherWorkspaceId: string, projectA: string;
  let otherProjectId: string;
  const users: string[] = [];
  const workspaces: string[] = [];

  const as = (who: keyof typeof cookies) => {
    cookie = cookies[who];
  };
  const driver = createFlowDriver({
    app: () => app,
    config: () => config,
    cookie: () => cookie,
    selection: () => ({ workspaceId, projectIds: [projectA] }),
    defaultClientId: CLIENT.own,
  });
  const { inject, connect, exchange, refresh } = driver;

  const revoke = (grantId: string, who?: keyof typeof cookies) => {
    if (who) as(who);
    return inject({ method: "DELETE", url: `/api/mcp-grants/${grantId}` });
  };
  const activeGrant = (userId: string, clientId: string, ws = workspaceId) =>
    authDb.mcpGrant.findFirstOrThrow({
      where: { userId, clientId, workspaceId: ws, status: "active" },
    });
  /** Connects as `who` and exchanges the code; returns tokens and the claims. */
  async function connectAs(
    who: keyof typeof cookies,
    clientId: string,
    options: { selection?: Json } = {},
  ) {
    as(who);
    const flow: Flow = await connect({ clientId, ...options });
    const response = await exchange(flow, { client_id: clientId });
    expect(response.statusCode).toBe(200);
    const tokens = response.json() as Json;
    const claims = jwtPayload(tokens.access_token) as Json;
    return { flow, tokens, claims };
  }
  const refreshAs = (token: string, clientId: string) =>
    refresh(token, clientId);

  beforeAll(async () => {
    let auth: ReturnType<typeof makeAuth>;
    ({ app, auth, config } = await withFlags({
      ORBIT_MCP_OAUTH: "true",
      ORBIT_MCP_CIMD_HOSTS: "client.test",
    }));
    await authDb.oauthClient.deleteMany({
      where: { clientId: { in: clientIds } },
    });
    const password = randomBytes(24).toString("base64url");
    const emails = {} as Record<keyof typeof ids, string>;
    for (const who of ["owner", "member", "editor", "outsider"] as const) {
      emails[who] = `${randomUUID()}@example.invalid`;
      const created = await auth.api.signUpEmail({
        body: { email: emails[who], name: `Synthetic ${who}`, password },
      });
      ids[who] = created.user.id;
      users.push(created.user.id);
    }
    const workspace = await authDb.workspace.create({
      data: {
        name: "Synthetic revoke workspace",
        members: {
          create: [
            { userId: ids.owner, role: "owner" },
            { userId: ids.member, role: "editor" },
            { userId: ids.editor, role: "editor" },
          ],
        },
        projects: {
          create: [
            {
              name: "Synthetic A",
              members: {
                create: [{ userId: ids.member, role: "editor" }],
              },
            },
          ],
        },
      },
      include: { projects: true },
    });
    workspaceId = workspace.id;
    projectA = workspace.projects[0]!.id;
    // The owner's second workspace and a foreign one nobody here belongs to.
    const other = await authDb.workspace.create({
      data: {
        name: "Synthetic revoke other workspace",
        members: { create: { userId: ids.owner, role: "owner" } },
        projects: { create: { name: "Synthetic other" } },
      },
      include: { projects: true },
    });
    otherWorkspaceId = other.id;
    otherProjectId = other.projects[0]!.id;
    workspaces.push(workspaceId, otherWorkspaceId);

    for (const who of ["owner", "member", "editor", "outsider"] as const) {
      const r = await inject({
        method: "POST",
        url: "/api/auth/sign-in/email",
        session: false,
        payload: { email: emails[who], password },
      });
      expect(r.statusCode).toBe(200);
      const set = r.headers["set-cookie"];
      cookies[who] = (Array.isArray(set) ? set : [set!])
        .map((v) => v.split(";")[0])
        .join("; ");
    }
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  afterAll(async () => {
    await authDb.mcpGrantEvent.deleteMany({ where: { userId: { in: users } } });
    await authDb.mcpGrant.deleteMany({
      where: { clientId: { in: clientIds } },
    });
    await authDb.workspace.deleteMany({ where: { id: { in: workspaces } } });
    await authDb.user.deleteMany({ where: { id: { in: users } } });
    await authDb.oauthClient.deleteMany({
      where: { clientId: { in: clientIds } },
    });
    await app?.close();
    await closeDatabase();
  });

  it("revoked grant fails on the next call", async () => {
    const clientId = CLIENT.own;
    const { tokens, claims } = await connectAs("owner", clientId);
    expect(claims[ORBIT_WORKSPACE_CLAIM]).toBe(workspaceId);
    const grant = await activeGrant(ids.owner, clientId);
    expect(await activeGrantForToken(claims as never)).toMatchObject({
      id: grant.id,
    });
    const rotated = await refreshAs(tokens.refresh_token, clientId);
    expect(rotated.statusCode).toBe(200);
    const latest = rotated.json().refresh_token as string;

    const revoked = await revoke(grant.id, "owner");
    expect(revoked.statusCode).toBe(204);
    expect(revoked.body).toBe("");

    const after = await refreshAs(latest, clientId);
    expect(after.statusCode).toBe(400);
    expect(after.json().error).toBe("invalid_grant");
    expect(await activeGrantForToken(claims as never)).toBeNull();

    const row = await authDb.mcpGrant.findUniqueOrThrow({
      where: { id: grant.id },
    });
    expect(row).toMatchObject({ status: "revoked", revokedBy: ids.owner });
    expect(row.revokedAt).toBeInstanceOf(Date);
    const reference = { clientId, userId: ids.owner, referenceId: workspaceId };
    expect(await authDb.oauthConsent.count({ where: reference })).toBe(0);
    expect(await authDb.oauthRefreshToken.count({ where: reference })).toBe(0);

    const events = await authDb.mcpGrantEvent.findMany({
      where: { grantId: grant.id, action: "grant.revoked" },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      userId: ids.owner,
      clientId,
      workspaceId,
      detail: { by: "user" },
    });
    const serialized = JSON.stringify(events);
    for (const secret of [tokens.access_token, tokens.refresh_token, latest])
      expect(serialized).not.toContain(secret);

    // Revoking twice is a 404 (not idempotent): nothing to revoke any more.
    expect((await revoke(grant.id)).statusCode).toBe(404);
    expect(
      await authDb.mcpGrantEvent.count({
        where: { grantId: grant.id, action: "grant.revoked" },
      }),
    ).toBe(1);

    // The user can connect the client again afterwards.
    const again = await connectAs("owner", clientId);
    expect(again.tokens.refresh_token).toBeTruthy();
  });

  it("the refresh reuse window is real without a revocation", async () => {
    const clientId = CLIENT.control;
    const { tokens } = await connectAs("owner", clientId);
    const first = await refreshAs(tokens.refresh_token, clientId);
    expect(first.statusCode).toBe(200);
    // Replaying the just-rotated token inside the 30 s window still works.
    const replay = await refreshAs(tokens.refresh_token, clientId);
    expect(replay.statusCode).toBe(200);
  });

  it("revocation beats the refresh reuse window", async () => {
    const clientId = CLIENT.window;
    const { tokens } = await connectAs("owner", clientId);
    const rotated = await refreshAs(tokens.refresh_token, clientId);
    expect(rotated.statusCode).toBe(200);
    const grant = await activeGrant(ids.owner, clientId);

    expect((await revoke(grant.id, "owner")).statusCode).toBe(204);

    // Both the just-rotated token (inside the reuse window) and its successor.
    const replay = await refreshAs(tokens.refresh_token, clientId);
    expect(replay.statusCode).toBe(400);
    expect(replay.json().error).toBe("invalid_grant");
    const newer = await refreshAs(rotated.json().refresh_token, clientId);
    expect(newer.statusCode).toBe(400);
    expect(newer.json().error).toBe("invalid_grant");
  });

  it("owner revokes another member's grant", async () => {
    const clientId = CLIENT.owner;
    const { tokens, claims } = await connectAs("member", clientId);
    const grant = await activeGrant(ids.member, clientId);
    expect((await refreshAs(tokens.refresh_token, clientId)).statusCode).toBe(
      200,
    );

    const revoked = await revoke(grant.id, "owner");
    expect(revoked.statusCode).toBe(204);

    const row = await authDb.mcpGrant.findUniqueOrThrow({
      where: { id: grant.id },
    });
    expect(row).toMatchObject({ status: "revoked", revokedBy: ids.owner });
    const event = await authDb.mcpGrantEvent.findFirstOrThrow({
      where: { grantId: grant.id, action: "grant.revoked" },
    });
    // The event names the grant's user, the detail says who acted.
    expect(event).toMatchObject({
      userId: ids.member,
      detail: { by: "owner" },
    });
    expect(await activeGrantForToken(claims as never)).toBeNull();
    const after = await refreshAs(tokens.refresh_token, clientId);
    expect(after.statusCode).toBe(400);
    expect(after.json().error).toBe("invalid_grant");
  });

  it("editor cannot revoke another member's grant (403)", async () => {
    const clientId = CLIENT.editor;
    const { tokens, claims } = await connectAs("member", clientId);
    const grant = await activeGrant(ids.member, clientId);

    const denied = await revoke(grant.id, "editor");
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.code).toBe("FORBIDDEN");

    expect((await activeGrant(ids.member, clientId)).id).toBe(grant.id);
    expect(await activeGrantForToken(claims as never)).toMatchObject({
      id: grant.id,
    });
    expect((await refreshAs(tokens.refresh_token, clientId)).statusCode).toBe(
      200,
    );
    expect(
      await authDb.mcpGrantEvent.count({
        where: { grantId: grant.id, action: "grant.revoked" },
      }),
    ).toBe(0);
  });

  it("non-member gets 404", async () => {
    const clientId = CLIENT.outsider;
    await connectAs("member", clientId);
    const grant = await activeGrant(ids.member, clientId);

    for (const target of [grant.id, randomUUID(), "not-a-uuid"]) {
      const r = await revoke(target, "outsider");
      expect(r.statusCode).toBe(404);
      expect(r.json().error.code).toBe("NOT_FOUND");
    }
    // Members get the same 404 for an unknown id.
    expect((await revoke(randomUUID(), "owner")).statusCode).toBe(404);
    expect((await activeGrant(ids.member, clientId)).id).toBe(grant.id);
  });

  it("the gateway lookup accepts only an active grant of a current member", async () => {
    const clientId = CLIENT.lookup;
    const { claims } = await connectAs("member", clientId);
    const grant = await activeGrant(ids.member, clientId);
    const base = { sub: ids.member, azp: clientId };
    const claimsFor = (extra: Record<string, unknown>) =>
      ({ ...base, ...extra }) as never;

    expect(
      await activeGrantForToken(
        claimsFor({ [ORBIT_WORKSPACE_CLAIM]: workspaceId }),
      ),
    ).toMatchObject({ id: grant.id });
    const lastUsed = (
      await authDb.mcpGrant.findUniqueOrThrow({ where: { id: grant.id } })
    ).lastUsedAt;
    expect(lastUsed).toBeNull(); // the lookup does not write lastUsedAt

    for (const workspaceClaim of [
      undefined,
      "",
      null,
      "not-a-uuid",
      randomUUID(),
      otherWorkspaceId,
    ])
      expect(
        await activeGrantForToken(
          claimsFor({ [ORBIT_WORKSPACE_CLAIM]: workspaceClaim }),
        ),
      ).toBeNull();
    // Wrong client or user.
    expect(
      await activeGrantForToken({ ...claims, azp: CLIENT.own } as never),
    ).toBeNull();
    expect(
      await activeGrantForToken({ ...claims, sub: ids.editor } as never),
    ).toBeNull();
    expect(
      await activeGrantForToken({ ...claims, sub: "" } as never),
    ).toBeNull();

    // A pending selection is not a grant.
    const pending = await authDb.mcpGrant.create({
      data: {
        userId: ids.editor,
        clientId,
        workspaceId,
        projectIds: [projectA],
        scopes: [],
        modules: [],
        status: "pending",
      },
    });
    expect(
      await activeGrantForToken({
        sub: ids.editor,
        azp: clientId,
        [ORBIT_WORKSPACE_CLAIM]: workspaceId,
      }),
    ).toBeNull();
    await authDb.mcpGrant.delete({ where: { id: pending.id } });

    // A user who left the workspace loses the grant's effect at once.
    const membership = { workspaceId, userId: ids.member, role: "editor" };
    await authDb.workspaceMember.delete({
      where: {
        workspaceId_userId: { workspaceId, userId: ids.member },
      },
    });
    expect(await activeGrantForToken(claims as never)).toBeNull();
    // Leaving cascades to the project membership; restore both.
    await authDb.workspaceMember.create({ data: membership });
    await authDb.projectMember.create({
      data: {
        workspaceId,
        projectId: projectA,
        userId: ids.member,
        role: "editor",
      },
    });
    expect(await activeGrantForToken(claims as never)).toMatchObject({
      id: grant.id,
    });
  });

  it("listing never returns token values or other workspaces' grants", async () => {
    const clientId = CLIENT.list;
    const secrets: string[] = [];
    const mine = await connectAs("owner", clientId);
    secrets.push(mine.tokens.access_token, mine.tokens.refresh_token);
    const theirs = await connectAs("member", clientId);
    secrets.push(theirs.tokens.access_token, theirs.tokens.refresh_token);
    secrets.push(
      mine.flow.final.searchParams.get("code")!,
      theirs.flow.final.searchParams.get("code")!,
    );
    // The owner's grant for another workspace, and a stranger's grant elsewhere.
    as("owner");
    const second = await connect({
      clientId: CLIENT.two,
      selection: {
        workspaceId: otherWorkspaceId,
        projectIds: [otherProjectId],
      },
    });
    secrets.push(second.final.searchParams.get("code")!);
    const strangerGrant = await authDb.mcpGrant.create({
      data: {
        userId: ids.outsider,
        clientId: "https://client.test/not-registered.json",
        workspaceId: otherWorkspaceId,
        projectIds: [],
        allCurrentProjects: true,
        scopes: ["orbit:read"],
        modules: [],
        status: "active",
        activatedAt: new Date(),
      },
    });
    // A revoked grant is never listed.
    const gone = await authDb.mcpGrant.create({
      data: {
        userId: ids.owner,
        clientId,
        workspaceId,
        projectIds: [],
        allCurrentProjects: true,
        scopes: [],
        modules: [],
        status: "revoked",
        revokedAt: new Date(),
      },
    });

    // mine: the caller's active grants in every workspace, nobody else's.
    as("owner");
    const own = await inject({ url: "/api/mcp-grants" });
    expect(own.statusCode).toBe(200);
    const ownRows = own.json().grants as Json[];
    expect(ownRows.every((g) => g.userId === ids.owner)).toBe(true);
    // Earlier tests left more active grants of the owner; these two are mine.
    expect(ownRows.map((g) => g.clientId)).toEqual(
      expect.arrayContaining([clientId, CLIENT.two]),
    );
    expect(ownRows.map((g) => g.id)).not.toContain(gone.id);
    const row = ownRows.find((g) => g.clientId === clientId)!;
    expect(Object.keys(row).sort()).toEqual(
      [
        "allCurrentProjects",
        "clientId",
        "clientName",
        "createdAt",
        "id",
        "lastUsedAt",
        "projectIds",
        "scopes",
        "userEmail",
        "userId",
        "workspaceId",
      ].sort(),
    );
    expect(row).toMatchObject({
      workspaceId,
      projectIds: [projectA],
      allCurrentProjects: false,
      clientName: `Synthetic /revoke-list.json`,
      lastUsedAt: null,
    });
    expect(row.userEmail).toMatch(/@example\.invalid$/);
    expect(row.scopes).toEqual(expect.arrayContaining(["orbit:read"]));

    as("member");
    const memberRows = (await inject({ url: "/api/mcp-grants" })).json()
      .grants as Json[];
    expect(memberRows.every((g) => g.userId === ids.member)).toBe(true);
    expect(memberRows.map((g) => g.clientId)).toContain(clientId);

    // Workspace listing: every active grant of that workspace, owner only.
    as("owner");
    const all = await inject({
      url: `/api/workspaces/${workspaceId}/mcp-grants`,
    });
    expect(all.statusCode).toBe(200);
    const allRows = all.json().grants as Json[];
    expect(allRows.every((g) => g.workspaceId === workspaceId)).toBe(true);
    expect(
      allRows
        .filter((g) => g.clientId === clientId)
        .map((g) => g.userId)
        .sort(),
    ).toEqual([ids.owner, ids.member].sort());
    expect(allRows.map((g) => g.id)).not.toContain(gone.id);
    expect(allRows.map((g) => g.id)).not.toContain(strangerGrant.id);

    // The other workspace lists its own grants; an unregistered client falls
    // back to its id as the name.
    const others = (
      await inject({ url: `/api/workspaces/${otherWorkspaceId}/mcp-grants` })
    ).json().grants as Json[];
    expect(others.map((g) => g.id)).toContain(strangerGrant.id);
    expect(others.find((g) => g.id === strangerGrant.id)).toMatchObject({
      clientName: "https://client.test/not-registered.json",
      allCurrentProjects: true,
    });

    as("editor");
    const forbidden = await inject({
      url: `/api/workspaces/${workspaceId}/mcp-grants`,
    });
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json().error.code).toBe("FORBIDDEN");
    for (const url of [
      `/api/workspaces/${workspaceId}/mcp-grants`,
      `/api/workspaces/${randomUUID()}/mcp-grants`,
      "/api/workspaces/not-a-uuid/mcp-grants",
    ]) {
      as("outsider");
      expect((await inject({ url })).statusCode).toBe(404);
    }

    const bodies = JSON.stringify([ownRows, memberRows, allRows, others]);
    for (const secret of secrets) expect(bodies).not.toContain(secret);
    expect(bodies).not.toMatch(/token|secret|code_verifier|"code"/i);

    // The service agrees with the routes.
    await expect(
      listGrants({ userId: ids.editor }, { workspaceId }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      listGrants({ userId: ids.outsider }, { workspaceId }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      revokeGrant({ userId: ids.outsider }, strangerGrant.id),
    ).resolves.toBeUndefined();
  });

  it("the routes need a session and a browser origin", async () => {
    const id = randomUUID();
    for (const [method, url] of [
      ["GET", "/api/mcp-grants"],
      ["GET", `/api/workspaces/${workspaceId}/mcp-grants`],
      ["DELETE", `/api/mcp-grants/${id}`],
      ["PATCH", `/api/mcp-grants/${id}`],
    ] as const) {
      const r = await inject({ method, url, session: false });
      expect(r.statusCode).toBe(401);
    }
    as("owner");
    for (const method of ["DELETE", "PATCH"] as const) {
      const noOrigin = await inject({
        method,
        url: `/api/mcp-grants/${id}`,
        payload: method === "PATCH" ? { proposals: false } : undefined,
        noOrigin: true,
      });
      expect(noOrigin.statusCode).toBe(403);
      expect(noOrigin.json().error.code).toBe("ORIGIN_REQUIRED");
    }
  });
});
