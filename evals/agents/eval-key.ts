/**
 * The key of a live review eval run: from ORBIT_EVAL_OPENAI_API_KEY, or,
 * when that is unset, from the macOS keychain item named by
 * ORBIT_EVAL_KEYCHAIN_SERVICE (see README.md). The keychain is read through
 * `execFile` without a shell, and only once the confirmation matches. Error
 * messages never contain the key or the tool's output.
 */
import { execFile } from "node:child_process";
import { assertLiveAllowed, type LiveEnv } from "../generation/live-plan.ts";

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
 * The key once both gates pass, as `assertLiveAllowed`: the key variable
 * wins; without it a set keychain service is read, after the confirmation
 * matched. No key in either place is EVAL_KEY_REQUIRED.
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
