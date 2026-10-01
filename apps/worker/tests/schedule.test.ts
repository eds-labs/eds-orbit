import { describe, it, expect } from "vitest";
import {
  earliestDue,
  eachLimited,
  safeErrorCode,
  workspaceAllowlist,
} from "../src/schedule.ts";
describe("worker pump scheduling helpers", () => {
  const at = new Date("2026-09-30T12:00:00.000Z");
  it("picks the earliest future candidate and caps idle projects", () => {
    expect(
      earliestDue(at, 60000, [
        new Date("2026-09-30T12:00:30.000Z"),
        null,
        new Date("2026-09-30T12:00:10.000Z"),
      ]).toISOString(),
    ).toBe("2026-09-30T12:00:10.000Z");
    expect(earliestDue(at, 60000, [null]).toISOString()).toBe(
      "2026-09-30T12:01:00.000Z",
    );
    expect(
      earliestDue(at, 60000, [new Date("2026-10-30T00:00:00.000Z")]).valueOf(),
    ).toBe(at.valueOf() + 60000);
  });
  it("treats past candidates as due now and ignores invalid ones", () => {
    expect(
      earliestDue(at, 60000, [new Date("2026-09-30T11:00:00.000Z")]).valueOf(),
    ).toBe(at.valueOf());
    expect(earliestDue(at, 60000, [new Date("invalid")]).valueOf()).toBe(
      at.valueOf() + 60000,
    );
  });
  it("runs every item with bounded concurrency", async () => {
    let active = 0,
      peak = 0;
    const seen: number[] = [];
    await eachLimited([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      seen.push(n);
      active--;
    });
    expect(peak).toBe(3);
    expect(seen.sort()).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });
  it("logs only sanitized error codes", () => {
    expect(safeErrorCode(new Error("PROJECT_PAUSED"))).toBe("PROJECT_PAUSED");
    expect(
      safeErrorCode(
        Object.assign(
          new Error("ENOENT: no such file, open '/Users/x/.runtime/a.json'"),
          { code: "ENOENT" },
        ),
      ),
    ).toBe("ENOENT");
    expect(
      safeErrorCode(
        new Error("connect postgresql://orbit_app:secret@127.0.0.1/orbit"),
      ),
    ).toBe("Error");
    expect(safeErrorCode({ message: "postgresql://u:p@h/db" })).toBe(
      "PUMP_FAILED",
    );
  });
  it("accepts a workspace allowlist only for test execution", () => {
    const id = "0f2d8a52-1b1e-4c3a-9d55-6c1a2b3c4d5e";
    expect(workspaceAllowlist(undefined, "live")).toBeNull();
    expect(workspaceAllowlist("", "test")).toBeNull();
    expect(workspaceAllowlist(id + ", " + id, "test")).toEqual([id]);
    expect(() => workspaceAllowlist(id, "live")).toThrow(
      "WORKER_WORKSPACE_ALLOWLIST_TEST_ONLY",
    );
    expect(() => workspaceAllowlist("not-a-uuid", "test")).toThrow(
      "WORKER_WORKSPACE_ALLOWLIST_INVALID",
    );
  });
});
