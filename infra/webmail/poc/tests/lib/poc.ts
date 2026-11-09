import { expect, type Frame, type Page } from '@playwright/test';

const CONTROL_URL = 'http://bridge:8080/__control';
const CONTROL_SECRET = process.env.POC_CONTROL_SECRET;

export const FULL_ACCESS = ['read', 'send', 'organize', 'convert'];
export const READ_ONLY = ['read'];
export const APEX = process.env.POC_APEX ?? 'orbit.test';
export const WEBMAIL_ORIGIN = `https://webmail.${APEX}`;
export const ORBIT_ORIGIN = `https://${APEX}`;
export const EVIL_ORIGIN = `https://evil.${APEX}`;

export async function control(path: string, body: unknown = {}): Promise<any> {
    const response = await fetch(`${CONTROL_URL}${path}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${CONTROL_SECRET}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    return response.json();
}

export async function issueToken(options: { mailbox?: string; capabilities?: string[]; ttlSeconds?: number } = {}) {
    const { token } = await control('/token', options);
    return token as string;
}

export async function bridgeCalls(endpoint?: string): Promise<any[]> {
    const { calls } = await control('/log');
    return endpoint ? calls.filter((call: any) => call.endpoint === endpoint) : calls;
}

export async function resetBridge() {
    await control('/log/reset');
    await control('/barrier', { status: 'ok' });
    await control('/authorize-failure', {});
}

/** The frame that shows Roundcube once a session exists. */
export function webmailFrame(page: Page): Frame {
    const frame = page.frames().find((candidate) => candidate.name() === 'webmail');
    if (!frame) throw new Error('webmail frame not found');
    return frame;
}

export async function waitForRoundcube(frame: Frame) {
    await frame.waitForFunction(() => {
        const client = (window as any).rcmail;
        return client && client.busy === false && client.env && client.env.request_token;
    });
}

export async function openWebmail(
    page: Page,
    options: { mailbox?: string; capabilities?: string[] } = {},
): Promise<Frame> {
    const token = await issueToken(options);
    await page.goto(`${ORBIT_ORIGIN}/rp/strict?token=${encodeURIComponent(token)}`);
    await expect.poll(() => webmailFrame(page).url(), { timeout: 30_000 }).toContain('_task=mail');
    const frame = webmailFrame(page);
    await waitForRoundcube(frame);
    return frame;
}

export async function waitForMailList(frame: Frame) {
    await frame.waitForFunction(() => {
        const list = (window as any).rcmail?.message_list;
        return list && Object.keys(list.rows).length > 0 && !(window as any).rcmail.busy;
    });
}

/** Sends a Roundcube AJAX request with the session's CSRF token, like the client does. */
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

export function lostMessages(page: Page): Promise<any[]> {
    return page.evaluate(() => (window as any).lost);
}

export function trackPageErrors(page: Page): string[] {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    return errors;
}

export function collectCspViolations(page: Page) {
    return page.addInitScript(() => {
        const store: any = ((window as any).__cspViolations = []);
        document.addEventListener('securitypolicyviolation', (event) => {
            store.push({
                directive: event.effectiveDirective,
                blocked: event.blockedURI,
                source: event.sourceFile,
                disposition: event.disposition,
            });
        });
    });
}

export async function cspViolations(frame: Frame): Promise<any[]> {
    return frame.evaluate(() => (window as any).__cspViolations ?? []);
}
