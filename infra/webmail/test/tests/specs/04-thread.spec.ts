import { CUSTOMER, expect, messageId, ok, POLL_TIMEOUT, sql, test, ticketDetail, ticketsBySubject, unique } from '../lib/stack';
import { customerMessages, deliver, uidOfSubject, withMailbox } from '../lib/imap';

test.describe('a taken-over ticket in Support', () => {
    test('no automatic mail or AI job; the reply threads and the customer\'s answer lands in the ticket', async ({ world }) => {
        const subject = unique('Delivery never arrived');
        const original = messageId();
        await deliver(world.address.sales, { to: world.address.sales, subject, text: 'Where is my parcel?', messageId: original });
        const uid = await uidOfSubject(world.address.sales, subject);
        const uidValidity = await withMailbox(world.address.sales, async (imap) => (await imap.select('INBOX')).uidValidity);

        const path = `/api/projects/${world.projectId}/webmail/mailboxes/${world.mailboxId.sales}/convert`;
        const answer = await ok('member', 'POST', path, {
            folder: 'INBOX',
            uid,
            uidValidity,
            target: 'support.ticket',
            mode: { kind: 'create', destinationId: world.inboxId },
        });
        expect(answer.status).toBe('done');
        const ticketId: string = answer.recordId;

        // Nothing left the building and no AI work was queued, though the inbox is in
        // "draft" AI mode. The dispatcher runs often, so waiting covers a pass of it.
        await new Promise((resolve) => setTimeout(resolve, 15_000));
        expect(await customerMessages(CUSTOMER, subject)).toEqual([]);
        const queued = await sql<{ topic: string }>(`SELECT topic FROM "Outbox" WHERE "projectId"=$1 AND ("entityId"=$2 OR payload::text LIKE $3)`, [world.projectId, ticketId, `%${ticketId}%`]);
        expect(queued.map((row) => row.topic).filter((topic) => ['support_triage', 'support_draft', 'domain_event', 'email_send'].includes(topic))).toEqual([]);
        const detail = await ticketDetail(world, ticketId);
        expect(detail.ticket.importSource).toBe('mailbox_import');
        expect(detail.aiCostMicros ?? 0).toBe(0);

        // A human reply goes out from the support inbox's own address.
        await ok('member', 'POST', `/api/projects/${world.projectId}/support/tickets/${ticketId}/replies`, { bodyText: 'It is on its way.' });
        await expect.poll(async () => (await customerMessages(CUSTOMER, subject)).length, { timeout: 90_000 }).toBe(1);
        const [sent] = await customerMessages(CUSTOMER, subject);
        expect(sent).toMatch(new RegExp(`^From:.*${world.address.support}`, 'mi'));
        expect(sent).toContain(`In-Reply-To: <${original}>`);
        expect(sent).toMatch(new RegExp(`^References:.*<${original}>`, 'mi'));
        expect(sent).toContain('It is on its way.');
        const replyId = /^Message-ID:\s*<([^>]+)>/mi.exec(sent)?.[1];
        expect(replyId).toBeTruthy();

        // The customer answers that mail: it arrives at the support mailbox and joins the ticket.
        await deliver(world.address.support, {
            from: `Casey Customer <${CUSTOMER}>`,
            to: world.address.support,
            subject: `Re: ${subject}`,
            text: 'Thank you, got it.',
            messageId: messageId(),
            headers: { 'In-Reply-To': `<${replyId}>`, References: `<${original}> <${replyId}>` },
        });
        await expect
            .poll(
                async () => {
                    const current = await ticketDetail(world, ticketId);
                    return current.timeline.filter((m: any) => m.kind === 'customer').map((m: any) => m.bodyText).join('|');
                },
                { timeout: POLL_TIMEOUT, intervals: [3000] },
            )
            .toContain('Thank you, got it.');
        expect((await ticketsBySubject(world, subject)).length).toBe(1);
    });
});
