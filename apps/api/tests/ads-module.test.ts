import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../../packages/config/src/index.ts";

describe("ads module skeleton (ADR 0025)", () => {
  const clear = () => {
    delete process.env.ORBIT_ADS;
  };
  beforeEach(clear);
  afterEach(clear);

  it("ORBIT_ADS defaults to false and accepts only false or true", () => {
    expect(loadConfig().ORBIT_ADS).toBe("false");
    process.env.ORBIT_ADS = "true";
    expect(loadConfig().ORBIT_ADS).toBe("true");
    process.env.ORBIT_ADS = "yes";
    expect(() => loadConfig()).toThrow();
  });
});
