import { describe, expect, it } from "vitest";
import { isAdministrationRoute } from "../src/platform/administration/routes.ts";

// Only the social organization calendar (ADR 0020, S6) is a member read
// under /api/organizations/; every other organization route is
// administration and exists only while ORBIT_ADMINISTRATION is on (P3).
describe("administration route rule", () => {
  it("exempts exactly the social calendar", () => {
    expect(isAdministrationRoute("/api/organizations/:workspaceId/social/calendar")).toBe(false);
    expect(isAdministrationRoute("/api/organizations/:workspaceId/social/other")).toBe(true);
    expect(isAdministrationRoute("/api/organizations/:workspaceId/members")).toBe(true);
    expect(isAdministrationRoute("/api/admin/users")).toBe(true);
    expect(isAdministrationRoute("/api/projects/:projectId/social/calendar")).toBe(false);
  });
});
