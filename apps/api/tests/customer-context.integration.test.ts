import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
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

// The provider (an n8n webhook or a product), the model and retrieval are
// replaced; everything else is the real API, database, RLS and audit.
const mocked = vi.hoisted(() => ({
  provider: null as null | ((request: any) => Response),
  calls: [] as Array<{
    url: string;
    headers: Record<string, string>;
    body: string;
  }>,
  requests: [] as any[],
  replies: [] as unknown[],
}));
vi.mock("../../../packages/connectors/src/http.ts", async (original) => {
  const real =
    await original<typeof import("../../../packages/connectors/src/http.ts")>();
  return {
    ...real,
    boundedFetch: vi.fn(async (url: string | URL, init: RequestInit = {}) => {
      const body = String(init.body ?? "");
      mocked.calls.push({
        url: String(url),
        headers: init.headers as Record<string, string>,
        body,
      });
      if (!mocked.provider) throw new real.ConnectorError("NETWORK_ERROR");
      return mocked.provider(JSON.parse(body));
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
  // No approved knowledge: an account question is answered from the account.
  knowledgeSearch: vi.fn(async () => ({
    result: { status: "no_evidence", facts: [], passages: [], gaps: [] },
    cards: [],
  })),
}));

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);
const examples = "packages/schemas/contracts/customer-context/v1/examples";
const example = (name: string) =>
  JSON.parse(readFileSync(`${examples}/${name}.json`, "utf8"));
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
/** A provider that answers every lookup with this example, echoing the request. */
const answering =
  (name: string, status = 200) =>
  (request: any) => {
    const body = example(name);
    if (status === 200) {
      body.source.integrationId = request.integrationId;
      body.customer.externalRef.id = request.subject.id;
    }
    return json(status, body);
  };
const notFoundForCheck = (request: any) =>
  request.subject.id === "orbit-connection-check"
    ? json(404, example("problem-not-found"))
    : json(503, example("problem-service-unavailable"));

const SIGNING_SECRET = "signing-secret-for-synthetic-tests-0001";

/**
 * Universal customer context in Support (ADR 0011): integration management,
 * the verified-identity gate, tenant isolation, permissions, failures and
 * the Support AI's use of account facts.
 */
describe.skipIf(!enabled)("customer context", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  let owner: Scope;
  let other: Scope;
  const ids = { owner: "", editor: "", viewer: "", outsider: "" };
  const cookies = { owner: "", editor: "", viewer: "", outsider: "" };
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
  let inboxId = "";
  let otherInboxId = "";
  let connectionId = "";
  let verifiedTicket = "";
  let anonymousTicket = "";
  let foreignIdentityTicket = "";

  /** An integration through the owner's action, then its connection check. */
  async function connect(
    who: keyof typeof ids = "owner",
    projectId = owner.projectId,
  ) {
    const created = await call(
      who,
      "POST",
      "/actions/customer-context-connect",
      {
        label: "Example SaaS via n8n",
        baseUrl: "https://n8n.example.com/webhook/orbit/",
        sourceSystem: "example-saas",
        timeoutMs: 2000,
        token: "synthetic-bearer-token-0001",
        signingSecret: SIGNING_SECRET,
      },
      projectId,
    );
    return created;
  }
  async function widgetTicket(
    bodyText: string,
    identity: { inboxId: string; externalUserId: string } | null,
    ticketInbox = inboxId,
  ) {
    return run(async (tx) => {
      // A verified user has one contact per inbox, as the widget resolves it.
      const known = identity
        ? await tx.supportContactIdentity.findFirst({
            where: {
              inboxId: identity.inboxId,
              channel: "widget",
              externalUserId: identity.externalUserId,
            },
          })
        : null;
      const contactId = known?.contactId ?? randomUUID();
      if (!known)
        await tx.supportContact.create({
          data: {
            id: contactId,
            workspaceId: owner.workspaceId,
            projectId: owner.projectId,
            name: "Anna Example",
            claimedEmail: "anna@example.invalid",
          },
        });
      if (identity && !known)
        await tx.supportContactIdentity.create({
          data: {
            id: randomUUID(),
            workspaceId: owner.workspaceId,
            projectId: owner.projectId,
            contactId,
            inboxId: identity.inboxId,
            channel: "widget",
            externalUserId: identity.externalUserId,
          },
        });
      const created = await createTicket(tx, owner, {
        inboxId: ticketInbox,
        channel: "widget",
        contactId,
        inbound: {
          externalId: null,
          contact: {},
          subject: "Account question",
          bodyText,
          attachments: [],
        },
      });
      return created.ticketId;
    });
  }
  const read = (
    who: keyof typeof ids,
    ticketId: string,
    projectId = owner.projectId,
  ) =>
    call(
      who,
      "GET",
      `/support/tickets/${ticketId}/customer-context`,
      undefined,
      projectId,
    );

  beforeAll(async () => {
    process.env.ORBIT_SUPPORT = "true";
    process.env.ORBIT_CUSTOMER_CONTEXT = "true";
    app = await buildServer();
    const accounts: Record<string, { email: string; password: string }> = {};
    for (const who of ["owner", "editor", "viewer", "outsider"] as const) {
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
        name: "Synthetic customer context",
        members: {
          create: [
            { userId: ids.owner, role: "owner" },
            { userId: ids.editor, role: "viewer" },
            { userId: ids.viewer, role: "viewer" },
          ],
        },
      },
    });
    const foreign = await authDb.workspace.create({
      data: {
        name: "Synthetic other tenant",
        members: { create: [{ userId: ids.outsider, role: "owner" }] },
      },
    });
    workspaces.push(workspace.id, foreign.id);
    const project = await authDb.project.create({
      data: { workspaceId: workspace.id, name: "Synthetic customer context" },
    });
    const otherProject = await authDb.project.create({
      data: { workspaceId: foreign.id, name: "Synthetic other tenant" },
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
    other = {
      workspaceId: foreign.id,
      projectId: otherProject.id,
      userId: ids.outsider,
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
      // A spend mandate and a priced synthetic model for the Support AI;
      // the model call itself is replaced above.
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
      inboxId = (
        await createInbox(tx, owner, {
          name: "App widget",
          channels: ["widget"],
          allowedOrigins: ["https://app.example.invalid"],
          aiMode: "draft",
        })
      ).inbox.id;
      otherInboxId = (
        await createInbox(tx, owner, {
          name: "Second app",
          channels: ["widget"],
          allowedOrigins: ["https://second.example.invalid"],
        })
      ).inbox.id;
    });
    for (const who of ["owner", "editor", "viewer", "outsider"] as const) {
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
    process.env.ORBIT_CUSTOMER_CONTEXT = "true";
    mocked.provider = null;
    mocked.calls.length = 0;
    mocked.requests.length = 0;
    mocked.replies.length = 0;
    resetCustomerContextCircuits();
  });
  afterAll(async () => {
    delete process.env.ORBIT_SUPPORT;
    delete process.env.ORBIT_CUSTOMER_CONTEXT;
    await authDb.workspace.deleteMany({ where: { id: { in: workspaces } } });
    await authDb.user.deleteMany({ where: { id: { in: users } } });
    await app?.close();
    await closeDatabase();
  });

  it("lets only owners add an integration, keeps its secrets and verifies it with a signed check", async () => {
    expect((await connect("editor")).statusCode).toBe(403);
    expect((await connect("viewer")).statusCode).toBe(403);
    const created = await connect();
    expect(created.statusCode).toBe(200);
    connectionId = created.json().id;
    const text = created.body;
    expect(text).not.toContain("synthetic-bearer-token-0001");
    expect(text).not.toContain(SIGNING_SECRET);
    expect(text).not.toContain("encryptedCredential");
    expect(created.json().data).toMatchObject({
      provider: "customer_context",
      baseUrl: "https://n8n.example.com/webhook/orbit",
      status: "configured",
    });
    // The generic connector action cannot create one without its secrets.
    const generic = await call("owner", "POST", "/actions/connector", {
      provider: "customer_context",
      baseUrl: "https://n8n.example.com",
      credential: "plain-credential",
    });
    expect(generic.statusCode).toBe(400);
    expect(generic.json().error.code).toBe("CUSTOMER_CONTEXT_CONNECT_REQUIRED");

    mocked.provider = notFoundForCheck;
    const checked = await call("owner", "POST", "/actions/connector-health", {
      connectorId: connectionId,
    });
    expect(checked.statusCode).toBe(200);
    expect(checked.json().data.status).toBe("read_verified");
    const [probe] = mocked.calls;
    expect(probe!.url).toBe(
      "https://n8n.example.com/webhook/orbit/v1/customer-context/lookup",
    );
    expect(JSON.parse(probe!.body).subject.id).toBe("orbit-connection-check");
    expect(probe!.headers["x-orbit-signature"]).toBe(
      `v1=${createHmac("sha256", SIGNING_SECRET)
        .update(`${probe!.headers["x-orbit-timestamp"]}.${probe!.body}`)
        .digest("hex")}`,
    );
    expect(probe!.headers.authorization).toBe(
      "Bearer synthetic-bearer-token-0001",
    );
  });

  it("refuses a failed check instead of marking the integration verified", async () => {
    const spare = (await connect()).json().id;
    mocked.provider = () => json(401, example("problem-unauthenticated"));
    const checked = await call("owner", "POST", "/actions/connector-health", {
      connectorId: spare,
    });
    expect(checked.statusCode).toBe(409);
    expect(checked.body).toContain("CUSTOMER_CONTEXT_CHECK_MISCONFIGURED");
    await call("owner", "POST", "/actions/customer-context-disconnect", {
      connectorId: spare,
    });
  });

  it("binds an inbox only to an integration of its own project (owner only)", async () => {
    const inbox = await run((tx) =>
      tx.supportInbox.findUniqueOrThrow({ where: { id: inboxId } }),
    );
    // Another tenant's integration id is unknown here.
    const foreignConnection = await connect("outsider", other.projectId);
    expect(foreignConnection.statusCode).toBe(200);
    const foreign = await call(
      "owner",
      "PATCH",
      `/support/inboxes/${inboxId}`,
      {
        version: inbox.version,
        rules: {
          customerContext: { connectionId: foreignConnection.json().id },
        },
      },
    );
    expect(foreign.statusCode).toBe(400);
    expect(foreign.body).toContain("INBOX_CUSTOMER_CONTEXT_INVALID");
    const editor = await call(
      "editor",
      "PATCH",
      `/support/inboxes/${inboxId}`,
      {
        version: inbox.version,
        rules: { customerContext: { connectionId } },
      },
    );
    expect(editor.statusCode).toBe(403);
    const bound = await call("owner", "PATCH", `/support/inboxes/${inboxId}`, {
      version: inbox.version,
      rules: { customerContext: { connectionId } },
    });
    expect(bound.statusCode).toBe(200);
    expect(bound.json().rules.customerContext).toEqual({ connectionId });

    verifiedTicket = await widgetTicket("Welches Abo habe ich?", {
      inboxId,
      externalUserId: "usr_48213",
    });
    anonymousTicket = await widgetTicket("Welches Abo habe ich?", null);
    foreignIdentityTicket = await widgetTicket("Welches Abo habe ich?", {
      inboxId: otherInboxId,
      externalUserId: "usr_99999",
    });
    const detail = await call(
      "viewer",
      "GET",
      `/support/tickets/${verifiedTicket}`,
    );
    expect(detail.json().inbox.customerContext).toBe(true);
    expect(JSON.stringify(detail.json().inbox)).not.toContain(connectionId);
  });

  it("reads the subscription of a verified customer without exposing the product's user id", async () => {
    mocked.provider = answering("found-active");
    const response = await read("editor", verifiedTicket);
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.sourceSystem).toBe("example-saas");
    expect(body.result.status).toBe("ok");
    expect(body.result.context.subscription.plan.name).toBe("Pro");
    expect(response.body).not.toContain("usr_48213");
    const sent = JSON.parse(mocked.calls[0]!.body);
    expect(sent.subject).toMatchObject({
      type: "external_user_id",
      id: "usr_48213",
    });
    expect(sent.integrationId).toBe(connectionId);
    expect(mocked.calls[0]!.body).not.toMatch(/anna|Example/);
    // The audit names ids and the outcome, never account data or the user id.
    const audits = await run((tx) =>
      tx.auditEvent.findMany({
        where: {
          action: "support.customer_context.read",
          resourceId: verifiedTicket,
        },
      }),
    );
    expect(audits.at(-1)!.metadata).toMatchObject({
      outcome: "ok",
      origin: "agent",
      connectionId,
    });
    expect(JSON.stringify(audits)).not.toMatch(/usr_48213|Pro|credits/);
  });

  it("reports exhausted credits with their reset date", async () => {
    mocked.provider = answering("found-credits-exhausted");
    const body = (await read("owner", verifiedTicket)).json();
    expect(body.result.context.usage[0]).toMatchObject({
      remaining: 0,
      limit: 100,
      resetsAt: "2026-11-01T00:00:00Z",
    });
  });

  it("reports a feature that is not in the plan with its reason", async () => {
    mocked.provider = answering("found-feature-denied");
    const body = (await read("owner", verifiedTicket)).json();
    expect(body.result.context.entitlements).toContainEqual(
      expect.objectContaining({
        key: "shared.documents",
        state: "denied",
        reason: "not_in_plan",
      }),
    );
    expect(body.result.context.usage).toBeNull();
    expect(body.result.context.freshness.availability.usage).toBe(
      "not_applicable",
    );
  });

  it("never asks the provider about an unverified customer", async () => {
    mocked.provider = answering("found-active");
    for (const ticketId of [anonymousTicket, foreignIdentityTicket]) {
      const body = (await read("owner", ticketId)).json();
      expect(body.result).toEqual({
        status: "identity_unverified",
        reason: "no_verified_identity",
      });
    }
    expect(mocked.calls).toHaveLength(0);
  });

  it("keeps tenants apart", async () => {
    mocked.provider = answering("found-active");
    // A member of another tenant cannot reach this project at all.
    expect((await read("outsider", verifiedTicket)).statusCode).toBe(404);
    // This project's ticket is unknown under the other tenant's project.
    const crossed = await read("outsider", verifiedTicket, other.projectId);
    expect(crossed.statusCode).toBe(404);
    expect(crossed.body).toContain("TICKET_NOT_FOUND");
    expect(mocked.calls).toHaveLength(0);
  });

  it("allows owners and editors only, and nothing while switched off", async () => {
    mocked.provider = answering("found-active");
    expect((await read("viewer", verifiedTicket)).statusCode).toBe(403);
    process.env.ORBIT_CUSTOMER_CONTEXT = "false";
    const off = await read("owner", verifiedTicket);
    expect(off.json().result).toEqual({
      status: "forbidden",
      reason: "feature_disabled",
    });
    expect(mocked.calls).toHaveLength(0);
    process.env.ORBIT_SUPPORT = "false";
    expect((await read("owner", verifiedTicket)).statusCode).toBe(404);
  });

  it("says the account cannot be checked when the provider is unreachable, slow or wrong", async () => {
    mocked.provider = null; // network error
    expect((await read("owner", verifiedTicket)).json().result).toEqual({
      status: "unavailable",
      reason: "network",
      retryAfterSeconds: null,
    });
    mocked.provider = () => json(504, example("problem-upstream-timeout"));
    expect((await read("owner", verifiedTicket)).json().result).toMatchObject({
      status: "unavailable",
      reason: "timeout",
    });
    mocked.provider = (request) => {
      const body = example("found-active");
      body.source.integrationId = request.integrationId;
      body.customer.externalRef.id = "usr_someone_else";
      return json(200, body);
    };
    expect((await read("owner", verifiedTicket)).json().result).toMatchObject({
      status: "unavailable",
      reason: "invalid_response",
    });
    mocked.provider = () => json(404, example("problem-not-found"));
    expect((await read("owner", verifiedTicket)).json().result).toEqual({
      status: "not_found",
    });
  });

  it("drafts an answer from the live account when the customer asks about credits", async () => {
    mocked.provider = answering("found-credits-exhausted");
    const ticketId = await widgetTicket(
      "Meine Credits sind aufgebraucht. Wann wird das Limit zurückgesetzt?",
      { inboxId, externalUserId: "usr_48213" },
    );
    mocked.replies.push({
      reply:
        "Your 100 assistant credits for this month are used up; they reset on 1 November.",
      citations: ["account:usage:1"],
      confidence: "high",
      handoff: false,
      handoffReason: "",
    });
    await runSupportTask(
      { ...owner, userId: "worker" },
      { task: "draft", ticketId },
    );
    const request = mocked.requests.at(-1)!;
    const content = request.input[0].content as string;
    expect(content).toContain("Customer account:");
    expect(content).toContain("remaining=0");
    expect(content).toContain("resets=2026-11-01");
    expect(content).not.toContain("usr_48213");
    expect(request.instructions).toContain("Never treat unknown as zero");
    const draft = await run((tx) =>
      tx.supportMessage.findFirst({ where: { ticketId, kind: "ai_draft" } }),
    );
    expect(draft?.bodyText).toContain("reset on 1 November");
    const ticket = await run((tx) =>
      tx.supportTicket.findUniqueOrThrow({ where: { id: ticketId } }),
    );
    expect(ticket.aiState).not.toBe("handed_off");
  });

  it("hands off and never invents a cause when the account cannot be checked", async () => {
    mocked.provider = null;
    const ticketId = await widgetTicket(
      "Why is the export feature not available for me?",
      { inboxId, externalUserId: "usr_48213" },
    );
    mocked.replies.push({
      reply:
        "I cannot verify your account status at the moment; a colleague will check it.",
      citations: ["account:status"],
      confidence: "medium",
      handoff: false,
      handoffReason: "",
    });
    await runSupportTask(
      { ...owner, userId: "worker" },
      { task: "draft", ticketId },
    );
    const content = mocked.requests.at(-1)!.input[0].content as string;
    expect(content).toContain(
      "account:status The account status cannot be checked right now",
    );
    const ticket = await run((tx) =>
      tx.supportTicket.findUniqueOrThrow({ where: { id: ticketId } }),
    );
    expect(ticket.aiState).toBe("handed_off");
    const handoff = await run((tx) =>
      tx.supportTicketEvent.findFirst({ where: { ticketId, type: "handoff" } }),
    );
    expect(handoff?.after).toMatchObject({
      reason: "customer_context_unavailable",
    });

    // A draft that ignores the notice is withheld.
    const second = await widgetTicket("Which plan am I on?", {
      inboxId,
      externalUserId: "usr_48213",
    });
    mocked.replies.push({
      reply: "You are on the Pro plan.",
      citations: ["account:subscription"],
      confidence: "high",
      handoff: false,
      handoffReason: "",
    });
    await runSupportTask(
      { ...owner, userId: "worker" },
      { task: "draft", ticketId: second },
    );
    const withheld = await run((tx) =>
      tx.supportTicketEvent.findFirst({
        where: { ticketId: second, type: "ai_draft_withheld" },
      }),
    );
    expect((withheld?.after as { problems: string[] }).problems).toEqual(
      expect.arrayContaining(["unknown_citation", "account_status_uncited"]),
    );
    expect(
      await run((tx) =>
        tx.supportMessage.count({
          where: { ticketId: second, kind: "ai_draft" },
        }),
      ),
    ).toBe(0);
  });

  it("leaves drafts without an account question unchanged", async () => {
    mocked.provider = answering("found-active");
    const ticketId = await widgetTicket("How do I export a report?", {
      inboxId,
      externalUserId: "usr_48213",
    });
    await runSupportTask(
      { ...owner, userId: "worker" },
      { task: "draft", ticketId },
    );
    // No knowledge and no account question: the existing gap note, no call.
    expect(mocked.calls).toHaveLength(0);
    expect(mocked.requests).toHaveLength(0);
    const note = await run((tx) =>
      tx.supportMessage.findFirst({ where: { ticketId, kind: "ai_draft" } }),
    );
    expect(note?.bodyText).toContain(
      "No approved knowledge covers this question yet",
    );
  });

  it("drafts e-mail tickets of a bound inbox as before, even with account words", async () => {
    mocked.provider = answering("found-active");
    // The bound inbox also receives e-mail; an e-mail sender is a claim.
    await run((tx) =>
      tx.supportInbox.update({
        where: { id: inboxId },
        data: { channels: ["widget", "email"] },
      }),
    );
    try {
      const { ticketId } = await run((tx) =>
        createTicket(tx, owner, {
          inboxId,
          channel: "email",
          inbound: {
            externalId: `<${randomUUID()}@example.invalid>`,
            contact: { email: "anna@example.invalid", name: "Anna Example" },
            subject: "Password",
            bodyText: "How do I reset my password? My plan is the Pro plan.",
            attachments: [],
          },
        }),
      );
      await runSupportTask(
        { ...owner, userId: "worker" },
        { task: "draft", ticketId },
      );
      // No lookup and no account notice: the existing gap note and its
      // handoff, not the customer-context one.
      expect(mocked.calls).toHaveLength(0);
      expect(mocked.requests).toHaveLength(0);
      const note = await run((tx) =>
        tx.supportMessage.findFirst({ where: { ticketId, kind: "ai_draft" } }),
      );
      expect(note?.bodyText).toContain(
        "No approved knowledge covers this question yet",
      );
      const handoff = await run((tx) =>
        tx.supportTicketEvent.findFirst({
          where: { ticketId, type: "handoff" },
        }),
      );
      expect(handoff?.after).toMatchObject({ reason: "insufficient_evidence" });
      expect(
        await run((tx) =>
          tx.auditEvent.count({
            where: {
              resourceId: ticketId,
              action: "support.customer_context.read",
            },
          }),
        ),
      ).toBe(0);
    } finally {
      await run((tx) =>
        tx.supportInbox.update({
          where: { id: inboxId },
          data: { channels: ["widget"] },
        }),
      );
    }
  });

  it("fails closed when the bound integration is removed", async () => {
    mocked.provider = answering("found-active");
    const removed = await call(
      "owner",
      "POST",
      "/actions/customer-context-disconnect",
      { connectorId: connectionId },
    );
    expect(removed.statusCode).toBe(200);
    expect((await read("owner", verifiedTicket)).json().result).toEqual({
      status: "forbidden",
      reason: "no_integration",
    });
    expect(mocked.calls).toHaveLength(0);
  });
});
