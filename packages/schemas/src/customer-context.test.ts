import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CUSTOMER_CONTEXT_LIMITS,
  CUSTOMER_CONTEXT_PATH,
  CUSTOMER_CONTEXT_PROBLEMS,
  customerContext,
  customerContextProblem,
  customerContextRequest,
  interpretCustomerContextResponse,
  type CustomerContextRequest,
} from "./customer-context.ts";
import {
  buildCustomerContextContract,
  contractText,
  CUSTOMER_CONTEXT_CONTRACT_DIR,
  OPENAPI_EXAMPLES,
} from "./customer-context-contract.ts";

const dir = join(process.cwd(), CUSTOMER_CONTEXT_CONTRACT_DIR);
const read = (path: string) =>
  JSON.parse(readFileSync(join(dir, path), "utf8"));
const jsonFiles = (sub: string) =>
  readdirSync(join(dir, sub)).filter((name) => name.endsWith(".json"));
const examples = Object.fromEntries(
  jsonFiles("examples").map((name) => [
    name.replace(/\.json$/, ""),
    read(`examples/${name}`),
  ]),
);
const request = examples.request as CustomerContextRequest;
const found = (name: string) => structuredClone(examples[name]);

describe("customer context contract v1 artifacts", () => {
  it("committed JSON Schemas and OpenAPI match the zod source", () => {
    for (const [name, value] of Object.entries(
      buildCustomerContextContract(examples),
    ))
      expect(
        readFileSync(join(dir, name), "utf8"),
        `${name} is stale: run pnpm contract:customer-context`,
      ).toBe(contractText(value));
  });

  it("every example is valid and used in the OpenAPI document", () => {
    const used = new Set<string>(Object.values(OPENAPI_EXAMPLES).flat());
    for (const [name, value] of Object.entries(examples)) {
      expect(used.has(name), `${name} is not referenced`).toBe(true);
      const schema =
        name === "request"
          ? customerContextRequest
          : name.startsWith("problem-")
            ? customerContextProblem
            : customerContext;
      const parsed = schema.safeParse(value);
      expect(parsed.success, `${name}: ${parsed.error?.message}`).toBe(true);
      expect(Buffer.byteLength(JSON.stringify(value))).toBeLessThan(
        CUSTOMER_CONTEXT_LIMITS.maxBodyBytes,
      );
    }
  });

  it("documents every problem code with its status and an example", () => {
    const openapi = read("openapi.json");
    const responses = openapi.paths[CUSTOMER_CONTEXT_PATH].post.responses;
    for (const [code, status] of Object.entries(CUSTOMER_CONTEXT_PROBLEMS)) {
      expect(responses[status], code).toBeDefined();
      expect(responses[status].description).toContain(code);
    }
    for (const response of Object.values<any>(responses)) {
      const media = Object.values<any>(response.content)[0];
      expect(Object.keys(media.examples).length).toBeGreaterThan(0);
    }
    expect(openapi["x-orbit-problem-codes"]).toEqual(CUSTOMER_CONTEXT_PROBLEMS);
  });

  it("resolves every local $ref of the OpenAPI document", () => {
    const openapi = read("openapi.json");
    const refs = JSON.stringify(openapi).match(/"\$ref":"[^"]+"/g) ?? [];
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) {
      const path = ref.slice(8, -1);
      expect(path.startsWith("#/")).toBe(true);
      const target = path
        .slice(2)
        .split("/")
        .reduce<any>((node, part) => node?.[part], openapi);
      expect(target, path).toBeDefined();
    }
  });

  it("allows no payment, trading, household or contact fields", () => {
    const forbidden =
      /card|iban|bic|payment|invoice|wallet|trad(e|ing)|balance|position|order|family|household|child|member|address|phone|email|birth|password|token|secret|metadata/i;
    const names = new Set<string>();
    const schemaKeys = (node: unknown): void => {
      if (!node || typeof node !== "object") return;
      const record = node as Record<string, unknown>;
      if (record.properties && typeof record.properties === "object")
        for (const name of Object.keys(record.properties)) names.add(name);
      Object.values(record).forEach(schemaKeys);
    };
    const valueKeys = (node: unknown): void => {
      if (!node || typeof node !== "object") return;
      for (const [name, value] of Object.entries(node)) {
        if (!Array.isArray(node)) names.add(name);
        valueKeys(value);
      }
    };
    for (const name of jsonFiles(".")) schemaKeys(read(name));
    Object.values(examples).forEach(valueKeys);
    expect(names.size).toBeGreaterThan(30);
    expect([...names].filter((name) => forbidden.test(name))).toEqual([]);
  });
});

describe("customer context schema rules", () => {
  const invalid: Record<string, string> = {
    "forbidden-payment-field": "subscription",
    "forbidden-customer-email": "customer",
    "missing-remaining": "usage.0.remaining",
    "negative-remaining": "usage.0.remaining",
    "unknown-version": "schemaVersion",
    "section-availability-mismatch": "usage",
  };

  it("rejects every invalid example at the expected path", () => {
    expect(
      jsonFiles("examples/invalid")
        .map((name) => name.replace(/\.json$/, ""))
        .sort(),
    ).toEqual(Object.keys(invalid).sort());
    for (const [name, path] of Object.entries(invalid)) {
      const parsed = customerContext.safeParse(
        read(`examples/invalid/${name}.json`),
      );
      expect(parsed.success, name).toBe(false);
      expect(
        parsed.error!.issues.map((issue) => issue.path.join(".")),
        name,
      ).toContain(path);
    }
  });

  it("keeps unknown credits null and never turns them into 0", () => {
    const context = customerContext.parse(found("found-unlimited-and-unknown"));
    const credits = context.usage!.find((item) => item.key === "ai.credits")!;
    expect(credits.remaining).toBeNull();
    expect(credits.limit).toBeNull();
    expect(credits.unlimited).toBeNull();
    expect(context.subscription).toBeNull();
  });

  it("rejects an unlimited quota that still carries a limit", () => {
    const value = found("found-unlimited-and-unknown");
    value.usage[0].limit = 10;
    expect(customerContext.safeParse(value).success).toBe(false);
  });

  it("rejects duplicate entitlement keys and oversized lists", () => {
    const duplicate = found("found-active");
    duplicate.entitlements.push(duplicate.entitlements[0]);
    expect(customerContext.safeParse(duplicate).success).toBe(false);
    const oversized = found("found-active");
    oversized.usage = Array.from(
      { length: CUSTOMER_CONTEXT_LIMITS.maxUsage + 1 },
      (_, index) => ({
        ...oversized.usage[0],
        key: `quota.${index}`,
      }),
    );
    expect(customerContext.safeParse(oversized).success).toBe(false);
  });

  it("requires a verified subject and carries no contact data in the request", () => {
    expect(
      customerContextRequest.safeParse({
        ...request,
        email: "person@example.com",
      }).success,
    ).toBe(false);
    const unverified = structuredClone(request) as any;
    delete unverified.subject.verification;
    expect(customerContextRequest.safeParse(unverified).success).toBe(false);
  });

  it("rejects a problem whose status does not match its code", () => {
    expect(
      customerContextProblem.safeParse({
        ...found("problem-not-found"),
        status: 400,
      }).success,
    ).toBe(false);
  });
});

describe("interpreting provider responses", () => {
  it("accepts a matching context", () => {
    expect(
      interpretCustomerContextResponse(request, 200, found("found-active")),
    ).toMatchObject({ status: "ok" });
  });

  it("rejects a context for another integration or another customer", () => {
    const foreignIntegration = found("found-active");
    foreignIntegration.source.integrationId =
      "11111111-2222-4333-8444-555555555555";
    expect(
      interpretCustomerContextResponse(request, 200, foreignIntegration),
    ).toEqual({
      status: "unavailable",
      reason: "invalid_response",
      retryAfterSeconds: null,
    });
    const foreignCustomer = found("found-active");
    foreignCustomer.customer.externalRef.id = "usr_other";
    expect(
      interpretCustomerContextResponse(request, 200, foreignCustomer),
    ).toMatchObject({
      reason: "invalid_response",
    });
  });

  it("maps problems to Orbit results", () => {
    const cases: Array<[string, number, unknown]> = [
      ["problem-not-found", 404, { status: "not_found" }],
      [
        "problem-identity-not-verified",
        422,
        { status: "identity_unverified", reason: "provider_rejected" },
      ],
      [
        "problem-access-denied",
        403,
        { status: "forbidden", reason: "provider_denied" },
      ],
      [
        "problem-unauthenticated",
        401,
        {
          status: "unavailable",
          reason: "misconfigured",
          retryAfterSeconds: null,
        },
      ],
      [
        "problem-unsupported-version",
        400,
        {
          status: "unavailable",
          reason: "misconfigured",
          retryAfterSeconds: null,
        },
      ],
      [
        "problem-rate-limited",
        429,
        {
          status: "unavailable",
          reason: "rate_limited",
          retryAfterSeconds: 30,
        },
      ],
      [
        "problem-service-unavailable",
        503,
        {
          status: "unavailable",
          reason: "provider_error",
          retryAfterSeconds: 60,
        },
      ],
      [
        "problem-upstream-timeout",
        504,
        { status: "unavailable", reason: "timeout", retryAfterSeconds: null },
      ],
    ];
    for (const [name, status, expected] of cases)
      expect(
        interpretCustomerContextResponse(request, status, found(name)),
        name,
      ).toEqual(expected);
  });

  it("never reports not found for a bare 404 or an unparseable body", () => {
    expect(
      interpretCustomerContextResponse(request, 404, undefined),
    ).toMatchObject({ reason: "misconfigured" });
    expect(
      interpretCustomerContextResponse(request, 200, undefined),
    ).toMatchObject({ reason: "invalid_response" });
    expect(
      interpretCustomerContextResponse(request, 502, "<html>"),
    ).toMatchObject({ reason: "provider_error" });
  });
});
