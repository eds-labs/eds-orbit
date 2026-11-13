/**
 * The provider key of a manual live eval (see README.md). Each provider has
 * its own variable: ORBIT_EVAL_OPENAI_API_KEY or ORBIT_EVAL_ANTHROPIC_API_KEY;
 * `resolveEvalKey` reads only the variable of the route's provider. When it
 * is unset, the macOS keychain item named by ORBIT_EVAL_KEYCHAIN_SERVICE is
 * read through `execFile` without a shell, and only once the confirmation
 * matches. A key or a confirmation alone is an error, never a silent dry run.
 * Error messages never contain the key or the keychain tool's output. Other
 * live evals reuse these helpers (`resolveLiveKey` is the OpenAI-only form
 * of the support and AI project manager evals).
 */
import { execFile } from "node:child_process";
import { assertLiveAllowed, type LiveEnv } from "../generation/live-plan.ts";

export type EvalProvider = "openai" | "anthropic";

/** The key variable of each provider. */
export const EVAL_KEY_VARIABLES: Readonly<Record<EvalProvider, string>> = {
  openai: "ORBIT_EVAL_OPENAI_API_KEY",
  anthropic: "ORBIT_EVAL_ANTHROPIC_API_KEY",
};

// A keychain lookup that hangs (for example on an unanswered prompt) fails.
const KEYCHAIN_TIMEOUT_MS = 60_000;

/** Reads a generic password with `security find-generic-password -s <service> -w`; a failed or empty lookup is EVAL_KEY_REQUIRED. */
export function readKeychainKey(service: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "security",
      ["find-generic-password", "-s", service, "-w"],
      { encoding: "utf8", timeout: KEYCHAIN_TIMEOUT_MS, maxBuffer: 64 * 1024 },
      (error, stdout) => {
        const key = error ? "" : String(stdout).trim();
        // Neither the tool's error nor its output is passed on.
        if (!key) reject(new Error("EVAL_KEY_REQUIRED"));
        else resolve(key);
      },
    );
  });
}

/**
 * Live mode is requested by any provider's key variable or a confirmation;
 * otherwise the run is a dry run. A keychain service alone requests nothing.
 */
export function isEvalLiveRequested(env: LiveEnv) {
  return (
    Object.values(EVAL_KEY_VARIABLES).some((name) => env[name]?.trim()) ||
    Boolean(env.ORBIT_EVAL_CONFIRM?.trim())
  );
}

/**
 * The key for `provider` once both gates pass, or null for a dry run (no key
 * variable of any provider and no confirmation). The variable of `provider`
 * wins; without it a set keychain service is read, after the confirmation
 * matched. No key for `provider` in either place is EVAL_KEY_REQUIRED, also
 * when another provider's variable is set; a confirmation that differs from
 * `confirmation` is EVAL_CONFIRMATION_MISMATCH.
 */
export async function resolveEvalKey(
  provider: EvalProvider,
  env: LiveEnv,
  confirmation: string,
): Promise<string | null> {
  if (!Object.hasOwn(EVAL_KEY_VARIABLES, provider))
    throw new Error("EVAL_PROVIDER_UNKNOWN");
  if (!isEvalLiveRequested(env)) return null;
  const key = env[EVAL_KEY_VARIABLES[provider]]?.trim();
  const service = env.ORBIT_EVAL_KEYCHAIN_SERVICE?.trim();
  if (!key && !service) throw new Error("EVAL_KEY_REQUIRED");
  // The keychain is only read for a confirmed run.
  if (env.ORBIT_EVAL_CONFIRM !== confirmation)
    throw new Error("EVAL_CONFIRMATION_MISMATCH");
  return key || readKeychainKey(service!);
}

/**
 * The OpenAI key once both gates pass, as `assertLiveAllowed`: the key
 * variable wins; without it a set keychain service is read, after the
 * confirmation matched. No key in either place is EVAL_KEY_REQUIRED.
 */
export async function resolveLiveKey(
  env: LiveEnv,
  confirmation: string,
): Promise<string> {
  const service = env.ORBIT_EVAL_KEYCHAIN_SERVICE?.trim();
  if (env.ORBIT_EVAL_OPENAI_API_KEY?.trim() || !service)
    return assertLiveAllowed(env, confirmation);
  // The keychain is only read for a confirmed run.
  if (env.ORBIT_EVAL_CONFIRM !== confirmation)
    throw new Error("EVAL_CONFIRMATION_MISMATCH");
  const key = await readKeychainKey(service);
  return assertLiveAllowed(
    { ...env, ORBIT_EVAL_OPENAI_API_KEY: key },
    confirmation,
  );
}
