import { describe, expect, it } from "vitest";
import { clearProviderAccess } from "./provider-free-env.ts";

// R62: the Creative Studio browser fixture starts its processes without any
// way to reach a paid AI provider through the environment.
describe("clearProviderAccess", () => {
  it("removes provider keys and model and image route variables only", () => {
    const env = {
      OPENAI_API_KEY: "synthetic",
      ANTHROPIC_API_KEY: "synthetic",
      OPENAI_IMAGE_API_KEY: "synthetic",
      OPENAI_IMAGE_MODEL: "gpt-image",
      OPENAI_IMAGE_MAX_COST_MICROS: "50000",
      OPENAI_IMAGE_PRICE_VERIFIED_AT: "2026-10-01",
      OPENAI_RATE_CARD_JSON: "{}",
      OPENAI_VERIFIED_MODELS: "m",
      DATABASE_URL: "postgresql://a@b/c",
      ORBIT_CREATIVE_STUDIO: "true",
    };
    expect(clearProviderAccess(env).sort()).toEqual([
      "ANTHROPIC_API_KEY",
      "OPENAI_API_KEY",
      "OPENAI_IMAGE_API_KEY",
      "OPENAI_IMAGE_MAX_COST_MICROS",
      "OPENAI_IMAGE_MODEL",
      "OPENAI_IMAGE_PRICE_VERIFIED_AT",
      "OPENAI_RATE_CARD_JSON",
      "OPENAI_VERIFIED_MODELS",
    ]);
    expect(env).toEqual({
      DATABASE_URL: "postgresql://a@b/c",
      ORBIT_CREATIVE_STUDIO: "true",
    });
  });
});
