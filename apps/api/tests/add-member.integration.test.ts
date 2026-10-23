import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { buildServer } from "../src/server.ts";
import { makeAuth } from "../src/auth.ts";
import {
  authDb,
  closeDatabase,
  scoped,
} from "../../../packages/db/src/index.ts";

const enabled = Boolean(process.env.TEST_DATABASE_URL);
// New people are invited (ADR 0012); nothing is mailed in test mode.
process.env.ORBIT_ADMINISTRATION = "true";
describe.skipIf(!enabled)("Adding project members (F-01, ADR 0012)", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  let workspaceId: string, otherWorkspaceId: string, projectId: string;
  const origin = process.env.APP_ORIGIN!;
  const password = randomBytes(24).toString("base64url");
  const users: string[] = [];
  const people: Record<
    "workspaceOwner" | "projectOwner" | "peerOwner" | "colleague" | "outsider",
    { id: string; email: string; cookie?: string }
  > = {} as any;

  const email = () => `${randomUUID()}@example.invalid`;
  async function signUp(name: string) {
    const address = email();
    const result = await makeAuth().api.signUpEmail({
      body: { email: address, name, password },
    });
    users.push(result.user.id);
    return { id: result.user.id, email: address };
  }
  async function signIn(address: string) {
    const r = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      headers: { origin },
      payload: { email: address, password },
    });
    expect(r.statusCode).toBe(200);
    const cookies = r.headers["set-cookie"];
    return (Array.isArray(cookies) ? cookies : [cookies])
      .map((c) => c!.split(";")[0])
      .join("; ");
  }
  const addMember = (
    who: "workspaceOwner" | "projectOwner",
    payload: { email: string; role: string },
  ) =>
    app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/actions/add-member`,
      headers: { origin, cookie: people[who].cookie! },
      payload,
    });
  const projectRole = async (userId: string) =>
    (
      await authDb.projectMember.findUnique({
        where: { projectId_userId: { projectId, userId } },
      })
    )?.role;
  const audits = (resourceId: string, action = "project_member.add") =>
    scoped(workspaceId, projectId, (tx) =>
      tx.auditEvent.findMany({
        where: { projectId, action, resourceId },
      }),
    );
  const invitationsFor = (address: string) =>
    authDb.invitation.findMany({
      where: { email: address.toLowerCase(), workspaceId },
      include: { projects: true },
    });

  beforeAll(async () => {
    app = await buildServer();
    const workspaceOwner = await signUp("Synthetic workspace owner"),
      projectOwner = await signUp("Synthetic project owner"),
      peerOwner = await signUp("Synthetic peer owner"),
      colleague = await signUp("Synthetic workspace colleague"),
      outsider = await signUp("Synthetic outsider");
    workspaceId = (
      await authDb.workspace.create({
        data: {
          name: "Synthetic member management",
          members: {
            create: [
              { userId: workspaceOwner.id, role: "owner" },
              { userId: projectOwner.id, role: "viewer" },
              { userId: peerOwner.id, role: "viewer" },
              { userId: colleague.id, role: "viewer" },
            ],
          },
        },
      })
    ).id;
    otherWorkspaceId = (
      await authDb.workspace.create({
        data: {
          name: "Synthetic other workspace",
          members: { create: { userId: outsider.id, role: "owner" } },
        },
      })
    ).id;
    projectId = (
      await authDb.project.create({
        data: {
          workspaceId,
          name: "Synthetic member project",
          members: {
            create: [
              { userId: projectOwner.id, role: "owner" },
              { userId: peerOwner.id, role: "owner" },
            ],
          },
        },
      })
    ).id;
    // Only the two acting owners sign in: sign-in is rate limited.
    Object.assign(people, { peerOwner, colleague, outsider });
    people.workspaceOwner = {
      ...workspaceOwner,
      cookie: await signIn(workspaceOwner.email),
    };
    people.projectOwner = {
      ...projectOwner,
      cookie: await signIn(projectOwner.email),
    };
  });
  afterAll(async () => {
    await authDb.workspace.deleteMany({
      where: { id: { in: [workspaceId, otherWorkspaceId] } },
    });
    await authDb.user.deleteMany({ where: { id: { in: users } } });
    await app?.close();
    await closeDatabase();
  });

  it("refuses owner grants by a project owner who is not workspace owner", async () => {
    const r = await addMember("projectOwner", {
      email: people.colleague.email,
      role: "owner",
    });
    expect(r.statusCode).toBe(403);
    expect(r.json().error.code).toBe("WORKSPACE_OWNER_REQUIRED");
    expect(await projectRole(people.colleague.id)).toBeUndefined();
  });

  it("refuses an owner grant before inviting anyone", async () => {
    const address = email();
    const r = await addMember("projectOwner", {
      email: address,
      role: "owner",
    });
    expect(r.statusCode).toBe(403);
    expect(await invitationsFor(address)).toEqual([]);
    expect(
      await authDb.user.findUnique({ where: { email: address } }),
    ).toBeNull();
  });

  it("invites, never attaches, an existing user from another workspace", async () => {
    const r = await addMember("projectOwner", {
      email: people.outsider.email,
      role: "viewer",
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ status: "invited", delivery: "link" });
    expect(await projectRole(people.outsider.id)).toBeUndefined();
    expect(
      await authDb.workspaceMember.findUnique({
        where: {
          workspaceId_userId: { workspaceId, userId: people.outsider.id },
        },
      }),
    ).toBeNull();
    const [invitation] = await invitationsFor(people.outsider.email);
    expect(invitation).toMatchObject({ workspaceRole: "viewer" });
    expect(invitation!.projects).toMatchObject([{ projectId, role: "viewer" }]);
  });

  it("refuses changing another owner's role unless workspace owner", async () => {
    const r = await addMember("projectOwner", {
      email: people.peerOwner.email,
      role: "viewer",
    });
    expect(r.statusCode).toBe(403);
    expect(r.json().error.code).toBe("WORKSPACE_OWNER_REQUIRED");
    expect(await projectRole(people.peerOwner.id)).toBe("owner");
  });

  it("lets a project owner add a workspace member as editor and audits it", async () => {
    const r = await addMember("projectOwner", {
      email: people.colleague.email,
      role: "editor",
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ status: "added" });
    expect(await projectRole(people.colleague.id)).toBe("editor");
    const rows = await audits(people.colleague.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      workspaceId,
      projectId,
      actorId: people.projectOwner.id,
      metadata: { role: "editor" },
    });
    // The audit trail identifies people by id only, never by address.
    expect(JSON.stringify(rows[0]!.metadata)).not.toContain("@");
  });

  it("invites a new address instead of creating an account with a password", async () => {
    const address = email();
    const r = await addMember("projectOwner", {
      email: address,
      role: "viewer",
    });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body).toMatchObject({ status: "invited", delivery: "link" });
    // The link carries the token in its fragment only.
    expect(body.link).toMatch(/\/invite#[A-Za-z0-9_-]{40,}$/);
    expect(
      await authDb.user.findUnique({ where: { email: address } }),
    ).toBeNull();
    const [invitation] = await invitationsFor(address);
    expect(invitation!.tokenHash).not.toContain(body.link.split("#")[1]);
    expect(
      await audits(invitation!.id, "project_member.invite"),
    ).toHaveLength(1);
  });

  it("refuses the old password field", async () => {
    const r = await addMember("workspaceOwner", {
      email: email(),
      role: "viewer",
      password,
    } as never);
    expect(r.statusCode).toBe(400);
  });

  it("lets the workspace owner invite an outside user as project owner", async () => {
    const r = await addMember("workspaceOwner", {
      email: people.outsider.email,
      role: "owner",
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ status: "invited" });
    // The newer invitation replaces the project owner's open one.
    const open = (await invitationsFor(people.outsider.email)).filter(
      (i) => !i.revokedAt,
    );
    expect(open).toHaveLength(1);
    expect(open[0]!.projects).toMatchObject([{ projectId, role: "owner" }]);
  });
});
