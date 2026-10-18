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
import { createInbox } from "../src/modules/support/inboxes.ts";
import { createTicket } from "../src/modules/support/tickets.ts";
import type { NormalizedInbound } from "../src/modules/support/channels/adapter.ts";
import { createMailInbox } from "./fixtures/mailbox.ts";

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);

/**
 * The agent workspace API (WP5.2): lists and search, the timeline, replies,
 * notes, field changes with events, merges, contacts and assignable agents.
 */
describe.skipIf(!enabled)("support workspace API", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  let owner: Scope;
  let inboxId = "";
  const ids = { owner: "", editor: "", viewer: "" };
  const cookies = { owner: "", editor: "", viewer: "" };
  const users: string[] = [];
  const workspaces: string[] = [];
  const origin = process.env.APP_ORIGIN!;
  const ip = () =>
    `198.18.${randomBytes(1)[0]}.${(randomBytes(1)[0]! % 254) + 1}`;
  const call = (
    who: keyof typeof ids,
    method: "GET" | "POST" | "PATCH",
    url: string,
    payload?: object,
  ) =>
    app.inject({
      method,
      url: `/api/projects/${owner.projectId}/support${url}`,
      headers: { origin, cookie: cookies[who], [CLIENT_IP_HEADER]: ip() },
      ...(payload ? { payload } : {}),
    });
  const run = <T>(fn: Parameters<typeof scoped<T>>[2]) =>
    scoped(owner.workspaceId, owner.projectId, fn);
  const inbound = (
    over: Partial<NormalizedInbound> = {},
  ): NormalizedInbound => ({
    externalId: `<${randomUUID()}@mail.example.invalid>`,
    contact: { email: "anna@example.invalid", name: "Anna Example" },
    subject: "Withdrawal pending",
    bodyText: "My withdrawal has been pending for two days.",
    attachments: [],
    ...over,
  });
  const ticket = (over: Partial<NormalizedInbound> = {}) =>
    run((tx) =>
      createTicket(tx, owner, {
        inboxId,
        channel: "email",
        inbound: inbound(over),
      }),
    );
  const supportFile = (moduleId = "support") =>
    run((tx) => {
      const id = randomUUID();
      return tx.file.create({
        data: {
          id,
          workspaceId: owner.workspaceId,
          projectId: owner.projectId,
          moduleId,
          key: `projects/${owner.projectId}/${moduleId}/${id}`,
          name: "screenshot.png",
          mime: "image/png",
          size: 3,
          sha256: "0".repeat(64),
          encryption: "aes-256-gcm/v1",
          createdBy: owner.userId,
        },
      });
    });

  beforeAll(async () => {
    process.env.ORBIT_SUPPORT = "true";
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
        name: "Synthetic support workspace",
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
      data: { workspaceId: workspace.id, name: "Synthetic support workspace" },
    });
    for (const [who, role] of [
      ["editor", "editor"],
      ["viewer", "viewer"],
    ] as const)
      await authDb.projectMember.create({
        data: {
          workspaceId: workspace.id,
          projectId: project.id,
          userId: ids[who],
          role,
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
  afterEach(() => {
    process.env.ORBIT_SUPPORT = "true";
  });
  afterAll(async () => {
    delete process.env.ORBIT_SUPPORT;
    await authDb.workspace.deleteMany({ where: { id: { in: workspaces } } });
    await authDb.user.deleteMany({ where: { id: { in: users } } });
    await app?.close();
    await closeDatabase();
  });

  it("lists, filters and searches tickets with a cursor", async () => {
    const created = [];
    for (let i = 0; i < 3; i++)
      created.push(
        await ticket({
          subject: `List ${i}`,
          contact: { email: `list${i}@example.invalid` },
          bodyText: i === 1 ? "The quokka wallet shows zero" : "Other text",
        }),
      );
    const page = await call("viewer", "GET", "/tickets?view=all&limit=2");
    expect(page.statusCode).toBe(200);
    expect(page.json().items).toHaveLength(2);
    expect(page.json().nextCursor).toEqual(expect.any(String));
    const next = await call(
      "viewer",
      "GET",
      `/tickets?view=all&limit=2&cursor=${encodeURIComponent(page.json().nextCursor)}`,
    );
    const seen = [...page.json().items, ...next.json().items].map(
      (t: any) => t.id,
    );
    expect(new Set(seen).size).toBe(seen.length);

    const search = await call("viewer", "GET", "/tickets?view=all&q=quokka");
    expect(search.json().items.map((t: any) => t.id)).toEqual([
      created[1]!.ticketId,
    ]);
    const byContact = await call(
      "viewer",
      "GET",
      "/tickets?view=all&q=list2%40example",
    );
    expect(byContact.json().items.map((t: any) => t.id)).toEqual([
      created[2]!.ticketId,
    ]);
    const unassigned = await call("viewer", "GET", "/tickets?view=unassigned");
    expect(unassigned.json().items.length).toBeGreaterThanOrEqual(3);
    const mine = await call("editor", "GET", "/tickets?view=mine");
    expect(mine.json().items).toEqual([]);
    expect(
      (await call("viewer", "GET", "/tickets?view=all&limit=500")).statusCode,
    ).toBe(400);
  });

  it("replies, writes notes and moves the status, with events", async () => {
    const t = await ticket();
    const reply = await call(
      "editor",
      "POST",
      `/tickets/${t.ticketId}/replies`,
      {
        bodyText: "We are looking into it.",
      },
    );
    expect(reply.statusCode).toBe(200);
    expect(reply.json()).toMatchObject({
      kind: "agent_reply",
      visibleToCustomer: true,
      // No mailbox in this project: the e-mail channel cannot send (WP5.3).
      deliveryState: "not_sent",
      channel: "email",
    });
    const note = await call("editor", "POST", `/tickets/${t.ticketId}/notes`, {
      bodyText: "Checked the payout queue.",
    });
    expect(note.json()).toMatchObject({
      kind: "internal_note",
      visibleToCustomer: false,
    });
    const view = await call("viewer", "GET", `/tickets/${t.ticketId}`);
    expect(view.statusCode).toBe(200);
    const body = view.json();
    expect(body.ticket).toMatchObject({ status: "pending_customer" });
    expect(body.ticket.firstRespondedAt).toEqual(expect.any(String));
    expect(body.contact).toMatchObject({ email: "anna@example.invalid" });
    const kinds = body.timeline.map((i: any) => i.kind ?? `event:${i.type}`);
    expect(kinds).toEqual([
      "customer",
      "event:created",
      "agent_reply",
      "event:status",
      "internal_note",
    ]);
    expect(
      (
        await call("viewer", "POST", `/tickets/${t.ticketId}/replies`, {
          bodyText: "x",
        })
      ).statusCode,
    ).toBe(403);
  });

  it("changes fields with one event each and recomputes SLA on priority", async () => {
    const t = await ticket();
    const before = await run((tx) =>
      tx.supportTicket.findUniqueOrThrow({ where: { id: t.ticketId } }),
    );
    const changed = await call("editor", "PATCH", `/tickets/${t.ticketId}`, {
      priority: "urgent",
      tags: ["payout"],
      assigneeUserId: ids.editor,
      status: "open",
    });
    expect(changed.statusCode).toBe(200);
    const after = changed.json();
    expect(after).toMatchObject({
      priority: "urgent",
      tags: ["payout"],
      assigneeUserId: ids.editor,
      status: "open",
    });
    // Urgent: first response 240 minutes after creation, resolution 720.
    expect(new Date(after.firstResponseDueAt).getTime()).toBe(
      before.createdAt.getTime() + 240 * 60_000,
    );
    expect(new Date(after.resolutionDueAt).getTime()).toBe(
      before.createdAt.getTime() + 720 * 60_000,
    );
    const events = await run((tx) =>
      tx.supportTicketEvent.findMany({
        where: { ticketId: t.ticketId, type: { not: "created" } },
        orderBy: { type: "asc" },
      }),
    );
    expect(events.map((e) => e.type)).toEqual([
      "assignee",
      "priority",
      "status",
      "tags",
    ]);
    const mine = await call("editor", "GET", "/tickets?view=mine");
    expect(mine.json().items.map((i: any) => i.id)).toContain(t.ticketId);

    const resolved = await call("editor", "PATCH", `/tickets/${t.ticketId}`, {
      status: "resolved",
    });
    expect(resolved.json().resolvedAt).toEqual(expect.any(String));
    const reopened = await call("editor", "PATCH", `/tickets/${t.ticketId}`, {
      status: "open",
    });
    expect(reopened.json().resolvedAt).toBeNull();
  });

  it("assigns only support agents and lists them", async () => {
    const t = await ticket();
    const agents = await call("viewer", "GET", "/agents");
    expect(
      agents
        .json()
        .items.map((a: any) => a.userId)
        .sort(),
    ).toEqual([ids.owner, ids.editor].sort());
    const refused = await call("editor", "PATCH", `/tickets/${t.ticketId}`, {
      assigneeUserId: ids.viewer,
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe("ASSIGNEE_NOT_AGENT");
  });

  it("merges contacts, then their tickets, and never tickets of two contacts", async () => {
    const a = await ticket({ contact: { email: "merge-a@example.invalid" } });
    const b = await ticket({ contact: { email: "merge-b@example.invalid" } });
    // Two customers' conversations never end up in one ticket (review fix 2).
    const across = await call(
      "editor",
      "POST",
      `/tickets/${a.ticketId}/merge`,
      {
        intoTicketId: b.ticketId,
      },
    );
    expect(across.statusCode).toBe(409);
    expect(across.json().error.code).toBe("MERGE_CONTACT_MISMATCH");

    const contactMerge = await call(
      "editor",
      "POST",
      `/contacts/${a.contactId}/merge`,
      { intoContactId: b.contactId },
    );
    expect(contactMerge.statusCode).toBe(200);
    const contact = await call("viewer", "GET", `/contacts/${b.contactId}`);
    expect(
      contact
        .json()
        .tickets.map((t: any) => t.id)
        .sort(),
    ).toEqual([a.ticketId, b.ticketId].sort());
    const list = await call("viewer", "GET", "/contacts?q=merge-a");
    expect(list.json().items).toEqual([]);
    // The tombstone keeps nothing personal.
    const tomb = await run((tx) =>
      tx.supportContact.findUniqueOrThrow({ where: { id: a.contactId } }),
    );
    expect(tomb).toMatchObject({
      email: null,
      name: null,
      claimedEmail: null,
      notes: null,
    });

    const merged = await call(
      "editor",
      "POST",
      `/tickets/${a.ticketId}/merge`,
      {
        intoTicketId: b.ticketId,
      },
    );
    expect(merged.statusCode).toBe(200);
    const source = await call("viewer", "GET", `/tickets/${a.ticketId}`);
    expect(source.json().ticket).toMatchObject({
      status: "closed",
      mergedIntoTicketId: b.ticketId,
    });
    const target = await call("viewer", "GET", `/tickets/${b.ticketId}`);
    expect(
      target.json().timeline.filter((i: any) => i.kind === "customer"),
    ).toHaveLength(2);
    expect(
      (
        await call("editor", "POST", `/tickets/${b.ticketId}/merge`, {
          intoTicketId: b.ticketId,
        })
      ).statusCode,
    ).toBe(409);
    const renamed = await call("editor", "PATCH", `/contacts/${b.contactId}`, {
      name: "Bea Merged",
      notes: "VIP",
    });
    expect(renamed.json()).toMatchObject({ name: "Bea Merged", notes: "VIP" });
  });

  it("attaches only live support files of the project to replies", async () => {
    const t = await ticket();
    const own = await supportFile();
    const ok = await call("editor", "POST", `/tickets/${t.ticketId}/replies`, {
      bodyText: "See the screenshot.",
      fileIds: [own.id],
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().attachments).toMatchObject([
      { fileId: own.id, name: "screenshot.png" },
    ]);
    const marketing = await supportFile("marketing");
    for (const fileId of [marketing.id, randomUUID()]) {
      const refused = await call(
        "editor",
        "POST",
        `/tickets/${t.ticketId}/replies`,
        { bodyText: "x", fileIds: [fileId] },
      );
      expect(refused.statusCode).toBe(400);
      expect(refused.json().error.code).toBe("ATTACHMENT_INVALID");
    }
  });

  it("answers 404 while support is off and keeps text out of audit and events", async () => {
    const t = await ticket({ bodyText: "Private body zqxmarker" });
    await call("editor", "POST", `/tickets/${t.ticketId}/replies`, {
      bodyText: "Private reply zqxmarker",
    });
    await call("editor", "POST", `/tickets/${t.ticketId}/notes`, {
      bodyText: "Private note zqxmarker",
    });
    const rows = await run(async (tx) => ({
      audits: await tx.auditEvent.findMany({
        where: {
          projectId: owner.projectId,
          action: { startsWith: "support." },
        },
      }),
      events: await tx.supportTicketEvent.findMany({
        where: { projectId: owner.projectId },
      }),
    }));
    // A marker with letters beyond hex never matches a random id by chance.
    expect(JSON.stringify(rows)).not.toMatch(/zqxmarker|anna@example/);
    delete process.env.ORBIT_SUPPORT;
    expect((await call("owner", "GET", "/tickets")).statusCode).toBe(404);
  });

  it("summarizes open, unassigned, at-risk and breached tickets", async () => {
    const before = (await call("viewer", "GET", "/summary")).json();
    const risky = await ticket();
    const late = await ticket();
    const now = Date.now();
    await run(async (tx) => {
      await tx.supportTicket.update({
        where: { id: risky.ticketId },
        data: { firstResponseDueAt: new Date(now + 30 * 60_000) },
      });
      await tx.supportTicket.update({
        where: { id: late.ticketId },
        data: { firstResponseDueAt: new Date(now - 60_000) },
      });
    });
    const after = (await call("viewer", "GET", "/summary")).json();
    expect(after.open - before.open).toBe(2);
    expect(after.unassigned - before.unassigned).toBe(2);
    expect(after.atRisk - before.atRisk).toBe(1);
    expect(after.breached - before.breached).toBe(1);
  });
});
