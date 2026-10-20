import { randomBytes, randomUUID } from "node:crypto";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import {
  authDb,
  closeDatabase,
  scoped,
} from "../../../packages/db/src/index.ts";
import type { Scope } from "../../../packages/schemas/src/index.ts";
import { makeAuth } from "../src/auth.ts";
import { CLIENT_IP_HEADER } from "../src/client-ip.ts";
import { buildServer } from "../src/server.ts";
import { create } from "../src/shared.ts";
import { moduleRegistry } from "../src/modules/registry.ts";
import { setModuleEnabled } from "../src/platform/modules/activation.ts";
import { budgetMonthStart } from "../src/platform/ai/budget.ts";
import type { AttentionResponse } from "../src/platform/attention/types.ts";
import {
  closeWorkerHeartbeat,
  workerBeat,
  workerSilent,
} from "./worker-heartbeat-helpers.ts";

const enabled = Boolean(
  process.env.TEST_DATABASE_URL &&
  process.env.TEST_AUTH_DATABASE_URL &&
  process.env.REDIS_URL,
);

const HOUR = 3_600_000;

/**
 * The knowledge module's and the platform's attention items and the
 * response's status block (UI restructure §4.1, §4.2): source freshness,
 * conflicts, failed imports, the worker, unclear AI cost, open action
 * requests, the marketing mode and the month's AI spend.
 */
describe.skipIf(!enabled)("knowledge and platform attention", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  let owner: Scope;
  const ids = { owner: "", editor: "", viewer: "" };
  const cookies = { owner: "", editor: "", viewer: "" };
  const users: string[] = [];
  const workspaces: string[] = [];
  const origin = process.env.APP_ORIGIN!;
  const ip = () =>
    `198.18.${randomBytes(1)[0]}.${(randomBytes(1)[0]! % 254) + 1}`;
  const run = <T>(fn: Parameters<typeof scoped<T>>[2]) =>
    scoped(owner.workspaceId, owner.projectId, fn);
  const attention = async (who: keyof typeof cookies = "owner") => {
    const response = await app.inject({
      method: "GET",
      url: `/api/projects/${owner.projectId}/attention`,
      headers: { origin, cookie: cookies[who], [CLIENT_IP_HEADER]: ip() },
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json() as AttentionResponse;
  };
  const itemsOf = async (
    moduleId: string,
    who: keyof typeof cookies = "owner",
  ) => (await attention(who)).items.filter((i) => i.moduleId === moduleId);
  const ago = (hours: number) =>
    new Date(Date.now() - hours * HOUR).toISOString();
  const source = (fields: Record<string, unknown>) =>
    run((tx) =>
      create(tx, owner, "sources", {
        type: "website",
        maxAgeHours: 168,
        ...fields,
      }),
    );
  const reservation = (
    state: string,
    amountMicros: bigint,
    extra: { settledMicros?: bigint; createdAt?: Date } = {},
  ) =>
    run((tx) =>
      tx.budgetReservation.create({
        data: {
          workspaceId: owner.workspaceId,
          projectId: owner.projectId,
          key: `${owner.projectId}:synthetic:${randomUUID()}`,
          category: "model",
          amountMicros,
          state,
          ...extra,
        },
      }),
    );
  const policy = (fields: Record<string, unknown> = {}) =>
    run((tx) =>
      create(tx, owner, "policies", {
        mode: "assisted",
        monthlyBudgetMicros: 20_000_000,
        active: true,
        ...fields,
      }),
    );
  /** The project's mode, as the policy activation sets it. */
  const projectMode = (mode: string) =>
    run((tx) =>
      tx.project.update({ where: { id: owner.projectId }, data: { mode } }),
    );
  const actionRequest = (fields: Record<string, unknown> = {}) =>
    run((tx) =>
      create(tx, owner, "action_requests", {
        actionType: "image.generate",
        riskClass: "C2",
        approvalMode: "approval_required",
        requestedBy: { kind: "user", userId: owner.userId },
        payload: {},
        packageHash: "a".repeat(64),
        costCeilingMicros: 1,
        status: "pending",
        expiresAt: new Date(Date.now() + HOUR).toISOString(),
        ...fields,
      }),
    );

  beforeAll(async () => {
    app = await buildServer();
    const accounts: Record<string, { email: string; password: string }> = {};
    for (const who of ["owner", "editor", "viewer"] as const) {
      const email = `${randomUUID()}@example.invalid`;
      const password = randomBytes(24).toString("base64url");
      const created = await makeAuth().api.signUpEmail({
        body: { email, name: `Synthetic ${who}`, password },
      });
      ids[who] = created.user.id;
      users.push(created.user.id);
      accounts[who] = { email, password };
    }
    const workspace = await authDb.workspace.create({
      data: {
        name: "Synthetic knowledge attention",
        members: {
          create: [
            { userId: ids.owner, role: "owner" },
            { userId: ids.editor, role: "viewer" },
            { userId: ids.viewer, role: "viewer" },
          ],
        },
      },
    });
    workspaces.push(workspace.id);
    const project = await authDb.project.create({
      data: {
        workspaceId: workspace.id,
        name: "Synthetic knowledge attention",
        // The AI month is the UTC calendar month whatever the project's zone.
        timezone: "Pacific/Kiritimati",
      },
    });
    await authDb.projectMember.createMany({
      data: [
        {
          workspaceId: workspace.id,
          projectId: project.id,
          userId: ids.editor,
          role: "editor",
        },
        {
          workspaceId: workspace.id,
          projectId: project.id,
          userId: ids.viewer,
          role: "viewer",
        },
      ],
    });
    owner = {
      workspaceId: workspace.id,
      projectId: project.id,
      userId: ids.owner,
      role: "owner",
    };
    for (const who of ["owner", "editor", "viewer"] as const) {
      const response = await app.inject({
        method: "POST",
        url: "/api/auth/sign-in/email",
        headers: { origin, [CLIENT_IP_HEADER]: ip() },
        payload: accounts[who],
      });
      expect(response.statusCode).toBe(200);
      const set = response.headers["set-cookie"];
      cookies[who] = (Array.isArray(set) ? set : [set])
        .map((v) => v!.split(";")[0])
        .join("; ");
    }
  });
  beforeEach(() => workerBeat());
  afterEach(async () => {
    delete process.env.ORBIT_MODULES;
    delete process.env.ORBIT_MODULE_ROLES;
    await authDb.projectMemberModuleRole.deleteMany({
      where: { projectId: owner.projectId },
    });
    await run(async (tx) => {
      await tx.budgetReservation.deleteMany({
        where: { projectId: owner.projectId },
      });
      await tx.entity.deleteMany({
        where: {
          kind: {
            in: ["sources", "facts", "jobs", "policies", "action_requests"],
          },
        },
      });
    });
  });
  afterAll(async () => {
    await workerBeat();
    closeWorkerHeartbeat();
    await authDb.workspace.deleteMany({ where: { id: { in: workspaces } } });
    await authDb.user.deleteMany({ where: { id: { in: users } } });
    await app?.close();
    await closeDatabase();
  });

  it("expiring within 48 h is a warning with dueAt", async () => {
    const synced = ago(7 * 24 - 1);
    const expiring = await source({
      name: "Docs",
      lastSuccessfulSyncAt: synced,
    });
    await source({ name: "Fresh", lastSuccessfulSyncAt: ago(24) });
    const items = await itemsOf("knowledge");
    expect(items).toEqual([
      {
        id: `knowledge:source-expiring:${expiring.id}`,
        moduleId: "knowledge",
        kind: "knowledge_source_expiring",
        severity: "warning",
        dueAt: new Date(Date.parse(synced) + 168 * HOUR).toISOString(),
        params: { name: "Docs" },
        navKey: "knowledge-sources",
        link: "/knowledge/sources",
      },
    ]);
  });

  it("manual fact imports do not raise sync warnings in attention or health", async () => {
    await source({
      name: "Imported facts",
      type: "verified_facts",
      status: "active",
    });
    await source({
      name: "Older facts",
      type: "verified_facts",
      lastSuccessfulSyncAt: ago(500),
    });
    await source({ name: "Revoked", status: "revoked" });
    const website = await source({ name: "Never synced website" });
    const gitbook = await source({
      name: "Old docs",
      type: "gitbook",
      lastSuccessfulSyncAt: ago(500),
    });
    const body = await attention("viewer");
    expect(body.counts["knowledge-sources"]).toBe(2);
    expect(
      body.items
        .filter((item) => item.moduleId === "knowledge")
        .map((item) => item.params.name)
        .sort(),
    ).toEqual(["Never synced website", "Old docs"]);
    const health = await app.inject({
      method: "GET",
      url: `/api/projects/${owner.projectId}/knowledge-health`,
      headers: { origin, cookie: cookies.viewer, [CLIENT_IP_HEADER]: ip() },
    });
    expect(health.statusCode, health.body).toBe(200);
    expect(
      health
        .json()
        .staleSources.map((source: { id: string }) => source.id)
        .sort(),
    ).toEqual([website.id, gitbook.id].sort());
  });

  it("a never-synced source is stale", async () => {
    const never = await source({ name: "Never", lastSuccessfulSyncAt: null });
    const synced = ago(9 * 24);
    // Without maxAgeHours the schema default of 168 h applies.
    const old = await source({
      name: "Old",
      lastSuccessfulSyncAt: synced,
      maxAgeHours: undefined,
    });
    // A revoked source never syncs again: it is not a problem to act on.
    await source({ name: "Revoked", status: "revoked" });
    const body = await attention("viewer");
    const items = body.items.filter((i) => i.moduleId === "knowledge");
    expect(items).toHaveLength(2);
    expect(items).toEqual(
      expect.arrayContaining([
        {
          id: `knowledge:source-stale:${never.id}`,
          moduleId: "knowledge",
          kind: "knowledge_source_stale",
          severity: "critical",
          params: { name: "Never" },
          navKey: "knowledge-sources",
          link: "/knowledge/sources",
        },
        {
          id: `knowledge:source-stale:${old.id}`,
          moduleId: "knowledge",
          kind: "knowledge_source_stale",
          severity: "critical",
          since: new Date(Date.parse(synced) + 168 * HOUR).toISOString(),
          params: { name: "Old" },
          navKey: "knowledge-sources",
          link: "/knowledge/sources",
        },
      ]),
    );
    expect(body.counts["knowledge-sources"]).toBe(2);
  });

  it("more than 3 stale or expiring sources add one aggregated item each (R18)", async () => {
    const expiryOf = (synced: string) =>
      new Date(Date.parse(synced) + 168 * HOUR).toISOString();
    // Five stale: never synced leads, then the oldest expiry first.
    const never = await source({ name: "S-never", lastSuccessfulSyncAt: null });
    const stale: Record<number, { id: string; expiresAt: string }> = {};
    for (const hours of [200, 290, 230, 260]) {
      const synced = ago(hours);
      const row = await source({
        name: `S-${hours}`,
        lastSuccessfulSyncAt: synced,
      });
      stale[hours] = { id: row.id, expiresAt: expiryOf(synced) };
    }
    // Four expiring, in hours left 1, 5, 10, 20: the soonest first.
    const expiring: Record<number, { id: string; dueAt: string }> = {};
    for (const left of [10, 1, 20, 5]) {
      const synced = ago(168 - left);
      const row = await source({
        name: `E-${left}`,
        lastSuccessfulSyncAt: synced,
      });
      expiring[left] = {
        id: row.id,
        dueAt: expiryOf(synced),
      };
    }
    const body = await attention("viewer");
    const items = body.items.filter((i) => i.moduleId === "knowledge");
    // Ids in emission order is not response order (the response is
    // sorted), so compare as sets.
    const ids = (kind: string) =>
      items
        .filter((i) => i.kind === kind)
        .map((i) => i.id)
        .sort();
    const more = (id: string) => items.find((i) => i.id === id);
    expect(ids("knowledge_source_stale")).toEqual(
      [
        `knowledge:source-stale:${never.id}`,
        `knowledge:source-stale:${stale[290]!.id}`,
        `knowledge:source-stale:${stale[260]!.id}`,
        "knowledge:source_stale:more",
      ].sort(),
    );
    expect(more("knowledge:source_stale:more")).toEqual({
      id: "knowledge:source_stale:more",
      moduleId: "knowledge",
      kind: "knowledge_source_stale",
      severity: "critical",
      count: 2,
      since: stale[230]!.expiresAt,
      params: {},
      navKey: "knowledge-sources",
      link: "/knowledge/sources",
    });
    expect(ids("knowledge_source_expiring")).toEqual(
      [
        `knowledge:source-expiring:${expiring[1]!.id}`,
        `knowledge:source-expiring:${expiring[5]!.id}`,
        `knowledge:source-expiring:${expiring[10]!.id}`,
        "knowledge:source_expiring:more",
      ].sort(),
    );
    expect(more("knowledge:source_expiring:more")).toEqual({
      id: "knowledge:source_expiring:more",
      moduleId: "knowledge",
      kind: "knowledge_source_expiring",
      severity: "warning",
      count: 1,
      dueAt: expiring[20]!.dueAt,
      params: {},
      navKey: "knowledge-sources",
      link: "/knowledge/sources",
    });
    // The badge still counts every source (R17).
    expect(body.counts["knowledge-sources"]).toBe(9);
  });

  it("conflicts and failed imports are aggregated", async () => {
    await run(async (tx) => {
      for (const status of ["conflicting", "conflicting", "verified"])
        await create(tx, owner, "facts", { key: randomUUID(), status });
      for (const [topic, status] of [
        ["ingestion", "failed"],
        ["ingestion", "failed"],
        ["ingestion", "completed"],
        ["publish", "failed"],
      ])
        await create(tx, owner, "jobs", { topic, status });
    });
    const body = await attention("viewer");
    const items = body.items.filter((i) => i.moduleId === "knowledge");
    expect(items.map(({ since: _since, ...rest }) => rest)).toEqual(
      expect.arrayContaining([
        {
          id: "knowledge:conflicts",
          moduleId: "knowledge",
          kind: "knowledge_conflicts",
          severity: "warning",
          count: 2,
          params: {},
          navKey: "knowledge-conflicts",
          link: "/knowledge/conflicts",
        },
        {
          id: "knowledge:import-failed",
          moduleId: "knowledge",
          kind: "knowledge_import_failed",
          severity: "warning",
          count: 2,
          params: {},
          navKey: "knowledge-import",
          link: "/knowledge/import",
        },
      ]),
    );
    expect(items).toHaveLength(2);
    for (const item of items) expect(Date.parse(item.since!)).not.toBeNaN();
    expect(body.counts["knowledge-conflicts"]).toBe(2);
    expect(body.counts["knowledge-import"]).toBe(2);
  });

  it("no knowledge items while the module is off", async () => {
    process.env.ORBIT_MODULES = "true";
    await source({ name: "Never", lastSuccessfulSyncAt: null });
    // Marketing depends on knowledge: it goes off first and on last.
    const toggle = (on: boolean) =>
      run(async (tx) => {
        for (const id of on
          ? ["knowledge", "marketing"]
          : ["marketing", "knowledge"])
          await setModuleEnabled(tx, owner, moduleRegistry(), id, on);
      });
    await toggle(false);
    try {
      expect(await itemsOf("knowledge")).toEqual([]);
    } finally {
      await toggle(true);
    }
  });

  it("a viewer gets no cost or action-request items", async () => {
    const unclear = await reservation("unknown", 1_200_000n, {
      createdAt: new Date(Date.now() - 2 * HOUR),
    });
    await reservation("unknown", 300_000n);
    // Last month's unclear cost no longer counts.
    await reservation("unknown", 9_000_000n, {
      createdAt: new Date(budgetMonthStart(new Date()).getTime() - 1),
    });
    const firstExpiry = new Date(Date.now() + HOUR).toISOString();
    const first = await actionRequest({ expiresAt: firstExpiry });
    await actionRequest({
      expiresAt: new Date(Date.now() + 2 * HOUR).toISOString(),
    });
    // Expired, decided or editor-decided requests are not the owner's to decide.
    await actionRequest({ expiresAt: new Date(Date.now() - 1).toISOString() });
    await actionRequest({ status: "approved" });
    await actionRequest({ actionType: "content_package.start" });

    const ownerItems = await itemsOf("platform");
    expect(ownerItems).toEqual(
      expect.arrayContaining([
        {
          id: "platform:cost-unknown",
          moduleId: "platform",
          kind: "platform_cost_unknown",
          severity: "warning",
          since: unclear.createdAt.toISOString(),
          params: { micros: 1_500_000 },
          navKey: "operations",
          link: "/operations",
        },
        {
          id: "platform:action-requests",
          moduleId: "platform",
          kind: "platform_action_request",
          severity: "warning",
          count: 2,
          dueAt: firstExpiry,
          since: first.createdAt.toISOString(),
          params: {},
          navKey: "decisions",
          link: "/decisions",
        },
      ]),
    );
    expect(ownerItems).toHaveLength(2);
    expect(await itemsOf("platform", "viewer")).toEqual([]);
    expect((await attention("viewer")).counts.decisions).toBeUndefined();
  });

  it("worker down without heartbeat", async () => {
    expect(await itemsOf("platform", "viewer")).toEqual([]);
    await workerSilent();
    const body = await attention("viewer");
    expect(body.items.filter((i) => i.moduleId === "platform")).toEqual([
      {
        id: "platform:worker-down",
        moduleId: "platform",
        kind: "platform_worker_down",
        severity: "critical",
        params: {},
        navKey: "operations",
        link: "/operations",
      },
    ]);
    expect(body.counts.operations).toBe(1);
  });

  it("R25: status.mode is the project's mode, not the active policy's", async () => {
    // A new project observes, with or without a policy.
    expect((await attention("viewer")).status.mode).toBe("observe");
    await policy({ mode: "autopilot" });
    expect((await attention("viewer")).status.mode).toBe("observe");
    await projectMode("assisted");
    try {
      expect((await attention("viewer")).status.mode).toBe("assisted");
    } finally {
      await projectMode("observe");
    }
  });

  it("status.mode is absent when marketing is off", async () => {
    await projectMode("assisted");
    expect((await attention("viewer")).status.mode).toBe("assisted");
    process.env.ORBIT_MODULES = "true";
    await run((tx) =>
      setModuleEnabled(tx, owner, moduleRegistry(), "marketing", false),
    );
    try {
      expect((await attention("viewer")).status).not.toHaveProperty("mode");
    } finally {
      await run((tx) =>
        setModuleEnabled(tx, owner, moduleRegistry(), "marketing", true),
      );
      await projectMode("observe");
    }
  });

  it("status.mode is absent when marketing is hidden from the member", async () => {
    await projectMode("autopilot");
    process.env.ORBIT_MODULE_ROLES = "true";
    await authDb.projectMemberModuleRole.create({
      data: {
        workspaceId: owner.workspaceId,
        projectId: owner.projectId,
        userId: ids.viewer,
        moduleId: "marketing",
        role: "none",
        changedBy: ids.owner,
      },
    });
    try {
      expect((await attention("viewer")).status).not.toHaveProperty("mode");
      expect((await attention("owner")).status.mode).toBe("autopilot");
    } finally {
      await projectMode("observe");
    }
  });

  it("aiMonth counts this month's reservations as enforcement does", async () => {
    // Without a policy the month is still known; the limit is not.
    expect((await attention("editor")).status.aiMonth).toEqual({
      spentMicros: 0,
      limitMicros: null,
    });
    await policy({ monthlyBudgetMicros: 20_000_000 });
    await reservation("settled", 900_000n, { settledMicros: 400_000n });
    await reservation("reserved", 100_000n);
    await reservation("in_flight", 20_000n);
    await reservation("unknown", 3_000n);
    // Released reservations and last month's spend do not count.
    await reservation("released", 5_000_000n);
    await reservation("settled", 7_000_000n, {
      settledMicros: 7_000_000n,
      createdAt: new Date(budgetMonthStart(new Date()).getTime() - 1),
    });
    expect((await attention("owner")).status).toEqual({
      paused: false,
      mode: "observe",
      aiMonth: { spentMicros: 523_000, limitMicros: 20_000_000 },
    });
  });

  it("R26: aiMonth only for owners and editors, like /ai-cost", async () => {
    await policy({ monthlyBudgetMicros: 20_000_000 });
    await reservation("reserved", 100_000n);
    expect((await attention("viewer")).status).not.toHaveProperty("aiMonth");
    expect((await attention("editor")).status.aiMonth).toEqual({
      spentMicros: 100_000,
      limitMicros: 20_000_000,
    });
  });

  it("R26: no limitMicros while the policies are hidden from the member", async () => {
    await policy({ monthlyBudgetMicros: 20_000_000 });
    await reservation("reserved", 100_000n);
    process.env.ORBIT_MODULE_ROLES = "true";
    await authDb.projectMemberModuleRole.create({
      data: {
        workspaceId: owner.workspaceId,
        projectId: owner.projectId,
        userId: ids.editor,
        moduleId: "marketing",
        role: "none",
        changedBy: ids.owner,
      },
    });
    // Unknown, not "no limit": the month's spend stays, the limit is left out.
    expect((await attention("editor")).status.aiMonth).toEqual({
      spentMicros: 100_000,
    });
    expect((await attention("owner")).status.aiMonth).toEqual({
      spentMicros: 100_000,
      limitMicros: 20_000_000,
    });
  });
});
