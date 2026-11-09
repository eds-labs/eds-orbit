import { existsSync, readFileSync } from 'node:fs';
import { request } from '@playwright/test';
import { ajaxGet, expect, GRANTS, messageId, ok, openMailbox, ORBIT, selectMessage, setGrant, signedIn, test, TRACKER, unique, WEBMAIL } from '../lib/stack';
import { deliver } from '../lib/imap';

const anonymous = () => request.newContext({ baseURL: WEBMAIL, ignoreHTTPSErrors: true });
// An AJAX refusal is a normal Roundcube JSON answer whose commands end the session.
const refused = (result: { status: number; text: string }) =>
    result.status !== 200 || (result.text.includes('session_error') && !result.text.includes('add_message_row'));

test.describe('security on the real stack', () => {
    test('the webmail host offers no login without a session', async ({ browser, world }) => {
        const context = await browser.newContext({ ignoreHTTPSErrors: true });
        const page = await context.newPage();
        const response = await page.goto(`${WEBMAIL}/`);
        expect(response?.status()).toBe(403);
        await expect(page.getByText(/open this mailbox from Orbit/i)).toBeVisible();
        expect(await page.locator('input[type=password]').count()).toBe(0);
        expect(await page.locator('input[name=_user]').count()).toBe(0);

        const client = await anonymous();
        const posted = await client.post('/', {
            form: { _task: 'login', _action: 'login', _user: world.address.sales, _pass: 'guess' },
            maxRedirects: 0,
        });
        expect(posted.status()).toBeGreaterThanOrEqual(400);
        const direct = await client.get('/?_task=mail&_action=list&_mbox=INBOX', { maxRedirects: 0 });
        expect(await direct.text()).not.toContain(world.address.sales);
        await client.dispose();
        await context.close();
    });

    test('revoking a grant ends the open session at the very next request', async ({ browser, world }) => {
        const context = await signedIn(browser, 'reader', world);
        const page = await context.newPage();
        const frame = await openMailbox(page, world, world.mailboxId.sales);
        expect((await ajaxGet(frame, 'mail', 'list', '&_mbox=INBOX')).status).toBe(200);
        try {
            await setGrant(world, world.mailboxId.sales, 'reader', GRANTS.NONE);
            // The very next request Roundcube itself makes, and what the member sees.
            const answered = page.waitForResponse((r) => r.url().includes('_action=refresh') || r.url().includes('_action=check-recent') || r.url().includes('_action=list'));
            await frame.evaluate(() => (window as any).rcmail.command('checkmail'));
            const next = await answered;
            expect(refused({ status: next.status(), text: await next.text() }), `status ${next.status()}`).toBe(true);
            await expect(page.getByText(/access to .* was withdrawn|session was closed|No mailbox available/i).first()).toBeVisible({ timeout: 45_000 });
            expect(page.frame({ name: 'orbit-webmail' })).toBeNull();
        } finally {
            await setGrant(world, world.mailboxId.sales, 'reader', GRANTS.READ_ONLY);
        }
        await context.close();
    });

    test('signing out of Orbit ends webmail', async ({ browser, world }) => {
        const context = await signedIn(browser, 'member', world, true);
        const webmail = await context.newPage();
        const frame = await openMailbox(webmail, world, world.mailboxId.sales);
        expect((await ajaxGet(frame, 'mail', 'list', '&_mbox=INBOX')).status).toBe(200);

        const orbit = await context.newPage();
        await orbit.goto(`${ORBIT}/p/${world.projectId}`);
        await orbit.getByLabel(/^Account menu/).click();
        await orbit.getByRole('menuitem', { name: 'Sign out' }).click();
        await expect(orbit.getByLabel(/^Email/)).toBeVisible();

        const next = await ajaxGet(frame, 'mail', 'list', '&_mbox=INBOX');
        expect(refused(next), `status ${next.status}`).toBe(true);
        await context.close();
    });

    test('a handoff token works once, from Orbit\'s origin only', async ({ world }) => {
        const opened = await ok('reader', 'POST', `/api/projects/${world.projectId}/webmail/mailboxes/${world.mailboxId.sales}/session`);
        const token: string = opened.fields._orbit_handoff;
        const form = { _task: 'login', _action: 'login', _orbit_handoff: token };

        const foreign = await request.newContext({ baseURL: WEBMAIL, ignoreHTTPSErrors: true, extraHTTPHeaders: { origin: `https://evil.${TRACKER}` } });
        const fromElsewhere = await foreign.post('/', { form, maxRedirects: 0 });
        expect(fromElsewhere.status()).toBeGreaterThanOrEqual(400);
        await foreign.dispose();

        const first = await request.newContext({ baseURL: WEBMAIL, ignoreHTTPSErrors: true, extraHTTPHeaders: { origin: ORBIT } });
        const accepted = await first.post('/', { form, maxRedirects: 0 });
        expect(accepted.status()).toBe(302);
        await first.dispose();

        const second = await request.newContext({ baseURL: WEBMAIL, ignoreHTTPSErrors: true, extraHTTPHeaders: { origin: ORBIT } });
        const replay = await second.post('/', { form, maxRedirects: 0 });
        expect(replay.status()).toBeGreaterThanOrEqual(400);
        expect(replay.headers()['location'] ?? '').not.toContain('_task=mail');
        await second.dispose();
    });

    test('a hostile HTML mail runs nothing and loads nothing', async ({ browser, world }) => {
        const subject = unique('Hostile HTML');
        const marker = subject.split(' ').at(-1);
        const html = [
            '<html><head>',
            `<link rel="stylesheet" href="https://${TRACKER}/style-${marker}.css">`,
            `<style>body { background: url(https://${TRACKER}/bg-${marker}.png); }</style>`,
            '</head><body onload="window.top.__pwned = 1; window.__pwned = 1">',
            `<img src="https://${TRACKER}/pixel-${marker}.png" alt="pixel">`,
            '<img src="x" onerror="window.__pwned = 2">',
            '<script>window.__pwned = 3</script>',
            `<iframe src="https://${TRACKER}/frame-${marker}"></iframe>`,
            '<a id="js-link" href="javascript:window.__pwned = 4">click</a>',
            '<p id="hostile-marker">Hostile body text</p>',
            '</body></html>',
        ].join('');
        await deliver(world.address.sales, { to: world.address.sales, subject, html, messageId: messageId() });

        const context = await signedIn(browser, 'member', world);
        const page = await context.newPage();
        const seen: string[] = [];
        page.on('request', (r) => {
            if (r.url().includes(TRACKER)) seen.push(r.url());
        });
        const frame = await openMailbox(page, world, world.mailboxId.sales);
        await selectMessage(frame, subject);
        const preview = frame.frameLocator('#messagecontframe');
        await expect(preview.locator('body')).toContainText('Hostile body text');

        await page.waitForTimeout(2000);
        expect(await page.evaluate(() => (window as any).__pwned)).toBeUndefined();
        for (const candidate of page.frames()) expect(await candidate.evaluate(() => (window as any).__pwned)).toBeUndefined();
        expect(seen).toEqual([]);
        const log = existsSync('/results/tracker.log') ? readFileSync('/results/tracker.log', 'utf8') : '';
        expect(log).not.toContain(String(marker));
        await context.close();
    });
});
