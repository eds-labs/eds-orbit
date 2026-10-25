import { defineConfig } from "vitest/config";
// Manual paid eval only; the normal config never includes live.eval.ts.
export default defineConfig({
  test: {
    setupFiles: ["tests/setup.ts"],
    include: ["evals/work-pm/live.eval.ts"],
    testTimeout: 30 * 60_000,
    hookTimeout: 30 * 60_000,
    fileParallelism: false,
    reporters: ["verbose"],
  },
});
