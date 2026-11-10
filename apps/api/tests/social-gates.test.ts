import { afterEach, describe, expect, it } from "vitest";
import { platformEnabled, sendMode, SENDABLE_PLATFORMS } from "../src/modules/social/dispatch/gates.ts";

// When the social module may really post (ADR 0020 §6.1, S5): live mode
// with external writes, and only to platforms the installation switched on.

const saved = { ...process.env };
afterEach(() => {
  for (const key of ["EXECUTION_MODE", "ENABLE_EXTERNAL_WRITES", "ORBIT_SOCIAL_PLATFORMS"]) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe("social delivery gates", () => {
  it("sends for real only in live mode with external writes", () => {
    delete process.env.EXECUTION_MODE;
    delete process.env.ENABLE_EXTERNAL_WRITES;
    expect(sendMode()).toBe("test");
    process.env.EXECUTION_MODE = "live";
    expect(sendMode()).toBe("test");
    process.env.ENABLE_EXTERNAL_WRITES = "true";
    expect(sendMode()).toBe("live");
  });

  it("knows only the platforms the installation switched on and that have an adapter", () => {
    delete process.env.ORBIT_SOCIAL_PLATFORMS;
    expect(platformEnabled("x")).toBe(false);
    process.env.ORBIT_SOCIAL_PLATFORMS = "x,telegram";
    expect(platformEnabled("x")).toBe(true);
    expect(platformEnabled("telegram")).toBe(true);
    expect(platformEnabled("instagram")).toBe(false);
    process.env.ORBIT_SOCIAL_PLATFORMS = "x,instagram,telegram,myspace";
    expect(() => platformEnabled("x")).toThrow();
    process.env.ORBIT_SOCIAL_PLATFORMS = "x, instagram ,telegram";
    expect(platformEnabled("facebook")).toBe(false);
    expect(platformEnabled("instagram")).toBe(true);
    process.env.ORBIT_SOCIAL_PLATFORMS = "facebook";
    expect(platformEnabled("facebook")).toBe(true);
    expect(SENDABLE_PLATFORMS).toEqual(["x", "facebook", "instagram", "telegram"]);
  });
});
