import { randomBytes, randomUUID } from "node:crypto";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { authDb, closeDatabase } from "../../../packages/db/src/index.ts";
import { buildServer } from "../src/server.ts";
import { makeAuth } from "../src/auth.ts";
import { chatScoped } from "../src/modules/chat.ts";
import { createPackageProject } from "./support/package-project.ts";
import { planSpec } from "./support/marketing-plan.ts";
const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);
describe.skipIf(!enabled)("Marketing plan native routes", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  let project: Awaited<ReturnType<typeof createPackageProject>>;
  const people = {} as Record<
    "owner" | "editor" | "viewer",
    { id: string; cookie: string }
  >;
  const request = (
    role: keyof typeof people,
    method: "GET" | "POST" | "PUT",
    suffix: string,
    payload?: unknown,
  ) =>
    app.inject({
      method,
      url: `/api/projects/${project.owner.projectId}/${suffix}`,
      headers: { origin: process.env.APP_ORIGIN!, cookie: people[role].cookie },
      ...(payload === undefined ? {} : { payload: payload as any }),
    });
  const input = () =>
    chatScoped(project.owner, (tx) => planSpec(tx, project.owner));
  beforeAll(async () => {
    app = await buildServer();
    const auth = makeAuth();
    for (const role of ["owner", "editor", "viewer"] as const) {
      const email = `${randomUUID()}@example.invalid`,
        password = randomBytes(24).toString("base64url");
      const user = await auth.api.signUpEmail({
        body: { email, password, name: `Synthetic plan ${role}` },
      });
      const login = await app.inject({
        method: "POST",
        url: "/api/auth/sign-in/email",
        headers: { origin: process.env.APP_ORIGIN! },
        payload: { email, password },
      });
      expect(login.statusCode).toBe(200);
      const cookies = login.headers["set-cookie"];
      people[role] = {
        id: user.user.id,
        cookie: (Array.isArray(cookies) ? cookies : [cookies])
          .map((c) => c!.split(";")[0])
          .join("; "),
      };
    }
  });
  beforeEach(async () => {
    vi.stubEnv("ORBIT_AGENTS", "true");
    project = await createPackageProject();
    for (const role of ["owner", "editor", "viewer"] as const) {
      await authDb.workspaceMember.create({
        data: {
          workspaceId: project.owner.workspaceId,
          userId: people[role].id,
          role: "viewer",
        },
      });
      await authDb.projectMember.create({
        data: {
          workspaceId: project.owner.workspaceId,
          projectId: project.owner.projectId,
          userId: people[role].id,
          role,
        },
      });
    }
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await project.cleanup();
  });
  afterAll(async () => {
    await app.close();
    await authDb.user.deleteMany({
      where: { id: { in: Object.values(people).map((u) => u.id) } },
    });
    await closeDatabase();
  });
  it("proposes, reads, reviews and exports strategy without execution", async () => {
    const response = await request(
      "editor",
      "POST",
      "marketing-plans",
      await input(),
    );
    expect(response.statusCode, response.body).toBe(200);
    const plan = response.json();
    expect(plan).toMatchObject({
      status: "proposed",
      strategicallyReviewed: false,
      activationAvailable: false,
    });
    expect(
      (await request("viewer", "GET", `marketing-plans/${plan.id}`)).json(),
    ).toMatchObject({ id: plan.id });
    const inbox = await request("owner", "GET", "action-requests");
    expect(inbox.json().items ?? inbox.json()).toContainEqual(
      expect.objectContaining({
        id: plan.actionRequest.id,
        summary: expect.objectContaining({
          marketingPlan: expect.objectContaining({ spec: plan.spec }),
        }),
      }),
    );
    const decision = await request(
      "owner",
      "POST",
      `action-requests/${plan.actionRequest.id}/decide`,
      {
        version: plan.actionRequest.version,
        packageHash: plan.actionRequest.packageHash,
        decision: "approve",
      },
    );
    expect(decision.statusCode, decision.body).toBe(200);
    const saved = await request("owner", "GET", `marketing-plans/${plan.id}`);
    expect(saved.json()).toMatchObject({
      status: "proposed",
      strategicallyReviewed: true,
      activationAvailable: false,
    });
    const exported = await request(
      "viewer",
      "GET",
      `marketing-plans/${plan.id}/export`,
    );
    expect(exported.statusCode).toBe(200);
    expect(exported.json().history.length).toBeGreaterThan(1);
    for (const kind of ["jobs", "content", "assignments"])
      expect((await request("owner", "GET", kind)).json().items).toEqual([]);
    expect(
      (
        await request("owner", "POST", "marketing_plans", {
          ...plan,
          status: "active",
        })
      ).statusCode,
    ).toBe(403);
  });
  it("enforces current member/module roles and versioned writes", async () => {
    const spec = await input();
    expect(
      (await request("viewer", "POST", "marketing-plans", spec)).statusCode,
    ).toBe(403);
    const plan = (
      await request("owner", "POST", "marketing-plans", spec)
    ).json();
    expect(
      (
        await request("editor", "PUT", `marketing-plans/${plan.id}`, {
          version: plan.version + 1,
          spec: { ...spec, goal: "New exact goal" },
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await request(
          "editor",
          "POST",
          `action-requests/${plan.actionRequest.id}/decide`,
          {
            version: plan.actionRequest.version,
            packageHash: plan.actionRequest.packageHash,
            decision: "approve",
          },
        )
      ).statusCode,
    ).toBe(403);
    vi.stubEnv("ORBIT_MODULE_ROLES", "true");
    await authDb.projectMemberModuleRole.create({
      data: {
        workspaceId: project.owner.workspaceId,
        projectId: project.owner.projectId,
        userId: people.editor.id,
        moduleId: "marketing",
        role: "none",
      },
    });
    expect(
      (await request("editor", "GET", `marketing-plans/${plan.id}`)).statusCode,
    ).toBe(404);
    expect(
      (
        await request("editor", "PUT", `marketing-plans/${plan.id}`, {
          version: plan.version,
          spec,
        })
      ).statusCode,
    ).toBe(404);
    vi.stubEnv("ORBIT_MODULES", "true");
    await chatScoped(project.owner, (tx) =>
      tx.projectModule.create({
        data: {
          workspaceId: project.owner.workspaceId,
          projectId: project.owner.projectId,
          moduleId: "marketing",
          moduleVersion: "1.0.0",
          enabled: false,
          changedBy: project.owner.userId,
        },
      }),
    );
    expect((await request("owner", "GET", "marketing-plans")).statusCode).toBe(
      404,
    );
    expect(
      (await request("owner", "POST", "marketing-plans", spec)).statusCode,
    ).toBe(404);
  });
  it("refuses foreign IDs, unbounded input and stale profile references", async () => {
    const malformed = (cookie?: string) =>
      app.inject({
        method: "GET",
        url: "/api/projects/not-a-uuid/marketing-plans",
        headers: {
          origin: process.env.APP_ORIGIN!,
          ...(cookie ? { cookie } : {}),
        },
      });
    expect((await malformed()).statusCode).toBe(401);
    expect((await malformed(people.owner.cookie)).statusCode).toBe(400);
    expect(
      (await request("viewer", "GET", `marketing-plans/${randomUUID()}`))
        .statusCode,
    ).toBe(404);
    const spec = await input();
    expect(
      (
        await request("owner", "POST", "marketing-plans", {
          ...spec,
          profileVersion: spec.profileVersion + 1,
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await request("owner", "POST", "marketing-plans", {
          ...spec,
          horizon: {
            startAt: spec.horizon.startAt,
            endAt: "2099-01-01T00:00:00.000Z",
          },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (await request("owner", "GET", "marketing-plans")).json(),
    ).toMatchObject({ items: [] });
  });
});
