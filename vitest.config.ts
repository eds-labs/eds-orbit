import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    setupFiles: ["tests/setup.ts"],
    include: [
      "apps/api/**/*.test.ts",
      "apps/worker/**/*.test.ts",
      "packages/**/*.test.ts",
      "evals/**/*.test.ts",
    ],
    testTimeout: 30000,
    hookTimeout: 30000,
    fileParallelism: false,
  },
});
