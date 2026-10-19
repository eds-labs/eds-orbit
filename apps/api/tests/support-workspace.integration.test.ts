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
    method: "GET" | "POST" | "PATCH" | "PUT",
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
    ]);
    // Private notes/drafts now require support.notes.read on native and MCP
    // paths alike: viewers keep public correspondence, agents keep notes.
    const agentView = await call("editor", "GET", `/tickets/${t.ticketId}`);
    expect(
      agentView.json().timeline.some((m: any) => m.kind === "internal_note"),
    ).toBe(true);
    expect(JSON.stringify(body)).not.toContain("Checked the payout queue.");
    expect(
      (
        await call("viewer", "POST", `/tickets/${t.ticketId}/replies`, {
          bodyText: "x",
        })
      ).statusCode,
    ).toBe(403);
  });

  /** Saves the project's tag list (owner), keeping the other settings. */
  const defineTags = async (
    tags: Array<{ key: string; label: string; color: string }>,
  ) => {
    const current = (await call("owner", "GET", "/settings")).json();
    return call("owner", "PUT", "/settings", {
      settings: { ...current.settings, tags },
      version: current.version,
    });
  };

  it("keeps a coloured tag list; tickets take listed tags and filter by them", async () => {
    // Only the fixed palette is accepted.
    expect(
      (await defineTags([{ key: "vip", label: "VIP", color: "chartreuse" }]))
        .statusCode,
    ).toBe(400);
    expect(
      (
        await defineTags([
          { key: "vip", label: "VIP", color: "purple" },
          { key: "bug", label: "Bug", color: "red" },
        ])
      ).statusCode,
    ).toBe(200);
    const one = await ticket({ subject: "Tagged one" });
    const two = await ticket({ subject: "Tagged two" });
    const unknown = await call("editor", "PATCH", `/tickets/${one.ticketId}`, {
      tags: ["vip", "nope"],
    });
    expect(unknown.statusCode).toBe(409);
    expect(unknown.json().error.code).toBe("TAG_UNKNOWN");
    expect(
      (
        await call("editor", "PATCH", `/tickets/${one.ticketId}`, {
          tags: ["vip"],
        })
      ).json().tags,
    ).toEqual(["vip"]);
    // A tag the list no longer has may stay on a ticket; only new ones are checked.
    await run((tx) =>
      tx.supportTicket.update({
        where: { id: two.ticketId },
        data: { tags: ["legacy"] },
      }),
    );
    expect(
      (
        await call("editor", "PATCH", `/tickets/${two.ticketId}`, {
          tags: ["legacy", "bug"],
        })
      ).statusCode,
    ).toBe(200);
    const vip = (await call("editor", "GET", "/tickets?tag=vip")).json();
    expect(vip.items.map((i: { id: string }) => i.id)).toContain(one.ticketId);
    expect(vip.items.map((i: { id: string }) => i.id)).not.toContain(
      two.ticketId,
    );
  });

  it("changes fields with one event each and recomputes SLA on priority", async () => {
    const t = await ticket();
    const before = await run((tx) =>
      tx.supportTicket.findUniqueOrThrow({ where: { id: t.ticketId } }),
    );
    await defineTags([{ key: "payout", label: "Payout", color: "blue" }]);
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

  describe("SLA order and the open filter", () => {
    const HOUR = 3_600_000;
    const base = Date.now() + 10 * 24 * HOUR;
    const due = (hours: number) => new Date(base + hours * HOUR);
    let counter = 0;
    /** A fresh inbox keeps these tickets apart from every other test. */
    const freshInbox = () =>
      run(
        async (tx) =>
          (
            await createMailInbox(tx, owner, {
              name: `Sla ${counter}`,
              channels: ["email"],
              emailAddress: `sla${counter++}@example.invalid`,
            })
          ).inbox.id,
      );
    const make = async (inbox: string, data: Record<string, unknown>) => {
      const created = await run((tx) =>
        createTicket(tx, owner, {
          inboxId: inbox,
          channel: "email",
          inbound: inbound({ contact: { email: `${randomUUID()}@e.invalid` } }),
        }),
      );
      await run((tx) =>
        tx.supportTicket.update({ where: { id: created.ticketId }, data }),
      );
      return created.ticketId;
    };
    const idsOf = (res: { json: () => any }) =>
      res.json().items.map((t: any) => t.id);

    it("sort=sla orders by the earliest open due time and skips resolved tickets", async () => {
      const inbox = await freshInbox();
      const first = await make(inbox, {
        firstResponseDueAt: due(3),
        resolutionDueAt: due(30),
      });
      const second = await make(inbox, {
        firstResponseDueAt: due(1),
        resolutionDueAt: due(30),
      });
      // The resolution clock is earlier than the pending first response.
      const resolutionFirst = await make(inbox, {
        firstResponseDueAt: due(5),
        resolutionDueAt: due(0.5),
      });
      // Responded: only the resolution clock runs.
      const responded = await make(inbox, {
        firstRespondedAt: due(-1),
        firstResponseDueAt: due(0.1),
        resolutionDueAt: due(4),
      });
      const noClock = await make(inbox, {
        firstResponseDueAt: null,
        resolutionDueAt: null,
      });
      const resolved = await make(inbox, {
        status: "resolved",
        firstRespondedAt: due(-2),
        resolvedAt: due(-1),
        resolutionDueAt: due(-3),
      });
      const waiting = await make(inbox, {
        status: "pending_customer",
        firstResponseDueAt: due(0.2),
      });
      const merged = await make(inbox, {
        firstResponseDueAt: due(0.3),
        mergedIntoTicketId: first,
      });
      const res = await call(
        "viewer",
        "GET",
        `/tickets?sort=sla&inboxId=${inbox}`,
      );
      expect(res.statusCode).toBe(200);
      expect(idsOf(res)).toEqual([
        resolutionFirst,
        second,
        first,
        responded,
        noClock,
      ]);
      expect(idsOf(res)).not.toContain(resolved);
      expect(idsOf(res)).not.toContain(waiting);
      expect(idsOf(res)).not.toContain(merged);
      // Other filters combine with the order.
      const mine = await call(
        "viewer",
        "GET",
        `/tickets?sort=sla&inboxId=${inbox}&view=mine`,
      );
      expect(mine.json().items).toEqual([]);
      const byPriority = await call(
        "viewer",
        "GET",
        `/tickets?sort=sla&inboxId=${inbox}&priority=urgent`,
      );
      expect(byPriority.json().items).toEqual([]);
      const byStatus = await call(
        "viewer",
        "GET",
        `/tickets?sort=sla&inboxId=${inbox}&status=resolved`,
      );
      expect(byStatus.json().items).toEqual([]);
    });

    it("sort=sla combines with search, tag, category and assignee filters", async () => {
      const inbox = await freshInbox();
      const hit = await make(inbox, {
        subject: "Quokka 100% sure",
        tags: ["vip"],
        category: "billing",
        assigneeUserId: ids.viewer,
        firstResponseDueAt: due(1),
      });
      await make(inbox, {
        subject: "Quokka 100 sure",
        tags: ["vip"],
        firstResponseDueAt: due(2),
      });
      const get = async (query: string) =>
        (
          await call(
            "viewer",
            "GET",
            `/tickets?sort=sla&inboxId=${inbox}${query}`,
          )
        )
          .json()
          .items.map((t: any) => t.id);
      // A literal percent sign in the search is not a wildcard.
      expect(await get("&q=100%25%20sure")).toEqual([hit]);
      expect(await get("&q=quokka")).toHaveLength(2);
      expect(await get("&q=nomatch")).toEqual([]);
      expect(await get("&tag=vip&category=billing")).toEqual([hit]);
      expect(await get("&view=mine")).toEqual([hit]);
      expect(await get("&view=unassigned")).toHaveLength(1);
    });

    it("openOnly excludes resolved, closed and merged tickets", async () => {
      const inbox = await freshInbox();
      const open = await make(inbox, { status: "open" });
      const pending = await make(inbox, { status: "pending_customer" });
      const resolved = await make(inbox, { status: "resolved" });
      const closed = await make(inbox, { status: "closed" });
      const merged = await make(inbox, { mergedIntoTicketId: open });
      const onlyOpen = await call(
        "viewer",
        "GET",
        `/tickets?openOnly=true&inboxId=${inbox}`,
      );
      expect(idsOf(onlyOpen).sort()).toEqual([open, pending].sort());
      const all = await call("viewer", "GET", `/tickets?inboxId=${inbox}`);
      expect(idsOf(all).sort()).toEqual(
        [open, pending, resolved, closed, merged].sort(),
      );
      const explicit = await call(
        "viewer",
        "GET",
        `/tickets?openOnly=false&inboxId=${inbox}`,
      );
      expect(idsOf(explicit)).toHaveLength(5);
      expect(
        (await call("viewer", "GET", "/tickets?openOnly=yes")).statusCode,
      ).toBe(400);
      expect(
        (await call("viewer", "GET", "/tickets?sort=newest")).statusCode,
      ).toBe(400);
    });

    it("sla cursor pages without duplicates", async () => {
      const inbox = await freshInbox();
      // Equal due times fall back to the id; two tickets have no clock.
      const clock = (hours: number | null) => ({
        firstResponseDueAt: hours === null ? null : due(hours),
        resolutionDueAt: null,
      });
      const tied = [
        await make(inbox, clock(2)),
        await make(inbox, clock(2)),
        await make(inbox, clock(1)),
        await make(inbox, clock(null)),
        await make(inbox, clock(null)),
      ];
      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const res = await call(
          "viewer",
          "GET",
          `/tickets?sort=sla&limit=2&inboxId=${inbox}${
            cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""
          }`,
        );
        expect(res.statusCode).toBe(200);
        seen.push(...idsOf(res));
        cursor = res.json().nextCursor;
        pages++;
      } while (cursor && pages < 5);
      expect(pages).toBe(3);
      expect(new Set(seen).size).toBe(5);
      expect([...seen].sort()).toEqual([...tied].sort());
      // The tied tickets come in id order; the no-clock tickets close the list.
      const byId = (a: string, b: string) => (a < b ? -1 : 1);
      expect(seen.slice(0, 3)).toEqual([
        tied[2],
        ...[tied[0]!, tied[1]!].sort(byId),
      ]);
      expect(seen.slice(3)).toEqual([tied[3]!, tied[4]!].sort(byId));
    });

    it("rejects a cursor of the other sort with CURSOR_INVALID", async () => {
      const inbox = await freshInbox();
      for (let i = 0; i < 2; i++)
        await make(inbox, {
          firstResponseDueAt: due(i),
          resolutionDueAt: null,
        });
      const updated = await call(
        "viewer",
        "GET",
        `/tickets?limit=1&inboxId=${inbox}`,
      );
      const updatedCursor = updated.json().nextCursor as string;
      expect(updatedCursor).toEqual(expect.any(String));
      const wrong = await call(
        "viewer",
        "GET",
        `/tickets?sort=sla&inboxId=${inbox}&cursor=${encodeURIComponent(updatedCursor)}`,
      );
      expect(wrong.statusCode).toBe(400);
      expect(wrong.json().error.code).toBe("CURSOR_INVALID");
      const sla = await call(
        "viewer",
        "GET",
        `/tickets?sort=sla&limit=1&inboxId=${inbox}`,
      );
      const slaCursor = sla.json().nextCursor as string;
      expect(slaCursor).toEqual(expect.any(String));
      const back = await call(
        "viewer",
        "GET",
        `/tickets?inboxId=${inbox}&cursor=${encodeURIComponent(slaCursor)}`,
      );
      expect(back.statusCode).toBe(400);
      expect(back.json().error.code).toBe("CURSOR_INVALID");
    });

    it("counts open tickets per inbox in the summary", async () => {
      const inbox = await freshInbox();
      const other = await freshInbox();
      const open = await make(inbox, { status: "open" });
      await make(inbox, { status: "pending_internal" });
      await make(inbox, { status: "resolved" });
      await make(inbox, { status: "closed" });
      await make(inbox, { status: "open", mergedIntoTicketId: open });
      const summary = (await call("viewer", "GET", "/summary")).json();
      expect(summary.openByInbox[inbox]).toBe(2);
      expect(summary.openByInbox[other]).toBeUndefined();
      expect(
        Object.values<number>(summary.openByInbox).reduce((a, b) => a + b, 0),
      ).toBe(summary.open);
    });
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
