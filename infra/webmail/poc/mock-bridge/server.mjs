// Mock of the Orbit webmail bridge. It implements the wire contract in contract.json,
// holds the test credentials and logs each call without any secret.
// The /__control routes exist only for the proof of concept.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { lookup } from 'node:dns/promises';

const BRIDGE_SECRET = requireEnv('POC_BRIDGE_SECRET');
const CONTROL_SECRET = requireEnv('POC_CONTROL_SECRET');
const ALLOWED_ORIGIN = requireEnv('POC_PARENT_ORIGIN');
const MAIL_HOST = requireEnv('POC_MAIL_HOST');
const IMAP_PORT = Number(process.env.POC_IMAP_PORT ?? 3993);
const SMTP_PORT = Number(process.env.POC_SMTP_PORT ?? 3465);
const TLS_MODE = process.env.POC_TLS_MODE ?? 'ssl';
const DEFAULT_CAPABILITIES = ['read', 'send', 'organize', 'convert'];

const mailboxes = {
    m1: {
        user: 'mb-m1@orbit.invalid',
        email: 'alice@mail.test',
        displayName: 'Alice Mailbox',
        login: 'alice@mail.test',
        password: requireEnv('POC_ALICE_PASSWORD'),
    },
    m2: {
        user: 'mb-m2@orbit.invalid',
        email: 'bob@mail.test',
        displayName: 'Bob Mailbox',
        login: 'bob@mail.test',
        password: requireEnv('POC_BOB_PASSWORD'),
    },
};

const tokens = new Map();
const sessions = new Map();
const callLog = [];
let barrierResponse = { status: 'ok' };
let tlsPeerName = MAIL_HOST;

function requireEnv(name) {
    const value = process.env[name];
    if (!value) throw new Error(`missing ${name}`);
    return value;
}

function shortHash(value) {
    return createHash('sha256').update(String(value)).digest('hex').slice(0, 10);
}

function isBearer(request, secret) {
    const expected = Buffer.from(`Bearer ${secret}`);
    const actual = Buffer.from(request.headers.authorization ?? '');
    return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function log(endpoint, fields) {
    callLog.push({ at: Date.now(), endpoint, ...fields });
}

async function server(account, port) {
    const { address } = await lookup(MAIL_HOST, { family: 4 });
    return {
        host: address,
        tlsPeerName,
        port,
        tlsMode: TLS_MODE,
        user: account.login,
        password: account.password,
    };
}

const bridgeRoutes = {
    '/v1/handoff/consume': (body) => {
        const entry = tokens.get(body.token);
        const fields = { token: shortHash(body.token), origin: body.origin };

        if (body.origin !== ALLOWED_ORIGIN) {
            log('handoff/consume', { ...fields, result: 'origin_mismatch' });
            return [403, { ok: false, error: 'origin_mismatch' }];
        }
        if (!entry) {
            log('handoff/consume', { ...fields, result: 'token_invalid' });
            return [410, { ok: false, error: 'token_invalid' }];
        }
        if (entry.consumed) {
            log('handoff/consume', { ...fields, result: 'token_consumed' });
            return [410, { ok: false, error: 'token_consumed' }];
        }
        if (entry.expiresAt <= Date.now()) {
            log('handoff/consume', { ...fields, result: 'token_expired' });
            return [410, { ok: false, error: 'token_expired' }];
        }

        entry.consumed = true;
        const handle = randomBytes(32).toString('base64url');
        sessions.set(handle, {
            mailbox: entry.mailbox,
            capabilities: entry.capabilities,
            revoked: false,
        });
        log('handoff/consume', { ...fields, handle: shortHash(handle), result: 'ok' });
        return [200, { ok: true, handle, user: mailboxes[entry.mailbox].user }];
    },

    '/v1/session/authorize': async (body) => {
        const session = sessions.get(body.handle);
        const fields = { handle: shortHash(body.handle), task: body.task, action: body.action };

        if (!session) {
            log('session/authorize', { ...fields, result: 'unknown_handle' });
            return [401, { ok: false, error: 'session_unknown' }];
        }
        if (session.revoked) {
            log('session/authorize', { ...fields, result: 'revoked' });
            return [401, { ok: false, error: 'session_revoked' }];
        }

        const account = mailboxes[session.mailbox];
        log('session/authorize', { ...fields, mailbox: session.mailbox, result: 'ok' });
        return [200, {
            ok: true,
            capabilities: session.capabilities,
            email: account.email,
            displayName: account.displayName,
            imap: await server(account, IMAP_PORT),
            smtp: await server(account, SMTP_PORT),
        }];
    },

    '/v1/session/barrier': (body) => {
        log('session/barrier', {
            handle: shortHash(body.handle),
            operation: body.operation,
            folder: body.folder,
            selection: body.selection,
            result: barrierResponse.status,
        });
        return [200, barrierResponse];
    },

    '/v1/session/end': (body) => {
        const session = sessions.get(body.handle);
        log('session/end', { handle: shortHash(body.handle), reason: body.reason, known: Boolean(session) });
        if (session) session.revoked = true;
        return [200, { ok: true }];
    },
};

const controlRoutes = {
    '/__control/token': (body) => {
        const token = randomBytes(32).toString('base64url');
        tokens.set(token, {
            mailbox: body.mailbox ?? 'm1',
            capabilities: body.capabilities ?? DEFAULT_CAPABILITIES,
            expiresAt: Date.now() + (body.ttlSeconds ?? 60) * 1000,
            consumed: false,
        });
        return [200, { token }];
    },
    '/__control/barrier': (body) => {
        barrierResponse = body;
        return [200, { ok: true }];
    },
    '/__control/revoke': () => {
        for (const session of sessions.values()) session.revoked = true;
        return [200, { ok: true }];
    },
    '/__control/capabilities': (body) => {
        for (const session of sessions.values()) {
            if (session.mailbox === body.mailbox) session.capabilities = body.capabilities;
        }
        return [200, { ok: true }];
    },
    '/__control/tls-peer': (body) => {
        tlsPeerName = body.tlsPeerName ?? MAIL_HOST;
        return [200, { ok: true }];
    },
    '/__control/log': () => [200, { calls: callLog }],
    '/__control/log/reset': () => {
        callLog.length = 0;
        return [200, { ok: true }];
    },
};

function respond(response, status, payload) {
    response.writeHead(status, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(payload));
}

async function readJson(request) {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

createServer(async (request, response) => {
    if (request.url === '/healthz') {
        return respond(response, 200, { ok: true });
    }

    const isControl = request.url.startsWith('/__control/');
    const routes = isControl ? controlRoutes : bridgeRoutes;
    const route = routes[request.url];

    if (request.method !== 'POST' || !route) {
        return respond(response, 404, { ok: false, error: 'not_found' });
    }
    if (!isBearer(request, isControl ? CONTROL_SECRET : BRIDGE_SECRET)) {
        log('rejected', { path: request.url, result: 'bad_bearer' });
        return respond(response, 401, { ok: false, error: 'unauthorized' });
    }

    try {
        const [status, payload] = await route(await readJson(request));
        respond(response, status, payload);
    } catch (error) {
        console.error(`bridge error on ${request.url}: ${error.message}`);
        respond(response, 500, { ok: false, error: 'internal' });
    }
}).listen(8080, () => console.log('mock bridge listening on 8080'));
