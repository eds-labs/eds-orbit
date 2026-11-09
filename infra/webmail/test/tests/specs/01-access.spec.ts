import { ownerSettingsRow, expect, frameInRoundcube, messageId, ok, openMailbox, ORBIT, raw, selectMessage, signedIn, test, unique, USERS, webmailPage } from '../lib/stack';
import { deliver } from '../lib/imap';

test.describe('access', () => {
    test('owner opens a mailbox and grants it, the member lands in Roundcube, no grant shows nothing', async ({ browser, world }) => {
        const subject = unique('Welcome to info');
        await deliver(world.address.info, { to: world.address.info, subject, text: 'Hello info.', messageId: messageId() });

        // A rerun starts from a closed mailbox.
        const base = `/api/projects/${world.projectId}/webmail`;
        const opened = (await ok('owner', 'GET', `${base}/settings`)).connections.find((c: any) => c.address === world.address.info).opened;
        if (opened) await ok('owner', 'DELETE', `${base}/settings/mailboxes/${opened.id}`);

        const ownerContext = await signedIn(browser, 'owner', world);
        const ownerPage = await ownerContext.newPage();
        const row = await ownerSettingsRow(ownerPage, world, world.address.info);
        await row.getByRole('button', { name: 'Open for webmail' }).click();
        await row.getByRole('button', { name: 'Manage access' }).click();
        // The checkbox follows the saved state, so it is not checked at once.
        await row.getByRole('group', { name: USERS.owner.name }).getByLabel('Read', { exact: true }).click();
        await expect(row.getByRole('group', { name: USERS.owner.name }).getByLabel('Read', { exact: true })).toBeChecked();

        const mailboxId = (await ok('owner', 'GET', `${base}/settings`)).connections.find((c: any) => c.address === world.address.info).opened.id as string;
        const ownerFrame = await openMailbox(ownerPage, world, mailboxId);
        await selectMessage(ownerFrame, subject);

        // The owner gives the member access through the same settings.
        const settings = await ownerSettingsRow(ownerPage, world, world.address.info);
        await settings.getByRole('button', { name: 'Manage access' }).click();
        const memberRow = settings.getByRole('group', { name: USERS.member.name });
        await memberRow.getByLabel('Read', { exact: true }).click();
        await expect(memberRow.getByLabel('Read', { exact: true })).toBeChecked();

        const memberContext = await signedIn(browser, 'member', world);
        const memberPage = await memberContext.newPage();
        await memberPage.goto(webmailPage(world));
        await memberPage.getByRole('link', { name: new RegExp(world.address.info) }).click();
        const frame = await frameInRoundcube(memberPage);
        await selectMessage(frame, subject);
        await expect(memberPage.locator('iframe[name=orbit-webmail]')).toHaveAttribute('sandbox', /allow-scripts/);

        // Project membership alone gives nothing.
        const outsider = await signedIn(browser, 'outsider', world);
        const outsiderPage = await outsider.newPage();
        await outsiderPage.goto(webmailPage(world));
        await expect(outsiderPage.getByText('No mailbox available to you')).toBeVisible();
        expect(outsiderPage.frame({ name: 'orbit-webmail' })).toBeNull();
        const list = await ok('outsider', 'GET', `${base}/mailboxes`);
        expect(list.mailboxes).toEqual([]);
        expect((await raw('outsider', 'POST', `${base}/mailboxes/${mailboxId}/session`)).status).toBe(404);

        // A deep link to somebody else's mailbox opens nothing either.
        await outsiderPage.goto(webmailPage(world, mailboxId));
        expect(outsiderPage.frame({ name: 'orbit-webmail' })).toBeNull();
        await expect(outsiderPage).toHaveURL(new RegExp(`^${ORBIT}/p/`));

        await ownerContext.close();
        await memberContext.close();
        await outsider.close();
    });

    test('switching between two granted mailboxes shows each one', async ({ browser, world }) => {
        const salesSubject = unique('Only in sales');
        const supportSubject = unique('Only in support');
        await deliver(world.address.sales, { to: world.address.sales, subject: salesSubject, text: 'S.', messageId: messageId() });
        await deliver(world.address.support, { to: world.address.support, subject: supportSubject, text: 'T.', messageId: messageId() });

        const context = await signedIn(browser, 'member', world);
        const page = await context.newPage();
        const frame = await openMailbox(page, world, world.mailboxId.sales);
        await selectMessage(frame, salesSubject);
        expect(await frame.locator('#messagelist tr', { hasText: supportSubject }).count()).toBe(0);

        await page.getByRole('link', { name: new RegExp(world.address.support) }).click();
        await expect(page.getByRole('navigation', { name: 'Mailboxes' }).locator('a[aria-current=page]')).toContainText(world.address.support);
        await expect
            .poll(async () => {
                const current = page.frame({ name: 'orbit-webmail' });
                if (!current) return 0;
                return current.locator('#messagelist tr', { hasText: supportSubject }).count().catch(() => 0);
            }, { timeout: 45_000 })
            .toBeGreaterThan(0);
        const second = await frameInRoundcube(page);
        expect(await second.locator('#messagelist tr', { hasText: salesSubject }).count()).toBe(0);

        await page.getByRole('link', { name: new RegExp(world.address.sales) }).click();
        await expect
            .poll(async () => {
                const current = page.frame({ name: 'orbit-webmail' });
                if (!current) return 0;
                return current.locator('#messagelist tr', { hasText: salesSubject }).count().catch(() => 0);
            }, { timeout: 45_000 })
            .toBeGreaterThan(0);
        await context.close();
    });
});
