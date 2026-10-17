import { describe, expect, it } from "vitest";
import { moduleRolesBody } from "./module-roles";

describe("module roles form (WP4.5)", () => {
  it("sends every module, null where the project role applies", () => {
    expect(
      moduleRolesBody(["knowledge", "marketing"], {
        knowledge: "",
        marketing: "none",
      }),
    ).toEqual({ roles: { knowledge: null, marketing: "none" } });
  });
});
