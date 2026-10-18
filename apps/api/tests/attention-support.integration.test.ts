import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  authDb,
  closeDatabase,
  scoped,
} from "../../../packages/db/src/index.ts";
import type { Scope } from "../../../packages/schemas/src/index.ts";
import { makeAuth } from "../src/auth.ts";
import { CLIENT_IP_HEADER } from "../src/client-ip.ts";
import { buildServer } from "../src/server.ts";
import { createTicket } from "../src/modules/support/tickets.ts";
import type { AttentionResponse } from "../src/platform/attention/types.ts";
import { createMailInbox } from "./fixtures/mailbox.ts";

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);

const MINUTE = 60_000;

/**
 * The support module's attention items (UI restructure §4.1): SLA breaches,
 * tickets at risk and the unassigned ones, in the project's attention route.
 */
describe.skipIf(!enabled)("support attention items", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  let owner: Scope;
  let inboxId = "";
  const ids = { owner: "", viewer: "" };
  const cookies = { owner: "", viewer: "" };
  const users: string[] = [];
  const workspaces: string[] = [];
  const origin = process.env.APP_ORIGIN!;
  const ip = () =>
    `198.18.${randomBytes(1)[0]}.${(randomBytes(1)[0]! % 254) + 1}`;
  const run = <T>(fn: Parameters<typeof scoped<T>>[2]) =>
    scoped(owner.workspaceId, owner.projectId, fn);
  const get = async <T>(who: keyof typeof cookies, path: string) => {
    const response = await app.inject({
      method: "GET",
      url: `/api/projects/${owner.projectId}${path}`,
      headers: { origin, cookie: cookies[who], [CLIENT_IP_HEADER]: ip() },
    });
    expect(response.statusCode).toBe(200);
    return response.json() as T;
  };
  const attention = (who: keyof typeof cookies = "owner") =>
    get<AttentionResponse>(who, "/attention");
  const supportItems = async (who: keyof typeof cookies = "owner") =>
    (await attention(who)).items.filter((i) => i.moduleId === "support");

  /**
   * A ticket with exactly the given clocks and fields; unset clocks lie far
   * ahead (a null clock is not what real tickets have, and the summary's
   * Prisma predicate drops tickets with one).
   */
  const make = async (data: Record<string, unknown> = {}) => {
    const created = await run((tx) =>
      createTicket(tx, owner, {
        inboxId,
        channel: "email",
        inbound: {
          externalId: `<${randomUUID()}@mail.example.invalid>`,
          contact: { email: `${randomUUID()}@example.invalid`, name: "Anna" },
          subject: "Withdrawal pending",
          bodyText: "My withdrawal has been pending for two days.",
          attachments: [],
        },
      }),
    );
    await run((tx) =>
      tx.supportTicket.update({
        where: { id: created.ticketId },
        data: {
          firstResponseDueAt: at(1000),
          resolutionDueAt: at(1000),
          assigneeUserId: owner.userId,
          ...data,
        },
      }),
    );
    return created.ticketId;
  };
  const at = (minutes: number) => new Date(Date.now() + minutes * MINUTE);

  beforeAll(async () => {
    process.env.ORBIT_SUPPORT = "true";
    app = await buildServer();
    const accounts: Record<string, { email: string; password: string }> = {};
    for (const who of ["owner", "viewer"] as const) {
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
        name: "Synthetic support attention",
        members: {
          create: [
            { userId: ids.owner, role: "owner" },
            { userId: ids.viewer, role: "viewer" },
          ],
        },
      },
    });
    workspaces.push(workspace.id);
    const project = await authDb.project.create({
      data: { workspaceId: workspace.id, name: "Synthetic support attention" },
    });
    await authDb.projectMember.create({
      data: {
        workspaceId: workspace.id,
        projectId: project.id,
        userId: ids.viewer,
        role: "viewer",
      },
    });
    owner = {
      workspaceId: workspace.id,
      projectId: project.id,
      userId: ids.owner,
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
      inboxId = (
        await createMailInbox(tx, owner, {
          name: "Mail",
          channels: ["email"],
          emailAddress: "support@example.invalid",
        })
      ).inbox.id;
    });
    for (const who of ["owner", "viewer"] as const) {
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
  afterEach(async () => {
    process.env.ORBIT_SUPPORT = "true";
    // Each test starts from an empty project.
    await run((tx) => tx.supportTicket.deleteMany({}));
  });
  afterAll(async () => {
    delete process.env.ORBIT_SUPPORT;
    await authDb.workspace.deleteMany({ where: { id: { in: workspaces } } });
    await authDb.user.deleteMany({ where: { id: { in: users } } });
    await app?.close();
    await closeDatabase();
  });

  it("a breached ticket is critical with its dueAt", async () => {
    const due = at(-10);
    const id = await make({ firstResponseDueAt: due, assigneeUserId: null });
    const items = await supportItems();
    const breached = items.find((i) => i.id === `support:sla:${id}`);
    expect(breached).toEqual({
      id: `support:sla:${id}`,
      moduleId: "support",
      kind: "support_sla_breached",
      severity: "critical",
      dueAt: due.toISOString(),
      params: {
        number: expect.any(Number),
        subject: "Withdrawal pending",
        channel: "email",
        assigned: false,
      },
      navKey: "support-tickets",
      link: `/support/tickets?ticket=${id}`,
    });
  });

  it("a ticket due within 60 minutes is a warning; later ones are not listed", async () => {
    const soon = await make({ firstResponseDueAt: at(30) });
    await make({ firstResponseDueAt: at(90) });
    const items = await supportItems();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: `support:sla:${soon}`,
      kind: "support_sla_at_risk",
      severity: "warning",
      params: { assigned: true },
      link: `/support/tickets?ticket=${soon}`,
    });
  });

  it("uses the earliest pending clock as dueAt", async () => {
    const first = at(-5);
    const id = await make({
      firstResponseDueAt: at(-1),
      resolutionDueAt: first,
    });
    const [item] = await supportItems();
    expect(item).toMatchObject({ id: `support:sla:${id}` });
    expect(item!.dueAt).toBe(first.toISOString());
  });

  it("aggregates unassigned tickets with the oldest since", async () => {
    const oldest = await make({
      assigneeUserId: null,
      createdAt: new Date("2026-10-01T08:00:00.000Z"),
    });
    await make({
      assigneeUserId: null,
      status: "pending_customer",
      createdAt: new Date("2026-10-05T08:00:00.000Z"),
    });
    await make({ assigneeUserId: null });
    // Assigned, resolved and merged tickets do not count.
    await make();
    await make({ assigneeUserId: null, status: "resolved" });
    await make({ assigneeUserId: null, mergedIntoTicketId: oldest });
    const items = await supportItems();
    expect(items).toEqual([
      {
        id: "support:unassigned",
        moduleId: "support",
        kind: "support_unassigned",
        severity: "warning",
        count: 3,
        since: "2026-10-01T08:00:00.000Z",
        params: {},
        navKey: "support-tickets",
        link: "/support/tickets",
      },
    ]);
    expect((await attention()).counts["support-tickets"]).toBe(3);
  });

  it("emits no unassigned item when every open ticket is assigned", async () => {
    await make();
    expect(await supportItems()).toEqual([]);
  });

  it("lists at most five tickets per SLA kind, earliest due first", async () => {
    const breached: string[] = [];
    for (let n = 0; n < 7; n++)
      breached.push(await make({ firstResponseDueAt: at(-70 + n) }));
    const risky: string[] = [];
    for (let n = 0; n < 6; n++)
      risky.push(await make({ resolutionDueAt: at(10 + n) }));
    const items = await supportItems();
    expect(
      items.filter((i) => i.kind === "support_sla_breached").map((i) => i.id),
    ).toEqual(breached.slice(0, 5).map((id) => `support:sla:${id}`));
    expect(
      items.filter((i) => i.kind === "support_sla_at_risk").map((i) => i.id),
    ).toEqual(risky.slice(0, 5).map((id) => `support:sla:${id}`));
  });

  it("merged, resolved and closed tickets never appear", async () => {
    const target = await make();
    const due = { firstResponseDueAt: at(-10), resolutionDueAt: at(-5) };
    await make({ ...due, mergedIntoTicketId: target });
    await make({ ...due, status: "resolved", resolvedAt: at(-1) });
    await make({ ...due, status: "closed" });
    // Waiting on the customer stops the SLA clock.
    await make({ ...due, status: "pending_customer" });
    expect(await supportItems()).toEqual([]);
  });

  it("a responded first clock no longer counts", async () => {
    await make({
      firstResponseDueAt: at(-10),
      firstRespondedAt: at(-20),
      resolutionDueAt: at(300),
    });
    expect(await supportItems()).toEqual([]);
  });

  it("agrees with /support/summary on breached and at risk", async () => {
    await make({ firstResponseDueAt: at(-30), assigneeUserId: null });
    await make({ resolutionDueAt: at(-1) });
    await make({ firstResponseDueAt: at(20), resolutionDueAt: at(-2) });
    await make({ firstResponseDueAt: at(45) });
    await make({ resolutionDueAt: at(59) });
    await make({ firstResponseDueAt: at(500) });
    await make({ status: "pending_customer", firstResponseDueAt: at(-30) });
    const summary = await get<{
      breached: number;
      atRisk: number;
      unassigned: number;
    }>("viewer", "/support/summary");
    const items = await supportItems("viewer");
    const kinds = (kind: string) => items.filter((i) => i.kind === kind);
    expect(summary).toMatchObject({ breached: 3, atRisk: 2 });
    expect(kinds("support_sla_breached")).toHaveLength(summary.breached);
    expect(kinds("support_sla_at_risk")).toHaveLength(summary.atRisk);
    expect(kinds("support_unassigned")[0]?.count ?? 0).toBe(summary.unassigned);
  });

  it("puts no message text or customer address into params", async () => {
    await make({ firstResponseDueAt: at(-10) });
    const text = JSON.stringify(await supportItems());
    expect(text).not.toContain("withdrawal has been pending");
    expect(text).not.toContain("@example.invalid");
  });

  it("gives nothing while support is off in the project", async () => {
    await make({ firstResponseDueAt: at(-10), assigneeUserId: null });
    expect((await supportItems()).length).toBeGreaterThan(0);
    process.env.ORBIT_SUPPORT = "false";
    expect(await supportItems()).toEqual([]);
    process.env.ORBIT_SUPPORT = "true";
    await run((tx) =>
      tx.projectModule.updateMany({
        where: { moduleId: "support" },
        data: { enabled: false },
      }),
    );
    try {
      expect(await supportItems()).toEqual([]);
    } finally {
      await run((tx) =>
        tx.projectModule.updateMany({
          where: { moduleId: "support" },
          data: { enabled: true },
        }),
      );
    }
  });
});
