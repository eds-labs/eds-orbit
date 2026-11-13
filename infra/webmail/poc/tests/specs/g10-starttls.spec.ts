import { connect } from 'node:net';
import { test, expect, request } from '@playwright/test';
import { control, FULL_ACCESS, issueToken, openWebmail, ORBIT_ORIGIN, resetBridge, waitForRoundcube, WEBMAIL_ORIGIN } from '../lib/poc';
import { Imap } from '../lib/imap.mjs';

const HOST = 'mail-starttls.test';
const CAROL = { login: 'carol@starttls.test', password: process.env.POC_CAROL_PASSWORD };

async function openCarol(): Promise<Imap> {
    const imap = await Imap.connect(143, HOST);
    await imap.startTls(HOST);
    const result = await imap.run(`LOGIN "${CAROL.login}" "${CAROL.password}"`);
    if (!result.ok) throw new Error('IMAP login failed');
    return imap;
}

async function inboxSubjects(): Promise<string> {
    const imap = await openCarol();
    await imap.select('INBOX');
    const result = await imap.run('UID FETCH 1:* (BODY.PEEK[HEADER.FIELDS (SUBJECT)])');
    imap.close();
    return result.lines.join(' ');
}

/** Reads what the server offers before any TLS, on a raw socket. */
function smtpEhloBeforeTls(): Promise<string> {
    return new Promise((resolve, reject) => {
        const socket = connect(587, HOST);
        let data = '';
        socket.setEncoding('utf8');
        socket.on('error', reject);
        socket.on('data', (chunk) => {
            data += chunk;
            if (/^220 /m.test(data) && !data.includes('EHLO-SENT')) {
                data += 'EHLO-SENT';
                socket.write('EHLO probe.test\r\n');
            } else if (/^250 /m.test(data)) {
                socket.end('QUIT\r\n');
                resolve(data);
            }
        });
    });
}

async function sendToSelf(frame: Awaited<ReturnType<typeof openWebmail>>, subject: string) {
    await frame.goto(`${WEBMAIL_ORIGIN}/?_task=mail&_action=compose&_to=${encodeURIComponent(CAROL.login)}`);
    await waitForRoundcube(frame);
    await frame.locator('#compose-subject').fill(subject);
    await frame.locator('#composebody').fill('Sent over STARTTLS.');
    await frame.evaluate(() => (window as any).rcmail.command('send', { nocheck: true }));
}

test.describe('G10 STARTTLS with Dovecot and Postfix', () => {
    test.beforeEach(resetBridge);
    test.afterEach(() => control('/tls-peer', {}));

    test('the servers offer no authentication before TLS', async () => {
        const imap = await Imap.connect(143, HOST);
        const capability = await imap.run('CAPABILITY');
        imap.close();
        expect(capability.lines.join(' ')).toContain('STARTTLS');
        expect(capability.lines.join(' ')).toContain('LOGINDISABLED');

        const ehlo = await smtpEhloBeforeTls();
        expect(ehlo).toContain('STARTTLS');
        expect(ehlo).not.toMatch(/AUTH/);
    });

    test('reading and sending work over STARTTLS', async ({ page }) => {
        const frame = await openWebmail(page, { mailbox: 'm3', capabilities: FULL_ACCESS });
        const subject = `STARTTLS ${Date.now()}`;

        await sendToSelf(frame, subject);
        await expect.poll(inboxSubjects, { timeout: 30_000 }).toContain(subject);

        await frame.goto(`${WEBMAIL_ORIGIN}/?_task=mail&_mbox=INBOX`);
        await waitForRoundcube(frame);
        await expect(frame.locator('#messagelist')).toContainText(subject, { timeout: 30_000 });
    });

    test('a wrong IMAP certificate name stops the login', async () => {
        await control('/tls-peer', { tlsPeerName: 'wrong.test' });
        const api = await request.newContext({ ignoreHTTPSErrors: true, maxRedirects: 0 });

        const response = await api.post(`${WEBMAIL_ORIGIN}/`, {
            form: { _task: 'login', _action: 'login', _orbit_handoff: await issueToken({ mailbox: 'm3' }) },
            headers: { Origin: ORBIT_ORIGIN },
        });

        expect(response.status()).toBe(403);
    });

    test('a wrong SMTP certificate name stops the send', async ({ page }) => {
        const frame = await openWebmail(page, { mailbox: 'm3', capabilities: FULL_ACCESS });
        const subject = `Wrong peer ${Date.now()}`;
        await control('/tls-peer', { smtpTlsPeerName: 'wrong.test' });

        await sendToSelf(frame, subject);

        await expect(frame.locator('#messagestack')).not.toBeEmpty({ timeout: 30_000 });
        await page.waitForTimeout(3000);
        expect(await inboxSubjects()).not.toContain(subject);
    });
});
