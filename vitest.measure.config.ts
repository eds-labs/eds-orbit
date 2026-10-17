import { defineConfig } from "vitest/config";
// Manual measurements only (WP4.3); the normal config never includes them.
export default defineConfig({
  test: {
    setupFiles: ["tests/setup.ts"],
    include: ["scripts/measure/**/*.measure.ts"],
    testTimeout: 10 * 60_000,
    hookTimeout: 10 * 60_000,
    fileParallelism: false,
    reporters: ["verbose"],
  },
});
