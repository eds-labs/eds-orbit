import { expect, test as base } from '@playwright/test';
import { messageId, ok, ORBIT, POLL_TIMEOUT, raw, sql, unique } from '../lib/stack';
import { deliver } from '../lib/imap';

// Runs after run.sh set ORBIT_WEBMAIL=false and ORBIT_WEBMAIL_REPLICAS=0.
const test = base;

async function project() {
    const { items } = await ok('owner', 'GET', '/api/projects');
    const found = items.find((p: any) => p.name === 'Acme chromium');
    if (!found) throw new Error('the chromium run provisions this project first');
    return found.id as string;
}

test('webmail routes answer 404 and the mail of Support and Finance is still processed', async () => {
    const projectId = await project();
    const base = `/api/projects/${projectId}`;
    for (const [method, path] of [
        ['GET', `${base}/webmail/mailboxes`],
        ['GET', `${base}/webmail/settings`],
        ['POST', `${base}/webmail/mailboxes/00000000-0000-4000-8000-000000000000/session`],
    ] as const)
        expect((await raw('owner', method, path)).status, path).toBe(404);
    expect((await ok('owner', 'GET', '/api/admin/webmail/status')).bridge).toBe('off');

    const supportAddress = 'support-chromium@acme.example.net';
    const billingAddress = 'billing-chromium@acme.example.net';
    const supportSubject = unique('After the switch off');
    const invoiceSubject = unique('Invoice after the switch off');
    const invoiceId = messageId();
    await deliver(supportAddress, { to: supportAddress, subject: supportSubject, text: 'Still here.', messageId: messageId() });
    await deliver(billingAddress, {
        to: billingAddress,
        subject: invoiceSubject,
        text: 'Invoice.',
        messageId: invoiceId,
        attachment: { name: 'invoice.pdf', mime: 'application/pdf', bytes: Buffer.from(`%PDF-1.4 ${invoiceSubject}`) },
    });

    await expect
        .poll(
            async () => {
                const answer = await ok('owner', 'GET', `${base}/support/tickets?limit=50&q=${encodeURIComponent(supportSubject)}`);
                return (answer.items as any[]).some((t) => String(t.subject).includes(supportSubject));
            },
            { timeout: POLL_TIMEOUT, intervals: [3000] },
        )
        .toBe(true);
    await expect
        .poll(
            async () => (await sql(`SELECT 1 FROM "FinanceDocument" WHERE "projectId"=$1 AND "messageId" IN ($2,$3)`, [projectId, invoiceId, `<${invoiceId}>`])).length,
            { timeout: POLL_TIMEOUT, intervals: [3000] },
        )
        .toBeGreaterThan(0);
});

test('the Orbit page does not offer the module', async ({ page }) => {
    const projectId = await project();
    const { USERS, browserLogin } = await import('../lib/stack');
    await browserLogin(page, 'owner');
    await page.goto(`${ORBIT}/p/${projectId}`);
    await expect(page.getByRole('navigation').getByRole('link', { name: 'Mailboxes' })).toHaveCount(0);
    await page.goto(`${ORBIT}/p/${projectId}/webmail`);
    expect(page.frame({ name: 'orbit-webmail' })).toBeNull();
    expect(USERS.owner.email).toBeTruthy();
});
