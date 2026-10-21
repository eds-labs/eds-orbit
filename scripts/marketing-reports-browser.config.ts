import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "../apps/web/tests",
  testMatch: "marketing-reports.spec.ts",
  workers: 1,
  timeout: 60000,
  outputDir: "../.runtime/marketing-reports-playwright",
  use: {
    baseURL: "http://localhost:44430",
    channel: "chrome",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
});
