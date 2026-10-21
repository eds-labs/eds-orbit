import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { ConnectorError } from "../../../../../packages/connectors/src/http.ts";
import {
  customerContextTimeout,
  customerContextUrl,
  lookupCustomerContext,
  resetCustomerContextCircuits,
  signCustomerContextBody,
  type CustomerContextTarget,
} from "./client.ts";

const examples = "packages/schemas/contracts/customer-context/v1/examples";
const example = (name: string) =>
  JSON.parse(readFileSync(`${examples}/${name}.json`, "utf8"));

const target: CustomerContextTarget = {
  connectionId: "7d1f6a0e-3c4b-4f8a-9b2e-5a6c7d8e9f01",
  baseUrl: "https://hooks.example.com/webhook/orbit",
  timeoutMs: 4000,
  credential: { token: "token-for-tests-123", signingSecret: "s".repeat(40) },
};
const subject = {
  id: "usr_48213",
  verifiedAt: new Date("2026-10-20T18:02:11Z"),
};

type Call = { url: string; init: RequestInit };
function provider(respond: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetch = async (url: string | URL, init: RequestInit = {}) => {
    const call = { url: String(url), init };
    calls.push(call);
    return respond(call);
  };
  return { calls, fetch };
}
const json = (
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

beforeEach(() => resetCustomerContextCircuits());

describe("customer context client", () => {
  it("sends a signed, data-minimal lookup to the integration's v1 path", async () => {
    const p = provider(() => json(200, example("found-active")));
    const { result } = await lookupCustomerContext(target, subject, {
      fetch: p.fetch,
      now: () => new Date("2026-10-21T09:15:00Z"),
    });
    expect(result.status).toBe("ok");
    const [call] = p.calls;
    expect(call!.url).toBe(
      "https://hooks.example.com/webhook/orbit/v1/customer-context/lookup",
    );
    const headers = call!.init.headers as Record<string, string>;
    const body = String(call!.init.body);
    expect(headers.authorization).toBe("Bearer token-for-tests-123");
    expect(headers["x-orbit-timestamp"]).toBe("1792574100");
    const expected = createHmac("sha256", target.credential.signingSecret)
      .update(`1792574100.${body}`)
      .digest("hex");
    expect(headers["x-orbit-signature"]).toBe(`v1=${expected}`);
    const sent = JSON.parse(body);
    expect(headers["x-orbit-request-id"]).toBe(sent.requestId);
    expect(sent).toMatchObject({
      integrationId: target.connectionId,
      subject: {
        type: "external_user_id",
        id: "usr_48213",
        verification: {
          method: "widget_hmac",
          verifiedAt: "2026-10-20T18:02:11.000Z",
        },
      },
      purpose: "support",
    });
    // No e-mail, name or Orbit tenant id leaves Orbit.
    expect(body).not.toMatch(/email|name|workspace|project/i);
    expect(call!.init.signal).toBeInstanceOf(AbortSignal);
  });

  it("reports exhausted credits and denied features as they are", async () => {
    const p = provider(() => json(200, example("found-credits-exhausted")));
    const { result } = await lookupCustomerContext(target, subject, {
      fetch: p.fetch,
    });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.context.usage![0]).toMatchObject({
      remaining: 0,
      limit: 100,
    });
    expect(result.context.entitlements![0]).toMatchObject({
      state: "denied",
      reason: "limit_reached",
    });
  });

  it("maps an unreachable provider, a timeout and a private address to unavailable", async () => {
    for (const [error, reason] of [
      [new ConnectorError("NETWORK_ERROR", "not_sent", true), "network"],
      [new ConnectorError("REQUEST_TIMEOUT", "not_sent", true), "timeout"],
      [new ConnectorError("PRIVATE_ENDPOINT"), "misconfigured"],
    ] as const) {
      resetCustomerContextCircuits();
      const p = provider(() => {
        throw error;
      });
      const { result } = await lookupCustomerContext(target, subject, {
        fetch: p.fetch,
      });
      expect(result).toEqual({
        status: "unavailable",
        reason,
        retryAfterSeconds: null,
      });
    }
  });

  it("aborts a provider that does not answer within the deadline", async () => {
    const hanging = (_url: string | URL, init: RequestInit = {}) =>
      new Promise<Response>((_resolve, reject) =>
        init.signal?.addEventListener("abort", () =>
          reject(new ConnectorError("REQUEST_TIMEOUT", "not_sent", true)),
        ),
      );
    const started = Date.now();
    const { result } = await lookupCustomerContext(
      { ...target, timeoutMs: 1000 },
      subject,
      { fetch: hanging },
    );
    expect(result).toMatchObject({ status: "unavailable", reason: "timeout" });
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it("rejects oversized and foreign answers", async () => {
    const big = provider(
      () => new Response("x".repeat(70 * 1024), { status: 200 }),
    );
    expect(
      (await lookupCustomerContext(target, subject, { fetch: big.fetch }))
        .result,
    ).toMatchObject({ reason: "invalid_response" });
    const foreign = example("found-active");
    foreign.customer.externalRef.id = "usr_other";
    const other = provider(() => json(200, foreign));
    expect(
      (await lookupCustomerContext(target, subject, { fetch: other.fetch }))
        .result,
    ).toMatchObject({ reason: "invalid_response" });
  });

  it("takes Retry-After from the header and opens the circuit after repeated failures", async () => {
    const limited = provider(() =>
      json(
        503,
        {
          ...example("problem-service-unavailable"),
          retryAfterSeconds: undefined,
        },
        { "retry-after": "17" },
      ),
    );
    expect(
      (await lookupCustomerContext(target, subject, { fetch: limited.fetch }))
        .result,
    ).toEqual({
      status: "unavailable",
      reason: "provider_error",
      retryAfterSeconds: 17,
    });
    resetCustomerContextCircuits();
    const down = provider(() => {
      throw new ConnectorError("NETWORK_ERROR", "not_sent", true);
    });
    for (let i = 0; i < 5; i++)
      await lookupCustomerContext(target, subject, { fetch: down.fetch });
    const { result } = await lookupCustomerContext(target, subject, {
      fetch: down.fetch,
    });
    expect(result).toMatchObject({
      status: "unavailable",
      reason: "circuit_open",
    });
    expect(down.calls).toHaveLength(5);
  });

  it("refuses non-HTTPS base URLs and clamps timeouts", async () => {
    expect(() => customerContextUrl("http://hooks.example.com")).toThrow();
    expect(() =>
      customerContextUrl("https://hooks.example.com/?x=1"),
    ).toThrow();
    const p = provider(() => json(200, {}));
    expect(
      (
        await lookupCustomerContext(
          { ...target, baseUrl: "http://x.example" },
          subject,
          { fetch: p.fetch },
        )
      ).result,
    ).toMatchObject({ reason: "misconfigured" });
    expect(p.calls).toHaveLength(0);
    expect(customerContextTimeout(50)).toBe(1000);
    expect(customerContextTimeout(60_000)).toBe(8000);
    expect(customerContextTimeout("x")).toBe(4000);
  });

  it("signs exactly as the provider guide verifies", () => {
    expect(signCustomerContextBody("secret", "1", "{}")).toBe(
      `v1=${createHmac("sha256", "secret").update("1.{}").digest("hex")}`,
    );
  });
});
