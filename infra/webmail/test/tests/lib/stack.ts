import { randomBytes } from 'node:crypto';
import { test as base, expect, request, type APIRequestContext, type Browser, type BrowserContext, type Frame, type Page } from '@playwright/test';
import pg from 'pg';
import { ensureFolders, MAIL_HOST, MAIL_PASSWORD } from './imap';

export const APEX = process.env.E2E_APEX!;
export const ORBIT = `https://${APEX}`;
export const WEBMAIL = `https://webmail.${APEX}`;
export const TRACKER = `tracker.${APEX}`;
export const CUSTOMER = 'casey@customer.example.org';
export const FRAME = 'orbit-webmail';

export type UserKey = 'owner' | 'member' | 'reader' | 'outsider';
const ownerPassword = process.env.E2E_OWNER_PASSWORD!;
const memberPassword = process.env.E2E_MEMBER_PASSWORD!;
export const USERS: Record<UserKey, { name: string; email: string; password: string }> = {
    owner: { name: 'Olive Owner', email: 'owner@acme.example.net', password: ownerPassword },
    member: { name: 'Mina Member', email: 'mina@acme.example.net', password: memberPassword },
    reader: { name: 'Rudi Reader', email: 'rudi@acme.example.net', password: memberPassword },
    outsider: { name: 'Otto Outsider', email: 'otto@acme.example.net', password: memberPassword },
};

export const unique = (label: string) => `${label} ${randomBytes(4).toString('hex')}`;
export const messageId = () => `${randomBytes(8).toString('hex')}@customer.example.org`;

// ---------------------------------------------------------------- API, as a real client.

export type Answer = { status: number; json: any; text: string };
const clients = new Map<UserKey, APIRequestContext>();

async function signIn(context: APIRequestContext, user: UserKey) {
    for (let attempt = 0; ; attempt++) {
        const response = await context.post('/api/auth/sign-in/email', {
            data: { email: USERS[user].email, password: USERS[user].password },
        });
        if (response.status() === 429 && attempt < 12) {
            await new Promise((resolve) => setTimeout(resolve, 11_000));
            continue;
        }
        if (!response.ok()) throw new Error(`sign-in of ${user}: ${response.status()}`);
        return;
    }
}

export async function client(user: UserKey): Promise<APIRequestContext> {
    const known = clients.get(user);
    if (known) return known;
    const context = await request.newContext({
        baseURL: ORBIT,
        ignoreHTTPSErrors: true,
        extraHTTPHeaders: { origin: ORBIT },
    });
    await signIn(context, user);
    clients.set(user, context);
    return context;
}

export async function raw(user: UserKey, method: string, path: string, body?: unknown): Promise<Answer> {
    const context = await client(user);
    const response = await context.fetch(path, { method, ...(body === undefined ? {} : { data: body }) });
    const text = await response.text();
    let json: any = null;
    try {
        json = JSON.parse(text);
    } catch {
        // Not every answer is JSON.
    }
    return { status: response.status(), json, text };
}

export async function ok(user: UserKey, method: string, path: string, body?: unknown): Promise<any> {
    const answer = await raw(user, method, path, body);
    if (answer.status >= 300) throw new Error(`${method} ${path}: ${answer.status} ${answer.text.slice(0, 300)}`);
    return answer.json;
}

// ---------------------------------------------------------------- The database, for facts no API shows.

let pool: pg.Pool | null = null;
export async function sql<T = any>(text: string, values: unknown[] = []): Promise<T[]> {
    pool ??= new pg.Pool({ connectionString: process.env.E2E_DB_URL, max: 2 });
    return (await pool.query(text, values)).rows as T[];
}

// ---------------------------------------------------------------- The world each browser works in.

export type MailboxKey = 'info' | 'sales' | 'support' | 'billing';
export type World = {
    browser: string;
    projectId: string;
    workspaceId: string;
    inboxId: string;
    connections: Record<MailboxKey, string>;
    address: Record<MailboxKey, string>;
    mailboxId: Record<'sales' | 'support' | 'billing', string>;
};

const FULL = { canRead: true, canSend: true, canOrganize: true, canConvert: true, canManage: false };
const READ_ONLY = { canRead: true, canSend: false, canOrganize: false, canConvert: false, canManage: false };
const NONE = { canRead: false, canSend: false, canOrganize: false, canConvert: false, canManage: false };
export const GRANTS = { FULL, READ_ONLY, NONE };

async function ensureInstallation() {
    const anonymous = await request.newContext({ baseURL: ORBIT, ignoreHTTPSErrors: true, extraHTTPHeaders: { origin: ORBIT } });
    const answer = await anonymous.post('/api/setup', {
        data: {
            name: USERS.owner.name,
            email: USERS.owner.email,
            password: USERS.owner.password,
            workspaceName: 'Acme',
            setupToken: process.env.E2E_SETUP_TOKEN,
        },
    });
    if (![201, 409].includes(answer.status())) throw new Error(`setup: ${answer.status()}`);
    await anonymous.dispose();
}

async function addMember(user: UserKey, workspaceId: string, projectId: string, role: 'editor' | 'viewer') {
    const answer = await ok('owner', 'POST', `/api/organizations/${workspaceId}/invitations`, {
        email: USERS[user].email,
        role: 'member',
        projects: [{ projectId, role }],
    });
    if (!answer.link) return;
    const token = String(answer.link).split('#')[1];
    const anonymous = await request.newContext({ baseURL: ORBIT, ignoreHTTPSErrors: true, extraHTTPHeaders: { origin: ORBIT } });
    const accepted = await anonymous.post('/api/invitations/accept', {
        data: { token, name: USERS[user].name, password: USERS[user].password },
    });
    if (!accepted.ok()) throw new Error(`accept for ${user}: ${accepted.status()}`);
    await anonymous.dispose();
}

async function provision(browser: string): Promise<World> {
    await ensureInstallation();
    const name = `Acme ${browser}`;
    const { items } = await ok('owner', 'GET', '/api/projects').then((x) => ({ items: x.projects ?? x.items ?? x }));
    let project = items.find((p: any) => p.name === name);
    const created = !project;
    if (created)
        project = await ok('owner', 'POST', '/api/projects', { name, timezone: 'Europe/Berlin', language: 'en' });
    const projectId: string = project.id;
    const workspaceId: string = project.workspaceId;
    const base = `/api/projects/${projectId}`;
    const address = {
        info: `info-${browser}@acme.example.net`,
        sales: `sales-${browser}@acme.example.net`,
        support: `support-${browser}@acme.example.net`,
        billing: `billing-${browser}@acme.example.net`,
    } as Record<MailboxKey, string>;

    if (created) {
        await addMember('member', workspaceId, projectId, 'editor');
        await addMember('reader', workspaceId, projectId, 'editor');
        await addMember('outsider', workspaceId, projectId, 'editor');
        for (const moduleId of ['support', 'finance', 'webmail'])
            await ok('owner', 'PUT', `${base}/modules/${moduleId}`, { enabled: true });
        for (const key of Object.keys(address) as MailboxKey[]) {
            await ensureFolders(address[key], ['Trash', 'Archive', 'Sent', 'Drafts']);
            const connection = await ok('owner', 'POST', `${base}/actions/email-connect`, {
                smtpHost: MAIL_HOST,
                smtpPort: 3465,
                smtpTls: 'implicit',
                imapHost: MAIL_HOST,
                imapPort: 3993,
                imapTls: 'implicit',
                username: address[key],
                fromAddress: address[key],
                fromName: `Acme ${key}`,
                password: MAIL_PASSWORD,
            });
            const checked = await ok('owner', 'POST', `${base}/actions/connector-health`, { connectorId: connection.id });
            expect(checked.data?.status ?? checked.status).toBe('read_verified');
        }
    }

    const { connections: settings } = await ok('owner', 'GET', `${base}/webmail/settings`);
    const connections = Object.fromEntries(
        (Object.keys(address) as MailboxKey[]).map((key) => [
            key,
            settings.find((c: any) => c.address === address[key]).connectionId,
        ]),
    ) as Record<MailboxKey, string>;

    if (created) {
        await ok('owner', 'POST', `${base}/support/inboxes`, {
            name: 'Support',
            channels: ['email'],
            emailAddress: address.support,
            emailConnectionId: connections.support,
            // A normal inbound message would queue AI work here; a takeover must not.
            aiMode: 'draft',
        });
        await ok('owner', 'POST', `${base}/finance/setup`, {});
        await ok('owner', 'POST', `${base}/finance/mailboxes`, { emailConnectionId: connections.billing });
    }
    const { items: inboxes } = await ok('owner', 'GET', `${base}/support/inboxes`);

    const after = (await ok('owner', 'GET', `${base}/webmail/settings`)).connections;
    const mailboxId = {} as World['mailboxId'];
    const owner = (await ok('owner', 'GET', '/api/me')).user.id as string;
    const people = (await ok('owner', 'GET', `${base}/members`)).items as any[];
    const idOf = (user: UserKey) => people.find((p) => p.user.email === USERS[user].email).user.id as string;
    for (const key of ['sales', 'support', 'billing'] as const) {
        const row = after.find((c: any) => c.connectionId === connections[key]);
        const id: string = row.opened?.id ?? (await ok('owner', 'POST', `${base}/webmail/settings/mailboxes`, { connectionId: connections[key] })).id;
        mailboxId[key] = id;
        await ok('owner', 'PUT', `${base}/webmail/mailboxes/${id}/grants/${owner}`, FULL);
    }
    await ok('owner', 'PUT', `${base}/webmail/mailboxes/${mailboxId.sales}/grants/${idOf('member')}`, FULL);
    await ok('owner', 'PUT', `${base}/webmail/mailboxes/${mailboxId.support}/grants/${idOf('member')}`, FULL);
    await ok('owner', 'PUT', `${base}/webmail/mailboxes/${mailboxId.billing}/grants/${idOf('member')}`, FULL);
    await ok('owner', 'PUT', `${base}/webmail/mailboxes/${mailboxId.sales}/grants/${idOf('reader')}`, READ_ONLY);

    return { browser, projectId, workspaceId, inboxId: inboxes[0].id, connections, address, mailboxId };
}

export const test = base.extend<object, { world: World }>({
    world: [async ({ browserName }, use) => use(await provision(browserName)), { scope: 'worker', timeout: 120_000 }],
});

export { expect };

// ---------------------------------------------------------------- Real logins in real browsers.

const remembered = new Map<string, Awaited<ReturnType<BrowserContext['storageState']>>>();
const contextOptions = { ignoreHTTPSErrors: true, viewport: { width: 1400, height: 860 }, locale: 'en-US', acceptDownloads: true };

export async function browserLogin(page: Page, user: UserKey) {
    // Better Auth allows three sign-ins per ten seconds from one address, and every
    // browser here shares one.
    for (let attempt = 0; attempt < 12; attempt++) {
        await page.goto(`${ORBIT}/`);
        await page.getByLabel(/^Email/).fill(USERS[user].email);
        await page.getByLabel(/^Password/).fill(USERS[user].password);
        const responded = page.waitForResponse((r) => r.url().endsWith('/api/auth/sign-in/email'));
        await page.getByRole('button', { name: 'Sign in', exact: true }).click();
        if ((await responded).status() !== 429) {
            await expect(page.getByLabel(/^Account menu/)).toBeVisible({ timeout: 30_000 });
            return;
        }
        await page.waitForTimeout(11_000);
    }
    throw new Error(`login of ${user} stayed rate limited`);
}

/** A context signed in through the login form; the session is reused within the browser. */
export async function signedIn(browser: Browser, user: UserKey, world: World, fresh = false): Promise<BrowserContext> {
    const key = `${world.browser}:${user}`;
    if (fresh || !remembered.has(key)) {
        const context = await browser.newContext(contextOptions);
        const page = await context.newPage();
        await browserLogin(page, user);
        const state = await context.storageState();
        await page.close();
        if (fresh) return context;
        await context.close();
        remembered.set(key, state);
    }
    return browser.newContext({ ...contextOptions, storageState: remembered.get(key)! });
}

export const webmailPage = (world: World, mailboxId?: string) =>
    `${ORBIT}/p/${world.projectId}/webmail${mailboxId ? `?mailbox=${encodeURIComponent(mailboxId)}` : ''}`;

export function webmailFrame(page: Page): Frame {
    const frame = page.frame({ name: FRAME });
    if (!frame) throw new Error('webmail frame not found');
    return frame;
}

export async function rcmailReady(frame: Frame) {
    await frame.waitForFunction(() => {
        const client = (window as any).rcmail;
        return client && client.busy === false && client.env && client.env.request_token;
    });
}

/** Waits until Roundcube is up in the frame; a login form there fails the test. */
export async function frameInRoundcube(page: Page): Promise<Frame> {
    await expect
        .poll(
            () => {
                const frame = page.frame({ name: FRAME });
                return frame ? frame.url() : '';
            },
            { timeout: 45_000 },
        )
        .toContain('_task=mail');
    const frame = webmailFrame(page);
    await rcmailReady(frame);
    expect(await frame.locator('input[type=password]').count()).toBe(0);
    return frame;
}

/** Picks a mailbox in the page head's menu, as a member does, and waits for the deep link. */
export async function chooseMailbox(page: Page, mailboxId: string) {
    const menu = page.getByRole('combobox', { name: 'Mailbox', exact: true });
    await menu.selectOption(mailboxId);
    await expect(menu).toHaveValue(mailboxId);
    await expect(page).toHaveURL(new RegExp(`[?&]mailbox=${encodeURIComponent(mailboxId)}(&|$)`));
}

export async function openMailbox(page: Page, world: World, mailboxId: string): Promise<Frame> {
    await page.goto(webmailPage(world, mailboxId));
    return frameInRoundcube(page);
}

/** The owner's row for a mailbox in the project settings. */
export async function ownerSettingsRow(page: Page, world: World, address: string) {
    await page.goto(`${ORBIT}/p/${world.projectId}/settings?section=integrations`);
    const row = page.locator('li.settings-row', { hasText: address });
    await expect(row).toBeVisible();
    return row;
}

export async function waitForRow(frame: Frame, subject: string) {
    await expect
        .poll(
            async () => {
                await frame.evaluate(() => {
                    const client = (window as any).rcmail;
                    if (!client.busy) client.command('checkmail');
                });
                await frame.waitForTimeout(800);
                return frame.locator('#messagelist tr', { hasText: subject }).count();
            },
            { timeout: 30_000 },
        )
        .toBeGreaterThan(0);
}

export async function selectMessage(frame: Frame, subject: string) {
    await waitForRow(frame, subject);
    await rcmailIdle(frame);
    await frame.locator('#messagelist tr', { hasText: subject }).first().click();
    await frame.waitForTimeout(400);
    await rcmailIdle(frame);
}

/** Roundcube ignores commands while it is busy, as it would for a person. */
export const rcmailIdle = (frame: Frame) => frame.waitForFunction(() => (window as any).rcmail.busy === false);

export async function ajaxPost(frame: Frame, task: string, action: string, fields: Record<string, string>) {
    return frame.evaluate(
        async ({ task, action, fields }) => {
            const client = (window as any).rcmail;
            const body = new URLSearchParams({ ...fields, _remote: '1' });
            const response = await fetch(`./?_task=${task}&_action=${action}`, {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'X-Roundcube-Request': client.env.request_token },
                body,
            });
            return { status: response.status, text: await response.text() };
        },
        { task, action, fields },
    );
}

export async function ajaxGet(frame: Frame, task: string, action: string, query = '') {
    return frame.evaluate(
        async ({ task, action, query }) => {
            const client = (window as any).rcmail;
            const response = await fetch(`./?_task=${task}&_action=${action}&_remote=1${query}`, {
                credentials: 'same-origin',
                headers: { 'X-Roundcube-Request': client.env.request_token },
            });
            return { status: response.status, text: await response.text() };
        },
        { task, action, query },
    );
}

// ---------------------------------------------------------------- Tickets.

const supportPath = (world: World) => `/api/projects/${world.projectId}/support`;

export async function ticketsBySubject(world: World, subject: string): Promise<any[]> {
    const answer = await ok('owner', 'GET', `${supportPath(world)}/tickets?limit=50&q=${encodeURIComponent(subject)}`);
    const items: any[] = answer.items ?? answer.tickets ?? [];
    return items.filter((t) => String(t.subject).includes(subject));
}

export const ticketBySubject = async (world: World, subject: string): Promise<any | null> =>
    (await ticketsBySubject(world, subject))[0] ?? null;

export const ticketDetail = (world: World, ticketId: string) =>
    ok('owner', 'GET', `${supportPath(world)}/tickets/${ticketId}`);

export const POLL_TIMEOUT = 330_000;

/** The worker reads each project every two minutes, and may start a pass late. */
export async function eventuallyTicket(world: World, subject: string, timeout = POLL_TIMEOUT) {
    let found: any = null;
    await expect
        .poll(
            async () => {
                found = await ticketBySubject(world, subject);
                return found !== null;
            },
            { timeout, intervals: [3000] },
        )
        .toBe(true);
    return found;
}

export const setGrant = async (world: World, mailboxId: string, user: UserKey, flags: typeof FULL) => {
    const people = (await ok('owner', 'GET', `/api/projects/${world.projectId}/members`)).items as any[];
    const id = people.find((p) => p.user.email === USERS[user].email).user.id;
    return ok('owner', 'PUT', `/api/projects/${world.projectId}/webmail/mailboxes/${mailboxId}/grants/${id}`, flags);
};
