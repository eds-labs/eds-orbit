import { describe, expect, it } from "vitest";
import {
  escalationEligible,
  modelRouteSchema,
  resolveRoute,
} from "./routing.ts";

const all = ["gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol", "gpt-6-astra"];

describe("resolveRoute", () => {
  it("falls back to default tiers with default output ceilings and no effort", () => {
    const blog = resolveRoute("draft_blog", { verifiedModels: ["gpt-5.6-sol"] });
    expect(blog).toEqual({ model: "gpt-5.6-sol", maxOutputTokens: 1800 });
    expect("reasoningEffort" in blog).toBe(false);
    expect(
      resolveRoute("chat_operator", { verifiedModels: all }),
    ).toEqual({ model: "gpt-5.6-terra", maxOutputTokens: 3000 });
    expect(resolveRoute("draft_social", { verifiedModels: all })).toEqual({
      model: "gpt-5.6-terra",
      maxOutputTokens: 1800,
    });
  });
  it("maps task classes onto configured legacy tiers", () => {
    const runtime = {
      verifiedModels: ["f", "s", "q", "e"],
      modelRoutes: { fast: "f", standard: "s", quality: "q", escalation: "e" },
    };
    expect(resolveRoute("draft_social", runtime).model).toBe("s");
    expect(resolveRoute("draft_blog", runtime).model).toBe("q");
    expect(resolveRoute("chat_operator", runtime).model).toBe("s");
  });
  it("lets a task route override tiers and carry effort and ceiling verbatim", () => {
    const runtime = {
      verifiedModels: all,
      modelRoutes: { fast: "f", standard: "s", quality: "q", escalation: "e" },
      taskRoutes: {
        draft_blog: {
          model: "gpt-6-astra",
          reasoningEffort: "high" as const,
          maxOutputTokens: 9000,
        },
      },
    };
    expect(resolveRoute("draft_blog", runtime)).toEqual({
      model: "gpt-6-astra",
      reasoningEffort: "high",
      maxOutputTokens: 9000,
    });
  });
  it("rejects unverified models", () => {
    expect(() =>
      resolveRoute("draft_blog", { verifiedModels: ["gpt-5.6-terra"] }),
    ).toThrow("MODEL_CAPABILITY_NOT_VERIFIED");
    expect(() =>
      resolveRoute("draft_social", {
        verifiedModels: ["gpt-5.6-terra"],
        taskRoutes: { draft_social: { model: "x", maxOutputTokens: 1000 } },
      }),
    ).toThrow("MODEL_CAPABILITY_NOT_VERIFIED");
  });
});

describe("modelRouteSchema", () => {
  it("enforces ceilings, strict keys and known efforts", () => {
    const ok = { model: "m", maxOutputTokens: 256 };
    expect(modelRouteSchema.safeParse(ok).success).toBe(true);
    expect(modelRouteSchema.safeParse({ ...ok, maxOutputTokens: 255 }).success).toBe(false);
    expect(modelRouteSchema.safeParse({ ...ok, maxOutputTokens: 16001 }).success).toBe(false);
    expect(modelRouteSchema.safeParse({ ...ok, extra: 1 }).success).toBe(false);
    expect(modelRouteSchema.safeParse({ ...ok, reasoningEffort: "turbo" }).success).toBe(false);
  });
});

describe("escalationEligible", () => {
  it("allows one escalation after two failed corrections", () => {
    expect(escalationEligible(2, 0)).toBe(true);
    expect(escalationEligible(1, 0)).toBe(false);
    expect(escalationEligible(2, 1)).toBe(false);
    expect(() => escalationEligible(3, 0)).toThrow("RETRY_LIMIT");
  });
});
