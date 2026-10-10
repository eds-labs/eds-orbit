import { beforeEach, describe, expect, it, vi } from "vitest";

// Offline: `execFile` is mocked, the macOS keychain is never touched.
const exec = vi.hoisted(() => ({
  calls: [] as Array<{ file: string; args: string[]; options: unknown }>,
  result: { error: null as Error | null, stdout: "" },
}));
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  execFile: vi.fn(
    (
      file: string,
      args: string[],
      options: unknown,
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      exec.calls.push({ file, args, options });
      queueMicrotask(() =>
        callback(exec.result.error, exec.result.stdout, "stderr text"),
      );
    },
  ),
}));
import { readKeychainKey, resolveLiveKey } from "./eval-key.ts";

// Deliberately not credential-shaped, so the repository secret scan stays clean.
const SYNTHETIC_KEY = "synthetic-eval-key-not-real-0123456789";
const CONFIRMATION = "c".repeat(64);
const SERVICE = "orbit-eval-openai";

beforeEach(() => {
  exec.calls = [];
  exec.result = { error: null, stdout: SYNTHETIC_KEY + "\n" };
});

describe("Eval key from the macOS keychain", () => {
  it("reads the key with execFile, no shell, and the exact arguments", async () => {
    expect(await readKeychainKey(SERVICE)).toBe(SYNTHETIC_KEY);
    expect(exec.calls).toHaveLength(1);
    const [call] = exec.calls;
    expect(call!.file).toBe("security");
    expect(call!.args).toEqual(["find-generic-password", "-s", SERVICE, "-w"]);
    expect(call!.options).not.toHaveProperty("shell");
  });

  it("reports a failed or empty lookup as EVAL_KEY_REQUIRED without its output", async () => {
    exec.result = {
      error: new Error("security: item not found " + SYNTHETIC_KEY),
      stdout: "",
    };
    let thrown: unknown = null;
    try {
      await readKeychainKey(SERVICE);
    } catch (error) {
      thrown = error;
    }
    expect(String(thrown)).toContain("EVAL_KEY_REQUIRED");
    expect(String(thrown)).not.toContain(SYNTHETIC_KEY);
    expect(String((thrown as Error).stack)).not.toContain(SYNTHETIC_KEY);
    exec.result = { error: null, stdout: "  \n" };
    await expect(readKeychainKey(SERVICE)).rejects.toThrow("EVAL_KEY_REQUIRED");
  });

  it("uses the keychain only when the key variable is unset and a confirmation matches", async () => {
    // The key variable wins; the keychain is not read.
    expect(
      await resolveLiveKey(
        {
          ORBIT_EVAL_OPENAI_API_KEY: "variable-key-not-real",
          ORBIT_EVAL_KEYCHAIN_SERVICE: SERVICE,
          ORBIT_EVAL_CONFIRM: CONFIRMATION,
        },
        CONFIRMATION,
      ),
    ).toBe("variable-key-not-real");
    expect(exec.calls).toHaveLength(0);
    // A wrong confirmation is refused before the keychain is read.
    await expect(
      resolveLiveKey(
        { ORBIT_EVAL_KEYCHAIN_SERVICE: SERVICE, ORBIT_EVAL_CONFIRM: "wrong" },
        CONFIRMATION,
      ),
    ).rejects.toThrow("EVAL_CONFIRMATION_MISMATCH");
    expect(exec.calls).toHaveLength(0);
    expect(
      await resolveLiveKey(
        {
          ORBIT_EVAL_KEYCHAIN_SERVICE: SERVICE,
          ORBIT_EVAL_CONFIRM: CONFIRMATION,
        },
        CONFIRMATION,
      ),
    ).toBe(SYNTHETIC_KEY);
    expect(exec.calls).toHaveLength(1);
    expect(exec.calls[0]!.args).toEqual([
      "find-generic-password",
      "-s",
      SERVICE,
      "-w",
    ]);
  });

  it("keeps the gate rules: no key anywhere is EVAL_KEY_REQUIRED, a key without confirmation is a mismatch", async () => {
    await expect(
      resolveLiveKey({ ORBIT_EVAL_CONFIRM: CONFIRMATION }, CONFIRMATION),
    ).rejects.toThrow("EVAL_KEY_REQUIRED");
    exec.result = { error: new Error("not found"), stdout: "" };
    await expect(
      resolveLiveKey(
        {
          ORBIT_EVAL_KEYCHAIN_SERVICE: SERVICE,
          ORBIT_EVAL_CONFIRM: CONFIRMATION,
        },
        CONFIRMATION,
      ),
    ).rejects.toThrow("EVAL_KEY_REQUIRED");
    await expect(
      resolveLiveKey(
        { ORBIT_EVAL_OPENAI_API_KEY: SYNTHETIC_KEY },
        CONFIRMATION,
      ),
    ).rejects.toThrow("EVAL_CONFIRMATION_MISMATCH");
    // A blank service name is no key source.
    await expect(
      resolveLiveKey(
        { ORBIT_EVAL_KEYCHAIN_SERVICE: " ", ORBIT_EVAL_CONFIRM: CONFIRMATION },
        CONFIRMATION,
      ),
    ).rejects.toThrow("EVAL_KEY_REQUIRED");
    expect(exec.calls).toHaveLength(1);
  });
});
