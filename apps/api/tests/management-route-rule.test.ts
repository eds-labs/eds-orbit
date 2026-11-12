import { describe, expect, it } from "vitest";
import { isManagementRoute } from "../src/platform/management/flag.ts";

describe("management route rule", () => {
  it("covers exactly the routes below /api/management/", () => {
    expect(isManagementRoute("/api/management/capabilities")).toBe(true);
    expect(isManagementRoute("/api/management")).toBe(false);
    expect(isManagementRoute("/api/admin/overview")).toBe(false);
    expect(isManagementRoute("/api/projects/:projectId/management/x")).toBe(false);
  });
});
