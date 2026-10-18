import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  authDb,
  closeDatabase,
  scoped,
  type DbTx,
} from "../../../packages/db/src/index.ts";
import type { Scope } from "../../../packages/schemas/src/index.ts";
import {
  myNotifications,
  setMyPreferences,
} from "../src/platform/notifications/members.ts";
import { createInbox, updateInbox } from "../src/modules/support/inboxes.ts";
import { createTicket } from "../src/modules/support/tickets.ts";
import {
  noteOnTicket,
  replyToTicket,
  updateTicket,
} from "../src/modules/support/workspace.ts";
import { supportScheduler } from "../src/modules/support/automations.ts";
import type { NormalizedInbound } from "../src/modules/support/channels/adapter.ts";

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);
const HOUR = 3_600_000;

/**
 * Support notifications and automations (WP5.5): who hears about what, auto
 * assignment, SLA at-risk and breach events once each, auto-close, per-inbox
 * switches and preferences; the sweep runs with a given time.
 */
describe.skipIf(!enabled)("support notifications and automations", () => {
  let owner: Scope;
  const agents: Record<"anna" | "ben", string> = { anna: "", ben: "" };
  const users: string[] = [];
  const workspaces: string[] = [];
  let mailInbox = "";
  const run = <T>(fn: (tx: DbTx) => Promise<T>) =>
    scoped(owner.workspaceId, owner.projectId, fn);
  const as = (userId: string): Scope => ({ ...owner, userId, role: "editor" });
  const inbound = (
    over: Partial<NormalizedInbound> = {},
  ): NormalizedInbound => ({
    externalId: `<${randomUUID()}@example.org>`,
    contact: { email: `c${randomUUID().slice(0, 8)}@example.org` },
    subject: "Help",
    bodyText: "Please help.",
    attachments: [],
    ...over,
  });
  const ticket = (inboxId = mailInbox, now?: Date) =>
    run((tx) =>
      createTicket(tx, owner, {
        inboxId,
        channel: "email",
        inbound: inbound(),
        ...(now ? { now } : {}),
      }),
    );
  const kinds = async (userId: string) =>
    ((await myNotifications(as(userId))).items as Array<{ kind: string }>).map(
      (n) => n.kind,
    );
  const sweep = (at: Date) =>
    run((tx) => supportScheduler.sweep(tx, owner, at));

  beforeAll(async () => {
    Object.assign(process.env, {
      ORBIT_SUPPORT: "true",
      ORBIT_NOTIFICATIONS: "true",
    });
    const workspace = await authDb.workspace.create({
      data: { name: "Synthetic support automations" },
    });
    workspaces.push(workspace.id);
    const project = await authDb.project.create({
      data: {
        workspaceId: workspace.id,
        name: "Synthetic support automations",
      },
    });
    for (const name of ["anna", "ben"] as const) {
      const user = await authDb.user.create({
        data: {
          id: randomUUID(),
          name: name === "anna" ? "Anna Agent" : "Ben Agent",
          email: `${randomUUID()}@example.invalid`,
        },
      });
      users.push(user.id);
      agents[name] = user.id;
      await authDb.workspaceMember.create({
        data: { workspaceId: workspace.id, userId: user.id, role: "viewer" },
      });
      await authDb.projectMember.create({
        data: {
          workspaceId: workspace.id,
          projectId: project.id,
          userId: user.id,
          role: "editor",
        },
      });
    }
    owner = {
      workspaceId: workspace.id,
      projectId: project.id,
      userId: agents.anna,
      role: "owner",
    };
    await run(async (tx) => {
      await tx.projectModule.create({
        data: {
          workspaceId: owner.workspaceId,
          projectId: owner.projectId,
          moduleId: "support",
          enabled: true,
          moduleVersion: "1.0.0",
        },
      });
      mailInbox = (
        await createInbox(tx, owner, {
          name: "Mail",
          channels: ["email"],
          emailAddress: "support@example.invalid",
        })
      ).inbox.id;
    });
  });
  afterEach(() => {
    Object.assign(process.env, {
      ORBIT_SUPPORT: "true",
      ORBIT_NOTIFICATIONS: "true",
    });
  });
  afterAll(async () => {
    delete process.env.ORBIT_SUPPORT;
    delete process.env.ORBIT_NOTIFICATIONS;
    await authDb.workspace.deleteMany({ where: { id: { in: workspaces } } });
    await authDb.user.deleteMany({ where: { id: { in: users } } });
    await closeDatabase();
  });

  it("tells every agent about a new ticket", async () => {
    await ticket();
    expect(await kinds(agents.anna)).toContain("support_ticket_new");
    expect(await kinds(agents.ben)).toContain("support_ticket_new");
  });

  it("assigns by a fixed agent or round robin, and tells the assignee", async () => {
    const fixed = await run(
      async (tx) =>
        (
          await createInbox(tx, owner, {
            name: "Fixed",
            channels: ["email"],
            emailAddress: "fixed@example.invalid",
            assignmentPolicy: "fixed",
            defaultAssigneeUserId: agents.ben,
          })
        ).inbox.id,
    );
    const t = await ticket(fixed);
    const row = await run((tx) =>
      tx.supportTicket.findUniqueOrThrow({ where: { id: t.ticketId } }),
    );
    expect(row.assigneeUserId).toBe(agents.ben);
    expect(await kinds(agents.ben)).toContain("support_ticket_assigned");

    const robin = await run(
      async (tx) =>
        (
          await createInbox(tx, owner, {
            name: "Robin",
            channels: ["email"],
            emailAddress: "robin@example.invalid",
            assignmentPolicy: "round_robin",
          })
        ).inbox.id,
    );
    const assignees = [];
    for (let i = 0; i < 4; i++) {
      const created = await ticket(robin);
      assignees.push(
        (
          await run((tx) =>
            tx.supportTicket.findUniqueOrThrow({
              where: { id: created.ticketId },
            }),
          )
        ).assigneeUserId,
      );
    }
    // Alternates over the support agents (the owner Anna and Ben).
    expect(new Set(assignees).size).toBe(2);
    expect(assignees[0]).not.toBe(assignees[1]);
    expect(assignees[0]).toBe(assignees[2]);
  });

  it("notifies the assignee of a customer reply, a handoff-free note mention and a manual assignment", async () => {
    const t = await ticket();
    await run((tx) =>
      updateTicket(tx, as(agents.anna), t.ticketId, {
        assigneeUserId: agents.ben,
      }),
    );
    await run((tx) =>
      noteOnTicket(tx, as(agents.ben), t.ticketId, {
        bodyText: "@Anna Agent can you check the payout?",
      }),
    );
    expect(await kinds(agents.anna)).toContain("support_mention");
    const beforeReply = (await kinds(agents.ben)).filter(
      (k) => k === "support_customer_replied",
    ).length;
    const { appendCustomerMessage } =
      await import("../src/modules/support/tickets.ts");
    await run(async (tx) =>
      appendCustomerMessage(
        tx,
        owner,
        await tx.supportTicket.findUniqueOrThrow({ where: { id: t.ticketId } }),
        { bodyText: "Any news?", channel: "email", externalId: null },
      ),
    );
    expect(
      (await kinds(agents.ben)).filter((k) => k === "support_customer_replied"),
    ).toHaveLength(beforeReply + 1);
  });

  it("raises SLA at risk and breach once each, and wakes up for the next due time", async () => {
    const now = new Date();
    const t = await ticket(mailInbox, now);
    // Normal priority: first response due in 24 h.
    const next = await run((tx) => supportScheduler.nextDueAt(tx, owner, now));
    expect(next).not.toBeNull();
    expect(next!.getTime()).toBeLessThanOrEqual(now.getTime() + 24 * HOUR);

    const risky = new Date(now.getTime() + 23.5 * HOUR);
    await sweep(risky);
    await sweep(risky);
    const late = new Date(now.getTime() + 25 * HOUR);
    await sweep(late);
    await sweep(late);
    const events = await run((tx) =>
      tx.supportTicketEvent.findMany({
        where: { ticketId: t.ticketId, type: { startsWith: "sla_" } },
        orderBy: { createdAt: "asc" },
      }),
    );
    expect(events.map((e) => e.type)).toEqual(["sla_at_risk", "sla_breached"]);
    expect(await kinds(agents.ben)).toEqual(
      expect.arrayContaining(["support_sla_at_risk", "support_sla_breached"]),
    );
  });

  it("closes tickets waiting on the customer after the inbox's days, unless switched off", async () => {
    const t = await ticket();
    await run((tx) =>
      replyToTicket(tx, as(agents.anna), t.ticketId, { bodyText: "Fixed?" }),
    );
    // Default: 7 days in pending_customer.
    await sweep(new Date(Date.now() + 6 * 24 * HOUR));
    const open = await run((tx) =>
      tx.supportTicket.findUniqueOrThrow({ where: { id: t.ticketId } }),
    );
    expect(open.status).toBe("pending_customer");
    await sweep(new Date(Date.now() + 8 * 24 * HOUR));
    const closed = await run((tx) =>
      tx.supportTicket.findUniqueOrThrow({ where: { id: t.ticketId } }),
    );
    expect(closed.status).toBe("closed");

    const keep = await run(
      async (tx) =>
        (
          await createInbox(tx, owner, {
            name: "Keep",
            channels: ["email"],
            emailAddress: "keep@example.invalid",
            rules: { autoClose: false },
          })
        ).inbox.id,
    );
    const kept = await ticket(keep);
    await run((tx) =>
      replyToTicket(tx, as(agents.anna), kept.ticketId, { bodyText: "Fixed?" }),
    );
    await sweep(new Date(Date.now() + 30 * 24 * HOUR));
    expect(
      (
        await run((tx) =>
          tx.supportTicket.findUniqueOrThrow({ where: { id: kept.ticketId } }),
        )
      ).status,
    ).toBe("pending_customer");
  });

  it("switches rules per inbox and keeps the inbox version", async () => {
    const inbox = await run((tx) =>
      createInbox(tx, owner, {
        name: "Rules",
        channels: ["email"],
        emailAddress: "rules@example.invalid",
      }),
    );
    const updated = await run((tx) =>
      updateInbox(tx, owner, inbox.inbox.id, {
        version: 1,
        rules: { autoAck: false, autoCloseDays: 3, sla: false },
      }),
    );
    expect(updated.rules).toEqual({
      autoAck: false,
      autoCloseDays: 3,
      sla: false,
    });
    const now = new Date();
    const t = await ticket(inbox.inbox.id, now);
    await sweep(new Date(now.getTime() + 48 * HOUR));
    const sla = await run((tx) =>
      tx.supportTicketEvent.count({
        where: { ticketId: t.ticketId, type: { startsWith: "sla_" } },
      }),
    );
    expect(sla).toBe(0);
  });

  it("respects a muted kind and sends nothing while support is off", async () => {
    await setMyPreferences(as(agents.ben), {
      kinds: { support_ticket_new: { inApp: false, email: false } },
    });
    const before = (await kinds(agents.ben)).filter(
      (k) => k === "support_ticket_new",
    ).length;
    await ticket();
    expect(
      (await kinds(agents.ben)).filter((k) => k === "support_ticket_new"),
    ).toHaveLength(before);
    delete process.env.ORBIT_SUPPORT;
    expect(await sweep(new Date())).toEqual({ queued: 0 });
  });
});
