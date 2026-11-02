import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../../packages/config/src/index.ts";

describe("social module skeleton (ADR 0020)", () => {
  const clear = () => {
    delete process.env.ORBIT_SOCIAL;
  };
  beforeEach(clear);
  afterEach(clear);

  it("ORBIT_SOCIAL defaults to false and accepts only false or true", () => {
    expect(loadConfig().ORBIT_SOCIAL).toBe("false");
    process.env.ORBIT_SOCIAL = "true";
    expect(loadConfig().ORBIT_SOCIAL).toBe("true");
    process.env.ORBIT_SOCIAL = "yes";
    expect(() => loadConfig()).toThrow();
  });
});
