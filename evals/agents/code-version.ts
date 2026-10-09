/**
 * What code the review eval measures: the hash of the review prompt and
 * output schema exactly as `runSpecialist` sends them, and the git commit of
 * the working tree. The prompt hash is bound into the confirmation; both go
 * into the evidence, so a PASS names the code it is valid for.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { zodTextFormat } from "openai/helpers/zod";
import { BASE_INSTRUCTIONS } from "../../apps/api/src/modules/agents/specialists/runner.ts";
import {
  REVIEW_INSTRUCTIONS,
  reviewOutput,
} from "../../apps/api/src/modules/agents/specialists/review.ts";
import { canonical } from "../generation/harness.ts";

/** Hash of the base and review instructions and the strict output schema (as `outputJsonSchema` in the runner builds it). */
export function reviewPromptHash() {
  const { $schema: _schema, ...schema } = zodTextFormat(
    reviewOutput,
    "orbit_agent_output",
  ).schema as Record<string, unknown>;
  return createHash("sha256")
    .update(
      JSON.stringify(
        canonical({
          instructions: `${BASE_INSTRUCTIONS} ${REVIEW_INSTRUCTIONS}`,
          outputSchema: schema,
        }),
      ),
    )
    .digest("hex");
}

/**
 * The checked-out commit and whether tracked files differ from it (untracked
 * files such as earlier evidence do not count). Null when git is unavailable.
 */
export function codeVersion(): {
  commit: string | null;
  dirty: boolean | null;
} {
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  try {
    return {
      commit: git("rev-parse", "HEAD"),
      dirty: git("status", "--porcelain", "--untracked-files=no") !== "",
    };
  } catch {
    return { commit: null, dirty: null };
  }
}
