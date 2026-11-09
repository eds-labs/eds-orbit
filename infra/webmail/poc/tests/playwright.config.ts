import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
    testDir: './specs',
    outputDir: '/results/playwright',
    timeout: 60_000,
    expect: { timeout: 15_000 },
    fullyParallel: false,
    workers: 1,
    retries: 0,
    reporter: [['list'], ['json', { outputFile: '/results/playwright-report.json' }]],
    use: {
        // The throwaway CA is not in the browsers' stores; TLS still runs end to end.
        ignoreHTTPSErrors: true,
        viewport: { width: 1320, height: 800 },
        locale: 'en-US',
    },
    projects: [
        { name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1320, height: 800 } } },
        { name: 'firefox', use: { ...devices['Desktop Firefox'], viewport: { width: 1320, height: 800 } } },
        { name: 'webkit', use: { ...devices['Desktop Safari'], viewport: { width: 1320, height: 800 } } },
    ],
});
