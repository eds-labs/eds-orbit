import { readFileSync } from 'node:fs';
import { ajaxGet, ajaxPost, CUSTOMER, expect, messageId, openMailbox, rcmailReady, selectMessage, signedIn, test, unique, WEBMAIL } from '../lib/stack';
import { customerMessages, deliver, uidOfSubject, withMailbox } from '../lib/imap';

const previewOf = (frame: Parameters<typeof rcmailReady>[0]) => frame.frameLocator('#messagecontframe').locator('body');

test.describe('working in a mailbox', () => {
    test('read, reply and compose reach the mail server', async ({ browser, world }) => {
        const subject = unique('Question about the invoice');
        const original = messageId();
        await deliver(world.address.sales, { to: world.address.sales, subject, text: 'Can you help me?', messageId: original });

        const context = await signedIn(browser, 'member', world);
        const page = await context.newPage();
        const frame = await openMailbox(page, world, world.mailboxId.sales);
        await selectMessage(frame, subject);
        await expect(previewOf(frame)).toContainText('Can you help me?');

        await frame.evaluate(() => (window as any).rcmail.command('reply', ''));
        await expect.poll(() => frame.url()).toContain('_action=compose');
        await rcmailReady(frame);
        await frame.locator('#composebody').fill('Happy to help.');
        await frame.evaluate(() => (window as any).rcmail.command('send', ''));

        await expect.poll(async () => (await customerMessages(CUSTOMER, subject)).length, { timeout: 30_000 }).toBe(1);
        const [reply] = await customerMessages(CUSTOMER, subject);
        expect(reply).toMatch(new RegExp(`^From:.*${world.address.sales}`, 'mi'));
        expect(reply).toContain(`In-Reply-To: <${original}>`);
        expect(reply).toContain('Happy to help.');

        await expect.poll(() => frame.url(), { timeout: 20_000 }).not.toContain('_action=compose');
        await rcmailReady(frame);
        const composed = unique('A new message');
        await frame.evaluate(() => (window as any).rcmail.command('compose', ''));
        await expect.poll(() => frame.url()).toContain('_action=compose');
        await rcmailReady(frame);
        await frame.locator('textarea[name=_to]').evaluate((el: HTMLTextAreaElement, to) => { el.value = to; }, CUSTOMER);
        await frame.locator('input[name=_subject]').fill(composed);
        await frame.locator('#composebody').fill('Written from scratch.');
        await frame.evaluate(() => (window as any).rcmail.command('send', ''));

        await expect.poll(async () => (await customerMessages(CUSTOMER, composed)).length, { timeout: 30_000 }).toBe(1);
        const [mail] = await customerMessages(CUSTOMER, composed);
        expect(mail).toMatch(new RegExp(`^From:.*${world.address.sales}`, 'mi'));
        // A sent copy where a mail client would put it.
        await expect.poll(() => uidOfSubject(world.address.sales, composed, 'Sent'), { timeout: 15_000 }).toBeTruthy();
        await context.close();
    });

    test('an attachment opens and downloads intact', async ({ browser, world }) => {
        const subject = unique('Contract attached');
        const bytes = Buffer.from('%PDF-1.4 e2e attachment ' + subject + '\n');
        await deliver(world.address.sales, {
            to: world.address.sales,
            subject,
            text: 'See attachment.',
            messageId: messageId(),
            attachment: { name: 'contract.pdf', mime: 'application/pdf', bytes },
        });
        const uid = await uidOfSubject(world.address.sales, subject);

        const context = await signedIn(browser, 'member', world);
        const page = await context.newPage();
        const frame = await openMailbox(page, world, world.mailboxId.sales);
        await frame.goto(`${WEBMAIL}/?_task=mail&_mbox=INBOX&_uid=${uid}&_action=show`);
        await rcmailReady(frame);
        await expect(frame.locator('#attachment-list')).toContainText('contract.pdf');

        const opened = await ajaxGet(frame, 'mail', 'get', `&_mbox=INBOX&_uid=${uid}&_part=2`);
        expect(opened.status).toBe(200);

        // A sandboxed frame may start a download only from a real click.
        await frame.evaluate((id) => {
            const client = (window as any).rcmail;
            const link = document.createElement('a');
            link.id = 'e2e-download';
            link.textContent = 'download';
            link.style.cssText = 'position:fixed;top:0;left:0;z-index:99999;background:#fff';
            link.href = client.url('get', { _mbox: 'INBOX', _uid: id, _part: '2', _download: 1, _token: client.env.request_token });
            document.body.appendChild(link);
        }, uid);
        const downloading = page.waitForEvent('download', { timeout: 30_000 });
        await frame.locator('#e2e-download').click();
        const download = await downloading;
        expect(download.suggestedFilename()).toBe('contract.pdf');
        expect(readFileSync(await download.path()).equals(bytes)).toBe(true);
        await context.close();
    });

    test('a read-only grant cannot send, move or delete, verified on the server', async ({ browser, world }) => {
        const subject = unique('Read only target');
        await deliver(world.address.sales, { to: world.address.sales, subject, text: 'Leave me alone.', messageId: messageId() });
        const uid = String(await uidOfSubject(world.address.sales, subject));

        const context = await signedIn(browser, 'reader', world);
        const page = await context.newPage();
        const frame = await openMailbox(page, world, world.mailboxId.sales);
        await selectMessage(frame, subject);
        await expect(previewOf(frame)).toContainText('Leave me alone.');

        const box = { _mbox: 'INBOX' };
        const forbidden = unique('Never sent');
        const attempts: Array<[string, Record<string, string>]> = [
            ['send', { _to: CUSTOMER, _subject: forbidden, _message: 'x' }],
            ['move', { ...box, _uid: uid, _target_mbox: 'Archive' }],
            ['delete', { ...box, _uid: uid }],
            ['copy', { ...box, _uid: uid, _target_mbox: 'Archive' }],
            ['mark', { ...box, _uid: uid, _flag: 'delete' }],
            ['folder-expunge', box],
            ['folder-purge', box],
        ];
        for (const [action, fields] of attempts) {
            const result = await ajaxPost(frame, 'mail', action, fields);
            expect(result.status, action).toBe(403);
        }
        expect((await ajaxGet(frame, 'mail', 'compose')).status).toBe(403);

        // What counts is the mail server, not the answer.
        expect(await customerMessages(CUSTOMER, forbidden)).toEqual([]);
        await withMailbox(world.address.sales, async (imap) => {
            await imap.select('INBOX');
            expect(await imap.search(`SUBJECT "${subject}"`)).toEqual([Number(uid)]);
            expect(await imap.flags(Number(uid))).not.toMatch(/Deleted|Seen/);
            await imap.select('Archive');
            expect(await imap.search(`SUBJECT "${subject}"`)).toEqual([]);
        });
        // The controls are gone as well, every copy of them: Elastic renders some twice,
        // and its desktop layout adds a delete button to the message list header.
        for (const selector of ['a.reply', 'a.delete', 'a.move', 'a.orbit-convert']) {
            const controls = frame.locator(selector);
            for (let i = 0; i < (await controls.count()); i++) {
                const control = controls.nth(i);
                const usable = (await control.isVisible()) && (await control.evaluate((el) => !el.classList.contains('disabled')));
                expect(usable, `${selector}[${i}]`).toBe(false);
            }
        }
        await context.close();
    });
});
