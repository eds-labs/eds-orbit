import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
export default defineConfig({
  // The web app's "@/" import alias (apps/web/tsconfig.json) for component tests.
  resolve: {
    alias: { "@": fileURLToPath(new URL("apps/web/src", import.meta.url)) },
  },
  test: {
    setupFiles: ["tests/setup.ts"],
    include: [
      "apps/api/**/*.test.ts",
      "apps/web/**/*.test.tsx",
      "apps/worker/**/*.test.ts",
      "packages/**/*.test.ts",
      "evals/**/*.test.ts",
    ],
    testTimeout: 30000,
    hookTimeout: 30000,
    fileParallelism: false,
  },
});
