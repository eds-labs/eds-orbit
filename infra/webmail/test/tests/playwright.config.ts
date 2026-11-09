import { defineConfig, devices } from '@playwright/test';

const flagOff = process.env.E2E_PHASE === 'flag-off';
const selected = (process.env.E2E_BROWSERS ?? 'chromium,firefox,webkit').split(',');
const viewport = { width: 1400, height: 860 };
const engines = {
    chromium: devices['Desktop Chrome'],
    firefox: devices['Desktop Firefox'],
    webkit: devices['Desktop Safari'],
} as const;

export default defineConfig({
    testDir: './specs',
    outputDir: '/results/playwright',
    // The worker reads a mailbox every two minutes, sometimes a little later.
    timeout: 480_000,
    expect: { timeout: 20_000 },
    fullyParallel: false,
    workers: 1,
    retries: 0,
    reporter: [['list'], ['json', { outputFile: flagOff ? '/results/report-flag-off.json' : '/results/report.json' }]],
    use: {
        // The throwaway CA is not in the browsers' stores; TLS still runs end to end.
        ignoreHTTPSErrors: true,
        viewport,
        locale: 'en-US',
        actionTimeout: 20_000,
        trace: 'retain-on-failure',
        screenshot: 'only-on-failure',
    },
    projects: flagOff
        ? [{ name: 'flag-off', testMatch: /flag-off\.spec\.ts/, use: { ...devices['Desktop Chrome'], viewport } }]
        : selected.map((name) => ({
              name,
              testIgnore: /flag-off\.spec\.ts/,
              use: { ...engines[name as keyof typeof engines], viewport },
          })),
});
