import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "../apps/web/tests",
  testMatch: "marketing-agent-v2.spec.ts",
  workers: 1,
  timeout: 90000,
  outputDir: "../.runtime/marketing-v2-playwright",
  use: {
    baseURL: "http://localhost:44330",
    channel: "chrome",
    viewport: { width: 1280, height: 900 },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
});
