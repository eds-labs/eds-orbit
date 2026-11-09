import { test, expect, type Frame, type Page } from '@playwright/test';
import { ajaxGet, control, FULL_ACCESS, lostMessages, openWebmail, ORBIT_ORIGIN, READ_ONLY, resetBridge, waitForMailList, waitForRoundcube, WEBMAIL_ORIGIN } from '../lib/poc';
import { BOB, seedAlice, seedBob, uidOf, withAlice } from '../lib/seed.mjs';
import { Imap } from '../lib/imap.mjs';

const SEND_CONTROLS = ['a.compose', '.toolbar a.reply', '.toolbar a.reply-all', '.toolbar a.forward'];
const ORGANIZE_CONTROLS = ['.toolbar a.delete', '.toolbar a.markmessage', 'a.sidebar-menu'];
const ALWAYS_HIDDEN_CONTROLS = ['#taskmenu a.settings', '#taskmenu a.contacts', '#taskmenu a.logout', '#taskmenu a.about', '#mailboxoptions-menu a.folders'];

async function visible(frame: Frame, selector: string): Promise<number> {
    return frame.locator(`${selector}:visible`).count();
}

function commandEnabled(frame: Frame, command: string): Promise<boolean> {
    return frame.evaluate((name) => Boolean((window as any).rcmail.commands[name]), command);
}

async function selectFirstMessage(frame: Frame) {
    await frame.evaluate(() => {
        const list = (window as any).rcmail.message_list;
        list.select_row(Object.keys(list.rows)[0]);
    });
}

async function flagsOf(subject: string): Promise<string> {
    const uid = await uidOf(subject);
    return withAlice(async (imap: Imap) => {
        await imap.select('INBOX');
        return imap.flags(uid);
    });
}

async function openMessage(frame: Frame, subject: string) {
    await frame.goto(`${WEBMAIL_ORIGIN}/?_task=mail&_mbox=INBOX&_uid=${await uidOf(subject)}&_action=show`);
    await waitForRoundcube(frame);
}

function pollOnce(frame: Frame) {
    return ajaxGet(frame, 'mail', 'check-recent', '&_mbox=INBOX');
}

async function triggerPoll(frame: Frame) {
    await frame.evaluate(() => (window as any).rcmail.refresh());
}

test.describe('G11 product behaviour', () => {
    test.beforeEach(async () => {
        await seedAlice();
        await seedBob();
        await resetBridge();
    });

    test('the interface shows the mailbox, never the opaque user', async ({ page }) => {
        const frame = await openWebmail(page, { capabilities: FULL_ACCESS });
        await waitForMailList(frame);

        await expect(frame.locator('.header-title.username .orbit-mailbox-address')).toHaveText('alice@mail.test');
        await expect(frame.locator('.header-title.username .orbit-mailbox-name')).toHaveText('Alice Mailbox');
        expect(await frame.content()).not.toContain('orbit.invalid');

        await frame.goto(`${WEBMAIL_ORIGIN}/?_task=mail&_action=compose`);
        await waitForRoundcube(frame);
        await expect(frame.locator('select[name="_from"]')).toContainText('Alice Mailbox <alice@mail.test>');
        expect(await frame.content()).not.toContain('orbit.invalid');
    });

    test('a sent message carries no trace of the opaque user', async ({ page }) => {
        const frame = await openWebmail(page, { capabilities: FULL_ACCESS });
        const subject = `Trace ${Date.now()}`;

        await frame.goto(`${WEBMAIL_ORIGIN}/?_task=mail&_action=compose&_to=bob%40mail.test`);
        await waitForRoundcube(frame);
        await frame.locator('#compose-subject').fill(subject);
        await frame.locator('#composebody').fill('Checking headers.');
        await frame.evaluate(() => (window as any).rcmail.command('send', { nocheck: true }));

        const fetchHeaders = async () => {
            const imap = await Imap.open(BOB.login, BOB.password);
            await imap.select('INBOX');
            const result = await imap.run('UID FETCH 1:* (BODY.PEEK[HEADER])');
            imap.close();
            return result.lines.join('\n');
        };
        await expect.poll(fetchHeaders, { timeout: 20_000 }).toContain(subject);
        const headers = await fetchHeaders();
        expect(headers).toContain('alice@mail.test');
        expect(headers).not.toContain('orbit.invalid');
        expect(headers).not.toContain('mb-m1');
    });

    test('a renamed mailbox updates its identity at the next login', async ({ page }) => {
        await control('/display-name', { mailbox: 'm2', displayName: 'Renamed Mailbox' });
        try {
            const frame = await openWebmail(page, { mailbox: 'm2', capabilities: FULL_ACCESS });
            await frame.goto(`${WEBMAIL_ORIGIN}/?_task=mail&_action=compose`);
            await waitForRoundcube(frame);
            await expect(frame.locator('select[name="_from"]')).toContainText('Renamed Mailbox <bob@mail.test>');
        } finally {
            await control('/display-name', { mailbox: 'm2', displayName: 'Bob Mailbox' });
        }
    });

    for (const [width, height] of [[1320, 800], [375, 760]] as const) {
        test(`a read-only session is offered nothing it cannot do at ${width}px`, async ({ page }) => {
            await page.setViewportSize({ width, height });
            await page.addInitScript(() => {
                document.addEventListener('DOMContentLoaded', () => {
                    const frame = document.getElementById('webmail');
                    if (frame) frame.style.width = `${window.innerWidth}px`;
                    if (frame) frame.style.height = `${window.innerHeight}px`;
                });
            });
            const frame = await openWebmail(page, { capabilities: READ_ONLY });
            await waitForMailList(frame);
            await selectFirstMessage(frame);

            for (const selector of [...SEND_CONTROLS, ...ORGANIZE_CONTROLS, ...ALWAYS_HIDDEN_CONTROLS, '.toolbar .dropbutton', 'a.orbit-convert']) {
                expect(await visible(frame, selector), selector).toBe(0);
            }
            for (const command of ['compose', 'reply', 'forward', 'delete', 'move', 'copy', 'mark', 'toggle_flag', 'toggle_status', 'purge', 'settings', 'logout']) {
                expect(await commandEnabled(frame, command), command).toBe(false);
            }
        });
    }

    test('a full session sees the mailbox controls', async ({ page }) => {
        const frame = await openWebmail(page, { capabilities: FULL_ACCESS });
        await waitForMailList(frame);
        await selectFirstMessage(frame);

        for (const selector of [...SEND_CONTROLS, ...ORGANIZE_CONTROLS]) {
            expect(await visible(frame, selector), selector).toBeGreaterThan(0);
        }
        for (const selector of ALWAYS_HIDDEN_CONTROLS) {
            expect(await visible(frame, selector), selector).toBe(0);
        }
        expect(await commandEnabled(frame, 'delete')).toBe(true);
        expect(await commandEnabled(frame, 'settings')).toBe(false);
    });

    test('capabilities hide their controls independently', async ({ page }) => {
        const frame = await openWebmail(page, { capabilities: ['read', 'send'] });
        await waitForMailList(frame);
        await selectFirstMessage(frame);

        expect(await visible(frame, '.toolbar a.reply')).toBeGreaterThan(0);
        expect(await visible(frame, '.toolbar a.delete')).toBe(0);
        expect(await commandEnabled(frame, 'reply')).toBe(true);
        expect(await commandEnabled(frame, 'delete')).toBe(false);
    });

    test('reading in a read-only session leaves the message unread', async ({ page }) => {
        const frame = await openWebmail(page, { capabilities: READ_ONLY });

        await openMessage(frame, 'Plain welcome');
        await expect(frame.locator('.subject').first()).toContainText('Plain welcome');
        await page.waitForTimeout(500);
        expect(await flagsOf('Plain welcome')).not.toContain('Seen');

        const source = await frame.evaluate(async (uid) => (
            await fetch(`./?_task=mail&_action=viewsource&_mbox=INBOX&_uid=${uid}`, { credentials: 'same-origin' })
        ).status, await uidOf('Plain welcome'));
        expect(source).toBe(200);
        expect(await flagsOf('Plain welcome')).not.toContain('Seen');
    });

    test('reading in a session that may organize marks the message as seen', async ({ page }) => {
        const frame = await openWebmail(page, { capabilities: FULL_ACCESS });

        await openMessage(frame, 'Plain welcome');

        await expect.poll(() => flagsOf('Plain welcome')).toContain('Seen');
    });

    for (const [status, error, reason] of [
        [401, 'session_revoked', 'session_revoked'],
        [401, 'session_expired', 'session_expired'],
        [401, 'session_unknown', 'session_unknown'],
        [403, 'not_authorized', 'not_authorized'],
    ] as const) {
        test(`a poll answered with ${error} tells Orbit the session is lost`, async ({ page }) => {
            const frame = await openWebmail(page, { capabilities: FULL_ACCESS });
            await waitForMailList(frame);
            await control('/authorize-failure', { status, body: { ok: false, error } });

            await triggerPoll(frame);

            await expect.poll(() => lostMessages(page)).toEqual([{ type: 'orbit.webmail.session_lost', reason }]);
            await expect(frame.locator('#messagestack')).not.toBeEmpty();
        });
    }

    test('a session is reported once, however many requests fail', async ({ page }) => {
        const frame = await openWebmail(page, { capabilities: FULL_ACCESS });
        await waitForMailList(frame);
        await control('/revoke');

        await triggerPoll(frame);
        await expect.poll(() => lostMessages(page)).toHaveLength(1);
        await triggerPoll(frame);
        await page.waitForTimeout(1000);

        expect(await lostMessages(page)).toHaveLength(1);
    });

    test('a full page refused for a lost session reports to Orbit with the exact origin', async ({ page }) => {
        const frame = await openWebmail(page, { capabilities: FULL_ACCESS });
        await waitForMailList(frame);
        await control('/revoke');

        const response = await frame.goto(`${WEBMAIL_ORIGIN}/?_task=mail&_mbox=INBOX`);

        expect(response?.status()).toBe(403);
        await expect(frame.locator('body')).toContainText('session has ended');
        await expect.poll(() => lostMessages(page)).toEqual([{ type: 'orbit.webmail.session_lost', reason: 'session_revoked' }]);

        const source = await response!.text();
        expect(source).toContain(JSON.stringify(ORBIT_ORIGIN));
        expect(source).not.toContain('"*"');
    });

    test('a lost session inside a preview frame reaches Orbit through its parent', async ({ page }) => {
        const frame = await openWebmail(page, { capabilities: FULL_ACCESS });
        await waitForMailList(frame);
        const uid = await uidOf('Plain welcome');
        await control('/revoke');

        await frame.evaluate((src) => {
            (document.getElementById('messagecontframe') as HTMLIFrameElement).src = src;
        }, `${WEBMAIL_ORIGIN}/?_task=mail&_mbox=INBOX&_uid=${uid}&_action=show&_framed=1`);

        await expect.poll(() => lostMessages(page)).toEqual([{ type: 'orbit.webmail.session_lost', reason: 'session_revoked' }]);
    });

    test('an unavailable mailbox keeps the session and recovers', async ({ page }) => {
        const frame = await openWebmail(page, { capabilities: FULL_ACCESS });
        await waitForMailList(frame);
        await control('/authorize-failure', { status: 503, body: { ok: false, error: 'mailbox_unavailable' } });

        const poll = await pollOnce(frame);
        expect(poll.text).toContain('currently unavailable');
        expect(poll.text).not.toContain('session_error');
        await page.waitForTimeout(500);
        expect(await lostMessages(page)).toEqual([]);

        const refused = await frame.goto(`${WEBMAIL_ORIGIN}/?_task=mail&_mbox=INBOX`);
        expect(refused?.status()).toBe(503);
        await expect.poll(() => lostMessages(page)).toEqual([{ type: 'orbit.webmail.session_lost', reason: 'mailbox_unavailable' }]);

        await control('/authorize-failure', {});
        await frame.goto(`${WEBMAIL_ORIGIN}/?_task=mail&_mbox=INBOX`);
        await waitForMailList(frame);
        await expect(frame.locator('#messagelist')).toContainText('Plain welcome');
    });

    test('an answer without a known code fails closed and keeps the session', async ({ page }) => {
        const frame = await openWebmail(page, { capabilities: FULL_ACCESS });
        await waitForMailList(frame);
        await control('/authorize-failure', { status: 502, body: {} });

        const poll = await pollOnce(frame);
        expect(poll.text).toContain('cannot be reached');
        expect(poll.text).not.toContain('Plain welcome');

        await control('/authorize-failure', {});
        expect((await ajaxGet(frame, 'mail', 'list', '&_mbox=INBOX')).text).toContain('Plain welcome');
    });

    for (const [error, status, text] of [
        ['session_expired', 401, 'Deine Postfach-Sitzung ist beendet'],
        ['not_authorized', 403, 'keinen Zugriff mehr'],
        ['mailbox_unavailable', 503, 'gerade nicht verfügbar'],
    ] as const) {
        test(`${error} is explained in German`, async ({ browser }) => {
            const context = await browser.newContext({ ignoreHTTPSErrors: true, locale: 'de-DE' });
            const page: Page = await context.newPage();
            const frame = await openWebmail(page, { mailbox: 'm2', capabilities: FULL_ACCESS });
            await control('/authorize-failure', { status, body: { ok: false, error } });

            await frame.goto(`${WEBMAIL_ORIGIN}/?_task=mail`);

            await expect(frame.locator('body')).toContainText(text);
            await context.close();
        });
    }
});
