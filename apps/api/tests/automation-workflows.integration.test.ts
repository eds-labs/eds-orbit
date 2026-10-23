import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { buildServer } from "../src/server.ts";
import { makeAuth } from "../src/auth.ts";
import { CLIENT_IP_HEADER } from "../src/client-ip.ts";
import { authDb, closeDatabase } from "../../../packages/db/src/index.ts";
import {
  setAutomationFetchForTests,
  signAutomationBody,
} from "../src/platform/automation/workflows.ts";

// n8n as a central automation connection (ADR 0013, WP3.7): signed,
// product-neutral triggers only from granted projects, signed callbacks,
// no payload kept, and a revoked grant ends both directions.

const enabled = Boolean(process.env.TEST_DATABASE_URL);
Object.assign(process.env, {
  ORBIT_ADMINISTRATION: "true",
  ORBIT_CONNECTIONS: "true",
  EXECUTION_MODE: "test",
  ENABLE_EXTERNAL_WRITES: "false",
});

describe.skipIf(!enabled)("Automation workflows (ADR 0013)", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  const origin = process.env.APP_ORIGIN!;
  const password = randomBytes(24).toString("base64url");
  const SIGNING = randomBytes(32).toString("hex");
  const API_KEY = `n8n-${randomBytes(12).toString("hex")}`;
  let cookie: string, userId: string, ws: string, p1: string, p2: string;
  let connectionId: string, bindingId: string, grantId: string, runId: string;
  const sent: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
  const ip = () => `198.18.${randomBytes(1)[0]}.${(randomBytes(1)[0]! % 254) + 1}`;
  const call = (method: "GET" | "POST" | "DELETE", url: string, payload?: unknown) =>
    app.inject({
      method,
      url,
      headers: { origin, [CLIENT_IP_HEADER]: ip(), cookie },
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
  const callback = (project: string, run: string, body: object, secret = SIGNING) => {
    const raw = JSON.stringify(body);
    const ts = String(Math.floor(Date.now() / 1000));
    return app.inject({
      method: "POST",
      url: `/api/automation/callbacks/${project}/${run}`,
      headers: {
        "content-type": "application/json",
        [CLIENT_IP_HEADER]: ip(),
        "x-orbit-timestamp": ts,
        "x-orbit-signature": signAutomationBody(secret, ts, raw),
      },
      payload: raw,
    });
  };

  beforeAll(async () => {
    app = await buildServer();
    const email = `${randomUUID()}@example.invalid`;
    const r = await makeAuth().api.signUpEmail({ body: { email, name: "Synthetic owner", password } });
    userId = r.user.id;
    const w = await authDb.workspace.create({
      data: {
        name: "Synthetic automation",
        members: { create: { userId, role: "owner" } },
        projects: { create: [{ name: "P1" }, { name: "P2" }] },
      },
      include: { projects: true },
    });
    ws = w.id;
    p1 = w.projects.find((p) => p.name === "P1")!.id;
    p2 = w.projects.find((p) => p.name === "P2")!.id;
    const s = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      headers: { origin, [CLIENT_IP_HEADER]: ip() },
      payload: { email, password },
    });
    const set = s.headers["set-cookie"];
    cookie = (Array.isArray(set) ? set : [set]).map((c) => c!.split(";")[0]).join("; ");
    const created = await call("POST", `/api/organizations/${ws}/connections`, {
      provider: "n8n",
      label: "Company n8n",
      config: { baseUrl: "https://n8n.example.invalid" },
      secret: JSON.stringify({ apiKey: API_KEY, signingSecret: SIGNING }),
    });
    expect(created.statusCode).toBe(201);
    connectionId = created.json().id;
    const binding = await call("POST", `/api/organizations/${ws}/connections/${connectionId}/workflows`, {
      contract: "automation.v1",
      workflowRef: "orbit/ticket-closed",
      label: "Ticket closed",
    });
    expect(binding.statusCode).toBe(201);
    bindingId = binding.json().id;
    grantId = (
      await call("POST", `/api/organizations/${ws}/connections/${connectionId}/grants`, {
        projectId: p1,
        purposes: ["automation"],
      })
    ).json().id;
  });
  afterAll(async () => {
    setAutomationFetchForTests(null);
    await authDb.workspace.deleteMany({ where: { id: ws } });
    await authDb.user.deleteMany({ where: { id: userId } });
    await app?.close();
    await closeDatabase();
  });

  it("offers the binding only to the granted project", async () => {
    expect((await call("GET", `/api/projects/${p1}/workflow-bindings`)).json().items).toMatchObject([
      { id: bindingId, label: "Ticket closed", contract: "automation.v1" },
    ]);
    expect((await call("GET", `/api/projects/${p2}/workflow-bindings`)).json().items).toEqual([]);
    expect(
      (await call("POST", `/api/projects/${p2}/workflow-runs`, { bindingId, event: "ticket.closed" })).statusCode,
    ).toBe(404);
  });

  it("sends nothing outside live mode", async () => {
    const r = await call("POST", `/api/projects/${p1}/workflow-runs`, { bindingId, event: "ticket.closed" });
    expect(r.json()).toMatchObject({ status: "test_receipt" });
  });

  it("sends a signed, product-neutral request and keeps no payload", async () => {
    Object.assign(process.env, { EXECUTION_MODE: "live", ENABLE_EXTERNAL_WRITES: "true" });
    setAutomationFetchForTests(async (url, init) => {
      sent.push({
        url: String(url),
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
        body: String(init?.body),
      });
      return new Response(JSON.stringify({ executionId: 4711 }), { status: 200 });
    });
    try {
      const r = await call("POST", `/api/projects/${p1}/workflow-runs`, {
        bindingId,
        event: "ticket.closed",
        payload: { ticketNumber: 42 },
      });
      expect(r.json()).toMatchObject({ status: "accepted", executionId: "4711" });
      runId = r.json().id;
    } finally {
      Object.assign(process.env, { EXECUTION_MODE: "test", ENABLE_EXTERNAL_WRITES: "false" });
    }
    const request = sent[0]!;
    expect(request.url).toBe("https://n8n.example.invalid/webhook/orbit/ticket-closed");
    expect(request.headers["x-orbit-signature"]).toBe(
      signAutomationBody(SIGNING, request.headers["x-orbit-timestamp"]!, request.body),
    );
    expect(JSON.parse(request.body)).toMatchObject({ contract: "automation.v1", event: "ticket.closed", runId });
    expect(request.body).not.toContain(API_KEY);
    expect(request.body).not.toContain(SIGNING);
    const runs = (await call("GET", `/api/projects/${p1}/workflow-runs`)).json().items;
    expect(JSON.stringify(runs)).not.toContain("ticketNumber");
  });

  it("accepts only correctly signed callbacks, once", async () => {
    expect((await callback(p1, runId, { status: "completed" }, "wrong-secret-wrong-secret-wrong-secret")).statusCode).toBe(404);
    const done = await callback(p1, runId, { status: "completed", executionId: "4711" });
    expect(done.json()).toEqual({ accepted: true });
    expect((await callback(p1, runId, { status: "failed" })).json()).toEqual({ accepted: true, unchanged: true });
    const runs = (await call("GET", `/api/projects/${p1}/workflow-runs`)).json().items;
    expect(runs.find((r: { id: string }) => r.id === runId)).toMatchObject({ status: "completed" });
  });

  it("ends triggers and callbacks once the grant is revoked", async () => {
    const trigger = await call("POST", `/api/projects/${p1}/workflow-runs`, { bindingId, event: "ticket.closed" });
    const pending = trigger.json().id;
    expect((await call("DELETE", `/api/organizations/${ws}/connection-grants/${grantId}`)).statusCode).toBe(204);
    expect((await call("POST", `/api/projects/${p1}/workflow-runs`, { bindingId, event: "ticket.closed" })).statusCode).toBe(404);
    expect((await callback(p1, pending, { status: "completed" })).statusCode).toBe(404);
  });
});
