import type { Frame, Page } from '@playwright/test';
import { eventuallyTicket, expect, messageId, openMailbox, ORBIT, raw, rcmailReady, selectMessage, signedIn, sql, test, ticketBySubject, ticketDetail, ticketsBySubject, unique, type World } from '../lib/stack';
import { deliver, uidOfSubject, withMailbox } from '../lib/imap';

const convertDialog = (page: Page) => page.getByRole('dialog', { name: 'Turn into a ticket' });

async function startTakeover(page: Page, frame: Frame, subject: string) {
    await selectMessage(frame, subject);
    await expect
        .poll(() => frame.evaluate(() => Boolean((window as any).rcmail.commands['plugin.orbit_bridge.convert'])))
        .toBe(true);
    await frame.locator('a.orbit-convert').first().click();
    await expect(convertDialog(page)).toBeVisible();
}

async function currentUidValidity(address: string, folder: string) {
    return withMailbox(address, async (imap) => (await imap.select(folder)).uidValidity);
}

const convertPath = (world: World) => `/api/projects/${world.projectId}/webmail/mailboxes/${world.mailboxId.sales}/convert`;

test.describe('turning a mail into a ticket', () => {
    test('new ticket with an attachment, in Orbit\'s dialog; the mail stays and a second click adds nothing', async ({ browser, world }) => {
        const subject = unique('Printer is broken');
        const bytes = Buffer.from('error log of ' + subject);
        const id = messageId();
        await deliver(world.address.sales, {
            to: world.address.sales,
            subject,
            text: 'It stopped working.',
            messageId: id,
            attachment: { name: 'error.txt', mime: 'text/plain', bytes },
        });
        const uid = await uidOfSubject(world.address.sales, subject);

        const context = await signedIn(browser, 'member', world);
        const page = await context.newPage();
        const frame = await openMailbox(page, world, world.mailboxId.sales);
        await startTakeover(page, frame, subject);

        // The dialog belongs to the Orbit page, not to the frame.
        expect(await frame.getByRole('dialog', { name: 'Turn into a ticket' }).count()).toBe(0);
        await expect(convertDialog(page).getByText(`Replies leave from: ${world.address.support}`)).toBeVisible();
        await convertDialog(page).getByRole('button', { name: 'Create ticket' }).click();
        await expect(convertDialog(page).getByText(/Ticket #\d+ created\./)).toBeVisible({ timeout: 45_000 });

        const ticket = await ticketBySubject(world, subject);
        expect(ticket, 'ticket exists').toBeTruthy();
        const detail = await ticketDetail(world, ticket.id);
        const first = detail.timeline.find((m: any) => m.kind === 'customer');
        expect(first.bodyText).toContain('It stopped working.');
        expect(first.attachments.map((a: any) => a.name)).toContain('error.txt');

        // The attachment and the original message are kept in Orbit.
        const [attachment] = first.attachments;
        const downloaded = await raw('member', 'GET', `/api/projects/${world.projectId}/files/${attachment.fileId}`);
        expect(downloaded.status).toBe(200);
        expect(downloaded.text).toBe(bytes.toString());
        const originals = await sql(
            `SELECT data FROM "Entity" WHERE "projectId"=$1 AND kind='inbound_emails' AND data->>'messageId'=$2`,
            [world.projectId, `<${id}>`],
        );
        expect(originals.length, 'one stored original').toBe(1);

        // The mail stays in the mailbox.
        await withMailbox(world.address.sales, async (imap) => {
            await imap.select('INBOX');
            expect(await imap.search(`SUBJECT "${subject}"`)).toEqual([uid]);
        });

        // The ticket opens from the dialog, in Orbit.
        await convertDialog(page).getByRole('link', { name: 'Open ticket' }).click();
        await expect(page).toHaveURL(new RegExp(`^${ORBIT}/p/${world.projectId}/.*${ticket.id}`));
        await expect(page.getByText(subject).first()).toBeVisible();

        // A second click finds the first result.
        const again = await openMailbox(page, world, world.mailboxId.sales);
        await startTakeover(page, again, subject);
        await expect(convertDialog(page).getByText('This message was already taken over.')).toBeVisible();
        expect((await ticketsBySubject(world, subject)).length).toBe(1);
        await context.close();
    });

    test('two concurrent takeovers create one ticket', async ({ world }) => {
        const subject = unique('Concurrent takeover');
        await deliver(world.address.sales, { to: world.address.sales, subject, text: 'Twice.', messageId: messageId() });
        const uid = await uidOfSubject(world.address.sales, subject);
        const uidValidity = await currentUidValidity(world.address.sales, 'INBOX');
        const body = {
            folder: 'INBOX',
            uid,
            uidValidity,
            target: 'support.ticket',
            mode: { kind: 'create', destinationId: world.inboxId },
        };

        const answers = await Promise.all([raw('member', 'POST', convertPath(world), body), raw('member', 'POST', convertPath(world), body), raw('owner', 'POST', convertPath(world), body)]);
        for (const answer of answers) expect([200, 202]).toContain(answer.status);

        // Whoever got "pending" asks again until the takeover finished.
        await expect.poll(async () => (await raw('member', 'POST', convertPath(world), body)).status, { timeout: 60_000 }).toBe(200);
        const done = answers.filter((a) => a.status === 200).map((a) => a.json.recordId);
        expect(new Set(done).size).toBeLessThanOrEqual(1);
        expect((await ticketsBySubject(world, subject)).length).toBe(1);
    });

    test('appending to an existing ticket adds the message there', async ({ browser, world }) => {
        const first = unique('Original issue');
        const second = unique('More details');
        await deliver(world.address.sales, { to: world.address.sales, subject: first, text: 'First part.', messageId: messageId() });
        await deliver(world.address.sales, { to: world.address.sales, subject: second, text: 'Second part.', messageId: messageId() });

        const context = await signedIn(browser, 'member', world);
        const page = await context.newPage();
        const frame = await openMailbox(page, world, world.mailboxId.sales);
        await startTakeover(page, frame, first);
        await convertDialog(page).getByRole('button', { name: 'Create ticket' }).click();
        await expect(convertDialog(page).getByText(/Ticket #\d+ created\./)).toBeVisible({ timeout: 45_000 });
        await convertDialog(page).getByRole('button', { name: 'Close', exact: true }).click();
        const ticket = await ticketBySubject(world, first);

        await startTakeover(page, frame, second);
        await convertDialog(page).getByLabel('Add to an existing ticket').check();
        await convertDialog(page).getByLabel('Search by number or subject').fill(first);
        const hit = convertDialog(page).getByRole('radio', { name: new RegExp(first) });
        await expect(hit).toBeVisible();
        await hit.check();
        await convertDialog(page).getByRole('button', { name: 'Add to ticket' }).click();
        await expect(convertDialog(page).getByText(/Ticket #\d+ created\.|already in ticket/)).toBeVisible({ timeout: 45_000 });

        await expect
            .poll(async () => {
                const detail = await ticketDetail(world, ticket.id);
                return detail.timeline.filter((m: any) => m.kind === 'customer').map((m: any) => m.bodyText);
            }, { timeout: 30_000 })
            .toEqual(expect.arrayContaining([expect.stringContaining('First part.'), expect.stringContaining('Second part.')]));
        expect((await ticketsBySubject(world, second)).length).toBe(0);
        await context.close();
    });

    test('a message in another folder can be taken over and stays there', async ({ browser, world }) => {
        const subject = unique('Filed in archive');
        await deliver(world.address.sales, { to: world.address.sales, subject, text: 'From the archive.', messageId: messageId() }, 'Archive');

        const context = await signedIn(browser, 'member', world);
        const page = await context.newPage();
        const frame = await openMailbox(page, world, world.mailboxId.sales);
        await frame.evaluate(() => (window as any).rcmail.list_mailbox('Archive'));
        await rcmailReady(frame);
        await startTakeover(page, frame, subject);
        await convertDialog(page).getByRole('button', { name: 'Create ticket' }).click();
        await expect(convertDialog(page).getByText(/Ticket #\d+ created\./)).toBeVisible({ timeout: 45_000 });

        const ticket = await eventuallyTicket(world, subject, 15_000);
        const detail = await ticketDetail(world, ticket.id);
        expect(JSON.stringify(detail)).toContain('From the archive.');
        expect(await uidOfSubject(world.address.sales, subject, 'Archive')).toBeTruthy();
        expect(await uidOfSubject(world.address.sales, subject, 'INBOX')).toBeUndefined();
        await context.close();
    });
});
