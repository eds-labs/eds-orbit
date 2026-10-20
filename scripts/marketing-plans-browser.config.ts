import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "../apps/web/tests",
  testMatch: "marketing-plans.spec.ts",
  workers: 1,
  timeout: 90000,
  outputDir: "../.runtime/marketing-plans-playwright",
  use: {
    baseURL: "http://localhost:44430",
    channel: "chrome",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
});
