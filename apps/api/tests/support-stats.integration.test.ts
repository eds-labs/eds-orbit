import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  authDb,
  closeDatabase,
  scoped,
  type DbTx,
} from "../../../packages/db/src/index.ts";
import type { Scope } from "../../../packages/schemas/src/index.ts";
import { createInbox } from "../src/modules/support/inboxes.ts";
import { createTicket } from "../src/modules/support/tickets.ts";
import { statsCsv, supportStats } from "../src/modules/support/stats.ts";

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);
const MIN = 60_000;
const T0 = new Date("2026-10-01T08:00:00.000Z");
const at = (minutes: number) => new Date(T0.getTime() + minutes * MIN);

/**
 * Support statistics (WP5.7) on a hand-computed fixture: four tickets in two
 * inboxes with set times, events and AI messages.
 *
 *  #1 mail,   deposits, created  0, first response  30, resolved 120, reopened once
 *  #2 mail,   deposits, created 10, first response 130 (due 70: breached), resolved 250
 *  #3 widget, billing,  created 20, no response, open
 *  #4 widget, -,        created 30, first response  40, open; one AI draft sent unchanged,
 *                       one AI draft edited, one withheld, one AI handoff; cost 1000 + 500
 */
describe.skipIf(!enabled)("support statistics", () => {
  let owner: Scope;
  const workspaces: string[] = [];
  const ids: string[] = [];
  let mail = "";
  let widget = "";
  const run = <T>(fn: (tx: DbTx) => Promise<T>) =>
    scoped(owner.workspaceId, owner.projectId, fn);
  const range = { from: at(-60).toISOString(), to: at(24 * 60).toISOString() };

  beforeAll(async () => {
    process.env.ORBIT_SUPPORT = "true";
    const workspace = await authDb.workspace.create({
      data: { name: "Synthetic support stats" },
    });
    workspaces.push(workspace.id);
    const project = await authDb.project.create({
      data: { workspaceId: workspace.id, name: "Synthetic support stats" },
    });
    owner = {
      workspaceId: workspace.id,
      projectId: project.id,
      userId: "owner-setup",
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
      mail = (
        await createInbox(tx, owner, {
          name: "Mail",
          channels: ["email"],
          emailAddress: "s@example.invalid",
        })
      ).inbox.id;
      widget = (
        await createInbox(tx, owner, {
          name: "Widget",
          channels: ["widget"],
          allowedOrigins: ["https://desk.example.invalid"],
        })
      ).inbox.id;
      const make = async (
        inboxId: string,
        channel: "email" | "widget",
        created: number,
        fields: Record<string, unknown>,
      ) => {
        const t = await createTicket(tx, owner, {
          inboxId,
          channel,
          now: at(created),
          inbound: {
            externalId: null,
            contact: { email: `${randomUUID()}@example.org` },
            subject: "Stats",
            bodyText: "x",
            attachments: [],
          },
        });
        await tx.supportTicket.update({
          where: { id: t.ticketId },
          data: fields,
        });
        ids.push(t.ticketId);
        return t.ticketId;
      };
      const t1 = await make(mail, "email", 0, {
        category: "deposits",
        firstRespondedAt: at(30),
        resolvedAt: at(120),
        status: "resolved",
      });
      await make(mail, "email", 10, {
        category: "deposits",
        firstResponseDueAt: at(70),
        firstRespondedAt: at(130),
        resolvedAt: at(250),
        status: "closed",
      });
      await make(widget, "widget", 20, {
        category: "billing",
        status: "open",
        tags: ["vip", "bug"],
      });
      const t4 = await make(widget, "widget", 30, {
        firstRespondedAt: at(40),
        status: "open",
        tags: ["vip"],
      });
      const event = (ticketId: string, type: string, extra: object = {}) =>
        tx.supportTicketEvent.create({
          data: {
            id: randomUUID(),
            workspaceId: owner.workspaceId,
            projectId: owner.projectId,
            ticketId,
            type,
            actorKind: "ai",
            createdAt: at(200),
            ...extra,
          },
        });
      await event(t1, "status", {
        actorKind: "contact",
        before: { status: "resolved" },
        after: { status: "open" },
      });
      await event(ids[1]!, "sla_breached", {
        actorKind: "system",
        after: { clock: "first_response" },
      });
      await event(t4, "ai_draft_withheld");
      await event(t4, "handoff", { after: { reason: "ai_unsure" } });
      const message = (kind: string, bodyText: string, minute: number) =>
        tx.supportMessage.create({
          data: {
            id: randomUUID(),
            workspaceId: owner.workspaceId,
            projectId: owner.projectId,
            ticketId: t4,
            kind,
            bodyText,
            channel: kind === "agent_reply" ? "widget" : "internal",
            visibleToCustomer: kind === "agent_reply",
            createdAt: at(minute),
          },
        });
      await message("ai_draft", "Deposits take an hour.", 35);
      await message("agent_reply", "Deposits take an hour.", 40);
      await message("ai_draft", "Your account is fine.", 45);
      await message("agent_reply", "Your account is fine, we checked.", 50);
      for (const [n, amount] of [
        [1, 1000],
        [2, 500],
      ] as const)
        await tx.budgetReservation.create({
          data: {
            workspaceId: owner.workspaceId,
            projectId: owner.projectId,
            key: `support:${t4}:draft:${n}`,
            amountMicros: BigInt(amount),
            settledMicros: BigInt(amount),
            category: "support_text",
            state: "settled",
            createdAt: at(36),
          },
        });
    });
  });
  afterAll(async () => {
    delete process.env.ORBIT_SUPPORT;
    await authDb.workspace.deleteMany({ where: { id: { in: workspaces } } });
    await closeDatabase();
  });

  it("matches the hand-computed numbers", async () => {
    const stats = await run((tx) => supportStats(tx, owner, range, at(300)));
    expect(stats.volume).toEqual({
      total: 4,
      byChannel: { email: 2, widget: 2 },
      byInbox: { [mail]: 2, [widget]: 2 },
      byCategory: { deposits: 2, billing: 1, none: 1 },
      byTag: { vip: 2, bug: 1 },
    });
    // First responses: 30, 120, 10 minutes; median 30, mean 53.3.
    expect(stats.firstResponse).toEqual({
      count: 3,
      medianMinutes: 30,
      meanMinutes: 53.3,
    });
    // Resolutions: 120, 240 minutes.
    expect(stats.resolution).toEqual({
      count: 2,
      medianMinutes: 180,
      meanMinutes: 180,
    });
    // Open at minute 300: #3 (age 280 min) and #4 (270 min), both under a day.
    expect(stats.backlog).toEqual({
      open: 2,
      ages: { under1d: 2, d1to3: 0, d3to7: 0, over7d: 0 },
    });
    // One of the two resolved tickets was reopened.
    expect(stats.reopenRate).toBe(0.5);
    // First response by its due time: #1, #4 yes; #2 no. One breach event.
    expect(stats.sla).toEqual({
      firstResponseMet: 2,
      firstResponseMissed: 1,
      attainment: 0.667,
      breaches: 1,
    });
    expect(stats.ai).toEqual({
      drafts: 2,
      draftsSent: 2,
      sentUnchanged: 1,
      sentEdited: 1,
      acceptanceRate: 1,
      withheld: 1,
      handoffs: 1,
      costMicros: 1500,
      costPerTicketMicros: 1500,
    });
  });

  it("filters by inbox and category", async () => {
    const byInbox = await run((tx) =>
      supportStats(tx, owner, { ...range, inboxId: widget }, at(300)),
    );
    expect(byInbox.volume.total).toBe(2);
    const byCategory = await run((tx) =>
      supportStats(tx, owner, { ...range, category: "deposits" }, at(300)),
    );
    expect(byCategory.volume.total).toBe(2);
    expect(byCategory.resolution.count).toBe(2);
    const byTag = await run((tx) =>
      supportStats(tx, owner, { ...range, tag: "vip" }, at(300)),
    );
    expect(byTag.volume.total).toBe(2);
  });

  it("exports the numbers as CSV without content", async () => {
    const stats = await run((tx) => supportStats(tx, owner, range, at(300)));
    const csv = statsCsv(stats);
    expect(csv.split("\n")[0]).toBe("metric,value");
    expect(csv).toContain("volume.total,4");
    expect(csv).toContain("firstResponse.medianMinutes,30");
    expect(csv).toContain("ai.costMicros,1500");
    expect(csv).not.toContain("Deposits take");
  });
});
