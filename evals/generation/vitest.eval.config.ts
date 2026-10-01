import { defineConfig } from "vitest/config";
// Manual live eval only; the normal config never includes live.eval.ts.
export default defineConfig({
  test: {
    setupFiles: ["tests/setup.ts"],
    include: ["evals/generation/live.eval.ts"],
    testTimeout: 30 * 60_000,
    hookTimeout: 30 * 60_000,
    fileParallelism: false,
    // The plan and report are console output; show them even when the test passes.
    reporters: ["verbose"],
  },
});
