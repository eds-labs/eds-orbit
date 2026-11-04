import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { authDb, closeDatabase, scoped } from "../../../packages/db/src/index.ts";
import type { Scope } from "../../../packages/schemas/src/index.ts";
import { makeAuth } from "../src/auth.ts";
import { moduleRegistry } from "../src/modules/registry.ts";
import { getConversation } from "../src/platform/assistant/chat.ts";
import { delegationNoticeSubscriber } from "../src/platform/assistant/notices.ts";
import { ensurePersonalSpace } from "../src/platform/assistant/personal-space.ts";
import { userScoped } from "../src/platform/tenancy/scope.ts";

// Delegation notices (ADR 0022, plan §2.5 step 4): when the last work order
// of an assistant delegation batch finished, one `notice` message with a
// result card per work order goes into the originating personal
// conversation, without any model call; a deleted conversation gets none.

vi.mock("../../../packages/ai/src/index.ts", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  respond: vi.fn(async () => {
    throw new Error("REAL_PROVIDER_CALLED");
  }),
}));

const enabled = Boolean(process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL);
Object.assign(process.env, { ORBIT_PERSONAL_ASSISTANT: "true", EXECUTION_MODE: "test" });

describe.skipIf(!enabled)("Assistant delegation notices (ADR 0022)", () => {
  const users: string[] = [];
  let workspaceId: string;
  let businessId: string;
  let userId: string;
  let personal: Scope;

  beforeAll(async () => {
    const r = await makeAuth().api.signUpEmail({
      body: { email: `${randomUUID()}@example.invalid`, name: "Synthetic notice user", password: randomUUID() },
    });
    userId = r.user.id;
    users.push(userId);
    workspaceId = (
      await authDb.workspace.create({
        data: { name: "Synthetic notice org", members: { create: { userId, role: "owner" } } },
      })
    ).id;
    businessId = (await authDb.project.create({ data: { workspaceId, name: "Synthetic support project" } })).id;
    const space = await ensurePersonalSpace(workspaceId, userId, moduleRegistry());
    personal = { workspaceId, projectId: space.projectId, userId, role: "owner" };
  });

  afterAll(async () => {
    if (workspaceId) await authDb.workspace.delete({ where: { id: workspaceId } }).catch(() => null);
    await authDb.user.deleteMany({ where: { id: { in: users } } });
    await closeDatabase();
  });

  const conversation = () =>
    userScoped(personal, (tx) =>
      tx.chatConversation.create({
        data: { workspaceId, projectId: personal.projectId, userId, title: "Delegation" },
      }),
    );
  async function batchOf(conversationId: string, size: number) {
    const batchId = randomUUID();
    const rows = [];
    for (let i = 0; i < size; i++)
      rows.push(
        await scoped(workspaceId, businessId, (tx) =>
          tx.agentWorkOrder.create({
            data: {
              workspaceId,
              projectId: businessId,
              target: "agent",
              origin: "assistant",
              idempotencyKey: `test:${batchId}:${i}`,
              requestedBy: {
                kind: "user",
                userId,
                via: "assistant",
                personalSpaceId: personal.projectId,
                conversationId,
                batchId,
                batchSize: size,
              },
              allow: {},
              goal: "Investigate the ticket",
              status: "running",
              ceilingMicros: BigInt(100_000),
              subjectType: "support.ticket",
              subjectId: randomUUID(),
            },
          }),
        ),
      );
    return rows;
  }
  const finish = (id: string, status: string, errorCode?: string) =>
    scoped(workspaceId, businessId, async (tx) => {
      await tx.agentWorkOrder.update({
        where: { id },
        data: { status, errorCode: errorCode ?? null, finishedAt: new Date() },
      });
      await delegationNoticeSubscriber.handler(tx, { workspaceId, projectId: businessId, userId, role: "owner" }, {
        id: randomUUID(),
        type: status === "succeeded" ? "platform.agent.work_order.finished" : "platform.agent.work_order.failed",
        subject: { type: "platform.agent_work_order", id },
        actor: { kind: "agent", id: null },
        data: {},
      } as never);
    });
  const notices = async (conversationId: string) =>
    (await getConversation(personal, conversationId)).messages.filter((m) => m.role === "notice");

  it("posts one notice with a card per work order once the whole batch finished", async () => {
    const thread = await conversation();
    const [a, b, c] = await batchOf(thread.id, 3);
    await finish(a!.id, "succeeded");
    await finish(b!.id, "failed", "AGENT_LIMIT");
    expect(await notices(thread.id)).toEqual([]);
    await finish(c!.id, "succeeded");
    // A repeated event writes nothing new.
    await finish(c!.id, "succeeded");
    const found = await notices(thread.id);
    expect(found).toHaveLength(1);
    const notice = found[0]! as (typeof found)[number] & { notice: { kind: string; key: string } };
    expect(notice.notice).toMatchObject({ kind: "work_order_failed" });
    expect(notice.text).toContain("2 of 3");
    const cards = notice.cards as Array<{ projectId: string; status: string; href: string; resourceId?: string }>;
    expect(cards).toHaveLength(3);
    expect(cards.every((card) => card.projectId === businessId && !card.resourceId)).toBe(true);
    expect(cards.map((card) => card.status)).toContain("failed:AGENT_LIMIT");
  });

  it("skips a deleted conversation and leaves the work orders as they are", async () => {
    const thread = await conversation();
    const [only] = await batchOf(thread.id, 1);
    await userScoped(personal, (tx) => tx.chatConversation.delete({ where: { id: thread.id } }));
    await finish(only!.id, "succeeded");
    const row = await scoped(workspaceId, businessId, (tx) =>
      tx.agentWorkOrder.findUniqueOrThrow({ where: { id: only!.id } }),
    );
    expect(row.status).toBe("succeeded");
  });

  it("ignores work orders that did not come from the assistant", async () => {
    const thread = await conversation();
    const [row] = await batchOf(thread.id, 1);
    await scoped(workspaceId, businessId, (tx) =>
      tx.agentWorkOrder.update({ where: { id: row!.id }, data: { origin: "manual" } }),
    );
    await finish(row!.id, "succeeded");
    expect(await notices(thread.id)).toEqual([]);
  });
});
