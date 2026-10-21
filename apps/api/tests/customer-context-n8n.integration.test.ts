import { execFileSync } from "node:child_process";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
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
import { runSupportTask } from "../src/modules/support/ai.ts";
import { resetCustomerContextCircuits } from "../src/platform/customer-context/client.ts";
import { create } from "../src/shared.ts";
import { saveOpenAiConfiguration } from "../src/modules/openai-configuration.ts";
// @ts-expect-error plain JavaScript test helper without type declarations
import * as stubs from "../../../integrations/n8n/customer-context/e2e/product-stubs.mjs";

// End-to-end: Orbit API, database and Support AI (model replaced) → a real
// local n8n running the generated workflows → local product stand-ins
// (integrations/n8n/customer-context/e2e). Orbit's SSRF guard only allows
// public HTTPS, so the transport forwards Orbit's exact signed request from
// the integration's public URL to the loopback n8n. Opt-in:
// CUSTOMER_CONTEXT_E2E_N8N=1 and N8N_BIN (see the integration's README).
const N8N_PORT = Number(process.env.N8N_E2E_PORT || 5678);
const PUBLIC_BASE = "https://n8n.e2e.invalid/webhook/orbit-cc";
const mocked = vi.hoisted(() => ({
  n8n: "" as string,
  calls: [] as string[],
  requests: [] as any[],
  replies: [] as unknown[],
}));
vi.mock("../../../packages/connectors/src/http.ts", async (original) => {
  const real =
    await original<typeof import("../../../packages/connectors/src/http.ts")>();
  return {
    ...real,
    boundedFetch: vi.fn(async (url: string | URL, init: RequestInit = {}) => {
      const target = String(url).replace(
        "https://n8n.e2e.invalid",
        mocked.n8n,
      );
      mocked.calls.push(target);
      try {
        return await fetch(target, {
          method: init.method,
          headers: init.headers,
          body: init.body,
          signal: init.signal,
          redirect: "manual",
        });
      } catch {
        throw init.signal?.aborted
          ? new real.ConnectorError("REQUEST_TIMEOUT", "unknown", false)
          : new real.ConnectorError("NETWORK_ERROR", "unknown", false);
      }
    }),
  };
});
vi.mock("../../../packages/ai/src/index.ts", async (original) => ({
  ...(await original<typeof import("../../../packages/ai/src/index.ts")>()),
  respond: vi.fn(async (request: any) => {
    mocked.requests.push(structuredClone(request));
    const next = mocked.replies.shift();
    if (next === undefined) throw new Error("NO_RECORDED_REPLY");
    return {
      output: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: JSON.stringify(next) }],
        },
      ],
      usage: {
        model: request.route.model,
        inputTokens: 100,
        cachedTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 20,
        reasoningTokens: 0,
        costMicros: 9,
      },
      responseId: `resp_${mocked.requests.length}`,
    };
  }),
}));
vi.mock("../src/platform/knowledge/search.ts", async (original) => ({
  ...(await original<typeof import("../src/platform/knowledge/search.ts")>()),
  knowledgeSearch: vi.fn(async () => ({
    result: { status: "no_evidence", facts: [], passages: [], gaps: [] },
    cards: [],
  })),
}));

const enabled = Boolean(
  process.env.TEST_DATABASE_URL &&
    process.env.TEST_AUTH_DATABASE_URL &&
    process.env.CUSTOMER_CONTEXT_E2E_N8N === "1" &&
    process.env.N8N_BIN,
);
const FP = "familyplan:5b2f0c1e-7d4a-4c8e-9a61-0f3b2d7c1a0";

describe.skipIf(!enabled)("customer context end to end through n8n", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  let owner: Scope;
  let other: Scope;
  const servers: Server[] = [];
  const users: string[] = [];
  const workspaces: string[] = [];
  const cookies = { owner: "", outsider: "" };
  const origin = process.env.APP_ORIGIN!;
  const ip = () =>
    `198.18.${randomBytes(1)[0]}.${(randomBytes(1)[0]! % 254) + 1}`;
  const call = (
    who: keyof typeof cookies,
    method: "GET" | "POST" | "PATCH",
    url: string,
    payload?: object,
    projectId = owner.projectId,
  ) =>
    app.inject({
      method,
      url: `/api/projects/${projectId}${url}`,
      headers: { origin, cookie: cookies[who], [CLIENT_IP_HEADER]: ip() },
      ...(payload ? { payload } : {}),
    });
  const run = <T>(fn: Parameters<typeof scoped<T>>[2], scope = owner) =>
    scoped(scope.workspaceId, scope.projectId, fn);
  const secrets = {
    desk: {
      token: randomBytes(32).toString("base64url"),
      signingSecret: randomBytes(32).toString("base64url"),
    },
    familyplan: {
      token: randomBytes(32).toString("base64url"),
      signingSecret: randomBytes(32).toString("base64url"),
    },
  };
  const connection = { desk: "", familyplan: "", foreign: "" };
  const inbox = { desk: "", familyplan: "" };

  async function connect(
    sourceSystem: string,
    secret: { token: string; signingSecret: string },
    who: keyof typeof cookies = "owner",
    projectId = owner.projectId,
  ) {
    const created = await call(
      who,
      "POST",
      "/actions/customer-context-connect",
      {
        label: `${sourceSystem} via n8n (E2E)`,
        baseUrl: PUBLIC_BASE,
        sourceSystem,
        timeoutMs: 4000,
        ...secret,
      },
      projectId,
    );
    expect(created.statusCode).toBe(200);
    return created.json().id as string;
  }
  async function widgetTicket(
    bodyText: string,
    inboxId: string,
    externalUserId: string | null,
  ) {
    return run(async (tx) => {
      // A verified user has one contact per inbox, as the widget resolves it.
      const known = externalUserId
        ? await tx.supportContactIdentity.findFirst({
            where: { inboxId, channel: "widget", externalUserId },
          })
        : null;
      const contactId = known?.contactId ?? randomUUID();
      if (!known)
        await tx.supportContact.create({
          data: {
            id: contactId,
            workspaceId: owner.workspaceId,
            projectId: owner.projectId,
            name: "Synthetic Customer",
            claimedEmail: "customer@example.invalid",
          },
        });
      if (externalUserId && !known)
        await tx.supportContactIdentity.create({
          data: {
            id: randomUUID(),
            workspaceId: owner.workspaceId,
            projectId: owner.projectId,
            contactId,
            inboxId,
            channel: "widget",
            externalUserId,
          },
        });
      return (
        await createTicket(tx, owner, {
          inboxId,
          channel: "widget",
          contactId,
          inbound: {
            externalId: null,
            contact: {},
            subject: "Account question",
            bodyText,
            attachments: [],
          },
        })
      ).ticketId;
    });
  }
  const read = async (ticketId: string) => {
    const response = await call(
      "owner",
      "GET",
      `/support/tickets/${ticketId}/customer-context`,
    );
    expect(response.statusCode).toBe(200);
    return response.json();
  };
  const lookup = async (inboxId: string, externalUserId: string | null) =>
    read(await widgetTicket("Welches Abo habe ich?", inboxId, externalUserId));
  async function draft(
    inboxId: string,
    externalUserId: string,
    question: string,
    reply: object,
  ) {
    const ticketId = await widgetTicket(question, inboxId, externalUserId);
    mocked.replies.push({
      confidence: "high",
      handoff: false,
      handoffReason: "",
      ...reply,
    });
    await runSupportTask(
      { ...owner, userId: "worker" },
      { task: "draft", ticketId },
    );
    const prompt = mocked.requests.at(-1)!.input[0].content as string;
    const ticket = await run((tx) =>
      tx.supportTicket.findUniqueOrThrow({ where: { id: ticketId } }),
    );
    const message = await run((tx) =>
      tx.supportMessage.findFirst({ where: { ticketId, kind: "ai_draft" } }),
    );
    return { prompt, ticket, draft: message?.bodyText ?? null };
  }

  beforeAll(async () => {
    process.env.ORBIT_SUPPORT = "true";
    process.env.ORBIT_CUSTOMER_CONTEXT = "true";
    mocked.n8n = `http://127.0.0.1:${N8N_PORT}`;
    servers.push(stubs.deskStub().listen(stubs.E2E.deskPort, "127.0.0.1"));
    servers.push(
      (await stubs.familyPlanStub()).listen(
        stubs.E2E.familyPlanPort,
        "127.0.0.1",
      ),
    );
    app = await buildServer();
    const accounts: Record<string, { email: string; password: string }> = {};
    const ids: Record<string, string> = {};
    for (const who of ["owner", "outsider"] as const) {
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
        name: "Synthetic customer context E2E",
        members: { create: [{ userId: ids.owner!, role: "owner" }] },
      },
    });
    const foreign = await authDb.workspace.create({
      data: {
        name: "Synthetic other tenant E2E",
        members: { create: [{ userId: ids.outsider!, role: "owner" }] },
      },
    });
    workspaces.push(workspace.id, foreign.id);
    const project = await authDb.project.create({
      data: { workspaceId: workspace.id, name: "Synthetic E2E" },
    });
    const otherProject = await authDb.project.create({
      data: { workspaceId: foreign.id, name: "Synthetic other tenant E2E" },
    });
    owner = {
      workspaceId: workspace.id,
      projectId: project.id,
      userId: ids.owner!,
      role: "owner",
    };
    other = {
      workspaceId: foreign.id,
      projectId: otherProject.id,
      userId: ids.outsider!,
      role: "owner",
    };
    for (const scope of [owner, other])
      await run(async (tx) => {
        await tx.projectModule.create({
          data: {
            workspaceId: scope.workspaceId,
            projectId: scope.projectId,
            moduleId: "support",
            enabled: true,
            moduleVersion: "1.0.0",
          },
        });
      }, scope);
    await run(async (tx) => {
      const now = Date.now();
      await create(tx, owner, "policies", {
        mode: "autopilot",
        channels: [],
        contentTypes: ["social"],
        allowedOrigins: ["https://example.invalid"],
        startAt: new Date(now - 3600000).toISOString(),
        endAt: new Date(now + 30 * 86400000).toISOString(),
        maxPerDay: 1,
        minIntervalMinutes: 1,
        dailyBudgetMicros: 10_000_000,
        monthlyBudgetMicros: 100_000_000,
        perRunBudgetMicros: 5_000_000,
        approvedPaidTests: true,
        active: true,
      });
      const rate = {
        inputMicrosPerMillion: 1000,
        outputMicrosPerMillion: 1000,
        verifiedAt: new Date().toISOString(),
      };
      await saveOpenAiConfiguration(tx, owner, {
        apiKey: "synthetic-no-provider-call-key",
        verifiedModels: ["synthetic-model", "text-embedding-3-small"],
        rateCard: {
          "synthetic-model": rate,
          "text-embedding-3-small": rate,
        },
        modelRoutes: {
          fast: "synthetic-model",
          standard: "synthetic-model",
          quality: "synthetic-model",
          escalation: "synthetic-model",
        },
      });
      for (const key of ["desk", "familyplan"] as const)
        inbox[key] = (
          await createInbox(tx, owner, {
            name: `${key} widget`,
            channels: ["widget"],
            allowedOrigins: [`https://${key}.example.invalid`],
            aiMode: "draft",
          })
        ).inbox.id;
    });
    for (const who of ["owner", "outsider"] as const) {
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

    connection.desk = await connect("uliquid-desk", secrets.desk);
    connection.familyplan = await connect("familyplan", secrets.familyplan);
    // Another tenant points an integration at the same gateway; n8n has no
    // binding for its integration id.
    connection.foreign = await connect(
      "uliquid-desk",
      {
        token: randomBytes(32).toString("base64url"),
        signingSecret: randomBytes(32).toString("base64url"),
      },
      "outsider",
      other.projectId,
    );
    // The gateway learns the two integration ids it serves: n8n keeps the
    // token's SHA-256 and the signing secret (CC_GATEWAY_INTEGRATIONS).
    const dir = mkdtempSync(join(tmpdir(), "orbit-cc-e2e-"));
    const file = join(dir, "integrations.json");
    writeFileSync(
      file,
      JSON.stringify(
        (["desk", "familyplan"] as const).map((key) => ({
          integrationId: connection[key],
          adapter: key === "desk" ? "uliquid-desk" : "familyplan",
          tokenSha256: createHash("sha256")
            .update(secrets[key].token)
            .digest("hex"),
          signingSecret: secrets[key].signingSecret,
        })),
      ),
      { mode: 0o600 },
    );
    execFileSync(
      "bash",
      ["integrations/n8n/customer-context/e2e/start-n8n.sh", file],
      { stdio: "inherit", timeout: 240_000 },
    );
  }, 300_000);
  afterEach(() => {
    mocked.n8n = `http://127.0.0.1:${N8N_PORT}`;
    mocked.calls.length = 0;
    mocked.requests.length = 0;
    mocked.replies.length = 0;
    stubs.stubRequests.length = 0;
    resetCustomerContextCircuits();
  });
  afterAll(async () => {
    delete process.env.ORBIT_SUPPORT;
    delete process.env.ORBIT_CUSTOMER_CONTEXT;
    for (const server of servers) server.close();
    await authDb.workspace.deleteMany({ where: { id: { in: workspaces } } });
    await authDb.user.deleteMany({ where: { id: { in: users } } });
    await app?.close();
    await closeDatabase();
  });

  it("verifies both integrations through n8n and the products, binds the inboxes", async () => {
    for (const key of ["desk", "familyplan"] as const) {
      const checked = await call("owner", "POST", "/actions/connector-health", {
        connectorId: connection[key],
      });
      expect(checked.statusCode, checked.body).toBe(200);
      const current = await run((tx) =>
        tx.supportInbox.findUniqueOrThrow({ where: { id: inbox[key] } }),
      );
      const bound = await call(
        "owner",
        "PATCH",
        `/support/inboxes/${inbox[key]}`,
        {
          version: current.version,
          rules: { customerContext: { connectionId: connection[key] } },
        },
      );
      expect(bound.statusCode).toBe(200);
    }
    // The check reached both products (Desk 404, FamilyPlan 400 after its
    // token check), so it proves the product credentials as well.
    expect(stubs.stubRequests).toEqual([
      { product: "uliquid-desk", id: "orbit-connection-check" },
      { product: "familyplan", id: "orbit-connection-check" },
    ]);
  });

  it("1. Desk: active subscription with 0 AI credits, from Desk's own numbers", async () => {
    const body = await lookup(inbox.desk, "ckdesk0002nocred");
    expect(body.sourceSystem).toBe("uliquid-desk");
    expect(body.result.status).toBe("ok");
    const context = body.result.context;
    expect(context.subscription).toMatchObject({
      status: "active",
      plan: { key: "pro", name: "Pro" },
    });
    expect(context.usage[0]).toMatchObject({
      key: "ai_credits",
      remaining: 0,
      unlimited: false,
    });
    const { prompt, ticket, draft: text } = await draft(
      inbox.desk,
      "ckdesk0002nocred",
      "Meine KI-Credits sind leer, warum kann ich keine Analysen mehr starten?",
      {
        reply: "Your AI credits are used up for now.",
        citations: ["account:usage:1"],
      },
    );
    expect(prompt).toContain("Customer account:");
    expect(prompt).toContain("subscription status=active");
    expect(prompt).toMatch(/"AI credits" \(credits, billing_period\) used=\d+; limit=unknown; remaining=0/);
    expect(prompt).not.toContain("ckdesk0002nocred");
    expect(text).toContain("AI credits are used up");
    expect(ticket.aiState).not.toBe("handed_off");
  });

  it("2. Desk: a feature outside the plan is denied with its reason", async () => {
    const body = await lookup(inbox.desk, "ckdesk0003denied");
    expect(body.result.context.entitlements).toContainEqual(
      expect.objectContaining({
        key: "ai_agent_chat",
        state: "denied",
        reason: "not_in_plan",
      }),
    );
    const { prompt } = await draft(
      inbox.desk,
      "ckdesk0003denied",
      "Warum ist der AI Agent Chat für mich nicht freigeschaltet?",
      {
        reply: "AI Agent Chat is not part of your current plan.",
        citations: ["account:entitlements:1"],
      },
    );
    expect(prompt).toContain(
      'feature "AI Agent Chat" state=denied; reason=not_in_plan',
    );
  });

  it("3. FamilyPlan: customer without valid Premium", async () => {
    const body = await lookup(inbox.familyplan, `${FP}2`);
    expect(body.sourceSystem).toBe("familyplan");
    const context = body.result.context;
    expect(context.subscription).toMatchObject({
      status: "expired",
      plan: null,
    });
    expect(context.entitlements).toContainEqual(
      expect.objectContaining({
        key: "chat",
        state: "denied",
        reason: "plan_inactive",
      }),
    );
    expect(context.entitlements).toContainEqual(
      expect.objectContaining({ key: "calendar", state: "granted" }),
    );
    const { prompt } = await draft(
      inbox.familyplan,
      `${FP}2`,
      "Warum kann ich den Familienchat nicht mehr nutzen? Habe ich noch Premium?",
      {
        reply: "Your Premium access has ended, so the family chat is not available.",
        citations: ["account:subscription"],
      },
    );
    expect(prompt).toContain("subscription status=expired");
  });

  it("4. Verified customers with an active subscription (Desk and FamilyPlan, several families)", async () => {
    const desk = await lookup(inbox.desk, "ckdesk0001active");
    expect(desk.result.context.subscription.status).toBe("active");
    expect(desk.result.context.usage[0].remaining).toBeGreaterThan(0);
    const premium = await lookup(inbox.familyplan, `${FP}1`);
    expect(premium.result.context.subscription).toMatchObject({
      status: "active",
      plan: { key: "family_premium", name: "FamilyPlan Premium" },
    });
    expect(
      premium.result.context.entitlements.every(
        (item: { state: string }) => item.state === "granted",
      ),
    ).toBe(true);
    const families = await lookup(inbox.familyplan, `${FP}3`);
    expect(families.result.context.subscription.status).toBe("active");
    expect(
      families.result.context.usage.map((u: { key: string; used: number }) => [
        u.key,
        u.used,
      ]),
    ).toEqual([
      ["families", 2],
      ["families.premium", 1],
    ]);
    // Nothing beyond the v1 allowlist reaches Orbit.
    expect(JSON.stringify(families)).not.toMatch(
      /familyCount|planTitle|f-3|f-4|capabilityPlan|exchange/,
    );
  });

  it("5. Unverified customers and other tenants get nothing", async () => {
    // No verified widget identity: decided in Orbit, no call at all.
    const anonymous = await lookup(inbox.desk, null);
    expect(anonymous.result).toEqual({
      status: "identity_unverified",
      reason: "no_verified_identity",
    });
    expect(mocked.calls).toHaveLength(0);
    // Another tenant cannot read this project's tickets.
    const ticketId = await widgetTicket(
      "Welches Abo habe ich?",
      inbox.desk,
      "ckdesk0001active",
    );
    expect(
      (
        await call(
          "outsider",
          "GET",
          `/support/tickets/${ticketId}/customer-context`,
          undefined,
          other.projectId,
        )
      ).statusCode,
    ).toBe(404);
    // Its own integration against the same gateway is refused by n8n.
    const foreign = await call(
      "outsider",
      "POST",
      "/actions/connector-health",
      { connectorId: connection.foreign },
      other.projectId,
    );
    expect(foreign.statusCode).toBe(409);
    expect(foreign.body).toContain("CUSTOMER_CONTEXT_CHECK_MISCONFIGURED");
    // Desk's credentials cannot be used to ask for FamilyPlan's ids (and the
    // other way round): the adapters refuse foreign ids without a call.
    expect((await lookup(inbox.desk, `${FP}1`)).result.status).toBe(
      "not_found",
    );
    expect(
      (await lookup(inbox.familyplan, "ckdesk0001active")).result.status,
    ).toBe("not_found");
    expect(stubs.stubRequests).toEqual([]);
    // A correctly signed request under one integration's secrets for the
    // other integration id is refused.
    const raw = JSON.stringify({
      schemaVersion: "1.0",
      requestId: randomUUID(),
      requestedAt: new Date().toISOString(),
      integrationId: connection.familyplan,
      acceptVersions: ["1.0"],
      subject: {
        type: "external_user_id",
        id: `${FP}1`,
        verification: {
          method: "widget_hmac",
          verifiedAt: new Date().toISOString(),
        },
      },
      purpose: "support",
    });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const crossed = await fetch(
      `${mocked.n8n}/webhook/orbit-cc/v1/customer-context/lookup`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${secrets.desk.token}`,
          "x-orbit-timestamp": timestamp,
          "x-orbit-request-id": JSON.parse(raw).requestId,
          "x-orbit-signature":
            "v1=" +
            createHmac("sha256", secrets.desk.signingSecret)
              .update(`${timestamp}.${raw}`)
              .digest("hex"),
        },
        body: raw,
      },
    );
    expect(crossed.status).toBe(401);
    expect(await crossed.json()).toMatchObject({ code: "unauthenticated" });
    expect(stubs.stubRequests).toEqual([]);
  });

  it("6. n8n or the product unreachable: 'cannot be checked', never a guessed status", async () => {
    // Desk too slow: n8n stops after its 2.5 s budget.
    const slow = await lookup(inbox.desk, "ckdesk0004slow");
    expect(slow.result).toMatchObject({
      status: "unavailable",
      reason: "timeout",
    });
    // Desk and FamilyPlan drop the connection.
    for (const [inboxId, id] of [
      [inbox.desk, "ckdesk0005broken"],
      [inbox.familyplan, `${FP}9`],
    ] as const)
      expect((await lookup(inboxId, id)).result).toMatchObject({
        status: "unavailable",
        reason: "provider_error",
      });
    // n8n itself unreachable.
    mocked.n8n = "http://127.0.0.1:9";
    expect((await lookup(inbox.desk, "ckdesk0001active")).result).toEqual({
      status: "unavailable",
      reason: "network",
      retryAfterSeconds: null,
    });
    const { prompt, ticket, draft: text } = await draft(
      inbox.desk,
      "ckdesk0002nocred",
      "Wie viele Credits habe ich noch?",
      {
        reply:
          "I cannot verify your account status at the moment; a colleague will check it.",
        citations: ["account:status"],
      },
    );
    expect(prompt).toContain(
      "account:status The account status cannot be checked right now",
    );
    expect(prompt).not.toMatch(/remaining=|subscription status=/);
    expect(text).toContain("cannot verify your account status");
    expect(ticket.aiState).toBe("handed_off");
  });
});
