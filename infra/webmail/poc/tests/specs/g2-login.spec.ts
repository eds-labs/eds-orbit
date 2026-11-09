import { test, expect, request, type APIRequestContext } from '@playwright/test';
import { APEX, bridgeCalls, EVIL_ORIGIN, issueToken, openWebmail, ORBIT_ORIGIN, resetBridge, WEBMAIL_ORIGIN, webmailFrame } from '../lib/poc';
import { seedAlice } from '../lib/seed.mjs';

const LOGIN_MARKERS = ['name="_user"', 'name="_pass"', '<form', 'rcmloginuser'];

function expectNoLoginForm(body: string) {
    for (const marker of LOGIN_MARKERS) expect(body).not.toContain(marker);
}

async function client(): Promise<APIRequestContext> {
    return request.newContext({ ignoreHTTPSErrors: true, maxRedirects: 0 });
}

function handoff(api: APIRequestContext, token: string, origin?: string) {
    return api.post(`${WEBMAIL_ORIGIN}/`, {
        form: { _task: 'login', _action: 'login', _orbit_handoff: token },
        headers: origin === undefined ? {} : { Origin: origin },
    });
}

test.describe('G2 one-time login', () => {
    test.beforeAll(seedAlice);
    test.beforeEach(resetBridge);

    test('valid Origin logs in without a login form and sets a session', async () => {
        const api = await client();
        const response = await handoff(api, await issueToken(), ORBIT_ORIGIN);

        expect(response.status()).toBe(302);
        expect(response.headers().location).toContain('_task=mail');
        expectNoLoginForm(await response.text());
        const consumed = await bridgeCalls('handoff/consume');
        expect(consumed).toHaveLength(1);
        expect(consumed[0].result).toBe('ok');
    });

    for (const [name, origin] of [
        ['Origin: null', 'null'],
        ['wrong Origin', EVIL_ORIGIN],
        ['subdomain lookalike Origin', `https://${APEX}.evil.test`],
        ['http downgrade Origin', `http://${APEX}`],
        ['missing Origin', undefined],
    ] as const) {
        test(`${name} is rejected before the token is consumed`, async () => {
            const api = await client();
            const response = await handoff(api, await issueToken(), origin);

            expect(response.status()).toBe(403);
            expectNoLoginForm(await response.text());
            expect(await bridgeCalls('handoff/consume')).toHaveLength(0);
        });
    }

    test('a replayed token is rejected', async () => {
        const token = await issueToken();
        const first = await handoff(await client(), token, ORBIT_ORIGIN);
        expect(first.status()).toBe(302);

        const replay = await handoff(await client(), token, ORBIT_ORIGIN);
        expect(replay.status()).toBe(403);
        expectNoLoginForm(await replay.text());
        expect((await bridgeCalls('handoff/consume')).map((call) => call.result)).toEqual(['ok', 'token_consumed']);
    });

    test('an expired token is rejected', async () => {
        const response = await handoff(await client(), await issueToken({ ttlSeconds: -1 }), ORBIT_ORIGIN);

        expect(response.status()).toBe(403);
        expect((await bridgeCalls('handoff/consume'))[0].result).toBe('token_expired');
    });

    test('an unknown token is rejected', async () => {
        const response = await handoff(await client(), 'forged-token', ORBIT_ORIGIN);

        expect(response.status()).toBe(403);
        expect((await bridgeCalls('handoff/consume'))[0].result).toBe('token_invalid');
    });

    test('a direct GET renders no login form', async () => {
        const api = await client();

        for (const path of ['/', '/?_task=login', '/?_task=mail', '/?_task=settings', '/?_task=login&_action=oauth']) {
            const response = await api.get(`${WEBMAIL_ORIGIN}${path}`);
            expect(response.status(), path).toBe(403);
            expectNoLoginForm(await response.text());
        }
    });

    test('a plain credential POST cannot log in', async () => {
        const api = await client();

        for (const headers of [{}, { Origin: ORBIT_ORIGIN }]) {
            const response = await api.post(`${WEBMAIL_ORIGIN}/`, {
                form: {
                    _task: 'login',
                    _action: 'login',
                    _user: 'alice@mail.test',
                    _pass: process.env.POC_ALICE_PASSWORD ?? '',
                    _token: 'guess',
                },
                headers,
            });

            expect(response.status()).toBe(403);
            expectNoLoginForm(await response.text());
        }

        expect(await bridgeCalls('handoff/consume')).toHaveLength(0);
        expect(await bridgeCalls('session/authorize')).toHaveLength(0);
    });

    test('the session id changes at login, including a planted id', async ({ page, context }) => {
        const plantedId = 'plantedsessionid0123456789abcdef';
        await context.addCookies([{
            name: '__Host-orbit_webmail_sid',
            value: plantedId,
            url: WEBMAIL_ORIGIN,
            secure: true,
            httpOnly: true,
            sameSite: 'Strict',
        }]);

        await openWebmail(page);

        const sessionCookie = (await context.cookies(WEBMAIL_ORIGIN))
            .find((cookie) => cookie.name === '__Host-orbit_webmail_sid');
        expect(sessionCookie?.value).toBeTruthy();
        expect(sessionCookie?.value).not.toBe(plantedId);
        await expect.poll(() => webmailFrame(page).url()).toContain('_task=mail');
    });
});
