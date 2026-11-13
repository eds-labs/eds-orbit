import { describe, expect, it } from "vitest";
import { taskClasses } from "../../../packages/ai/src/index.ts";
import {
  assertProviderAllowedForData,
  providersForData,
} from "../src/platform/ai/data-class.ts";
import {
  TASK_DATA_CLASSES,
  routesNotAllowedForData,
} from "../src/platform/ai/openai-configuration.ts";
import { failureNoticeBody } from "../src/platform/agents/work-orders/execute.ts";

/**
 * The provider allow-list per data class (ADR 0021 D-11) is a code
 * constant: widening it needs a recorded legal decision and a code change.
 * This pin fails on any change, so such a change is never incidental
 * (plan 2026-11-10, WP2 invariant).
 */
describe("data-class allow-list", () => {
  it("pins customer and financial data to OpenAI only", () => {
    expect(providersForData("customer_personal")).toEqual(["openai"]);
    expect(providersForData("financial")).toEqual(["openai"]);
    expect(providersForData("internal")).toBeNull();
    expect(() => assertProviderAllowedForData("anthropic", "financial")).toThrow(
      "AGENT_PROVIDER_NOT_ALLOWED_FOR_DATA",
    );
    expect(() => assertProviderAllowedForData("openai", "financial")).not.toThrow();
  });
});

describe("routesNotAllowedForData", () => {
  const route = (provider: string) => ({
    model: provider === "anthropic" ? "claude-haiku-5-5" : "gpt-5-mini",
    provider,
    price: "current",
  });

  it("names Support routes on Claude as blocked and finance as not yet checked", () => {
    expect(
      routesNotAllowedForData({
        support_triage: route("anthropic"),
        support_draft: route("openai"),
        finance_extraction: route("anthropic"),
        chat_operator: route("anthropic"),
      }),
    ).toEqual([
      {
        task: "finance_extraction",
        dataClass: "financial",
        provider: "anthropic",
        allowed: ["openai"],
        enforced: false,
      },
      {
        task: "support_triage",
        dataClass: "customer_personal",
        provider: "anthropic",
        allowed: ["openai"],
        enforced: true,
      },
    ]);
  });

  it("ignores unresolved routes and an empty view", () => {
    expect(
      routesNotAllowedForData({
        support_triage: { error: "MODEL_CAPABILITY_NOT_VERIFIED" },
      }),
    ).toEqual([]);
    expect(routesNotAllowedForData(undefined)).toEqual([]);
  });

  it("covers only real task classes", () => {
    for (const task of Object.keys(TASK_DATA_CLASSES))
      expect(taskClasses as readonly string[]).toContain(task);
  });
});

describe("work-order failure notice", () => {
  it("explains the data-class block and keeps the code", () => {
    const body = failureNoticeBody("AGENT_PROVIDER_NOT_ALLOWED_FOR_DATA");
    expect(body).toContain("may only go to OpenAI");
    expect(body).toContain("Nothing was sent");
    expect(body).toMatch(/\(AGENT_PROVIDER_NOT_ALLOWED_FOR_DATA\)$/);
    expect(failureNoticeBody("SOMETHING_ELSE")).toBe("Code: SOMETHING_ELSE");
  });
});
