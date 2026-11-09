import { test, expect, type Frame } from '@playwright/test';
import { EVIL_ORIGIN, FULL_ACCESS, issueToken, openWebmail, ORBIT_ORIGIN, READ_ONLY, resetBridge, waitForMailList, waitForRoundcube, WEBMAIL_ORIGIN, webmailFrame } from '../lib/poc';
import { seedAlice, seedBob, uidOf, withAlice } from '../lib/seed.mjs';

const BUTTON = 'a.orbit-convert';
const COMMAND = 'plugin.orbit_bridge.convert';

function commandEnabled(frame: Frame) {
    return frame.evaluate((name) => Boolean((window as any).rcmail.commands[name]), COMMAND);
}

async function selectRows(frame: Frame, count: number) {
    await frame.evaluate((total) => {
        const list = (window as any).rcmail.message_list;
        const uids = Object.keys(list.rows).slice(0, total);
        list.select_row(uids[0]);
        for (const uid of uids.slice(1)) list.select_row(uid, 1, true);
    }, count);
}

test.describe('G8 convert button', () => {
    test.beforeEach(async () => {
        await seedAlice();
        await resetBridge();
    });

    test('list view enables the button for exactly one message and posts to Orbit', async ({ page }) => {
        const frame = await openWebmail(page, { capabilities: FULL_ACCESS });
        await waitForMailList(frame);
        await expect(frame.locator(BUTTON)).toContainText('Convert to support ticket');
        expect(await commandEnabled(frame)).toBe(false);

        await selectRows(frame, 2);
        expect(await commandEnabled(frame)).toBe(false);

        const uid = await uidOf('Keep one');
        const expectedValidity = await withAlice(async (imap) => (await imap.select('INBOX')).uidValidity);
        await frame.evaluate((target) => {
            const list = (window as any).rcmail.message_list;
            list.clear_selection();
            list.select_row(String(target));
        }, uid);
        expect(await commandEnabled(frame)).toBe(true);

        await frame.locator(BUTTON).click();

        await expect.poll(() => page.evaluate(() => (window as any).received)).toEqual([{
            type: 'orbit.webmail.convert',
            folder: 'INBOX',
            uid,
            uidValidity: expectedValidity,
        }]);
    });

    test('message view shows the button and posts to Orbit', async ({ page }) => {
        const frame = await openWebmail(page, { capabilities: FULL_ACCESS });
        const uid = await uidOf('Plain welcome');

        await frame.goto(`${WEBMAIL_ORIGIN}/?_task=mail&_mbox=INBOX&_uid=${uid}&_action=show`);
        await waitForRoundcube(frame);
        await expect(frame.locator(BUTTON)).toContainText('Convert to support ticket');
        expect(await commandEnabled(frame)).toBe(true);

        await frame.locator(BUTTON).click();

        await expect.poll(() => page.evaluate(() => (window as any).received.length)).toBe(1);
        expect((await page.evaluate(() => (window as any).received))[0].uid).toBe(uid);
    });

    test('the postMessage target is the Orbit origin, not a wildcard', async ({ page }) => {
        const frame = await openWebmail(page, { capabilities: FULL_ACCESS });
        await waitForMailList(frame);

        expect(await frame.evaluate(() => (window as any).rcmail.env.orbit_parent_origin)).toBe(ORBIT_ORIGIN);
    });

    test('a message from a wrong origin is ignored', async ({ page }) => {
        const token = await issueToken({ capabilities: FULL_ACCESS });
        await page.goto(`${ORBIT_ORIGIN}/rp/strict?evil=1&token=${encodeURIComponent(token)}`);
        await expect.poll(() => webmailFrame(page).url(), { timeout: 30_000 }).toContain('_task=mail');

        await expect.poll(() => page.evaluate(() => (window as any).ignored.length)).toBeGreaterThan(0);
        expect(await page.evaluate(() => (window as any).ignored[0].origin)).toBe(EVIL_ORIGIN);
        expect(await page.evaluate(() => (window as any).received)).toEqual([]);
    });

    test('the button is absent without the convert capability', async ({ page }) => {
        const frame = await openWebmail(page, { capabilities: READ_ONLY });
        await waitForMailList(frame);

        await expect(frame.locator(BUTTON)).toHaveCount(0);
    });

    test('a rendered session tells Orbit it is ready', async ({ page }) => {
        await openWebmail(page, { capabilities: READ_ONLY });

        await expect.poll(() => page.evaluate(() => (window as any).ready[0])).toEqual({ type: 'orbit.webmail.ready' });
    });

    test('a refused login never reports ready', async ({ page }) => {
        await page.goto(`${ORBIT_ORIGIN}/rp/strict?token=forged-token`);
        await expect.poll(() => page.evaluate(() => (window as any).lost)).toEqual([
            { type: 'orbit.webmail.session_lost', reason: 'handoff_failed' },
        ]);

        expect(await page.evaluate(() => (window as any).ready)).toEqual([]);
    });

    test('outside the frame the button opens the Orbit link', async ({ page, context }) => {
        await openWebmail(page, { capabilities: FULL_ACCESS });
        const uid = await uidOf('Plain welcome');
        const validity = await withAlice(async (imap) => (await imap.select('INBOX')).uidValidity);
        const tab = await context.newPage();
        await tab.goto(`${WEBMAIL_ORIGIN}/?_task=mail&_mbox=INBOX&_uid=${uid}&_action=show`);
        await waitForRoundcube(tab.mainFrame());

        const [orbit] = await Promise.all([context.waitForEvent('page'), tab.locator(BUTTON).click()]);

        await expect.poll(() => orbit.url()).toBe(
            `${ORBIT_ORIGIN}/p/project-1/webmail?mailbox=m1&convert=1&folder=INBOX&uid=${uid}&uidValidity=${validity}`,
        );
        expect(await orbit.evaluate(() => window.opener)).toBeNull();
    });

    test('outside the frame the button reports failure without a project', async ({ page, context }) => {
        await seedBob();
        await openWebmail(page, { mailbox: 'm2', capabilities: FULL_ACCESS });
        const tab = await context.newPage();
        await tab.goto(`${WEBMAIL_ORIGIN}/?_task=mail&_mbox=INBOX`);
        await waitForMailList(tab.mainFrame());
        await tab.evaluate(() => {
            const list = (window as any).rcmail.message_list;
            list.select_row(Object.keys(list.rows)[0]);
        });
        const pagesBefore = context.pages().length;

        await tab.locator(BUTTON).click();

        await expect(tab.locator('#messagestack')).toContainText('could not be prepared');
        expect(context.pages()).toHaveLength(pagesBefore);
    });

    test('the label follows the German locale', async ({ browser }) => {
        const context = await browser.newContext({ ignoreHTTPSErrors: true, locale: 'de-DE' });
        const page = await context.newPage();
        const frame = await openWebmail(page, { mailbox: 'm2', capabilities: FULL_ACCESS });

        await expect(frame.locator(BUTTON)).toContainText('Als Supportticket übernehmen');
        await context.close();
    });
});
