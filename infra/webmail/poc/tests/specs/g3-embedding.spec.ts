import { test, expect } from '@playwright/test';
import { EVIL_ORIGIN, issueToken, openWebmail, ORBIT_ORIGIN, resetBridge, trackPageErrors, waitForMailList, waitForRoundcube, WEBMAIL_ORIGIN, webmailFrame } from '../lib/poc';
import { seedAlice, uidOf } from '../lib/seed.mjs';

test.describe('G3 embedding', () => {
    test.beforeEach(async () => {
        await seedAlice();
        await resetBridge();
    });

    test('sandboxed iframe keeps its session across navigation', async ({ page }) => {
        const pageErrors = trackPageErrors(page);
        const frame = await openWebmail(page);
        await waitForMailList(frame);

        const sandbox = await page.locator('#webmail').getAttribute('sandbox');
        expect(sandbox).toBe('allow-same-origin allow-scripts allow-forms allow-downloads allow-popups');

        const uid = await uidOf('Plain welcome');
        await frame.goto(`${WEBMAIL_ORIGIN}/?_task=mail&_mbox=INBOX&_uid=${uid}&_action=show`);
        await waitForRoundcube(frame);
        await expect(frame.locator('.subject').first()).toContainText('Plain welcome');

        await frame.goto(`${WEBMAIL_ORIGIN}/?_task=mail&_action=compose`);
        await waitForRoundcube(frame);
        await expect(frame.locator('#compose-subject')).toBeVisible();

        await frame.goto(`${WEBMAIL_ORIGIN}/?_task=mail`);
        await waitForMailList(frame);
        await expect(frame.locator('#messagelist')).toContainText('Plain welcome');
        expect(pageErrors).toEqual([]);
    });

    test('parent Referrer-Policy same-origin produces Origin: null', async ({ page }) => {
        const token = await issueToken();
        await page.goto(`${ORBIT_ORIGIN}/rp/same-origin?target=echo&token=${token}`);
        await expect.poll(() => webmailFrame(page).url()).toContain('/__poc/echo');

        expect(JSON.parse(await webmailFrame(page).locator('body').innerText()).origin).toBe('null');
    });

    test('parent Referrer-Policy strict-origin-when-cross-origin sends the Orbit origin', async ({ page }) => {
        const token = await issueToken();
        await page.goto(`${ORBIT_ORIGIN}/rp/strict?target=echo&token=${token}`);
        await expect.poll(() => webmailFrame(page).url()).toContain('/__poc/echo');

        expect(JSON.parse(await webmailFrame(page).locator('body').innerText()).origin).toBe(ORBIT_ORIGIN);
    });

    test('parent Referrer-Policy same-origin cannot start a session', async ({ page }) => {
        const token = await issueToken();
        await page.goto(`${ORBIT_ORIGIN}/rp/same-origin?token=${token}`);
        await expect.poll(() => webmailFrame(page).url()).toContain(WEBMAIL_ORIGIN);

        await expect(webmailFrame(page).locator('body')).toContainText('Please open this mailbox from Orbit');
        expect(await webmailFrame(page).locator('form').count()).toBe(0);
    });

    test('attachment download works inside the sandbox', async ({ page }) => {
        const frame = await openWebmail(page);
        const uid = await uidOf('With attachment');
        const url = `${WEBMAIL_ORIGIN}/?_task=mail&_action=get&_mbox=INBOX&_uid=${uid}&_part=2&_download=1&_token=${
            await frame.evaluate(() => (window as any).rcmail.env.request_token)
        }`;

        const downloadPromise = page.waitForEvent('download');
        await frame.evaluate((href) => {
            const link = document.createElement('a');
            link.href = href;
            link.id = 'poc-download';
            document.body.append(link);
            link.click();
        }, url);

        const download = await downloadPromise;
        expect(download.suggestedFilename()).toBe('report.txt');
        expect(await download.failure()).toBeNull();
    });

    test('Roundcube cannot be framed by a foreign origin', async ({ page }) => {
        await page.goto(`${EVIL_ORIGIN}/evil.html`);
        await page.evaluate((src) => {
            const frame = document.createElement('iframe');
            frame.name = 'attempt';
            frame.src = src;
            document.body.append(frame);
        }, `${WEBMAIL_ORIGIN}/`);
        await page.waitForTimeout(2000);

        const attempt = page.frames().find((candidate) => candidate.name() === 'attempt');
        const text = attempt ? await attempt.locator('body').innerText({ timeout: 2000 }).catch(() => '') : '';
        expect(text).not.toContain('Please open this mailbox');
    });
});
