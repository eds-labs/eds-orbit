import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "apps/web/tests",
  testMatch: "**/*.spec.ts",
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  outputDir: ".runtime/playwright-results",
  reporter: [
    ["list"],
    ["html", { outputFolder: ".runtime/playwright-report", open: "never" }],
  ],
  use: {
    baseURL: "http://localhost:4310",
    actionTimeout: 15_000,
    ...(process.env.PLAYWRIGHT_CHANNEL
      ? { channel: process.env.PLAYWRIGHT_CHANNEL }
      : {}),
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
