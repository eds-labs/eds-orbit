// Unit and contract tests for the n8n customer context layer: gateway
// authentication, the product adapters against Orbit's zod contract, and the
// generated workflow Code nodes run outside n8n.

import { createHash, createHmac } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { customerContext, customerContextProblem } from "../../../../packages/schemas/src/customer-context.ts";
import { IDS, workflows } from "../build.mjs";
import { mapDeskResponse, runDeskAdapter } from "../src/desk.js";
import { mapFamilyPlanResponse, runFamilyPlanAdapter } from "../src/familyplan.js";
import { authenticate, parseIntegrations } from "../src/gateway.js";
import { contextIssues, finalizeResponse, productTimeout, productUrl, validateRequest } from "../src/shared.js";

const here = dirname(fileURLToPath(import.meta.url));
const readJson = (...parts) => JSON.parse(readFileSync(join(here, ...parts), "utf8"));
const contractDir = join(here, "../../../../packages/schemas/contracts/customer-context/v1/examples");
const example = (name) => JSON.parse(readFileSync(join(contractDir, name), "utf8"));
const deskFixture = (name) => readJson("../fixtures/desk", `desk-${name}.json`);
const fpFixture = (name) => readJson("../fixtures/familyplan", `familyplan-${name}.json`);

const integrationId = "6f1b7c55-3f0e-4c2b-8f0a-2d9c4e5a7b10";
const token = "cc-test-token-" + "a".repeat(40);
const signingSecret = "cc-test-signing-secret-" + "b".repeat(40);
const NOW = Date.parse("2026-10-21T09:15:00.000Z");
const generatedAt = "2026-10-21T09:15:01.000Z";

function lookup(id, extra = {}) {
  return {
    schemaVersion: "1.0",
    requestId: "0c6a7f3e-2b1d-4e8f-9a7b-3c5d1e2f4a6b",
    requestedAt: "2026-10-21T09:15:00.000Z",
    integrationId,
    acceptVersions: ["1.0"],
    subject: {
      type: "external_user_id",
      id,
      verification: { method: "widget_hmac", verifiedAt: "2026-10-21T09:00:00.000Z" },
    },
    purpose: "support",
    ...extra,
  };
}

function expectValidContext(result, request) {
  expect(result.status).toBe(200);
  expect(contextIssues(result.body, request)).toEqual([]);
  expect(customerContext.parse(result.body)).toEqual(result.body);
  return result.body;
}

function expectProblem(result, code) {
  expect(result.body.code).toBe(code);
  expect(customerContextProblem.parse(result.body)).toEqual(result.body);
}

describe("shared validator agrees with Orbit's zod contract", () => {
  const files = readdirSync(contractDir).filter((name) => name.startsWith("found-"));
  it.each(files)("accepts %s", (name) => {
    expect(contextIssues(example(name))).toEqual([]);
  });
  const invalid = readdirSync(join(contractDir, "invalid")).filter((name) => name.endsWith(".json"));
  it.each(invalid)("rejects invalid/%s like zod", (name) => {
    const value = example(`invalid/${name}`);
    expect(customerContext.safeParse(value).success).toBe(false);
    expect(contextIssues(value)).not.toEqual([]);
  });
  it("validates the example request and rejects extra or wrong fields", () => {
    expect(validateRequest(example("request.json")).ok).toBe(true);
    expect(validateRequest({ ...example("request.json"), email: "a@example.invalid" }).code).toBe("invalid_request");
    expect(validateRequest({ ...example("request.json"), schemaVersion: "2.0", acceptVersions: ["2.0"] }).code).toBe(
      "unsupported_version",
    );
  });
  it("allows plain HTTP only for loopback product stubs", () => {
    expect(productUrl("https://api.desk.uliquid.vip/")).toBe("https://api.desk.uliquid.vip");
    expect(productUrl("http://127.0.0.1:5801")).toBe("http://127.0.0.1:5801");
    expect(productUrl("http://api.desk.uliquid.vip")).toBeNull();
    expect(productUrl("https://user:pw@api.example.com")).toBeNull();
    expect(productUrl("not a url")).toBeNull();
    expect(productUrl("https://api.example.com/x?y=1")).toBeNull();
    expect(productUrl("https://api.example.com/#x")).toBeNull();
    expect(productUrl("https://x.supabase.co/functions/v1/support-customer-context")).toBe(
      "https://x.supabase.co/functions/v1/support-customer-context",
    );
    expect(productUrl("http://localhost:5802/a/")).toBe("http://localhost:5802/a");
  });
});

describe("gateway authentication", () => {
  const integrations = parseIntegrations(
    JSON.stringify([
      { integrationId, adapter: "uliquid-desk", tokenSha256: createHash("sha256").update(token).digest("hex"), signingSecret },
      { integrationId: "7a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d", adapter: "unknown", tokenSha256: "0".repeat(64), signingSecret },
      { integrationId: "broken" },
    ]),
  );
  const crypto = { createHash, createHmac, timingSafeEqual: (a, b) => a.equals(b) };
  function call(body, override = {}) {
    const raw = typeof body === "string" ? body : JSON.stringify(body);
    const timestamp = String(Math.floor(NOW / 1000));
    const headers = {
      authorization: `Bearer ${token}`,
      "x-orbit-timestamp": timestamp,
      "x-orbit-request-id": body.requestId,
      "x-orbit-signature": "v1=" + createHmac("sha256", signingSecret).update(`${timestamp}.${raw}`).digest("hex"),
      ...override,
    };
    return authenticate({ raw, headers, now: NOW, integrations, crypto });
  }

  it("drops invalid integration entries", () => {
    expect(integrations).toHaveLength(2);
    expect(parseIntegrations("not json")).toEqual([]);
  });
  it("accepts a correctly signed request and routes to the bound adapter", () => {
    const result = call(lookup("ckdesk0001active"));
    expect(result).toMatchObject({ ok: true, adapter: "uliquid-desk", adapterWorkflowId: IDS.desk });
  });
  it.each([
    ["wrong token", { authorization: "Bearer wrong-token-" + "c".repeat(40) }],
    ["no token", { authorization: "" }],
    ["wrong signature", { "x-orbit-signature": "v1=" + "0".repeat(64) }],
    ["stale timestamp", { "x-orbit-timestamp": String(Math.floor(NOW / 1000) - 301) }],
    ["malformed timestamp", { "x-orbit-timestamp": "yesterday" }],
  ])("refuses %s with a generic 401", (_, override) => {
    const result = call(lookup("ckdesk0001active"), override);
    expect(result).toMatchObject({ ok: false, status: 401 });
    expect(result.body).not.toHaveProperty("requestId");
    expectProblem(result, "unauthenticated");
  });
  it("refuses an integration it does not know (other tenant) like a wrong token", () => {
    const result = call(lookup("ckdesk0001active", { integrationId: "9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a" }));
    expect(result).toMatchObject({ ok: false, status: 401 });
  });
  it("answers invalid and mismatched requests only after authentication", () => {
    expectProblem(call(lookup("ckdesk0001active", { purpose: "marketing" })), "invalid_request");
    expectProblem(call(lookup("ckdesk0001active"), { "x-orbit-request-id": "other" }), "invalid_request");
    expectProblem(call(lookup("ckdesk0001active", { schemaVersion: "2.0", acceptVersions: ["2.0"] })), "unsupported_version");
    expect(authenticate({ raw: "{", headers: {}, now: NOW, integrations, crypto }).status).toBe(400);
    expect(authenticate({ raw: "x".repeat(70000), headers: {}, now: NOW, integrations, crypto }).status).toBe(400);
  });
  it("never routes to an adapter outside the allowlist", () => {
    const other = lookup("ckdesk0001active", { integrationId: "7a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d" });
    const raw = JSON.stringify(other);
    const timestamp = String(Math.floor(NOW / 1000));
    const result = authenticate({
      raw,
      headers: {
        authorization: "Bearer x",
        "x-orbit-timestamp": timestamp,
        "x-orbit-request-id": other.requestId,
        "x-orbit-signature": "v1=" + createHmac("sha256", signingSecret).update(`${timestamp}.${raw}`).digest("hex"),
      },
      now: NOW,
      integrations: [{ ...integrations[1], tokenSha256: createHash("sha256").update("x").digest("hex") }],
      crypto,
    });
    expectProblem(result, "service_unavailable");
  });
});

describe("uLiquid Desk adapter", () => {
  const ok = (body, headers = {}) => ({ statusCode: 200, body, headers });

  it("maps an active customer with credits", () => {
    const request = lookup("ckdesk0001active");
    const body = expectValidContext(mapDeskResponse(request, ok(deskFixture("active")), generatedAt), request);
    expect(body.source.system).toBe("uliquid-desk");
    expect(body.subscription).toMatchObject({ status: "active", plan: { key: "pro" } });
    const credits = body.usage.find((item) => item.key === "ai_credits");
    expect(credits.remaining).toBeGreaterThan(0);
  });
  it("reports exhausted credits as 0 remaining, from Desk's own value", () => {
    const request = lookup("ckdesk0002nocred");
    const body = expectValidContext(mapDeskResponse(request, ok(deskFixture("credits-exhausted")), generatedAt), request);
    expect(body.usage.find((item) => item.key === "ai_credits")).toMatchObject({ remaining: 0, unlimited: false });
    expect(body.subscription.cancellation.state).toBe("scheduled");
  });
  it("reports a feature outside the plan as denied", () => {
    const request = lookup("ckdesk0003denied");
    const body = expectValidContext(mapDeskResponse(request, ok(deskFixture("feature-denied")), generatedAt), request);
    expect(body.entitlements.find((item) => item.key === "ai_agent_chat")).toMatchObject({
      state: "denied",
      reason: "not_in_plan",
      source: null,
    });
  });
  it("keeps an unknown balance unknown, never 0", () => {
    const fixture = deskFixture("active");
    delete fixture.aiCredits.available;
    fixture.aiCredits.usage.thisMonth = "not a number";
    const request = lookup("ckdesk0001active");
    const credits = expectValidContext(mapDeskResponse(request, ok(fixture), generatedAt), request).usage[0];
    expect(credits.remaining).toBeNull();
    expect(credits.used).toBeNull();
  });
  it("honours include and drops everything Desk sends beyond the allowlist", () => {
    const request = lookup("ckdesk0001active", { include: ["subscription"] });
    const body = expectValidContext(mapDeskResponse(request, ok(deskFixture("active")), generatedAt), request);
    expect(body.entitlements).toBeNull();
    expect(body.freshness.availability.usage).toBe("not_requested");
    expect(JSON.stringify(body)).not.toMatch(/exchange|wallet|balanceHistory|capabilityPlan/i);
  });
  it.each([
    [404, "customer_not_found"],
    [400, "customer_not_found"],
    [401, "service_unavailable"],
    [403, "access_denied"],
    [500, "service_unavailable"],
    [504, "upstream_timeout"],
  ])("maps Desk %s to %s", (statusCode, code) => {
    expectProblem(mapDeskResponse(lookup("ckdesk0001active"), { statusCode, body: {}, headers: {} }, generatedAt), code);
  });
  it("passes Desk's Retry-After on 429", () => {
    const result = mapDeskResponse(lookup("ckdesk0001active"), { statusCode: 429, body: {}, headers: { "retry-after": "30" } }, generatedAt);
    expect(result.body).toMatchObject({ code: "rate_limited", retryAfterSeconds: 30 });
  });
  it("refuses a Desk answer for another customer", () => {
    expectProblem(mapDeskResponse(lookup("ckdesk0009other"), ok(deskFixture("active")), generatedAt), "service_unavailable");
  });
  it("calls Desk with its token, a timeout and no customer data beyond the id", async () => {
    const calls = [];
    const httpRequest = async (options) => {
      calls.push(options);
      return ok(deskFixture("active"));
    };
    const env = { CC_DESK_BASE_URL: "https://api.desk.uliquid.vip", CC_DESK_TOKEN: "dctx_" + "t".repeat(43) };
    const request = lookup("ckdesk0001active");
    expectValidContext(await runDeskAdapter({ request, env, httpRequest, now: () => new Date(generatedAt) }), request);
    expect(calls).toEqual([
      expect.objectContaining({
        method: "GET",
        url: "https://api.desk.uliquid.vip/integrations/v1/customers/ckdesk0001active/context",
        headers: { authorization: `Bearer ${env.CC_DESK_TOKEN}`, accept: "application/json" },
        timeout: 2500,
      }),
    ]);
  });
  it("gives Desk the budget of CC_DESK_TIMEOUT_MS, bounded", async () => {
    const timeouts = [];
    const httpRequest = async (options) => {
      timeouts.push(options.timeout);
      return ok(deskFixture("active"));
    };
    const env = { CC_DESK_BASE_URL: "https://api.desk.uliquid.vip", CC_DESK_TOKEN: "dctx_" + "t".repeat(43) };
    for (const value of ["6500", "60000", "100", "soon", "", undefined])
      await runDeskAdapter({
        request: lookup("ckdesk0001active"),
        env: { ...env, CC_DESK_TIMEOUT_MS: value },
        httpRequest,
        now: () => new Date(generatedAt),
      });
    expect(timeouts).toEqual([6500, 7000, 2500, 2500, 2500, 2500]);
    expect(productTimeout("6500")).toBe(6500);
  });
  it("does not call Desk for foreign ids or without configuration", async () => {
    const httpRequest = async () => {
      throw new Error("must not be called");
    };
    const env = { CC_DESK_BASE_URL: "https://api.desk.uliquid.vip", CC_DESK_TOKEN: "dctx_" + "t".repeat(43) };
    const run = (id, e) => runDeskAdapter({ request: lookup(id), env: e, httpRequest, now: () => new Date() });
    expectProblem(await run("familyplan:5b2f0c1e-7d4a-4c8e-9a61-0f3b2d7c1a01", env), "customer_not_found");
    expectProblem(await run("ckdesk0001active", { ...env, CC_DESK_TOKEN: "" }), "service_unavailable");
    expectProblem(await run("ckdesk0001active", { ...env, CC_DESK_BASE_URL: "http://api.desk.uliquid.vip" }), "service_unavailable");
  });
  it("maps timeouts and network errors", async () => {
    const env = { CC_DESK_BASE_URL: "https://api.desk.uliquid.vip", CC_DESK_TOKEN: "dctx_" + "t".repeat(43) };
    const fail = (error) => async () => {
      throw error;
    };
    const run = (error) => runDeskAdapter({ request: lookup("ckdesk0001active"), env, httpRequest: fail(error), now: () => new Date() });
    expectProblem(await run(Object.assign(new Error("timeout of 2500ms exceeded"), { code: "ECONNABORTED" })), "upstream_timeout");
    expectProblem(await run(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" })), "service_unavailable");
  });
});

describe("FamilyPlan adapter", () => {
  const ok = (body) => ({ statusCode: 200, body, headers: {} });
  const id = (n) => `familyplan:5b2f0c1e-7d4a-4c8e-9a61-0f3b2d7c1a0${n}`;

  it("maps an active Premium family", () => {
    const request = lookup(id(1));
    const body = expectValidContext(mapFamilyPlanResponse(request, ok(fpFixture("premium")), generatedAt), request);
    expect(body.subscription).toMatchObject({
      status: "active",
      plan: { key: "family_premium" },
      currentPeriodEnd: "2026-11-21T09:00:00.000Z",
      cancellation: { state: "unknown" },
    });
    expect(body.entitlements.every((item) => item.state === "granted" && item.source === "plan")).toBe(true);
  });
  it("maps a customer without valid Premium: expired, Premium features denied", () => {
    const request = lookup(id(2));
    const body = expectValidContext(mapFamilyPlanResponse(request, ok(fpFixture("no-premium")), generatedAt), request);
    expect(body.subscription).toMatchObject({ status: "expired", plan: null, cancellation: { state: "effective" } });
    expect(body.entitlements.find((item) => item.key === "chat")).toMatchObject({ state: "denied", reason: "plan_inactive" });
    expect(body.entitlements.find((item) => item.key === "calendar")).toMatchObject({ state: "granted" });
  });
  it("marks multiple families without family data", () => {
    const request = lookup(id(3));
    const body = expectValidContext(mapFamilyPlanResponse(request, ok(fpFixture("multiple-families")), generatedAt), request);
    expect(body.subscription.status).toBe("active");
    expect(body.entitlements[0].source).toBe("override");
    expect(body.usage.map((item) => [item.key, item.used])).toEqual([
      ["families", 2],
      ["families.premium", 1],
    ]);
  });
  it("maps a trial and a never-subscribed account", () => {
    const trial = fpFixture("premium");
    trial.access.status = "trial";
    const request = lookup(id(1));
    const body = expectValidContext(mapFamilyPlanResponse(request, ok(trial), generatedAt), request);
    expect(body.subscription).toMatchObject({ status: "trialing", trialEndsAt: "2026-11-21T09:00:00.000Z", currentPeriodEnd: null });
    const none = fpFixture("no-premium");
    none.access.status = "none";
    const request2 = lookup(id(2));
    const body2 = expectValidContext(mapFamilyPlanResponse(request2, ok(none), generatedAt), request2);
    expect(body2.subscription).toMatchObject({ status: "none", cancellation: { state: "none" } });
    expect(body2.entitlements.find((item) => item.key === "chat").reason).toBe("not_in_plan");
  });
  it.each([
    ["extra family data", (b) => (b.customer.familyName = "Muster")],
    ["other customer", (b) => (b.customer.externalUserId = id(9))],
    ["unknown access status", (b) => (b.access.status = "lifetime")],
    ["more premium families than families", (b) => (b.customer.premiumFamilyCount = 5)],
  ])("refuses an off-contract answer: %s", (_, change) => {
    const body = fpFixture("premium");
    change(body);
    const result = mapFamilyPlanResponse(lookup(id(1)), ok(body), generatedAt);
    // Unknown extra fields are not copied; the others fail closed.
    if (result.status === 200) expect(JSON.stringify(result.body)).not.toContain("Muster");
    else expectProblem(result, "service_unavailable");
  });
  it("posts only the id with its token, and never for foreign ids", async () => {
    const calls = [];
    const env = { CC_FAMILYPLAN_FUNCTION_URL: "https://x.supabase.co/functions/v1/support-customer-context", CC_FAMILYPLAN_TOKEN: "fpctx_" + "t".repeat(43) };
    const httpRequest = async (options) => {
      calls.push(options);
      return ok(fpFixture("premium"));
    };
    const request = lookup(id(1));
    expectValidContext(await runFamilyPlanAdapter({ request, env, httpRequest, now: () => new Date(generatedAt) }), request);
    expect(calls).toEqual([
      expect.objectContaining({
        method: "POST",
        url: env.CC_FAMILYPLAN_FUNCTION_URL,
        headers: { "x-customer-context-token": env.CC_FAMILYPLAN_TOKEN, accept: "application/json" },
        body: { externalUserId: id(1) },
        timeout: 2500,
      }),
    ]);
    for (const other of ["ckdesk0001active", "familyplan:NOT-A-UUID", `${id(1)}x`])
      expectProblem(await runFamilyPlanAdapter({ request: lookup(other), env, httpRequest, now: () => new Date() }), "customer_not_found");
    expect(calls).toHaveLength(1);
    // The connection check reaches FamilyPlan, whose 400 means "not found".
    const check = lookup("orbit-connection-check");
    const answer = await runFamilyPlanAdapter({
      request: check,
      env,
      httpRequest: async (options) => {
        calls.push(options);
        return { statusCode: 400, body: { error: "INVALID_REQUEST" }, headers: {} };
      },
      now: () => new Date(),
    });
    expectProblem(answer, "customer_not_found");
    expect(calls.at(-1).body).toEqual({ externalUserId: "orbit-connection-check" });
  });
});

describe("gateway finalize", () => {
  const request = lookup("ckdesk0001active");
  it("passes a valid context and valid problems", () => {
    const context = mapDeskResponse(request, { statusCode: 200, body: deskFixture("active"), headers: {} }, generatedAt);
    expect(finalizeResponse(request, context)).toEqual(context);
    expect(finalizeResponse(request, { status: 404, body: { code: "customer_not_found" } }).body.code).toBe("customer_not_found");
  });
  it("turns everything off-contract into service_unavailable", () => {
    const context = mapDeskResponse(request, { statusCode: 200, body: deskFixture("active"), headers: {} }, generatedAt);
    for (const bad of [
      { ...context, body: { ...context.body, email: "a@example.invalid" } },
      { ...context, body: { ...context.body, source: { ...context.body.source, integrationId: "7a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d" } } },
      { status: 404, body: { code: "rate_limited" } },
      { error: "adapter crashed" },
      null,
    ])
      expect(finalizeResponse(request, bad).body.code).toBe("service_unavailable");
  });
});

describe("generated workflows", () => {
  it("are up to date with src/ (run build.mjs)", () => {
    for (const [file, workflow] of Object.entries(workflows()))
      expect(readFileSync(join(here, "../workflows", file), "utf8")).toBe(JSON.stringify(workflow, null, 2) + "\n");
  });
  it("store no execution data, restrict adapters to the gateway and carry no secrets", () => {
    for (const workflow of Object.values(workflows())) {
      expect(workflow.settings).toMatchObject({ saveDataSuccessExecution: "none", saveDataErrorExecution: "none", saveManualExecutions: false });
      expect(JSON.stringify(workflow)).not.toMatch(/dctx_[A-Za-z0-9]|Bearer [A-Za-z0-9]{20}|"credentials"/);
    }
    expect(workflows()["adapter-uliquid-desk.json"].settings).toMatchObject({ callerPolicy: "workflowsFromAList", callerIds: IDS.gateway });
    expect(workflows()["adapter-familyplan.json"].settings).toMatchObject({ callerPolicy: "workflowsFromAList", callerIds: IDS.gateway });
  });

  // Runs a Code node's jsCode the way n8n does: an async function body with
  // `$input`, `$env`, `$` and `require`, and `this.helpers`. n8n's sandbox
  // has no global URL, so it is hidden here as well.
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  function runNode(code, { input, env = {}, nodes = {}, helpers = {} }) {
    const fn = new AsyncFunction("$input", "$env", "$", "require", "URL", code);
    const $input = { first: () => ({ json: input }) };
    const $ = (name) => ({ first: () => ({ json: nodes[name] }) });
    return fn.call({ helpers }, $input, env, $, createRequire(import.meta.url), undefined);
  }
  const node = (file, name) => workflows()[file].nodes.find((n) => n.name === name).parameters.jsCode;

  it("gateway Authenticate node verifies a signed webhook call", async () => {
    const body = lookup("ckdesk0001active");
    const raw = JSON.stringify(body);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const headers = {
      authorization: `Bearer ${token}`,
      "x-orbit-timestamp": timestamp,
      "x-orbit-request-id": body.requestId,
      "x-orbit-signature": "v1=" + createHmac("sha256", signingSecret).update(`${timestamp}.${raw}`).digest("hex"),
    };
    const env = {
      CC_GATEWAY_INTEGRATIONS: JSON.stringify([
        { integrationId, adapter: "uliquid-desk", tokenSha256: createHash("sha256").update(token).digest("hex"), signingSecret },
      ]),
    };
    const helpers = { getBinaryDataBuffer: async () => Buffer.from(raw) };
    const [ok] = await runNode(node("gateway.json", "Authenticate"), { input: { headers }, env, helpers });
    expect(ok.json).toMatchObject({ ok: true, adapterWorkflowId: IDS.desk });
    const [denied] = await runNode(node("gateway.json", "Authenticate"), {
      input: { headers: { ...headers, authorization: "Bearer nope" } },
      env,
      helpers,
    });
    expect(denied.json).toMatchObject({ ok: false, status: 401 });
    const [empty] = await runNode(node("gateway.json", "Authenticate"), {
      input: { headers },
      env,
      helpers: { getBinaryDataBuffer: async () => { throw new Error("no binary"); } },
    });
    expect(empty.json).toMatchObject({ ok: false, status: 400 });
  });

  it("adapter nodes translate through n8n's httpRequest helper", async () => {
    const request = lookup(`familyplan:5b2f0c1e-7d4a-4c8e-9a61-0f3b2d7c1a02`);
    const [fp] = await runNode(node("adapter-familyplan.json", "Lookup and translate"), {
      input: { request },
      env: { CC_FAMILYPLAN_FUNCTION_URL: "https://x.supabase.co/functions/v1/support-customer-context", CC_FAMILYPLAN_TOKEN: "f".repeat(48) },
      helpers: { httpRequest: async () => ({ statusCode: 200, body: fpFixture("no-premium"), headers: {} }) },
    });
    expectValidContext(fp.json, request);
    const [finalized] = await runNode(node("gateway.json", "Finalize"), { input: fp.json, nodes: { Authenticate: { request } } });
    expect(finalized.json.status).toBe(200);

    const deskRequest = lookup("ckdesk0002nocred");
    const [desk] = await runNode(node("adapter-uliquid-desk.json", "Lookup and translate"), {
      input: { request: deskRequest },
      env: { CC_DESK_BASE_URL: "https://api.desk.uliquid.vip", CC_DESK_TOKEN: "d".repeat(48) },
      helpers: { httpRequest: async () => ({ statusCode: 200, body: deskFixture("credits-exhausted"), headers: {} }) },
    });
    expectValidContext(desk.json, deskRequest);
  });
});
