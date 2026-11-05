import { describe, expect, it } from "vitest";
import { driveFeature } from "./feature";

// Whether the shell lists the Drive page (design 2026-11-05 §5.2): the
// status reloads with the workspace revision, and a reload does not hide
// the entry for a moment; another project starts unknown.

describe("Drive feature", () => {
  it("follows the loaded status", () => {
    expect(driveFeature(null, "p1", { enabled: true })).toEqual({ projectId: "p1", enabled: true });
    expect(driveFeature({ projectId: "p1", enabled: true }, "p1", { enabled: false })).toEqual({
      projectId: "p1",
      enabled: false,
    });
  });

  it("keeps the last value of the project while the status reloads", () => {
    expect(driveFeature({ projectId: "p1", enabled: true }, "p1", null)).toEqual({ projectId: "p1", enabled: true });
  });

  it("forgets another project's value", () => {
    expect(driveFeature({ projectId: "p1", enabled: true }, "p2", null)).toBeNull();
  });
});
