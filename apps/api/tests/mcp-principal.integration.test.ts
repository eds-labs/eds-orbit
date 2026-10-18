import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  authDb,
  closeDatabase,
  scoped,
} from "../../../packages/db/src/index.ts";
import type { Scope } from "../../../packages/schemas/src/index.ts";
import {
  moduleRegistry,
  registerModules,
  registerTestModules,
} from "../src/modules/registry.ts";
import { setModuleEnabled } from "../src/platform/modules/activation.ts";
import { registeredTools } from "../src/platform/modules/contributions.ts";
import { ORBIT_WORKSPACE_CLAIM } from "../src/platform/mcp-auth/plugins.ts";
import {
  mapBounded,
  MEMBERSHIP_CHECK_CONCURRENCY,
  projectScope,
  resolvePrincipal,
  type McpPrincipal,
} from "../src/platform/mcp/principal.ts";
import {
  authorizeMcpCall,
  requiredScope,
  visibleMcpTools,
} from "../src/platform/mcp/visibility.ts";
import { tasksFixture } from "./fixtures/modules/tasks/contributions.ts";

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);
registerTestModules([tasksFixture]);
registerModules();

type Role = "owner" | "editor" | "viewer" | "nonMember";
type ModuleState =
  "enabled" | "disabled" | "roleNone" | "roleViewer" | "rolesFlagOff";
type GrantCase = "in" | "out" | "restrictedOther" | "restrictedTasks";
type ScopeCase = "read" | "readPropose";

// The fixture tools: task_digest (R0, viewers up), suggest_task (P, editors
// up), both MCP-exposed; propose_tasks is P but not exposed to MCP and
// knowledge_search is a platform assistant tool, so neither may ever appear.
// Marketing's project_status (R0, every member) is exposed too (WP-M3); it
// belongs to the marketing module, so the tasks module's state and the
// tasks module roles do not touch it, while a module restriction does.
const PROBED = [
  "project_status",
  "task_digest",
  "suggest_task",
  "propose_tasks",
  "knowledge_search",
  "no_such_tool",
];

/**
 * The permission intersection for MCP (WP-M2, 09 §4.2): tool permission ∩
 * current role in the project (incl. module roles) ∩ grant (projects, scopes,
 * modules) ∩ module activation. Every case checks the list and every call.
 */
describe.skipIf(!enabled)("MCP principal and permission intersection", () => {
  const users: string[] = [];
  const workspaces: string[] = [];
  let workspaceId = "";
  let projectId = "";
  let otherProjectId = "";
  let foreignProjectId = "";
  const ids = {} as Record<Role, string>;
  let ownerScope: Scope;

  const user = async () => {
    const row = await authDb.user.create({
      data: {
        id: randomUUID(),
        name: "Synthetic MCP principal user",
        email: `${randomUUID()}@example.invalid`,
      },
    });
    users.push(row.id);
    return row.id;
  };
  const projectMember = (
    userId: string,
    project: string,
    role: "editor" | "viewer",
  ) =>
    authDb.projectMember.create({
      data: { workspaceId, projectId: project, userId, role },
    });
  const workspaceMember = (userId: string) =>
    authDb.workspaceMember.create({
      data: { workspaceId, userId, role: "viewer" },
    });

  const grant = async (
    userId: string,
    options: {
      projectIds?: string[];
      allCurrentProjects?: boolean;
      scopes?: string[];
      modules?: string[];
      status?: string;
      expiresAt?: Date | null;
      workspace?: string;
    } = {},
  ) => {
    const clientId = `client-${randomUUID()}`;
    const row = await authDb.mcpGrant.create({
      data: {
        userId,
        clientId,
        workspaceId: options.workspace ?? workspaceId,
        projectIds: options.projectIds ?? [projectId, otherProjectId],
        allCurrentProjects: options.allCurrentProjects ?? false,
        scopes: options.scopes ?? ["orbit:read", "orbit:propose"],
        modules: options.modules ?? [],
        status: options.status ?? "active",
        expiresAt: options.expiresAt ?? null,
      },
    });
    return { grant: row, clientId };
  };
  const claims = (
    userId: string,
    clientId: string,
    scope = "openid orbit:read orbit:propose",
    workspace = workspaceId,
  ) => ({
    iss: "https://orbit.example.invalid/api/auth",
    aud: ["https://orbit.example.invalid/mcp"],
    sub: userId,
    azp: clientId,
    scope,
    [ORBIT_WORKSPACE_CLAIM]: workspace,
  });
  const refusal = async (promise: Promise<unknown>) => {
    try {
      await promise;
      return null;
    } catch (error) {
      const { code, status } = error as { code?: string; status?: number };
      return { code, status };
    }
  };

  beforeAll(async () => {
    ids.owner = await user();
    const workspace = await authDb.workspace.create({
      data: {
        name: "Synthetic MCP principal",
        members: { create: { userId: ids.owner, role: "owner" } },
      },
    });
    workspaceId = workspace.id;
    workspaces.push(workspaceId);
    const project = await authDb.project.create({
      data: { workspaceId, name: "B project", timezone: "Europe/Berlin" },
    });
    projectId = project.id;
    const other = await authDb.project.create({
      data: { workspaceId, name: "A project", timezone: "Europe/Berlin" },
    });
    otherProjectId = other.id;
    ownerScope = {
      workspaceId,
      projectId,
      userId: ids.owner,
      role: "owner",
    };
    ids.editor = await user();
    ids.viewer = await user();
    ids.nonMember = await user();
    for (const role of ["editor", "viewer", "nonMember"] as const) {
      await workspaceMember(ids[role]);
      // Everyone is an editor in the other project, so a grant without the
      // matrix project still resolves to a principal.
      await projectMember(ids[role], otherProjectId, "editor");
    }
    await projectMember(ids.editor, projectId, "editor");
    await projectMember(ids.viewer, projectId, "viewer");

    // A project of another workspace the users have nothing to do with.
    const foreignOwner = await user();
    const foreign = await authDb.workspace.create({
      data: {
        name: "Synthetic MCP foreign",
        members: { create: { userId: foreignOwner, role: "owner" } },
      },
    });
    workspaces.push(foreign.id);
    foreignProjectId = (
      await authDb.project.create({
        data: {
          workspaceId: foreign.id,
          name: "Foreign project",
          timezone: "Europe/Berlin",
        },
      })
    ).id;
  });
  afterAll(async () => {
    delete process.env.ORBIT_MODULES;
    delete process.env.ORBIT_MODULE_ROLES;
    for (const id of workspaces)
      await authDb.workspace.delete({ where: { id } });
    await authDb.user.deleteMany({ where: { id: { in: users } } });
    await closeDatabase();
  });

  it("maps tool risk to the required OAuth scope", () => {
    const byName = new Map(registeredTools().map((t) => [t.name, t]));
    expect(requiredScope(byName.get("task_digest")!)).toBe("orbit:read");
    expect(requiredScope(byName.get("suggest_task")!)).toBe("orbit:propose");
    expect(
      requiredScope({ ...byName.get("task_digest")!, risk: "W0_internal" }),
    ).toBe("orbit:write");
  });

  describe("intersection matrix", () => {
    const setModuleState = async (state: ModuleState, on: boolean) => {
      if (state === "disabled") {
        process.env.ORBIT_MODULES = "true";
        await scoped(workspaceId, projectId, (tx) =>
          setModuleEnabled(tx, ownerScope, moduleRegistry(), "tasks", !on),
        );
        if (!on) delete process.env.ORBIT_MODULES;
      }
      if (
        state === "roleNone" ||
        state === "roleViewer" ||
        state === "rolesFlagOff"
      ) {
        if (on && state !== "rolesFlagOff")
          process.env.ORBIT_MODULE_ROLES = "true";
        else delete process.env.ORBIT_MODULE_ROLES;
        const role = state === "roleViewer" ? "viewer" : "none";
        for (const member of ["editor", "viewer"] as const)
          if (on)
            await authDb.projectMemberModuleRole.create({
              data: {
                workspaceId,
                projectId,
                userId: ids[member],
                moduleId: "tasks",
                role,
              },
            });
          else
            await authDb.projectMemberModuleRole.deleteMany({
              where: { projectId, userId: ids[member] },
            });
      }
    };

    // What the user may list in the matrix project; null when the project
    // itself must be refused (404).
    const expected = (
      role: Role,
      state: ModuleState,
      grantCase: GrantCase,
      scopeCase: ScopeCase,
    ): string[] | null => {
      if (role === "nonMember" || grantCase === "out") return null;
      const marketing =
        grantCase === "restrictedTasks" ? [] : ["project_status"];
      if (state === "disabled" || grantCase === "restrictedOther")
        return marketing;
      if (state === "roleNone" && role !== "owner") return marketing;
      const effective =
        state === "roleViewer" && role !== "owner" ? "viewer" : role;
      const tools: string[] = [...marketing];
      if (scopeCase === "readPropose" && effective !== "viewer")
        tools.push("suggest_task");
      tools.push("task_digest");
      return tools;
    };

    const states: ModuleState[] = [
      "enabled",
      "disabled",
      "roleNone",
      "roleViewer",
      "rolesFlagOff",
    ];
    for (const state of states)
      describe(`module ${state}`, () => {
        beforeAll(() => setModuleState(state, true));
        afterAll(() => setModuleState(state, false));
        for (const role of ["owner", "editor", "viewer", "nonMember"] as const)
          for (const grantCase of [
            "in",
            "out",
            "restrictedOther",
            "restrictedTasks",
          ] as const)
            for (const scopeCase of ["read", "readPropose"] as const)
              it(`${role} / grant ${grantCase} / ${scopeCase}`, async () => {
                const { clientId } = await grant(ids[role], {
                  projectIds:
                    grantCase === "out"
                      ? [otherProjectId]
                      : [projectId, otherProjectId],
                  modules:
                    grantCase === "restrictedOther"
                      ? ["marketing"]
                      : grantCase === "restrictedTasks"
                        ? ["tasks"]
                        : [],
                });
                const token = claims(
                  ids[role],
                  clientId,
                  scopeCase === "read"
                    ? "openid orbit:read"
                    : "openid orbit:read orbit:propose",
                );
                const principal = await resolvePrincipal(token);
                expect(principal).not.toBeNull();
                const want = expected(role, state, grantCase, scopeCase);
                if (want === null) {
                  expect(principal!.projectIds).not.toContain(projectId);
                  expect(
                    await refusal(visibleMcpTools(principal!, projectId)),
                  ).toEqual({ code: "NOT_FOUND", status: 404 });
                } else {
                  expect(principal!.projectIds).toContain(projectId);
                  expect(
                    (await visibleMcpTools(principal!, projectId)).map(
                      (t) => t.name,
                    ),
                  ).toEqual(want);
                }
                for (const name of PROBED) {
                  const outcome = await refusal(
                    authorizeMcpCall(principal!, name, projectId),
                  );
                  if (want === null)
                    expect(outcome, name).toEqual({
                      code: "NOT_FOUND",
                      status: 404,
                    });
                  else if (want.includes(name))
                    expect(outcome, name).toBeNull();
                  else
                    expect(outcome, name).toEqual({
                      code: "MCP_TOOL_NOT_ALLOWED",
                      status: 403,
                    });
                }
              });
      });
  });

  it("returns the project's scope with the member's current role", async () => {
    const { clientId } = await grant(ids.viewer);
    const principal = (await resolvePrincipal(claims(ids.viewer, clientId)))!;
    expect(principal).toMatchObject({
      userId: ids.viewer,
      clientId,
      workspaceId,
    });
    const scope = await projectScope(principal, projectId);
    expect(scope).toEqual({
      workspaceId,
      projectId,
      userId: ids.viewer,
      role: "viewer",
    });
    const call = await authorizeMcpCall(principal, "task_digest", projectId);
    expect(call.tool.name).toBe("task_digest");
    expect(call.scope).toEqual(scope);
  });

  describe("token scope ∩ grant scopes", () => {
    it("drops a scope the grant lacks", async () => {
      const { clientId } = await grant(ids.editor, { scopes: ["orbit:read"] });
      const principal = (await resolvePrincipal(
        claims(ids.editor, clientId, "orbit:read orbit:propose orbit:write"),
      ))!;
      expect([...principal.scopes].sort()).toEqual(["orbit:read"]);
      expect(
        (await visibleMcpTools(principal, projectId)).map((t) => t.name),
      ).toEqual(["project_status", "task_digest"]);
      expect(
        await refusal(authorizeMcpCall(principal, "suggest_task", projectId)),
      ).toEqual({ code: "MCP_TOOL_NOT_ALLOWED", status: 403 });
    });

    it("drops a scope the token lacks", async () => {
      const { clientId } = await grant(ids.editor, {
        scopes: ["orbit:read", "orbit:propose", "orbit:write"],
      });
      const principal = (await resolvePrincipal(
        claims(ids.editor, clientId, "orbit:propose"),
      ))!;
      expect([...principal.scopes]).toEqual(["orbit:propose"]);
      expect(
        (await visibleMcpTools(principal, projectId)).map((t) => t.name),
      ).toEqual(["suggest_task"]);
      expect(
        await refusal(authorizeMcpCall(principal, "task_digest", projectId)),
      ).toEqual({ code: "MCP_TOOL_NOT_ALLOWED", status: 403 });
    });

    it("resolves nothing without an Orbit scope in both", async () => {
      const { clientId } = await grant(ids.editor, { scopes: ["orbit:read"] });
      expect(
        await resolvePrincipal(claims(ids.editor, clientId, "orbit:propose")),
      ).toBeNull();
      expect(
        await resolvePrincipal(claims(ids.editor, clientId, "openid")),
      ).toBeNull();
      const { scope: _scope, ...withoutScope } = claims(ids.editor, clientId);
      expect(await resolvePrincipal(withoutScope)).toBeNull();
    });
  });

  // Review Focus "foreign aud and issuer are refused", principal level: the
  // token verifier is Task 3; here, claims without an active grant resolve to nothing.
  describe("claims without an active grant", () => {
    it("resolve to nothing for an unknown client, user or workspace", async () => {
      const { clientId } = await grant(ids.editor);
      expect(
        await resolvePrincipal(claims(ids.editor, `client-${randomUUID()}`)),
      ).toBeNull();
      expect(await resolvePrincipal(claims(ids.viewer, clientId))).toBeNull();
      expect(
        await resolvePrincipal(
          claims(ids.editor, clientId, undefined, randomUUID()),
        ),
      ).toBeNull();
      const { [ORBIT_WORKSPACE_CLAIM]: _w, ...noWorkspace } = claims(
        ids.editor,
        clientId,
      );
      expect(await resolvePrincipal(noWorkspace)).toBeNull();
      expect(
        await resolvePrincipal({
          ...claims(ids.editor, clientId),
          sub: 42 as unknown as string,
        }),
      ).toBeNull();
    });

    it("refuses a revoked grant", async () => {
      const { clientId } = await grant(ids.editor, { status: "revoked" });
      expect(await resolvePrincipal(claims(ids.editor, clientId))).toBeNull();
    });

    it("refuses a pending grant", async () => {
      const { clientId } = await grant(ids.editor, { status: "pending" });
      expect(await resolvePrincipal(claims(ids.editor, clientId))).toBeNull();
    });

    it("refuses an expired grant and accepts one that still runs", async () => {
      const expired = await grant(ids.editor, {
        expiresAt: new Date(Date.now() - 1000),
      });
      expect(
        await resolvePrincipal(claims(ids.editor, expired.clientId)),
      ).toBeNull();
      const running = await grant(ids.editor, {
        expiresAt: new Date(Date.now() + 60_000),
      });
      expect(
        await resolvePrincipal(claims(ids.editor, running.clientId)),
      ).not.toBeNull();
    });

    it("refuses a grant whose user left the workspace", async () => {
      const leaver = await user();
      await workspaceMember(leaver);
      await projectMember(leaver, projectId, "editor");
      const { clientId } = await grant(leaver);
      expect(await resolvePrincipal(claims(leaver, clientId))).not.toBeNull();
      await authDb.projectMember.deleteMany({ where: { userId: leaver } });
      await authDb.workspaceMember.deleteMany({ where: { userId: leaver } });
      expect(await resolvePrincipal(claims(leaver, clientId))).toBeNull();
    });
  });

  it("lost membership hides the project", async () => {
    const member = await user();
    await workspaceMember(member);
    await projectMember(member, projectId, "editor");
    await projectMember(member, otherProjectId, "viewer");
    const { clientId } = await grant(member);
    const principal = (await resolvePrincipal(claims(member, clientId)))!;
    expect([...principal.projectIds].sort()).toEqual(
      [projectId, otherProjectId].sort(),
    );
    expect(
      (await visibleMcpTools(principal, projectId)).map((t) => t.name),
    ).toEqual(["project_status", "suggest_task", "task_digest"]);

    await authDb.projectMember.delete({
      where: { projectId_userId: { projectId, userId: member } },
    });
    // The principal from before is checked again on every call.
    expect(await refusal(visibleMcpTools(principal, projectId))).toEqual({
      code: "NOT_FOUND",
      status: 404,
    });
    expect(
      await refusal(authorizeMcpCall(principal, "task_digest", projectId)),
    ).toEqual({ code: "NOT_FOUND", status: 404 });
    expect(await refusal(projectScope(principal, projectId))).toEqual({
      code: "NOT_FOUND",
      status: 404,
    });
    // A fresh principal no longer lists it; the other project stays.
    const fresh = (await resolvePrincipal(claims(member, clientId)))!;
    expect(fresh.projectIds).toEqual([otherProjectId]);
    expect(
      (await visibleMcpTools(fresh, otherProjectId)).map((t) => t.name),
    ).toEqual(["project_status", "task_digest"]);

    // Without any project left, nothing usable remains.
    await authDb.projectMember.delete({
      where: {
        projectId_userId: { projectId: otherProjectId, userId: member },
      },
    });
    expect(await resolvePrincipal(claims(member, clientId))).toBeNull();
  });

  it("never reveals whether a project outside the grant exists", async () => {
    const { clientId } = await grant(ids.owner, { projectIds: [projectId] });
    const principal = (await resolvePrincipal(claims(ids.owner, clientId)))!;
    expect(principal.projectIds).toEqual([projectId]);
    for (const outside of [
      otherProjectId,
      foreignProjectId,
      randomUUID(),
      "not-a-uuid",
    ]) {
      const want = { code: "NOT_FOUND", status: 404 };
      expect(await refusal(projectScope(principal, outside))).toEqual(want);
      expect(await refusal(visibleMcpTools(principal, outside))).toEqual(want);
      expect(
        await refusal(authorizeMcpCall(principal, "task_digest", outside)),
      ).toEqual(want);
    }
  });

  it("drops a granted project of another workspace", async () => {
    const { clientId } = await grant(ids.owner, {
      projectIds: [projectId, foreignProjectId],
    });
    const principal = (await resolvePrincipal(claims(ids.owner, clientId)))!;
    expect(principal.projectIds).toEqual([projectId]);
  });

  describe("all current projects", () => {
    it("resolve to the user's current projects in the workspace at call time", async () => {
      const member = await user();
      await workspaceMember(member);
      await projectMember(member, otherProjectId, "viewer");
      const { clientId } = await grant(member, {
        projectIds: [],
        allCurrentProjects: true,
      });
      const before = (await resolvePrincipal(claims(member, clientId)))!;
      expect(before.projectIds).toEqual([otherProjectId]);
      expect(await refusal(visibleMcpTools(before, projectId))).toEqual({
        code: "NOT_FOUND",
        status: 404,
      });

      // Added to a project after the grant: covered on the next resolution.
      await projectMember(member, projectId, "editor");
      const after = (await resolvePrincipal(claims(member, clientId)))!;
      expect([...after.projectIds].sort()).toEqual(
        [projectId, otherProjectId].sort(),
      );
      expect(
        (await visibleMcpTools(after, projectId)).map((t) => t.name),
      ).toEqual(["project_status", "suggest_task", "task_digest"]);
      expect(after.projectIds).not.toContain(foreignProjectId);
    });

    it("cover every project of the workspace for its owner", async () => {
      const late = await authDb.project.create({
        data: { workspaceId, name: "C project", timezone: "Europe/Berlin" },
      });
      const { clientId } = await grant(ids.owner, {
        projectIds: [],
        allCurrentProjects: true,
      });
      const principal = (await resolvePrincipal(claims(ids.owner, clientId)))!;
      expect([...principal.projectIds].sort()).toEqual(
        [projectId, otherProjectId, late.id].sort(),
      );
      expect(principal.projectIds).not.toContain(foreignProjectId);
    });
  });

  it("lists in name order, not registration order", async () => {
    const order = registeredTools()
      .map((t) => t.name)
      .filter((name) => name === "task_digest" || name === "suggest_task");
    expect(order).toEqual(["task_digest", "suggest_task"]);
    const { clientId } = await grant(ids.owner);
    const principal = (await resolvePrincipal(claims(ids.owner, clientId)))!;
    expect(
      (await visibleMcpTools(principal, projectId)).map((t) => t.name),
    ).toEqual(["project_status", "suggest_task", "task_digest"]);
  });

  it("checks many granted projects a few at a time and keeps grant order", async () => {
    const member = await user();
    await workspaceMember(member);
    const many: string[] = [];
    for (let i = 0; i < 9; i++)
      many.push(
        (
          await authDb.project.create({
            data: {
              workspaceId,
              name: `Z bulk ${i}`,
              timezone: "Europe/Berlin",
            },
          })
        ).id,
      );
    // A member of every other one only.
    const kept = many.filter((_, i) => i % 2 === 0);
    for (const id of kept) await projectMember(member, id, "viewer");
    const { clientId } = await grant(member, { projectIds: many });
    const principal = (await resolvePrincipal(claims(member, clientId)))!;
    expect(principal.projectIds).toEqual(kept);
  });

  it("keeps the principal's fields minimal and typed", async () => {
    const { grant: row, clientId } = await grant(ids.editor, {
      modules: ["tasks"],
    });
    const principal: McpPrincipal = (await resolvePrincipal(
      claims(ids.editor, clientId),
    ))!;
    expect(principal.grantId).toBe(row.id);
    expect(principal.modules).toEqual(["tasks"]);
    expect([...principal.scopes].sort()).toEqual([
      "orbit:propose",
      "orbit:read",
    ]);
  });
});

describe("bounded membership checks", () => {
  it("runs at most the limit at once and keeps input order", async () => {
    let inFlight = 0;
    let peak = 0;
    const items = Array.from({ length: 23 }, (_, i) => i);
    const results = await mapBounded(
      items,
      MEMBERSHIP_CHECK_CONCURRENCY,
      async (i) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, (i * 7) % 5));
        inFlight--;
        return i * 2;
      },
    );
    expect(MEMBERSHIP_CHECK_CONCURRENCY).toBe(4);
    expect(peak).toBe(MEMBERSHIP_CHECK_CONCURRENCY);
    expect(results).toEqual(items.map((i) => i * 2));
    expect(await mapBounded([], 4, async () => 1)).toEqual([]);
    expect(await mapBounded([1, 2], 0, async (i) => i)).toEqual([1, 2]);
  });

  it("propagates a failing check", async () => {
    await expect(
      mapBounded([1, 2, 3], 2, async (i) => {
        if (i === 2) throw new Error("check failed");
        return i;
      }),
    ).rejects.toThrow("check failed");
  });
});
