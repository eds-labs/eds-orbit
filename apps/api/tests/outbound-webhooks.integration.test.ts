import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { authDb, closeDatabase, scoped } from "../../../packages/db/src/index.ts";
import type { Scope } from "../../../packages/schemas/src/index.ts";
import { makeAuth } from "../src/auth.ts";
import { CLIENT_IP_HEADER } from "../src/client-ip.ts";
import { buildServer } from "../src/server.ts";
import {
  deliverWebhook,
  DISABLE_AFTER_FAILURES,
  emitWebhookEvent,
  setWebhookFetchForTests,
} from "../src/platform/outbound-webhooks/webhooks.ts";

const enabled = Boolean(process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL);

/**
 * Outbound webhooks (ADR 0029, CH1.3): owners manage endpoints while
 * ORBIT_WEBHOOKS is on; a module's event becomes one signed delivery per
 * subscribed active endpoint; failures back off, 410 and repeated failures
 * disable the endpoint; secrets rotate with an overlap; deliveries replay.
 */
describe.skipIf(!enabled)("outbound webhooks", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  let workspaceId = "";
  let projectId = "";
  let scope: Scope;
  const ids = { owner: "", editor: "" };
  const cookies = { owner: "", editor: "" };
  const users: string[] = [];
  const origin = process.env.APP_ORIGIN!;
  const ip = () => `198.18.${randomBytes(1)[0]}.${(randomBytes(1)[0]! % 254) + 1}`;
  const call = (who: keyof typeof ids, method: "GET" | "POST" | "PATCH", path = "", payload?: object) =>
    app.inject({
      method,
      url: `/api/projects/${projectId}/webhooks${path}`,
      headers: { origin, cookie: cookies[who], [CLIENT_IP_HEADER]: ip() },
      ...(payload ? { payload } : {}),
    });
  const code = (response: { json(): { error?: { code: string } } }) => response.json().error?.code;
  const sent: { url: string; headers: Headers; body: string }[] = [];
  let answer = 200;
  const createEndpoint = async (eventTypes = ["cms.entry.published"]) => {
    const response = await call("owner", "POST", "", {
      ownerModule: "cms",
      name: "FamilyPlan revalidate",
      url: "https://hooks.example.invalid/orbit/revalidate",
      eventTypes,
    });
    expect(response.statusCode).toBe(201);
    return response.json() as { id: string; secret: string; version: number };
  };
  const delivery = (id: string) => scoped(workspaceId, projectId, (tx) => tx.webhookDelivery.findUniqueOrThrow({ where: { id } }));
  const endpointRow = (id: string) => scoped(workspaceId, projectId, (tx) => tx.webhookEndpoint.findUniqueOrThrow({ where: { id } }));
  const emit = () =>
    scoped(workspaceId, projectId, (tx) =>
      emitWebhookEvent(tx, scope, "cms.entry.published", { entry: { id: randomUUID(), path: "/blog/a/" } }),
    );
  const deliveriesOf = (eventId: string) =>
    scoped(workspaceId, projectId, (tx) => tx.webhookDelivery.findMany({ where: { eventId } }));
  const verify = (secret: string, headers: Headers, body: string) =>
    headers
      .get("x-orbit-signature")!
      .split(",")
      .includes(`v1=${createHmac("sha256", secret).update(`${headers.get("x-orbit-timestamp")}.${body}`).digest("hex")}`);

  beforeAll(async () => {
    app = await buildServer();
    const accounts: Record<string, { email: string; password: string }> = {};
    for (const who of ["owner", "editor"] as const) {
      const email = `${randomUUID()}@example.invalid`;
      const password = randomBytes(24).toString("base64url");
      const created = await makeAuth().api.signUpEmail({ body: { email, name: `Synthetic hooks ${who}`, password } });
      ids[who] = created.user.id;
      users.push(created.user.id);
      accounts[who] = { email, password };
    }
    const workspace = await authDb.workspace.create({
      data: {
        name: "Synthetic hooks",
        members: { create: [{ userId: ids.owner, role: "owner" }, { userId: ids.editor, role: "viewer" }] },
      },
    });
    workspaceId = workspace.id;
    projectId = (await authDb.project.create({ data: { workspaceId, name: "Synthetic hooks" } })).id;
    await authDb.projectMember.create({ data: { workspaceId, projectId, userId: ids.editor, role: "editor" } });
    scope = { workspaceId, projectId, userId: "worker", role: "owner" };
    for (const who of ["owner", "editor"] as const) {
      const response = await app.inject({
        method: "POST",
        url: "/api/auth/sign-in/email",
        headers: { origin, [CLIENT_IP_HEADER]: ip() },
        payload: accounts[who],
      });
      expect(response.statusCode).toBe(200);
      const set = response.headers["set-cookie"];
      cookies[who] = (Array.isArray(set) ? set : [set]).map((v) => v!.split(";")[0]).join("; ");
    }
    setWebhookFetchForTests(async (url, init) => {
      sent.push({ url: String(url), headers: new Headers(init?.headers), body: String(init?.body) });
      return new Response(null, { status: answer });
    });
  });
  beforeEach(() => {
    process.env.ORBIT_WEBHOOKS = "true";
    process.env.ORBIT_CMS = "true";
    process.env.EXECUTION_MODE = "live";
    process.env.ENABLE_EXTERNAL_WRITES = "true";
    answer = 200;
    sent.length = 0;
  });
  afterEach(() => {
    for (const key of ["ORBIT_WEBHOOKS", "ORBIT_CMS", "EXECUTION_MODE", "ENABLE_EXTERNAL_WRITES"]) delete process.env[key];
  });
  afterAll(async () => {
    setWebhookFetchForTests(null);
    await authDb.workspace.deleteMany({ where: { id: workspaceId } });
    await authDb.user.deleteMany({ where: { id: { in: users } } });
    await app?.close();
    await closeDatabase();
  });

  it("does not exist while ORBIT_WEBHOOKS is off, and emits nothing", async () => {
    delete process.env.ORBIT_WEBHOOKS;
    expect((await call("owner", "GET")).statusCode).toBe(404);
    expect(await emit()).toBeNull();
  });

  it("lets only the owner manage endpoints and shows the secret once", async () => {
    expect((await call("editor", "GET")).statusCode).toBe(403);
    const refused = await call("editor", "POST", "", {
      ownerModule: "cms",
      name: "x",
      url: "https://hooks.example.invalid/x",
      eventTypes: ["cms.entry.published"],
    });
    expect(refused.statusCode).toBe(403);
    const created = await createEndpoint();
    expect(created.secret).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
    const list = (await call("owner", "GET")).json();
    expect(list.events.map((e: { type: string }) => e.type)).toContain("cms.entry.updated");
    const listed = list.items.find((item: { id: string }) => item.id === created.id);
    expect(listed.secret).toBeUndefined();
    expect(listed.secretCipher).toBeUndefined();
    const row = await endpointRow(created.id);
    expect(row.secretCipher).not.toContain(created.secret);
  });

  it("refuses foreign or unknown events, plain http and URLs with credentials", async () => {
    const base = { ownerModule: "cms", name: "x", url: "https://hooks.example.invalid/x", eventTypes: ["cms.entry.published"] };
    for (const [payload, expected] of [
      [{ ...base, eventTypes: ["support.ticket.created"] }, "WEBHOOK_EVENT_UNKNOWN"],
      [{ ...base, eventTypes: ["orbit.ping"] }, "WEBHOOK_EVENT_UNKNOWN"],
      [{ ...base, url: "http://hooks.example.invalid/x" }, "VALIDATION_ERROR"],
      [{ ...base, url: "https://user:pw@hooks.example.invalid/x" }, "VALIDATION_ERROR"],
    ] as const) {
      const response = await call("owner", "POST", "", payload);
      expect(response.statusCode, JSON.stringify(payload)).toBe(400);
      if (expected !== "VALIDATION_ERROR") expect(code(response)).toBe(expected);
    }
    delete process.env.ORBIT_CMS;
    const off = await call("owner", "POST", "", base);
    expect([off.statusCode, code(off)]).toEqual([409, "WEBHOOK_MODULE_UNAVAILABLE"]);
  });

  it("delivers a signed event once per subscribed active endpoint", async () => {
    const a = await createEndpoint();
    const other = await createEndpoint(["cms.entry.updated"]);
    const eventId = await emit();
    expect(eventId).toMatch(/^evt_/);
    const rows = await deliveriesOf(eventId!);
    expect(rows.map((row) => row.endpointId)).toContain(a.id);
    expect(rows.map((row) => row.endpointId)).not.toContain(other.id);
    const mine = rows.find((row) => row.endpointId === a.id)!;
    await deliverWebhook(scope, mine.id);
    const request = sent.find((entry) => entry.headers.get("x-orbit-event-id") === eventId)!;
    expect(request.url).toBe("https://hooks.example.invalid/orbit/revalidate");
    expect(verify(a.secret, request.headers, request.body)).toBe(true);
    expect(JSON.parse(request.body)).toMatchObject({ id: eventId, type: "cms.entry.published", projectId, data: { entry: { path: "/blog/a/" } } });
    expect(await delivery(mine.id)).toMatchObject({ status: "delivered", attempts: 1, lastStatus: 200 });
    // A second run of the same job sends nothing.
    await deliverWebhook(scope, mine.id);
    expect(sent.filter((entry) => entry.headers.get("x-orbit-event-id") === eventId)).toHaveLength(1);
  });

  it("backs off on failures, stops at 410 and disables a failing endpoint", async () => {
    const endpoint = await createEndpoint();
    const eventId = await emit();
    const [row] = (await deliveriesOf(eventId!)).filter((d) => d.endpointId === endpoint.id);
    answer = 500;
    await deliverWebhook(scope, row!.id);
    const retried = await delivery(row!.id);
    expect(retried).toMatchObject({ status: "pending", attempts: 1, lastErrorCode: "HTTP_500" });
    expect(retried.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now());
    expect((await endpointRow(endpoint.id)).consecutiveFailures).toBe(1);

    answer = 410;
    await deliverWebhook(scope, row!.id);
    expect(await delivery(row!.id)).toMatchObject({ status: "dead", attempts: 2 });
    expect(await endpointRow(endpoint.id)).toMatchObject({ status: "disabled", disabledReason: "GONE" });

    const failing = await createEndpoint();
    await scoped(workspaceId, projectId, (tx) =>
      tx.webhookEndpoint.update({ where: { id: failing.id }, data: { consecutiveFailures: DISABLE_AFTER_FAILURES - 1 } }),
    );
    const next = await emit();
    const [last] = (await deliveriesOf(next!)).filter((d) => d.endpointId === failing.id);
    answer = 503;
    await deliverWebhook(scope, last!.id);
    expect(await endpointRow(failing.id)).toMatchObject({ status: "disabled", disabledReason: "FAILURES" });
    // Re-enabling resets the counter; a disabled endpoint gets no new events.
    const reEnabled = await call("owner", "PATCH", `/${failing.id}`, { version: (await endpointRow(failing.id)).version, status: "active" });
    expect(reEnabled.json()).toMatchObject({ status: "active", consecutiveFailures: 0 });
  });

  it("signs with both secrets after a rotation and replays a finished delivery", async () => {
    const endpoint = await createEndpoint();
    const rotated = await call("owner", "POST", `/${endpoint.id}/rotate-secret`);
    const fresh = rotated.json().secret as string;
    expect(fresh).not.toBe(endpoint.secret);
    const eventId = await emit();
    const [row] = (await deliveriesOf(eventId!)).filter((d) => d.endpointId === endpoint.id);
    await deliverWebhook(scope, row!.id);
    const request = sent.at(-1)!;
    expect(verify(fresh, request.headers, request.body)).toBe(true);
    expect(verify(endpoint.secret, request.headers, request.body)).toBe(true);

    const replay = await call("owner", "POST", `/deliveries/${row!.id}/replay`);
    expect(replay.statusCode).toBe(202);
    expect(replay.json()).toMatchObject({ status: "pending", attempts: 0 });
    await deliverWebhook(scope, row!.id);
    expect(sent.filter((entry) => entry.headers.get("x-orbit-event-id") === eventId)).toHaveLength(2);
    const history = await call("owner", "GET", `/${endpoint.id}/deliveries`);
    expect(history.json().items[0]).toMatchObject({ id: row!.id, status: "delivered" });
  });

  it("sends a ping to one endpoint and only records it in test mode", async () => {
    const endpoint = await createEndpoint();
    delete process.env.EXECUTION_MODE;
    const ping = await call("owner", "POST", `/${endpoint.id}/ping`);
    expect(ping.statusCode).toBe(202);
    const before = sent.length;
    await deliverWebhook(scope, ping.json().deliveryId);
    expect(sent.length).toBe(before);
    expect(await delivery(ping.json().deliveryId)).toMatchObject({ status: "skipped", lastErrorCode: "TEST_MODE", eventType: "orbit.ping" });
  });
});
