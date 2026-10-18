import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  authDb,
  closeDatabase,
  scoped,
  type DbTx,
} from "../../../packages/db/src/index.ts";
import type { Scope } from "../../../packages/schemas/src/index.ts";
import { create, data, entity, update } from "../src/shared.ts";
import {
  cancelActionRequest,
  createActionRequest,
  decideActionRequest,
  findPendingMcpProposal,
  requestedBy,
} from "../src/modules/action-requests.ts";
import { registerModules } from "../src/modules/registry.ts";
import { registeredActionTypes } from "../src/platform/modules/contributions.ts";

registerModules();

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);
const hex = (c: string) => c.repeat(64);
const mcpRequester = (over: Record<string, unknown> = {}) => ({
  kind: "mcp" as const,
  userId: "user-1",
  clientId: "https://client.example/metadata.json",
  grantId: "grant-1",
  agentRunId: null,
  argsHash: hex("a"),
  ...over,
});

describe("requestedBy contract for MCP proposals (WP-M4)", () => {
  it("accepts the mcp variant and keeps the existing variants", () => {
    expect(requestedBy.parse(mcpRequester())).toEqual(mcpRequester());
    expect(
      requestedBy.parse(mcpRequester({ agentRunId: "run-1" })),
    ).toMatchObject({ agentRunId: "run-1" });
    expect(requestedBy.parse({ kind: "user", userId: "u" })).toEqual({
      kind: "user",
      userId: "u",
    });
    expect(
      requestedBy.parse({ kind: "agent", userId: "u", agentRunId: null }),
    ).toMatchObject({ kind: "agent" });
  });

  it("rejects incomplete, extended or malformed mcp shapes", () => {
    const { grantId: _g, ...withoutGrant } = mcpRequester();
    expect(() => requestedBy.parse(withoutGrant)).toThrow();
    expect(() => requestedBy.parse(mcpRequester({ extra: 1 }))).toThrow();
    expect(() =>
      requestedBy.parse(mcpRequester({ argsHash: "abc" })),
    ).toThrow();
    expect(() =>
      requestedBy.parse(mcpRequester({ argsHash: hex("A") })),
    ).toThrow();
    expect(() => requestedBy.parse(mcpRequester({ clientId: "" }))).toThrow();
    expect(() => requestedBy.parse(mcpRequester({ userId: "" }))).toThrow();
    expect(() =>
      requestedBy.parse({ kind: "user", userId: "u", clientId: "c" }),
    ).toThrow();
  });
});

describe("registry-wide MCP proposable action types (WP-M4)", () => {
  it("allows exactly assignment.confirm to be proposed from MCP", () => {
    const proposable = [...registeredActionTypes()]
      .filter(([, definition]) => definition.mcpProposable === true)
      .map(([type]) => type)
      .sort();
    expect(proposable).toEqual(["assignment.confirm"]);
  });
});

describe.skipIf(!enabled)("ActionRequests from MCP clients (WP-M4)", () => {
  let owner: Scope;
  const users: string[] = [];
  const run = <T>(work: (tx: DbTx) => Promise<T>) =>
    scoped(owner.workspaceId, owner.projectId, work);
  const assignment = { assignmentId: "a-1", name: "Daily" };
  const propose = (
    requester: ReturnType<typeof mcpRequester>,
    actionType = "assignment.confirm",
  ) =>
    run((tx) =>
      createActionRequest(tx, owner, {
        actionType,
        payload: assignment,
        requestedBy: requester,
      }),
    );
  const find = (over: Record<string, unknown> = {}) =>
    run((tx) =>
      findPendingMcpProposal(tx, owner, {
        grantId: "grant-1",
        actionType: "assignment.confirm",
        argsHash: hex("a"),
        now: new Date(),
        ...over,
      }),
    );
  const auditRows = (action: string) =>
    run((tx) =>
      tx.auditEvent.findMany({
        where: {
          workspaceId: owner.workspaceId,
          projectId: owner.projectId,
          action,
        },
      }),
    );

  beforeAll(async () => {
    const id = randomUUID();
    await authDb.user.create({
      data: {
        id,
        name: "Synthetic MCP requester",
        email: `${randomUUID()}@example.invalid`,
      },
    });
    users.push(id);
    const workspace = await authDb.workspace.create({
      data: {
        name: "MCP proposals contract",
        members: { create: { userId: id, role: "owner" } },
      },
    });
    const project = await authDb.project.create({
      data: { workspaceId: workspace.id, name: "MCP proposals project" },
    });
    owner = {
      workspaceId: workspace.id,
      projectId: project.id,
      userId: id,
      role: "owner",
    };
    await run((tx) =>
      create(tx, owner, "policies", {
        mode: "observe",
        channels: ["x-test"],
        contentTypes: ["social"],
        allowedOrigins: ["https://example.invalid"],
        startAt: new Date(Date.now() - 3600000).toISOString(),
        endAt: new Date(Date.now() + 86400000).toISOString(),
        maxPerDay: 0,
        minIntervalMinutes: 1,
        dailyBudgetMicros: 100000,
        monthlyBudgetMicros: 100000,
        perRunBudgetMicros: 10000,
        approvedPaidTests: true,
        active: true,
      }),
    );
  });

  afterAll(async () => {
    await authDb.workspace.delete({ where: { id: owner.workspaceId } });
    await authDb.user.deleteMany({ where: { id: { in: users } } });
    await closeDatabase();
  });

  it("creates an assignment.confirm request for an mcp requester and audits it without the payload", async () => {
    const row = await propose(mcpRequester());
    expect(data(row)).toMatchObject({
      actionType: "assignment.confirm",
      status: "pending",
      requestedBy: mcpRequester(),
    });
    const events = (await auditRows("action_request.proposed")).filter(
      (e) => e.resourceId === row.id,
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.metadata).toEqual({
      actionType: "assignment.confirm",
      packageHash: data(row).packageHash,
      clientId: mcpRequester().clientId,
      grantId: "grant-1",
    });
    expect(JSON.stringify(events[0]!.metadata)).not.toContain("Daily");
  });

  it("does not write the proposed audit for user requesters", async () => {
    const row = await run((tx) =>
      createActionRequest(tx, owner, {
        actionType: "assignment.confirm",
        payload: assignment,
        requestedBy: { kind: "user", userId: owner.userId },
      }),
    );
    expect(
      (await auditRows("action_request.proposed")).filter(
        (e) => e.resourceId === row.id,
      ),
    ).toHaveLength(0);
  });

  it.each(["image.generate", "content_package.start", "content.schedule"])(
    "refuses %s from an mcp requester",
    async (actionType) => {
      await expect(propose(mcpRequester(), actionType)).rejects.toMatchObject({
        code: "ACTION_TYPE_NOT_PROPOSABLE",
        status: 403,
      });
    },
  );

  it("refuses an unknown type before the proposable check", async () => {
    await expect(propose(mcpRequester(), "nope.nothing")).rejects.toMatchObject(
      { code: "ACTION_TYPE_NOT_SUPPORTED" },
    );
  });

  describe("findPendingMcpProposal", () => {
    it("finds the newest pending unexpired request of the same grant and args", async () => {
      const args = hex("1");
      const older = await propose(mcpRequester({ argsHash: args }));
      const newer = await propose(mcpRequester({ argsHash: args }));
      const found = await find({ argsHash: args });
      expect(found?.id).toBe(newer.id);
      expect(found?.id).not.toBe(older.id);
    });

    it("returns null without a match", async () => {
      expect(await find({ argsHash: hex("9") })).toBeNull();
    });

    it("ignores another grant, other args and another action type", async () => {
      const args = hex("2");
      await propose(mcpRequester({ argsHash: args, grantId: "grant-2" }));
      expect(await find({ argsHash: args })).toBeNull();
      expect(await find({ argsHash: args, grantId: "grant-2" })).not.toBeNull();
      expect(
        await find({
          argsHash: args,
          grantId: "grant-2",
          actionType: "content.schedule",
        }),
      ).toBeNull();
    });

    it("ignores requests that did not come from mcp", async () => {
      const row = await run((tx) =>
        createActionRequest(tx, owner, {
          actionType: "assignment.confirm",
          payload: assignment,
          requestedBy: { kind: "user", userId: "grant-3" },
        }),
      );
      expect(row).toBeDefined();
      expect(await find({ grantId: "grant-3", argsHash: hex("3") })).toBeNull();
    });

    it("ignores expired requests", async () => {
      const args = hex("4");
      const row = await propose(mcpRequester({ argsHash: args }));
      await run(async (tx) => {
        const fresh = await entity(tx, owner, "action_requests", row.id);
        await update(tx, owner, fresh, {
          ...data(fresh),
          expiresAt: new Date(Date.now() - 1000).toISOString(),
        });
      });
      expect(await find({ argsHash: args })).toBeNull();
    });

    it("ignores decided and canceled requests", async () => {
      const rejectedArgs = hex("5");
      const rejected = await propose(mcpRequester({ argsHash: rejectedArgs }));
      await run((tx) =>
        decideActionRequest(tx, owner, rejected.id, {
          version: rejected.version,
          packageHash: data(rejected).packageHash,
          decision: "reject",
        }),
      );
      expect(await find({ argsHash: rejectedArgs })).toBeNull();
      const canceledArgs = hex("6");
      const canceled = await propose(mcpRequester({ argsHash: canceledArgs }));
      await run((tx) => cancelActionRequest(tx, owner, canceled.id));
      expect(await find({ argsHash: canceledArgs })).toBeNull();
    });

    it("skips an expired newer request and returns the live older one", async () => {
      const args = hex("7");
      const live = await propose(mcpRequester({ argsHash: args }));
      const stale = await propose(mcpRequester({ argsHash: args }));
      await run(async (tx) => {
        const fresh = await entity(tx, owner, "action_requests", stale.id);
        await update(tx, owner, fresh, {
          ...data(fresh),
          expiresAt: new Date(Date.now() - 1000).toISOString(),
        });
      });
      expect((await find({ argsHash: args }))?.id).toBe(live.id);
    });

    it("honours the now parameter for expiry", async () => {
      const args = hex("8");
      await propose(mcpRequester({ argsHash: args }));
      expect(
        await find({
          argsHash: args,
          now: new Date(Date.now() + 8 * 24 * 3600000),
        }),
      ).toBeNull();
    });
  });
});
