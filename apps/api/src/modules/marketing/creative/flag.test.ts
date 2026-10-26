import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { creativeStudioEnabled } from "./flag.ts";

// The configuration the API needs to start, so the test also runs without a local env file.
const REQUIRED = {
  DATABASE_URL: "postgresql://a@b/c",
  AUTH_DATABASE_URL: "postgresql://a@b/c",
  REDIS_URL: "redis://redis:6379",
  AUTH_SECRET: "x".repeat(32),
  ORBIT_SETUP_TOKEN: "y".repeat(20),
  CREDENTIAL_KEY: "0".repeat(64),
};

describe("creativeStudioEnabled", () => {
  const original = process.env.ORBIT_CREATIVE_STUDIO;
  beforeEach(() => {
    for (const [name, value] of Object.entries(REQUIRED))
      vi.stubEnv(name, process.env[name] ?? value);
    delete process.env.ORBIT_CREATIVE_STUDIO;
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    if (original === undefined) delete process.env.ORBIT_CREATIVE_STUDIO;
    else process.env.ORBIT_CREATIVE_STUDIO = original;
  });

  it("is off without the environment variable and for false", () => {
    expect(creativeStudioEnabled()).toBe(false);
    vi.stubEnv("ORBIT_CREATIVE_STUDIO", "false");
    expect(creativeStudioEnabled()).toBe(false);
  });

  it("is on when the variable is true", () => {
    vi.stubEnv("ORBIT_CREATIVE_STUDIO", "true");
    expect(creativeStudioEnabled()).toBe(true);
  });
});
