import { eventuallyTicket, expect, messageId, ok, openMailbox, POLL_TIMEOUT, raw, selectMessage, signedIn, sql, test, ticketBySubject, unique, webmailPage } from '../lib/stack';
import { deliver, uidOfSubject } from '../lib/imap';

test.describe('sync with the worker', () => {
    test('a brand-new message moved in Roundcube before the next poll still reaches Support', async ({ browser, world }) => {
        const subject = unique('Moved before polling');
        const id = messageId();
        await deliver(world.address.support, { to: world.address.support, subject, text: 'Do not lose me.', messageId: id });
        const before = await uidOfSubject(world.address.support, subject);
        expect(before).toBeTruthy();

        const context = await signedIn(browser, 'member', world);
        const page = await context.newPage();
        const frame = await openMailbox(page, world, world.mailboxId.support);
        await selectMessage(frame, subject);
        expect(await ticketBySubject(world, subject), 'no ticket before the move').toBeNull();

        await frame.evaluate(() => (window as any).rcmail.move_messages('Archive'));
        await expect.poll(() => uidOfSubject(world.address.support, subject, 'Archive'), { timeout: 30_000 }).toBeTruthy();
        expect(await uidOfSubject(world.address.support, subject, 'INBOX')).toBeUndefined();

        // The barrier ingests the message at the move, not at the next pass.
        await expect
            .poll(
                async () => (await sql(`SELECT 1 FROM "Entity" WHERE "projectId"=$1 AND kind='inbound_emails' AND data->>'messageId'=$2`, [world.projectId, `<${id}>`])).length,
                { timeout: 15_000 },
            )
            .toBe(1);
        const ticket = await eventuallyTicket(world, subject);
        expect(ticket.subject).toContain(subject);
        await context.close();
    });

    test('a Finance mailbox keeps processing mail and stays closed to members without finance.settings', async ({ browser, world }) => {
        const subject = unique('Invoice 4711');
        const id = messageId();
        const base = `/api/projects/${world.projectId}`;
        await deliver(world.address.billing, {
            to: world.address.billing,
            subject,
            text: 'Your invoice is attached.',
            messageId: id,
            attachment: { name: 'invoice.pdf', mime: 'application/pdf', bytes: Buffer.from(`%PDF-1.4 ${subject}`) },
        });

        // The member holds a full grant, but no finance.settings.
        const list = await ok('member', 'GET', `${base}/webmail/mailboxes`);
        expect(list.mailboxes.map((m: any) => m.id)).not.toContain(world.mailboxId.billing);
        expect((await raw('member', 'POST', `${base}/webmail/mailboxes/${world.mailboxId.billing}/session`)).status).toBe(404);
        const context = await signedIn(browser, 'member', world);
        const page = await context.newPage();
        await page.goto(webmailPage(world, world.mailboxId.billing));
        await expect(page.getByText('This mailbox is not available to you.')).toBeVisible();
        expect(page.frame({ name: 'orbit-webmail' })).toBeNull();
        await context.close();

        // The owner has finance.settings and can open it.
        const ownerContext = await signedIn(browser, 'owner', world);
        const ownerPage = await ownerContext.newPage();
        const frame = await openMailbox(ownerPage, world, world.mailboxId.billing);
        await selectMessage(frame, subject);
        await ownerContext.close();

        // Finance reads its mail as before, reading it in webmail does not stop that.
        await expect
            .poll(
                async () => (await sql(`SELECT 1 FROM "FinanceDocument" WHERE "projectId"=$1 AND "messageId" IN ($2,$3)`, [world.projectId, id, `<${id}>`])).length,
                { timeout: POLL_TIMEOUT, intervals: [3000] },
            )
            .toBeGreaterThan(0);
    });
});
