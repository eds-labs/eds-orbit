import { describe, expect, it } from "vitest";
import { configSchema } from "../../../packages/config/src/index.ts";

const BASE = {
  DATABASE_URL: "postgresql://a@b/c",
  AUTH_DATABASE_URL: "postgresql://a@b/c",
  REDIS_URL: "redis://redis:6379",
  AUTH_SECRET: "x".repeat(32),
  ORBIT_SETUP_TOKEN: "y".repeat(20),
  CREDENTIAL_KEY: "0".repeat(64),
};

describe("configuration as Compose passes it", () => {
  // Compose renders `${NAME:-}` as an empty string; the API must still start.
  it("treats empty optional file variables as unset (production incident 2026-10-17)", () => {
    const config = configSchema.parse({
      ...BASE,
      ORBIT_FILES: "false",
      FILES_S3_ENDPOINT: "",
      FILES_S3_BUCKET: "",
      FILES_S3_REGION: "auto",
      FILES_S3_ACCESS_KEY_ID: "",
      FILES_S3_SECRET_ACCESS_KEY: "",
      FILES_ENCRYPTION_KEY: "",
      FILES_MAX_BYTES: "20971520",
    });
    expect(config.FILES_S3_ENDPOINT).toBeUndefined();
    expect(config.FILES_ENCRYPTION_KEY).toBeUndefined();
    expect(config.FILES_MAX_BYTES).toBe(20971520);
  });
  it("still refuses an invalid value that is set", () => {
    expect(() =>
      configSchema.parse({ ...BASE, FILES_ENCRYPTION_KEY: "short" }),
    ).toThrow();
  });

  it("defaults the MCP gateway off on port 4312 and accepts Compose's empty strings (WP-M2)", () => {
    const config = configSchema.parse({ ...BASE });
    expect(config.ORBIT_MCP_GATEWAY).toBe("false");
    expect(config.MCP_PORT).toBe(4312);
    expect(config.ORBIT_MCP_ALLOWED_ORIGINS).toBe("");
    const composed = configSchema.parse({
      ...BASE,
      ORBIT_MCP_GATEWAY: "false",
      MCP_PORT: "",
      ORBIT_MCP_ALLOWED_ORIGINS: "",
    });
    expect(composed.MCP_PORT).toBe(4312);
    expect(composed.ORBIT_MCP_ALLOWED_ORIGINS).toBe("");
    const set = configSchema.parse({
      ...BASE,
      ORBIT_MCP_GATEWAY: "true",
      MCP_PORT: "4400",
      ORBIT_MCP_ALLOWED_ORIGINS: "https://a.example,https://b.example",
    });
    expect(set.ORBIT_MCP_GATEWAY).toBe("true");
    expect(set.MCP_PORT).toBe(4400);
    expect(set.ORBIT_MCP_ALLOWED_ORIGINS).toBe(
      "https://a.example,https://b.example",
    );
  });
  it("defaults MCP proposals off and accepts Compose's empty string (WP-M4)", () => {
    expect(configSchema.parse({ ...BASE }).ORBIT_MCP_PROPOSALS).toBe("false");
    expect(
      configSchema.parse({ ...BASE, ORBIT_MCP_PROPOSALS: "" })
        .ORBIT_MCP_PROPOSALS,
    ).toBe("false");
    expect(
      configSchema.parse({ ...BASE, ORBIT_MCP_PROPOSALS: "true" })
        .ORBIT_MCP_PROPOSALS,
    ).toBe("true");
    expect(() =>
      configSchema.parse({ ...BASE, ORBIT_MCP_PROPOSALS: "yes" }),
    ).toThrow();
  });
  it("refuses an invalid gateway flag or port", () => {
    expect(() =>
      configSchema.parse({ ...BASE, ORBIT_MCP_GATEWAY: "yes" }),
    ).toThrow();
    expect(() => configSchema.parse({ ...BASE, MCP_PORT: "0" })).toThrow();
    expect(() => configSchema.parse({ ...BASE, MCP_PORT: "70000" })).toThrow();
  });
});
