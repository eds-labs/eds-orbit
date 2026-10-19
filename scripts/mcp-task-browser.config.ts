import { defineConfig } from "@playwright/test";

/** Opt-in acceptance against scripts/mcp-task-browser-fixture.ts. */
export default defineConfig({
  testDir: "../apps/web/tests",
  testMatch: "mcp-work-orders.spec.ts",
  workers: 1,
  timeout: 90000,
  outputDir: "../.runtime/mcp2-playwright",
  use: {
    baseURL: "http://localhost:44310",
    viewport: { width: 1280, height: 900 },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
});
