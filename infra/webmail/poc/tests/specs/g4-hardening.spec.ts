import { test, expect, request } from '@playwright/test';
import { APEX, collectCspViolations, cspViolations, openWebmail, ORBIT_ORIGIN, resetBridge, trackPageErrors, waitForMailList, waitForRoundcube, WEBMAIL_ORIGIN } from '../lib/poc';
import { appendAttachment, seedAlice, uidOf } from '../lib/seed.mjs';

const EXPECTED_CSP = `default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'self' https://${APEX}`;

test.describe('G4 hardening', () => {
    test.beforeEach(async () => {
        await seedAlice();
        await resetBridge();
    });

    test('session cookies use the __Host- prefix and strict attributes', async ({ page, context }) => {
        await openWebmail(page);
        const cookies = await context.cookies(WEBMAIL_ORIGIN);
        const webmailCookies = cookies.filter((cookie) => cookie.domain.includes(`webmail.${APEX}`));

        expect(webmailCookies.map((cookie) => cookie.name).sort()).toEqual([
            '__Host-orbit_webmail_auth',
            '__Host-orbit_webmail_sid',
        ]);
        for (const cookie of webmailCookies) {
            expect(cookie.secure, cookie.name).toBe(true);
            expect(cookie.httpOnly, cookie.name).toBe(true);
            expect(cookie.path, cookie.name).toBe('/');
            expect(cookie.domain, cookie.name).toBe(`webmail.${APEX}`);
            expect(cookie.sameSite, cookie.name).toBe('Strict');
        }
    });

    test('the documented CSP is sent on pages and static assets', async () => {
        const api = await request.newContext({ ignoreHTTPSErrors: true, maxRedirects: 0 });

        for (const path of ['/', '/static.php/skins/elastic/images/favicon.ico', '/static.php/plugins/orbit_bridge/orbit_bridge.js']) {
            const response = await api.get(`${WEBMAIL_ORIGIN}${path}`);
            expect(response.headers()['content-security-policy'], path).toBe(EXPECTED_CSP);
            expect(response.headers()['x-frame-options'], path).toBeUndefined();
        }
    });

    test('list, message, HTML mail, compose and upload run without CSP violations', async ({ page }) => {
        const pageErrors = trackPageErrors(page);
        await collectCspViolations(page);
        const frame = await openWebmail(page);
        await waitForMailList(frame);
        expect(await cspViolations(frame)).toEqual([]);

        await frame.goto(`${WEBMAIL_ORIGIN}/?_task=mail&_mbox=INBOX&_uid=${await uidOf('Plain welcome')}&_action=show`);
        await waitForRoundcube(frame);
        expect(await cspViolations(frame)).toEqual([]);

        await frame.goto(`${WEBMAIL_ORIGIN}/?_task=mail&_mbox=INBOX&_uid=${await uidOf('Hostile HTML')}&_action=show`);
        await waitForRoundcube(frame);
        await expect(frame.locator('#hostile-marker, #message-htmlpart1 p').first()).toContainText('Hostile body text');
        expect(await cspViolations(frame)).toEqual([]);

        await frame.goto(`${WEBMAIL_ORIGIN}/?_task=mail&_action=compose`);
        await waitForRoundcube(frame);
        await expect(frame.locator('#compose-subject')).toBeVisible();
        await frame.locator('input[type=file]').first().setInputFiles({
            name: 'upload.txt',
            mimeType: 'text/plain',
            buffer: Buffer.from('uploaded in the PoC\n'),
        });
        await expect(frame.locator('#attachment-list')).toContainText('upload.txt');
        expect(await cspViolations(frame)).toEqual([]);
        expect(pageErrors).toEqual([]);
    });

    test('hostile HTML loads no remote resource and runs no script', async ({ page }) => {
        const remoteRequests: string[] = [];
        page.on('request', (entry) => {
            if (entry.url().includes(`tracker.${APEX}`)) remoteRequests.push(entry.url());
        });

        const frame = await openWebmail(page);
        await frame.goto(`${WEBMAIL_ORIGIN}/?_task=mail&_mbox=INBOX&_uid=${await uidOf('Hostile HTML')}&_action=show`);
        await waitForRoundcube(frame);

        expect(remoteRequests).toEqual([]);
        expect(await frame.evaluate(() => (window as any).__pwned)).toBeUndefined();
    });

    test('forcing _safe=1 is still stopped by the CSP', async ({ page }) => {
        const remoteResponses: string[] = [];
        page.on('response', (entry) => {
            if (entry.url().includes(`tracker.${APEX}`)) remoteResponses.push(entry.url());
        });

        const frame = await openWebmail(page);
        await frame.goto(`${WEBMAIL_ORIGIN}/?_task=mail&_mbox=INBOX&_uid=${await uidOf('Hostile HTML')}&_action=show&_safe=1`);
        await waitForRoundcube(frame);
        await page.waitForTimeout(1000);

        // A request blocked by CSP never produces a response. checks.sh also counts proxy hits.
        expect(remoteResponses).toEqual([]);
        expect(await frame.evaluate(() => (window as any).__pwned)).toBeUndefined();
    });

    test('the docroot exposes no configuration, source, SQL, logs, temp or installer', async () => {
        const api = await request.newContext({ ignoreHTTPSErrors: true, maxRedirects: 0 });

        for (const path of [
            '/config/config.inc.php',
            '/config/config.docker.inc.php',
            '/config/defaults.inc.php',
            '/SQL/postgres.initial.sql',
            '/logs/errors.log',
            '/temp/',
            '/installer.php',
            '/installer/',
            '/.htaccess',
            '/composer.json',
            '/vendor/autoload.php',
            '/bin/initdb.sh',
            '/program/include/iniset.php',
            '/plugins/orbit_bridge/orbit_bridge.php',
            '/plugins/orbit_bridge/actions.inc.php',
            '/static.php/config/config.inc.php',
            '/static.php/../config/config.inc.php',
            '/static.php/plugins/orbit_bridge/orbit_bridge.php',
            '/static.php/plugins/orbit_bridge/actions.inc.php',
            '/static.php/skins/orbit/templates/login.html',
        ]) {
            const response = await api.get(`${WEBMAIL_ORIGIN}${path}`);
            expect([403, 404], path).toContain(response.status());
            const body = await response.text();
            expect(body, path).not.toContain('des_key');
            expect(body, path).not.toContain('orbit_bridge_secret');
            expect(body, path).not.toContain('<?php');
        }
    });

    test.describe('raw mail content', () => {
        const SANDBOX = 'sandbox allow-same-origin allow-downloads allow-popups';
        const PIXEL = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

        function partUrl(uid: number, query: string) {
            return `${WEBMAIL_ORIGIN}/?_task=mail&_action=get&_mbox=INBOX&_uid=${uid}&_part=2&${query}`;
        }

        // Playwright cannot evaluate inside a document without script, so these tests
        // read responses and never query the sandboxed frame itself.
        test('a text attachment displays in its frame under the sandbox', async ({ page }) => {
            const frame = await openWebmail(page);
            const uid = await uidOf('With attachment');
            const embedded = page.waitForResponse((entry) => entry.url().includes('_embed=1'));

            const outer = await frame.goto(partUrl(uid, '_frame=1'));
            await frame.waitForFunction(() => (window as any).rcmail?.env?.task === 'mail');

            expect(outer?.headers()['content-security-policy']).not.toContain('sandbox');
            const inner = await embedded;
            expect(inner.status()).toBe(200);
            expect(inner.headers()['content-security-policy']).toContain(SANDBOX);
            expect(inner.headers()['content-security-policy']).toContain("default-src 'self'");
            expect(await inner.text()).toContain('attachment payload');
        });

        test('an image attachment loads through the preload page under the sandbox', async ({ page, browserName }) => {
            await appendAttachment('Image attachment', 'pixel.png', 'image/png', PIXEL);
            const frame = await openWebmail(page);
            const uid = await uidOf('Image attachment');
            const embedded = page.waitForResponse((entry) => entry.url().includes('_embed=1') && entry.url().includes('_mimewarning=1'));

            await frame.goto(partUrl(uid, '_frame=1'));

            const inner = await embedded;
            expect(inner.status()).toBe(200);
            expect(inner.headers()['content-type']).toContain('image/png');
            expect(inner.headers()['content-security-policy']).toContain(SANDBOX);
            await page.waitForTimeout(500);
            await page.screenshot({ path: `/results/screens/${browserName}-attachment-image.png` });
        });

        test('script in an SVG attachment does not run', async ({ page }) => {
            const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>parent.postMessage({type:"pwned"},"*")</script></svg>';
            await appendAttachment('Scripted SVG', 'evil.svg', 'image/svg+xml', Buffer.from(svg).toString('base64'));
            const frame = await openWebmail(page);

            const response = await frame.goto(partUrl(await uidOf('Scripted SVG'), '_embed=1&_mimewarning=1'));

            expect(response?.headers()['content-security-policy']).toContain(SANDBOX);
            await page.waitForTimeout(1000);
            expect(await page.evaluate(() => (window as any).ignored.map((entry: any) => entry.type))).not.toContain('pwned');
        });

        test('the message source is sandboxed', async ({ page }) => {
            const frame = await openWebmail(page);

            const response = await frame.goto(`${WEBMAIL_ORIGIN}/?_task=mail&_action=viewsource&_mbox=INBOX&_uid=${await uidOf('Plain welcome')}`);

            expect(response?.status()).toBe(200);
            expect(response?.headers()['content-security-policy']).toContain(SANDBOX);
            expect(await response!.text()).toContain('Plain welcome');
        });
    });

    test('settings that alter identities and folders are refused', async ({ page }) => {
        const frame = await openWebmail(page);
        const responses = await frame.evaluate(async () => {
            const client = (window as any).rcmail;
            const results: Record<string, number> = {};

            for (const path of ['_task=settings', '_task=settings&_action=identities', '_task=settings&_action=folders', '_task=addressbook']) {
                const response = await fetch(`./?${path}&_remote=1`, {
                    headers: { 'X-Roundcube-Request': client.env.request_token },
                });
                results[path] = response.status;
            }

            return results;
        });

        for (const [path, status] of Object.entries(responses)) expect(status, path).toBe(403);
    });
});

test('parent stays non-frameable', async () => {
    const api = await request.newContext({ ignoreHTTPSErrors: true });
    const response = await api.get(`${ORBIT_ORIGIN}/index.html`);

    expect(response.headers()['x-frame-options']).toBe('DENY');
});
