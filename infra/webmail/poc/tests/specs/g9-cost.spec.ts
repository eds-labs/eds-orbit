import { writeFileSync } from 'node:fs';
import { test, expect, type Page } from '@playwright/test';
import { bridgeCalls, FULL_ACCESS, openWebmail, resetBridge, waitForMailList, WEBMAIL_ORIGIN } from '../lib/poc';
import { greenmailLog, imapsConnections, newLines } from '../lib/greenmail';
import { seedAlice, uidOf } from '../lib/seed.mjs';

function trackRoundcubeRequests(page: Page) {
    const urls: string[] = [];
    page.on('request', (entry) => {
        const url = entry.url();
        if (url.startsWith(`${WEBMAIL_ORIGIN}/?`) || url === `${WEBMAIL_ORIGIN}/`) urls.push(url);
    });
    return urls;
}

async function measure(page: Page, requests: string[], step: () => Promise<void>) {
    requests.length = 0;
    await resetBridge();
    const before = greenmailLog();

    await step();
    await page.waitForTimeout(2500);

    return {
        httpRequests: requests.length,
        authorizeCalls: (await bridgeCalls('session/authorize')).length,
        imapConnections: imapsConnections(newLines(before)),
        actions: requests.map((url) => new URL(url).searchParams.get('_action') ?? 'index'),
    };
}

test('G9 cost per request', async ({ page, browserName }) => {
    await seedAlice();
    await resetBridge();
    const requests = trackRoundcubeRequests(page);
    const frame = await openWebmail(page, { capabilities: FULL_ACCESS });
    await waitForMailList(frame);
    const uid = await uidOf('Plain welcome');

    const openList = await measure(page, requests, async () => {
        await frame.goto(`${WEBMAIL_ORIGIN}/?_task=mail&_mbox=INBOX`);
        await waitForMailList(frame);
    });
    const openMessage = await measure(page, requests, async () => {
        await frame.goto(`${WEBMAIL_ORIGIN}/?_task=mail&_mbox=INBOX&_uid=${uid}&_action=show`);
        await page.waitForTimeout(500);
    });
    await frame.goto(`${WEBMAIL_ORIGIN}/?_task=mail&_mbox=INBOX`);
    await waitForMailList(frame);
    const refreshPoll = await measure(page, requests, async () => {
        await frame.evaluate(() => (window as any).rcmail.refresh());
    });

    const report = { openList, openMessage, refreshPoll };
    console.log(`G9-COST ${browserName} ${JSON.stringify(report)}`);
    writeFileSync(`/results/g9-cost-${browserName}.json`, JSON.stringify(report, null, 2));

    for (const step of [openList, openMessage, refreshPoll]) {
        expect(step.authorizeCalls).toBeLessThanOrEqual(step.httpRequests);
    }
});
