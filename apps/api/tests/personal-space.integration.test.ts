import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { authDb, closeDatabase, scoped } from "../../../packages/db/src/index.ts";
import type { Scope } from "../../../packages/schemas/src/index.ts";
import { makeAuth } from "../src/auth.ts";
import { CLIENT_IP_HEADER } from "../src/client-ip.ts";
import { moduleRegistry } from "../src/modules/registry.ts";
import { buildServer } from "../src/server.ts";
import {
  listOrganizations,
  listProjects,
  organizationDetail,
  overview,
} from "../src/platform/administration/queries.ts";
import {
  removeWorkspaceMember,
  setMemberAssistant,
  setProjectMember,
} from "../src/platform/administration/memberships.ts";
import {
  organizationAiUsage,
  saveOrganizationAiBudget,
} from "../src/platform/administration/ai-budget.ts";
import {
  ensurePersonalSpace,
  personalSpaceCleanup,
} from "../src/platform/assistant/personal-space.ts";
import { requireSpendMandate } from "../src/platform/ai/spend-mandate.ts";
import { saveSpendPolicy } from "../src/platform/ai/spend-policy.ts";
import { reserve } from "../src/platform/ai/budget.ts";
import { setModuleEnabled } from "../src/platform/modules/activation.ts";
import { grantableWorkspace } from "../src/platform/mcp-auth/grants.ts";
import { actorScope, projectMembership } from "../src/platform/tenancy/member-scope.ts";

// The personal space (ADR 0022 D-08/D-09): one per user and organization,
// reachable by its user only (no implicit org-owner or administrator
// access), absent from every business list, paid from the organization's
// per-user cap that its user cannot raise, and deleted 30 days after the
// user left the organization or at once with the user.

const enabled = Boolean(process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL);
Object.assign(process.env, {
  ORBIT_PERSONAL_ASSISTANT: "true",
  ORBIT_ADMINISTRATION: "true",
  EXECUTION_MODE: "test",
  ENABLE_EXTERNAL_WRITES: "false",
});
const USD = 1_000_000;
const DAY = 86_400_000;

type Person = { id: string; email: string; cookie?: string };

describe.skipIf(!enabled)("Personal space (ADR 0022)", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  const origin = process.env.APP_ORIGIN!;
  const password = randomBytes(24).toString("base64url");
  const users: string[] = [];
  let workspaceId: string;
  let businessId: string;
  let personalId: string;
  const p: Record<"owner" | "member" | "admin" | "leaver" | "erased", Person> = {} as never;

  const ip = () => `198.18.${randomBytes(1)[0]}.${(randomBytes(1)[0]! % 254) + 1}`;
  async function signUp(name: string) {
    const email = `${randomUUID()}@example.invalid`;
    const r = await makeAuth().api.signUpEmail({ body: { email, name, password } });
    users.push(r.user.id);
    return { id: r.user.id, email };
  }
  const cookieOf = (set: string | string[] | undefined) =>
    (Array.isArray(set) ? set : [set])
      .filter(Boolean)
      .map((c) => c!.split(";")[0])
      .join("; ");
  async function signIn(person: Person) {
    const r = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      headers: { origin, [CLIENT_IP_HEADER]: ip() },
      payload: { email: person.email, password },
    });
    expect(r.statusCode).toBe(200);
    person.cookie = cookieOf(r.headers["set-cookie"]);
  }
  const call = (method: "GET" | "POST" | "PUT", url: string, who: Person, payload?: unknown) =>
    app.inject({
      method,
      url,
      headers: { origin, [CLIENT_IP_HEADER]: ip(), cookie: who.cookie! },
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
  const scopeOf = (projectId: string, userId: string): Scope => ({
    workspaceId,
    projectId,
    userId,
    role: "owner",
  });

  beforeAll(async () => {
    app = await buildServer();
    for (const key of ["owner", "member", "admin", "leaver", "erased"] as const)
      p[key] = await signUp(`Synthetic ${key}`);
    await authDb.user.update({ where: { id: p.admin.id }, data: { role: "admin" } });
    workspaceId = (
      await authDb.workspace.create({
        data: {
          name: "Synthetic personal-space org",
          members: {
            create: [
              { userId: p.owner.id, role: "owner" },
              // A system administrator who is also an organization owner.
              { userId: p.admin.id, role: "owner" },
              { userId: p.member.id, role: "viewer" },
              { userId: p.leaver.id, role: "viewer" },
              { userId: p.erased.id, role: "viewer" },
            ],
          },
        },
      })
    ).id;
    businessId = (
      await authDb.project.create({
        data: {
          workspaceId,
          name: "Synthetic business project",
          members: { create: [{ userId: p.member.id, role: "editor" }] },
        },
      })
    ).id;
    await signIn(p.owner);
    await signIn(p.member);
    await signIn(p.admin);
  });

  afterAll(async () => {
    if (workspaceId) await authDb.workspace.delete({ where: { id: workspaceId } }).catch(() => null);
    await authDb.user.deleteMany({ where: { id: { in: users } } });
    await app?.close();
    await closeDatabase();
  });

  it("is created once under parallel first use, with only its user and no business module", async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () => ensurePersonalSpace(workspaceId, p.member.id, moduleRegistry())),
    );
    personalId = results[0]!.projectId;
    expect(new Set(results.map((r) => r.projectId)).size).toBe(1);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    const project = await authDb.project.findUniqueOrThrow({
      where: { id: personalId },
      include: { members: true },
    });
    expect(project).toMatchObject({ kind: "personal", personalUserId: p.member.id });
    expect(project.members.map((m) => [m.userId, m.role])).toEqual([[p.member.id, "owner"]]);
    const modules = await scoped(workspaceId, personalId, (tx) =>
      tx.projectModule.findMany({ where: { projectId: personalId } }),
    );
    expect(modules.length).toBe(moduleRegistry().modules.length);
    expect(modules.every((m) => !m.enabled)).toBe(true);
    await expect(
      scoped(workspaceId, personalId, (tx) =>
        setModuleEnabled(tx, scopeOf(personalId, p.member.id), moduleRegistry(), "knowledge", true),
      ),
    ).rejects.toMatchObject({ code: "PERSONAL_SPACE_NO_MODULES" });
    // A second personal space for the same user and organization is refused.
    await expect(
      authDb.project.create({
        data: { workspaceId, name: "Second", kind: "personal", personalUserId: p.member.id },
      }),
    ).rejects.toMatchObject({ code: "P2002" });
    // The kind and the personal user go together.
    await expect(
      authDb.project.create({ data: { workspaceId, name: "Orphan", kind: "personal" } }),
    ).rejects.toThrow();
  });

  it("admits only its user: no implicit access for org owners or system administrators", async () => {
    expect((await projectMembership(personalId, p.member.id))?.role).toBe("owner");
    expect(await projectMembership(personalId, p.owner.id)).toBeNull();
    expect(await projectMembership(personalId, p.admin.id)).toBeNull();
    expect(await actorScope(workspaceId, personalId, p.owner.id)).toBeNull();
    // Org owners keep their implicit access to business projects.
    expect((await projectMembership(businessId, p.owner.id))?.role).toBe("owner");
    for (const who of [p.owner, p.admin]) {
      const r = await call("GET", `/api/projects/${personalId}/members`, who);
      expect([403, 404]).toContain(r.statusCode);
    }
    expect((await call("GET", `/api/projects/${personalId}/members`, p.member)).statusCode).toBe(200);
    // A membership row someone else got does not open it either.
    await authDb.projectMember.create({
      data: { workspaceId, projectId: personalId, userId: p.owner.id, role: "owner" },
    });
    expect(await projectMembership(personalId, p.owner.id)).toBeNull();
    await authDb.projectMember.delete({
      where: { projectId_userId: { projectId: personalId, userId: p.owner.id } },
    });
    // Administration cannot add anyone to it.
    await expect(
      setProjectMember(
        { userId: p.owner.id, kind: "org_owner" },
        { workspaceId, projectId: personalId, userId: p.owner.id },
        { role: "viewer" },
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("is absent from every business list", async () => {
    for (const who of [p.owner, p.member, p.admin]) {
      const me = (await call("GET", "/api/me", who)).json();
      expect(me.projects.map((x: { id: string }) => x.id)).not.toContain(personalId);
      const projects = (await call("GET", "/api/projects", who)).json();
      expect(projects.items.map((x: { id: string }) => x.id)).not.toContain(personalId);
      const summary = await call("GET", "/api/action-requests/summary", who);
      expect(summary.statusCode).toBe(200);
      expect(JSON.stringify(summary.json())).not.toContain(personalId);
    }
    const me = (await call("GET", "/api/me", p.member)).json();
    expect(me.projects.map((x: { id: string }) => x.id)).toContain(businessId);
    expect(JSON.stringify((await listProjects({ workspaceId })).items)).not.toContain(personalId);
    const detail = await organizationDetail(workspaceId);
    expect(detail.projects.map((x) => x.id)).toEqual([businessId]);
    const orgs = await listOrganizations({ query: "Synthetic personal-space org" });
    expect(orgs.items.find((o) => o.id === workspaceId)?.projects).toBe(1);
    expect((await overview()).projects.total).toBe(
      await authDb.project.count({ where: { kind: { not: "personal" } } }),
    );
    for (const userId of [p.member.id, p.owner.id]) {
      const grantable = await grantableWorkspace(userId, workspaceId);
      expect(grantable?.projects.map((x) => x.id)).not.toContain(personalId);
    }
    const usage = await organizationAiUsage(workspaceId);
    expect(usage.projects.map((x) => x.projectId)).not.toContain(personalId);
    expect(usage.assistants.spaces).toBeGreaterThanOrEqual(1);
  });

  it("is paid only within the organization's per-user cap, which its user cannot raise", async () => {
    const scope = scopeOf(personalId, p.member.id);
    await scoped(workspaceId, personalId, async (tx) => {
      await expect(requireSpendMandate(tx, scope)).rejects.toMatchObject({ code: "POLICY_REQUIRED" });
    });
    await saveOrganizationAiBudget(p.owner.id, workspaceId, {
      monthlyMicros: null,
      assistantPerUserMonthlyMicros: 3 * USD,
    });
    const mandate = await scoped(workspaceId, personalId, (tx) => requireSpendMandate(tx, scope));
    expect(mandate.limits).toMatchObject({
      approvedPaidTests: true,
      monthlyBudgetMicros: 3 * USD,
      dailyBudgetMicros: 300_000,
      perRunBudgetMicros: 300_000,
    });
    await scoped(workspaceId, personalId, async (tx) => {
      await expect(
        saveSpendPolicy(tx, scope, { profile: "monthly", monthlyBudgetMicros: 50 * USD }),
      ).rejects.toMatchObject({ code: "PERSONAL_SPACE_SPEND_READ_ONLY", status: 403 });
    });
    const limits = mandate.limits;
    await expect(
      scoped(workspaceId, personalId, (tx) =>
        reserve(tx, scope, `assistant:${randomUUID()}`, "assistant", 400_000, limits),
      ),
    ).rejects.toMatchObject({ code: "BUDGET_NOT_APPROVED" });
    const ok = await scoped(workspaceId, personalId, (tx) =>
      reserve(tx, scope, `assistant:${randomUUID()}`, "assistant", 100_000, limits),
    );
    expect(ok).toBeTruthy();
    // A save that leaves the cap out keeps it; null clears it again.
    await saveOrganizationAiBudget(p.owner.id, workspaceId, { monthlyMicros: null });
    expect(
      (await authDb.organizationAiBudget.findFirstOrThrow({ where: { workspaceId } }))
        .assistantPerUserMonthlyMicros,
    ).toBe(BigInt(3 * USD));
    await saveOrganizationAiBudget(p.owner.id, workspaceId, {
      monthlyMicros: null,
      assistantPerUserMonthlyMicros: null,
    });
    await scoped(workspaceId, personalId, async (tx) => {
      await expect(requireSpendMandate(tx, scope)).rejects.toMatchObject({ code: "POLICY_REQUIRED" });
    });
    // Business projects keep their own authority.
    await scoped(workspaceId, businessId, async (tx) => {
      await expect(
        requireSpendMandate(tx, scopeOf(businessId, p.owner.id)),
      ).rejects.toMatchObject({ code: "POLICY_REQUIRED" });
    });
  });

  it("never sets the per-member cap by itself, and a project's own authority never pays for it (WP2 A)", async () => {
    // An organization without any AI budget row: reading the assistant's
    // status reports no cap and writes nothing.
    const fresh = (
      await authDb.workspace.create({
        data: {
          name: "Synthetic org without an AI budget",
          members: { create: [{ userId: p.owner.id, role: "owner" }, { userId: p.member.id, role: "viewer" }] },
        },
      })
    ).id;
    try {
      const status = await call("GET", `/api/assistant?workspaceId=${fresh}`, p.member);
      expect(status.statusCode).toBe(200);
      expect(status.json()).toMatchObject({ enabled: true, capMicros: null });
      const ownerView = await call("GET", `/api/assistant?workspaceId=${fresh}`, p.owner);
      expect(ownerView.json()).toMatchObject({ enabled: true, capMicros: null });
      expect(await authDb.organizationAiBudget.count({ where: { workspaceId: fresh } })).toBe(0);
      // A FamilyPlan-like business project with an active spending
      // authority: it authorizes its own calls, never the personal space.
      const business = (
        await authDb.project.create({ data: { workspaceId: fresh, name: "Synthetic FamilyPlan-like" } })
      ).id;
      const businessScope: Scope = { workspaceId: fresh, projectId: business, userId: p.owner.id, role: "owner" };
      await scoped(fresh, business, (tx) =>
        saveSpendPolicy(tx, businessScope, { profile: "monthly", monthlyBudgetMicros: 25 * USD }),
      );
      const space = await ensurePersonalSpace(fresh, p.member.id, moduleRegistry());
      const personalScope: Scope = { workspaceId: fresh, projectId: space.projectId, userId: p.member.id, role: "owner" };
      await scoped(fresh, space.projectId, async (tx) => {
        await expect(requireSpendMandate(tx, personalScope)).rejects.toMatchObject({ code: "POLICY_REQUIRED" });
        expect(await tx.budgetReservation.count({ where: { projectId: space.projectId } })).toBe(0);
      });
      expect(await authDb.organizationAiBudget.count({ where: { workspaceId: fresh } })).toBe(0);
      // A cap of 0 is a decision too: no paid turns, still nothing written.
      await saveOrganizationAiBudget(p.owner.id, fresh, { monthlyMicros: null, assistantPerUserMonthlyMicros: 0 });
      const zero = await scoped(fresh, space.projectId, (tx) => requireSpendMandate(tx, personalScope));
      expect(zero.limits).toMatchObject({ approvedPaidTests: false, monthlyBudgetMicros: 0, perRunBudgetMicros: 0 });
      await expect(
        scoped(fresh, space.projectId, (tx) =>
          reserve(tx, personalScope, `assistant:${randomUUID()}`, "chat_text", 1_000, zero.limits),
        ),
      ).rejects.toMatchObject({ code: "BUDGET_NOT_APPROVED" });
      expect((await call("GET", `/api/assistant?workspaceId=${fresh}`, p.member)).json().capMicros).toBe(0);
    } finally {
      await authDb.workspace.delete({ where: { id: fresh } }).catch(() => null);
    }
  });

  it("follows the owner's per-member switch and the organization membership", async () => {
    await setMemberAssistant({ userId: p.owner.id, kind: "org_owner" }, workspaceId, p.member.id, {
      enabled: false,
    });
    await expect(ensurePersonalSpace(workspaceId, p.member.id, moduleRegistry())).rejects.toMatchObject({
      code: "ASSISTANT_DISABLED_FOR_MEMBER",
    });
    await setMemberAssistant({ userId: p.owner.id, kind: "org_owner" }, workspaceId, p.member.id, {
      enabled: true,
    });
    await expect(
      setMemberAssistant({ userId: p.member.id, kind: "project_owner" }, workspaceId, p.member.id, {
        enabled: false,
      }),
    ).rejects.toMatchObject({ code: "WORKSPACE_OWNER_REQUIRED" });
    const outsider = await signUp("Synthetic outsider");
    await expect(ensurePersonalSpace(workspaceId, outsider.id, moduleRegistry())).rejects.toMatchObject({
      code: "WORKSPACE_FORBIDDEN",
    });
    process.env.ORBIT_PERSONAL_ASSISTANT = "false";
    try {
      await expect(ensurePersonalSpace(workspaceId, p.member.id, moduleRegistry())).rejects.toMatchObject({
        code: "ASSISTANT_DISABLED",
      });
    } finally {
      process.env.ORBIT_PERSONAL_ASSISTANT = "true";
    }
  });

  it("is kept 30 days after its user left, restored on rejoin, then deleted", async () => {
    const { projectId } = await ensurePersonalSpace(workspaceId, p.leaver.id, moduleRegistry());
    const task = (id: string) => personalSpaceCleanup.run({ workspaceId, projectId: id } as Scope);
    expect(await task(projectId)).toEqual({ status: "kept" });
    await removeWorkspaceMember({ userId: p.owner.id, kind: "org_owner" }, workspaceId, p.leaver.id);
    expect(await projectMembership(projectId, p.leaver.id)).toBeNull();
    const left = await authDb.project.findUniqueOrThrow({ where: { id: projectId } });
    expect(left.personalLeftAt).toBeInstanceOf(Date);
    expect(await task(projectId)).toEqual({ status: "grace" });
    // Rejoining within the grace period brings the space back.
    await authDb.workspaceMember.create({ data: { workspaceId, userId: p.leaver.id, role: "viewer" } });
    const again = await ensurePersonalSpace(workspaceId, p.leaver.id, moduleRegistry());
    expect(again).toMatchObject({ projectId, created: false });
    expect((await projectMembership(projectId, p.leaver.id))?.role).toBe("owner");
    expect((await authDb.project.findUniqueOrThrow({ where: { id: projectId } })).personalLeftAt).toBeNull();
    // Leaving again, past the grace period: deleted.
    await removeWorkspaceMember({ userId: p.owner.id, kind: "org_owner" }, workspaceId, p.leaver.id);
    await authDb.project.update({
      where: { id: projectId },
      data: { personalLeftAt: new Date(Date.now() - 31 * DAY) },
    });
    expect(await task(projectId)).toEqual({ status: "deleted" });
    expect(await authDb.project.findUnique({ where: { id: projectId } })).toBeNull();
    // A business project is never touched by the clean-up.
    expect(await task(businessId)).toBeUndefined();
  });

  it("is deleted at once with its user", async () => {
    const { projectId } = await ensurePersonalSpace(workspaceId, p.erased.id, moduleRegistry());
    await authDb.user.delete({ where: { id: p.erased.id } });
    expect(await authDb.project.findUnique({ where: { id: projectId } })).toBeNull();
  });
});
