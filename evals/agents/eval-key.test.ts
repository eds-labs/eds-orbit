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
import {
  EVAL_KEY_VARIABLES,
  isEvalLiveRequested,
  readKeychainKey,
  resolveEvalKey,
  resolveLiveKey,
  type EvalProvider,
} from "./eval-key.ts";

// Deliberately not credential-shaped, so the repository secret scan stays clean.
const SYNTHETIC_KEY = "synthetic-eval-key-not-real-0123456789";
const OTHER_KEY = "other-provider-key-not-real-0123456789";
const CONFIRMATION = "c".repeat(64);
const SERVICES: Record<EvalProvider, string> = {
  openai: "orbit-eval-openai",
  anthropic: "orbit-eval-anthropic",
};
const PROVIDERS = ["openai", "anthropic"] as const;

beforeEach(() => {
  exec.calls = [];
  exec.result = { error: null, stdout: SYNTHETIC_KEY + "\n" };
});

async function thrownBy(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  return null;
}

describe("Eval key from the macOS keychain", () => {
  it("reads the key with execFile, no shell, and the exact arguments", async () => {
    expect(await readKeychainKey(SERVICES.anthropic)).toBe(SYNTHETIC_KEY);
    expect(exec.calls).toHaveLength(1);
    const [call] = exec.calls;
    expect(call!.file).toBe("security");
    expect(call!.args).toEqual([
      "find-generic-password",
      "-s",
      SERVICES.anthropic,
      "-w",
    ]);
    expect(call!.options).not.toHaveProperty("shell");
  });

  it("reports a failed or empty lookup as EVAL_KEY_REQUIRED without its output", async () => {
    exec.result = {
      error: new Error("security: item not found " + SYNTHETIC_KEY),
      stdout: "",
    };
    const thrown = await thrownBy(readKeychainKey(SERVICES.openai));
    expect(String(thrown)).toContain("EVAL_KEY_REQUIRED");
    expect(String(thrown)).not.toContain(SYNTHETIC_KEY);
    expect(String((thrown as Error).stack)).not.toContain(SYNTHETIC_KEY);
    exec.result = { error: null, stdout: "  \n" };
    await expect(readKeychainKey(SERVICES.openai)).rejects.toThrow(
      "EVAL_KEY_REQUIRED",
    );
  });
});

describe("Eval key per provider", () => {
  it("names one key variable per provider", () => {
    expect(EVAL_KEY_VARIABLES).toEqual({
      openai: "ORBIT_EVAL_OPENAI_API_KEY",
      anthropic: "ORBIT_EVAL_ANTHROPIC_API_KEY",
    });
  });

  it("stays a dry run without a key variable and a confirmation; a keychain service alone requests nothing", async () => {
    for (const provider of PROVIDERS) {
      expect(await resolveEvalKey(provider, {}, CONFIRMATION)).toBeNull();
      expect(
        await resolveEvalKey(
          provider,
          {
            ORBIT_EVAL_OPENAI_API_KEY: "  ",
            ORBIT_EVAL_ANTHROPIC_API_KEY: "",
            ORBIT_EVAL_CONFIRM: " ",
            ORBIT_EVAL_MAX_USD: "0.5",
          },
          CONFIRMATION,
        ),
      ).toBeNull();
      expect(
        await resolveEvalKey(
          provider,
          { ORBIT_EVAL_KEYCHAIN_SERVICE: SERVICES[provider] },
          CONFIRMATION,
        ),
      ).toBeNull();
    }
    expect(exec.calls).toHaveLength(0);
    expect(isEvalLiveRequested({})).toBe(false);
    expect(
      isEvalLiveRequested({ ORBIT_EVAL_KEYCHAIN_SERVICE: SERVICES.anthropic }),
    ).toBe(false);
    // Any provider's key variable or a confirmation requests a live run.
    expect(isEvalLiveRequested({ ORBIT_EVAL_OPENAI_API_KEY: OTHER_KEY })).toBe(
      true,
    );
    expect(
      isEvalLiveRequested({ ORBIT_EVAL_ANTHROPIC_API_KEY: SYNTHETIC_KEY }),
    ).toBe(true);
    expect(isEvalLiveRequested({ ORBIT_EVAL_CONFIRM: CONFIRMATION })).toBe(
      true,
    );
  });

  it("reads only the variable of the route's provider", async () => {
    const both = {
      ORBIT_EVAL_OPENAI_API_KEY: OTHER_KEY,
      ORBIT_EVAL_ANTHROPIC_API_KEY: SYNTHETIC_KEY,
      ORBIT_EVAL_CONFIRM: CONFIRMATION,
    };
    expect(await resolveEvalKey("anthropic", both, CONFIRMATION)).toBe(
      SYNTHETIC_KEY,
    );
    expect(await resolveEvalKey("openai", both, CONFIRMATION)).toBe(OTHER_KEY);
    // The other provider's key is never used in place of the missing one.
    await expect(
      resolveEvalKey(
        "anthropic",
        {
          ORBIT_EVAL_OPENAI_API_KEY: OTHER_KEY,
          ORBIT_EVAL_CONFIRM: CONFIRMATION,
        },
        CONFIRMATION,
      ),
    ).rejects.toThrow("EVAL_KEY_REQUIRED");
    await expect(
      resolveEvalKey(
        "openai",
        {
          ORBIT_EVAL_ANTHROPIC_API_KEY: SYNTHETIC_KEY,
          ORBIT_EVAL_CONFIRM: CONFIRMATION,
        },
        CONFIRMATION,
      ),
    ).rejects.toThrow("EVAL_KEY_REQUIRED");
    expect(exec.calls).toHaveLength(0);
  });

  it("treats a key alone or a confirmation alone as an error, never as a dry run", async () => {
    for (const provider of PROVIDERS) {
      const variable = EVAL_KEY_VARIABLES[provider];
      const thrown = await thrownBy(
        resolveEvalKey(provider, { [variable]: SYNTHETIC_KEY }, CONFIRMATION),
      );
      expect(String(thrown)).toContain("EVAL_CONFIRMATION_MISMATCH");
      expect(String(thrown)).not.toContain(SYNTHETIC_KEY);
      await expect(
        resolveEvalKey(
          provider,
          { [variable]: SYNTHETIC_KEY, ORBIT_EVAL_CONFIRM: "wrong" },
          CONFIRMATION,
        ),
      ).rejects.toThrow("EVAL_CONFIRMATION_MISMATCH");
      await expect(
        resolveEvalKey(
          provider,
          { ORBIT_EVAL_CONFIRM: CONFIRMATION },
          CONFIRMATION,
        ),
      ).rejects.toThrow("EVAL_KEY_REQUIRED");
    }
    // The OpenAI key alone on the Anthropic route is an error as well.
    await expect(
      resolveEvalKey(
        "anthropic",
        { ORBIT_EVAL_OPENAI_API_KEY: OTHER_KEY },
        CONFIRMATION,
      ),
    ).rejects.toThrow("EVAL_KEY_REQUIRED");
    expect(exec.calls).toHaveLength(0);
  });

  it("uses the keychain for the route's provider only when its variable is unset and a confirmation matches", async () => {
    for (const provider of PROVIDERS) {
      exec.calls = [];
      const service = SERVICES[provider];
      const variable = EVAL_KEY_VARIABLES[provider];
      // The key variable wins; the keychain is not read.
      expect(
        await resolveEvalKey(
          provider,
          {
            [variable]: "variable-key-not-real",
            ORBIT_EVAL_KEYCHAIN_SERVICE: service,
            ORBIT_EVAL_CONFIRM: CONFIRMATION,
          },
          CONFIRMATION,
        ),
      ).toBe("variable-key-not-real");
      expect(exec.calls).toHaveLength(0);
      // A wrong confirmation is refused before the keychain is read.
      await expect(
        resolveEvalKey(
          provider,
          { ORBIT_EVAL_KEYCHAIN_SERVICE: service, ORBIT_EVAL_CONFIRM: "wrong" },
          CONFIRMATION,
        ),
      ).rejects.toThrow("EVAL_CONFIRMATION_MISMATCH");
      expect(exec.calls).toHaveLength(0);
      expect(
        await resolveEvalKey(
          provider,
          {
            ORBIT_EVAL_KEYCHAIN_SERVICE: service,
            ORBIT_EVAL_CONFIRM: CONFIRMATION,
          },
          CONFIRMATION,
        ),
      ).toBe(SYNTHETIC_KEY);
      expect(exec.calls).toHaveLength(1);
      expect(exec.calls[0]!.args).toEqual([
        "find-generic-password",
        "-s",
        service,
        "-w",
      ]);
    }
    // The Anthropic route reads its keychain item although the OpenAI variable is set.
    exec.calls = [];
    expect(
      await resolveEvalKey(
        "anthropic",
        {
          ORBIT_EVAL_OPENAI_API_KEY: OTHER_KEY,
          ORBIT_EVAL_KEYCHAIN_SERVICE: SERVICES.anthropic,
          ORBIT_EVAL_CONFIRM: CONFIRMATION,
        },
        CONFIRMATION,
      ),
    ).toBe(SYNTHETIC_KEY);
    expect(exec.calls).toHaveLength(1);
  });

  it("keeps the gate rules: no key anywhere is EVAL_KEY_REQUIRED, a blank service is no key source", async () => {
    exec.result = { error: new Error("not found"), stdout: "" };
    await expect(
      resolveEvalKey(
        "anthropic",
        {
          ORBIT_EVAL_KEYCHAIN_SERVICE: SERVICES.anthropic,
          ORBIT_EVAL_CONFIRM: CONFIRMATION,
        },
        CONFIRMATION,
      ),
    ).rejects.toThrow("EVAL_KEY_REQUIRED");
    await expect(
      resolveEvalKey(
        "anthropic",
        { ORBIT_EVAL_KEYCHAIN_SERVICE: " ", ORBIT_EVAL_CONFIRM: CONFIRMATION },
        CONFIRMATION,
      ),
    ).rejects.toThrow("EVAL_KEY_REQUIRED");
    expect(exec.calls).toHaveLength(1);
  });

  it("refuses a provider it has no key variable for", async () => {
    await expect(
      resolveEvalKey(
        "gemini" as EvalProvider,
        { ORBIT_EVAL_CONFIRM: CONFIRMATION },
        CONFIRMATION,
      ),
    ).rejects.toThrow("EVAL_PROVIDER_UNKNOWN");
  });
});

// The OpenAI-only form the support and AI project manager evals use, unchanged.
describe("OpenAI eval key (resolveLiveKey)", () => {
  const SERVICE = SERVICES.openai;

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
