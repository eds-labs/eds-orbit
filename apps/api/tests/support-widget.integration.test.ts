import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  authDb,
  closeDatabase,
  scoped,
  type DbTx,
} from "../../../packages/db/src/index.ts";
import type { Scope } from "../../../packages/schemas/src/index.ts";
import { CLIENT_IP_HEADER } from "../src/client-ip.ts";
import { buildServer } from "../src/server.ts";
import { createInbox, updateInbox } from "../src/modules/support/inboxes.ts";
import { enableWidgetKey } from "../src/modules/support/widget.ts";
import {
  noteOnTicket,
  replyToTicket,
} from "../src/modules/support/workspace.ts";

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);
const SITE = "https://desk.example.invalid";

/**
 * The support widget's public API (WP5.4): identities (anonymous and HMAC
 * verified), conversations, messages, handoff and the stream, each visitor
 * limited to their own conversations; agent replies reach the widget.
 */
describe.skipIf(!enabled)("support widget public API", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  let owner: Scope;
  let publicKey = "";
  let widgetSecret = "";
  let widgetInboxId = "";
  const workspaces: string[] = [];
  const run = <T>(fn: (tx: DbTx) => Promise<T>) =>
    scoped(owner.workspaceId, owner.projectId, fn);
  const ip = () =>
    `198.18.${randomBytes(1)[0]}.${(randomBytes(1)[0]! % 254) + 1}`;
  const call = (
    method: "GET" | "POST",
    path: string,
    options: { token?: string; payload?: object; origin?: string } = {},
  ) =>
    app.inject({
      method,
      url: `/api/public/support/${publicKey}${path}`,
      headers: {
        origin: options.origin ?? SITE,
        [CLIENT_IP_HEADER]: ip(),
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      },
      ...(options.payload ? { payload: options.payload } : {}),
    });
  const visitor = async () => {
    const response = await call("POST", "/session");
    expect(response.statusCode).toBe(201);
    return response.json().token as string;
  };
  const sign = (userId: string) =>
    createHmac("sha256", widgetSecret).update(userId).digest("hex");

  beforeAll(async () => {
    Object.assign(process.env, {
      ORBIT_SUPPORT: "true",
      ORBIT_PUBLIC_INGRESS: "true",
    });
    app = await buildServer();
    const workspace = await authDb.workspace.create({
      data: { name: "Synthetic support widget" },
    });
    workspaces.push(workspace.id);
    const project = await authDb.project.create({
      data: { workspaceId: workspace.id, name: "Synthetic support widget" },
    });
    owner = {
      workspaceId: workspace.id,
      projectId: project.id,
      userId: "owner-setup",
      role: "owner",
    };
    const inboxId = await run(async (tx) => {
      await tx.projectModule.create({
        data: {
          workspaceId: owner.workspaceId,
          projectId: owner.projectId,
          moduleId: "support",
          enabled: true,
          moduleVersion: "1.0.0",
        },
      });
      const created = await createInbox(tx, owner, {
        name: "Desk app",
        channels: ["widget"],
        allowedOrigins: [SITE],
      });
      widgetSecret = created.widgetSecret!;
      return created.inbox.id;
    });
    widgetInboxId = inboxId;
    publicKey = (await enableWidgetKey(owner, inboxId)).publicKey;
  });
  afterEach(() => {
    Object.assign(process.env, {
      ORBIT_SUPPORT: "true",
      ORBIT_PUBLIC_INGRESS: "true",
    });
  });
  afterAll(async () => {
    delete process.env.ORBIT_SUPPORT;
    delete process.env.ORBIT_PUBLIC_INGRESS;
    await authDb.workspace.deleteMany({ where: { id: { in: workspaces } } });
    await app?.close();
    await closeDatabase();
  });

  it("lets an anonymous visitor open a conversation that only they can read", async () => {
    const token = await visitor();
    const identify = await call("POST", "/identify", {
      token,
      payload: { email: "visitor@example.org", name: "Vera" },
    });
    expect(identify.statusCode).toBe(200);
    expect(identify.json()).toMatchObject({ verified: false });
    const opened = await call("POST", "/conversations", {
      token,
      payload: { bodyText: "How do I reset my password?" },
    });
    expect(opened.statusCode).toBe(200);
    const ticketId = opened.json().ticketId as string;
    const ticket = await run((tx) =>
      tx.supportTicket.findUniqueOrThrow({ where: { id: ticketId } }),
    );
    expect(ticket).toMatchObject({ channel: "widget", status: "new" });
    const mine = await call("GET", "/conversations", { token });
    expect(mine.json().items.map((c: any) => c.ticketId)).toEqual([ticketId]);

    const stranger = await visitor();
    await call("POST", "/identify", {
      token: stranger,
      payload: { email: "visitor@example.org" },
    });
    expect(
      (await call("GET", "/conversations", { token: stranger })).json().items,
    ).toEqual([]);
    const peek = await call("GET", `/messages?ticket=${ticketId}`, {
      token: stranger,
    });
    expect(peek.statusCode).toBe(404);
  });

  it("verifies signed users, keeps their history across sessions and refuses bad signatures", async () => {
    const first = await visitor();
    const ok = await call("POST", "/identify", {
      token: first,
      payload: {
        externalUserId: "desk-user-1",
        signature: sign("desk-user-1"),
        email: "dana@example.org",
      },
    });
    expect(ok.json()).toMatchObject({ verified: true });
    const opened = await call("POST", "/conversations", {
      token: first,
      payload: { bodyText: "My deposit is missing." },
    });
    const ticketId = opened.json().ticketId as string;

    const later = await visitor();
    await call("POST", "/identify", {
      token: later,
      payload: {
        externalUserId: "desk-user-1",
        signature: sign("desk-user-1"),
      },
    });
    expect(
      (await call("GET", "/conversations", { token: later }))
        .json()
        .items.map((c: any) => c.ticketId),
    ).toContain(ticketId);

    const forged = await visitor();
    const bad = await call("POST", "/identify", {
      token: forged,
      payload: {
        externalUserId: "desk-user-1",
        signature: sign("desk-user-2"),
      },
    });
    expect(bad.statusCode).toBe(403);
    expect(bad.json().error.code).toBe("SIGNATURE_INVALID");
    expect(
      (await call("GET", `/messages?ticket=${ticketId}`, { token: forged }))
        .statusCode,
    ).toBe(404);
  });

  it("shows agent replies but never internal notes, and appends customer messages", async () => {
    const token = await visitor();
    await call("POST", "/identify", {
      token,
      payload: { email: "chat@example.org" },
    });
    const ticketId = (
      await call("POST", "/conversations", {
        token,
        payload: { bodyText: "Hello?" },
      })
    ).json().ticketId as string;
    // The visitor is online (they just wrote), so the reply is delivered in the widget.
    await call("GET", `/messages?ticket=${ticketId}`, { token });
    const agent = { ...owner, userId: "agent-1" };
    const reply = await run((tx) =>
      replyToTicket(tx, agent, ticketId, { bodyText: "Hi, how can we help?" }),
    );
    expect(reply.deliveryState).toBe("sent");
    await run((tx) =>
      noteOnTicket(tx, agent, ticketId, { bodyText: "Secret internal note" }),
    );
    await call("POST", "/messages", {
      token,
      payload: { ticketId, bodyText: "I need a human." },
    });
    const messages = await call("GET", `/messages?ticket=${ticketId}`, {
      token,
    });
    const items = messages.json().items as Array<{
      id: number;
      from: string;
      bodyText: string;
    }>;
    expect(items.map((m) => [m.from, m.bodyText])).toEqual([
      ["customer", "Hello?"],
      ["agent", "Hi, how can we help?"],
      ["customer", "I need a human."],
    ]);
    expect(messages.body).not.toContain("Secret internal note");
    const newer = await call(
      "GET",
      `/messages?ticket=${ticketId}&after=${items[1]!.id}`,
      { token },
    );
    expect(newer.json().items.map((m: any) => m.bodyText)).toEqual([
      "I need a human.",
    ]);
  });

  it("hands off to a human", async () => {
    const token = await visitor();
    await call("POST", "/identify", {
      token,
      payload: { email: "h@example.org" },
    });
    const ticketId = (
      await call("POST", "/conversations", {
        token,
        payload: { bodyText: "Bot?" },
      })
    ).json().ticketId as string;
    const handoff = await call("POST", "/handoff", {
      token,
      payload: { ticketId },
    });
    expect(handoff.statusCode).toBe(200);
    const ticket = await run((tx) =>
      tx.supportTicket.findUniqueOrThrow({ where: { id: ticketId } }),
    );
    expect(ticket).toMatchObject({ aiState: "handed_off", status: "open" });
    const events = await run((tx) =>
      tx.supportTicketEvent.findMany({ where: { ticketId, type: "handoff" } }),
    );
    expect(events).toHaveLength(1);
  });

  it("streams a conversation with the CORS header and Last-Event-ID resume", async () => {
    const token = await visitor();
    await call("POST", "/identify", {
      token,
      payload: { email: "s@example.org" },
    });
    const ticketId = (
      await call("POST", "/conversations", {
        token,
        payload: { bodyText: "One" },
      })
    ).json().ticketId as string;
    await call("POST", "/messages", {
      token,
      payload: { ticketId, bodyText: "Two" },
    });
    // A closed conversation ends its stream after the replay.
    await run((tx) =>
      tx.supportTicket.update({
        where: { id: ticketId },
        data: { status: "closed" },
      }),
    );
    const stream = await app.inject({
      method: "GET",
      url: `/api/public/support/${publicKey}/stream?ticket=${ticketId}`,
      headers: {
        origin: SITE,
        [CLIENT_IP_HEADER]: ip(),
        authorization: `Bearer ${token}`,
        "last-event-id": "1",
      },
    });
    expect(stream.statusCode).toBe(200);
    expect(stream.headers["access-control-allow-origin"]).toBe(SITE);
    expect(stream.headers["content-type"]).toContain("text/event-stream");
    expect(stream.body).toContain("id: 2");
    expect(stream.body).not.toContain("id: 1\n");
    expect(stream.body).toContain("Two");
  });

  it("requires an identity, refuses foreign origins and answers 404 while support is off", async () => {
    const token = await visitor();
    const anonymous = await call("POST", "/conversations", {
      token,
      payload: { bodyText: "No identity" },
    });
    expect(anonymous.statusCode).toBe(409);
    expect(anonymous.json().error.code).toBe("IDENTITY_REQUIRED");
    const foreign = await call("GET", "/conversations", {
      token,
      origin: "https://evil.example.invalid",
    });
    expect(foreign.statusCode).toBe(403);
    delete process.env.ORBIT_SUPPORT;
    expect((await call("GET", "/conversations", { token })).statusCode).toBe(
      404,
    );
  });

  it("caps conversations per anonymous session (WP5.8)", async () => {
    const token = await visitor();
    await call("POST", "/identify", {
      token,
      payload: { email: "many@example.org" },
    });
    const statuses = [];
    for (let i = 0; i < 6; i++)
      statuses.push(
        (
          await call("POST", "/conversations", {
            token,
            payload: { bodyText: `Question ${i}` },
          })
        ).statusCode,
      );
    expect(statuses.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
    expect(statuses[5]).toBe(429);
  });

  it("touches a session's last-seen time without a new version per request (review fix 12)", async () => {
    const token = await visitor();
    await call("POST", "/identify", {
      token,
      payload: { email: "seen@example.org" },
    });
    for (let i = 0; i < 5; i++) await call("GET", "/conversations", { token });
    const versions = await run(async (tx) => {
      const row = await tx.entity.findFirstOrThrow({
        where: { kind: "support_widget_sessions" },
        orderBy: { createdAt: "desc" },
      });
      return tx.entityVersion.count({ where: { entityId: row.id } });
    });
    expect(versions).toBeLessThanOrEqual(2);
  });

  it("keeps the widget key's origins in step with the inbox and revokes it with the widget (review fix 10)", async () => {
    const NEW_SITE = "https://app.example.invalid";
    const inbox = await run((tx) =>
      tx.supportInbox.findUniqueOrThrow({ where: { id: widgetInboxId } }),
    );
    await run((tx) =>
      updateInbox(tx, owner, widgetInboxId, {
        version: inbox.version,
        allowedOrigins: [NEW_SITE],
      }),
    );
    expect((await call("POST", "/session", { origin: SITE })).statusCode).toBe(
      403,
    );
    expect(
      (await call("POST", "/session", { origin: NEW_SITE })).statusCode,
    ).toBe(201);
    const current = await run((tx) =>
      tx.supportInbox.findUniqueOrThrow({ where: { id: widgetInboxId } }),
    );
    await run((tx) =>
      updateInbox(tx, owner, widgetInboxId, {
        version: current.version,
        channels: ["email"],
        emailAddress: "w@example.invalid",
      }),
    );
    expect(
      (await call("POST", "/session", { origin: NEW_SITE })).statusCode,
    ).toBe(404);
  });
});
