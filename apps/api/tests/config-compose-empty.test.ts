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
});
