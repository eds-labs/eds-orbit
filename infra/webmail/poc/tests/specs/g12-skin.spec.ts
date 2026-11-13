import { mkdirSync } from 'node:fs';
import { test, expect, type Frame, type Page } from '@playwright/test';
import { FULL_ACCESS, openWebmail, READ_ONLY, resetBridge, trackPageErrors, waitForMailList, waitForRoundcube, WEBMAIL_ORIGIN } from '../lib/poc';
import { seedAlice, uidOf } from '../lib/seed.mjs';

const SCREENS = '/results/screens';

function colorOf(frame: Frame, selector: string, property: string): Promise<string> {
    return frame.evaluate(
        ({ selector, property }) => getComputedStyle(document.querySelector(selector)!).getPropertyValue(property),
        { selector, property },
    );
}

function fitFrameToViewport(page: Page) {
    return page.addInitScript(() => {
        document.addEventListener('DOMContentLoaded', () => {
            const frame = document.getElementById('webmail');
            if (frame) {
                frame.style.width = `${window.innerWidth}px`;
                frame.style.height = `${window.innerHeight}px`;
            }
        });
    });
}

test.describe('G12 orbit skin', () => {
    test.beforeAll(() => mkdirSync(SCREENS, { recursive: true }));

    test.beforeEach(async () => {
        await seedAlice();
        await resetBridge();
    });

    test('the skin applies Orbit tokens and system fonts', async ({ page, browserName }) => {
        const fontRequests: string[] = [];
        page.on('request', (entry) => {
            if (/roboto/i.test(entry.url())) fontRequests.push(entry.url());
        });
        const pageErrors = trackPageErrors(page);

        const frame = await openWebmail(page, { capabilities: FULL_ACCESS });
        await waitForMailList(frame);

        expect(await frame.evaluate(() => (window as any).rcmail.env.skin)).toBe('orbit');
        expect(await colorOf(frame, '#layout-menu', 'background-color')).toBe('rgb(14, 39, 57)');
        expect(await colorOf(frame, 'body', 'font-family')).toContain('Inter');
        expect(await colorOf(frame, 'body', 'color')).toBe('rgb(7, 21, 34)');
        expect(fontRequests).toEqual([]);
        expect(pageErrors).toEqual([]);
        await page.screenshot({ path: `${SCREENS}/${browserName}-desktop-light.png` });
    });

    test('dark mode follows the browser preference', async ({ page, browserName }) => {
        await page.emulateMedia({ colorScheme: 'dark' });

        const frame = await openWebmail(page, { capabilities: FULL_ACCESS });
        await waitForMailList(frame);

        expect(await frame.evaluate(() => document.documentElement.classList.contains('dark-mode'))).toBe(true);
        expect(await colorOf(frame, 'body', 'background-color')).toBe('rgb(14, 39, 57)');
        await page.screenshot({ path: `${SCREENS}/${browserName}-desktop-dark.png` });
    });

    test('the page works at phone width without horizontal scrolling', async ({ page, browserName }) => {
        await page.setViewportSize({ width: 375, height: 760 });
        await fitFrameToViewport(page);
        const pageErrors = trackPageErrors(page);

        const frame = await openWebmail(page, { capabilities: FULL_ACCESS });
        await waitForMailList(frame);

        expect(await frame.evaluate(() => document.documentElement.classList.contains('layout-phone'))).toBe(true);
        expect(await frame.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        await page.screenshot({ path: `${SCREENS}/${browserName}-phone-list.png` });

        await frame.goto(`${WEBMAIL_ORIGIN}/?_task=mail&_mbox=INBOX&_uid=${await uidOf('Plain welcome')}&_action=show`);
        await waitForRoundcube(frame);
        expect(await frame.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        await page.screenshot({ path: `${SCREENS}/${browserName}-phone-message.png` });
        expect(pageErrors).toEqual([]);
    });

    test('read-only desktop view has no write controls in the screenshot', async ({ page, browserName }) => {
        const frame = await openWebmail(page, { capabilities: READ_ONLY });
        await waitForMailList(frame);
        await frame.evaluate(() => {
            const list = (window as any).rcmail.message_list;
            list.select_row(Object.keys(list.rows)[0]);
        });
        await expect(frame.locator('a.compose:visible')).toHaveCount(0);
        await page.screenshot({ path: `${SCREENS}/${browserName}-desktop-readonly.png` });
    });
});
