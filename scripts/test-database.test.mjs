import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isLocalTestDatabase,
  loadWorktreeTestEnv,
  testUrlKeys,
  worktreeTestDatabase,
} from "./test-database.ts";

const local = (name) =>
  new URL(`postgresql://orbit_app:x@127.0.0.1:55432/${name}`);

describe("worktree test databases", () => {
  const saved = Object.fromEntries(
    testUrlKeys.map((key) => [key, process.env[key]]),
  );
  let dir;
  afterEach(() => {
    for (const key of testUrlKeys)
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("derives a distinct, valid name per worktree path", () => {
    const a = worktreeTestDatabase(
      "/repo/.claude/worktrees/Vigilant-Chatelet-f0f3a8",
    );
    const b = worktreeTestDatabase(
      "/other/.claude/worktrees/vigilant-chatelet-f0f3a8",
    );
    expect(a).toMatch(/^orbit_test_vigilant_chatelet_f0f3a8_[a-f0-9]{6}$/);
    expect(a).not.toBe(b);
    expect(isLocalTestDatabase(local(a))).toBe(true);
    const long = worktreeTestDatabase("/r/" + "x".repeat(200));
    expect(long.length).toBeLessThanOrEqual(63);
    expect(worktreeTestDatabase("/r/---")).toMatch(/^orbit_test_worktree_/);
  });

  it("accepts only local test databases", () => {
    expect(isLocalTestDatabase(local("orbit_test"))).toBe(true);
    expect(isLocalTestDatabase(local("orbit"))).toBe(false);
    expect(isLocalTestDatabase(local("orbit_restore_test"))).toBe(false);
    expect(isLocalTestDatabase(local("orbit_test_"))).toBe(false);
    expect(
      isLocalTestDatabase(
        new URL("postgresql://orbit_app:x@db.example.com:55432/orbit_test"),
      ),
    ).toBe(false);
    expect(
      isLocalTestDatabase(
        new URL("postgresql://orbit_app:x@127.0.0.1:5432/orbit_test"),
      ),
    ).toBe(false);
  });

  it("loads the worktree file over the shared TEST_* URLs", () => {
    dir = mkdtempSync(join(tmpdir(), "orbit-test-env-"));
    const file = join(dir, "test.env");
    expect(loadWorktreeTestEnv(file)).toBeUndefined();
    for (const key of testUrlKeys) process.env[key] = local("orbit_test").href;
    writeFileSync(
      file,
      testUrlKeys
        .map((key) => `${key}=${local("orbit_test_wt_abc123").href}`)
        .join("\n"),
    );
    expect(loadWorktreeTestEnv(file)).toBe("orbit_test_wt_abc123");
    for (const key of testUrlKeys)
      expect(new URL(process.env[key]).pathname).toBe("/orbit_test_wt_abc123");
  });

  it("refuses a file that names another database", () => {
    dir = mkdtempSync(join(tmpdir(), "orbit-test-env-"));
    const file = join(dir, "test.env");
    writeFileSync(
      file,
      testUrlKeys.map((key) => `${key}=${local("orbit").href}`).join("\n"),
    );
    expect(() => loadWorktreeTestEnv(file)).toThrow(
      /local Orbit test database/,
    );
    writeFileSync(
      file,
      testUrlKeys
        .map(
          (key, i) => `${key}=${local(i ? "orbit_test" : "orbit_test_a").href}`,
        )
        .join("\n"),
    );
    expect(() => loadWorktreeTestEnv(file)).toThrow(/same database/);
  });
});
