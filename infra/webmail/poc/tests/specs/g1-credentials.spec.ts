import { test, expect, request } from '@playwright/test';
import { ajaxGet, bridgeCalls, control, FULL_ACCESS, issueToken, openWebmail, ORBIT_ORIGIN, resetBridge, waitForRoundcube, WEBMAIL_ORIGIN } from '../lib/poc';
import { greenmailLog, imapLogins, imapsConnections, newLines, smtpsConnections } from '../lib/greenmail';
import { BOB, seedAlice, seedBob } from '../lib/seed.mjs';
import { Imap } from '../lib/imap.mjs';

async function bobSubjects(): Promise<string[]> {
    const imap = await Imap.open(BOB.login, BOB.password);
    await imap.select('INBOX');
    const result = await imap.run('UID FETCH 1:* (BODY.PEEK[HEADER.FIELDS (SUBJECT FROM)])');
    imap.close();
    return result.lines;
}

test.describe('G1 credential model', () => {
    test.beforeEach(async () => {
        await seedAlice();
        await seedBob();
        await resetBridge();
    });

    test.afterEach(() => control('/tls-peer', {}));

    test('IMAP uses the bridge target at login and on later requests', async ({ page }) => {
        const before = greenmailLog();

        const frame = await openWebmail(page, { capabilities: FULL_ACCESS });
        await page.waitForTimeout(1000);
        const afterLogin = newLines(before);
        expect(imapsConnections(afterLogin)).toBeGreaterThan(0);
        expect(imapLogins(afterLogin).every((login) => login.startsWith('LOGIN "alice@mail.test"') || login.startsWith('LOGIN alice@mail.test'))).toBe(true);
        expect(afterLogin.join('\n')).not.toContain('mb-m1');

        const beforeLater = greenmailLog();
        const authorizeBefore = (await bridgeCalls('session/authorize')).length;
        expect((await ajaxGet(frame, 'mail', 'list', '&_mbox=INBOX')).status).toBe(200);
        await page.waitForTimeout(1000);
        const later = newLines(beforeLater);

        expect(imapsConnections(later)).toBeGreaterThan(0);
        expect(imapLogins(later).length).toBeGreaterThan(0);
        expect((await bridgeCalls('session/authorize')).length).toBeGreaterThan(authorizeBefore);
    });

    test('the two mailboxes stay separate', async ({ page }) => {
        const frame = await openWebmail(page, { mailbox: 'm2', capabilities: FULL_ACCESS });
        const list = await ajaxGet(frame, 'mail', 'list', '&_mbox=INBOX');

        expect(list.text).toContain('Bob only');
        expect(list.text).not.toContain('Plain welcome');
    });

    test('TLS peer verification is active on the bridge-supplied target', async () => {
        await control('/tls-peer', { tlsPeerName: 'wrong.test' });
        const api = await request.newContext({ ignoreHTTPSErrors: true, maxRedirects: 0 });

        const response = await api.post(`${WEBMAIL_ORIGIN}/`, {
            form: { _task: 'login', _action: 'login', _orbit_handoff: await issueToken() },
            headers: { Origin: ORBIT_ORIGIN },
        });

        expect(response.status()).toBe(403);
    });

    test('a message is sent through the bridge-supplied SMTP target', async ({ page }) => {
        const frame = await openWebmail(page, { capabilities: FULL_ACCESS });
        const before = greenmailLog();
        const subject = `PoC send ${Date.now()}`;

        await frame.goto(`${WEBMAIL_ORIGIN}/?_task=mail&_action=compose&_to=bob%40mail.test`);
        await waitForRoundcube(frame);
        await frame.locator('#compose-subject').fill(subject);
        await frame.locator('#composebody').fill('Sent through the PoC.');
        await frame.evaluate(() => (window as any).rcmail.command('send', { nocheck: true }));

        await expect.poll(async () => (await bobSubjects()).join(' '), { timeout: 20_000 }).toContain(subject);
        const lines = newLines(before);
        expect(smtpsConnections(lines)).toBeGreaterThan(0);
        expect((await bobSubjects()).join(' ')).toContain('alice@mail.test');
        expect(lines.join('\n')).not.toContain('mb-m1');
    });

    test('a forged sender address is refused', async ({ page }) => {
        const frame = await openWebmail(page, { capabilities: FULL_ACCESS });
        const subject = `PoC forged ${Date.now()}`;

        await frame.goto(`${WEBMAIL_ORIGIN}/?_task=mail&_action=compose&_to=bob%40mail.test`);
        await waitForRoundcube(frame);
        await frame.locator('#compose-subject').fill(subject);
        await frame.locator('#composebody').fill('Should never arrive.');
        await frame.evaluate(() => {
            const select = document.querySelector('select[name="_from"]') as HTMLSelectElement;
            const option = new Option('forged@mail.test', 'forged@mail.test', true, true);
            select.add(option);
            (window as any).rcmail.command('send', { nocheck: true });
        });

        await expect(frame.locator('#messagestack')).toContainText('address of this mailbox', { timeout: 20_000 });
        expect((await bobSubjects()).join(' ')).not.toContain(subject);
    });
});
