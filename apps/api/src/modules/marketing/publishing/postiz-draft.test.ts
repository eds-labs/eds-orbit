import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { postizDraftPayload } from "./postiz-draft.ts";

// The configuration the API needs to start, so the flag can be read without a local env file.
const REQUIRED = {
  DATABASE_URL: "postgresql://a@b/c",
  AUTH_DATABASE_URL: "postgresql://a@b/c",
  REDIS_URL: "redis://redis:6379",
  AUTH_SECRET: "x".repeat(32),
  ORBIT_SETUP_TOKEN: "y".repeat(20),
  CREDENTIAL_KEY: "0".repeat(64),
};

const payload = (identifier: string) =>
  postizDraftPayload({
    integrationId: "channel-1",
    identifier,
    text: "Hello",
    images: [],
    date: "2026-10-27T10:00:00.000Z",
  }).posts[0]!.settings;

describe("Postiz draft payload settings", () => {
  beforeEach(() => {
    for (const [name, value] of Object.entries(REQUIRED))
      vi.stubEnv(name, process.env[name] ?? value);
  });
  afterEach(() => vi.unstubAllEnvs());

  // CS-D6 (R64): the Instagram post type comes with the Creative Studio.
  it("sends Instagram only its type while the Creative Studio is off", () => {
    vi.stubEnv("ORBIT_CREATIVE_STUDIO", "false");
    expect(payload("instagram")).toEqual({ __type: "instagram" });
    expect(payload("x")).toEqual({
      __type: "x",
      who_can_reply_post: "everyone",
    });
  });

  it("sends Instagram's feed post type with the Creative Studio on", () => {
    vi.stubEnv("ORBIT_CREATIVE_STUDIO", "true");
    expect(payload("instagram")).toEqual({
      __type: "instagram",
      post_type: "post",
    });
    expect(payload("x")).toEqual({
      __type: "x",
      who_can_reply_post: "everyone",
    });
  });
});
