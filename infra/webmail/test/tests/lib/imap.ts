// A minimal IMAP client for seeding and inspecting mail over GreenMail's plain test port.
import net from 'node:net';

type Result = { ok: boolean; lines: string[]; status: string };

export const MAIL_HOST = process.env.E2E_MAIL_HOST!;
export const MAIL_PASSWORD = process.env.E2E_MAIL_PASSWORD!;

export class Imap {
    private buffer = '';
    private pending: { tag: string; resolve: (r: Result) => void; lines: string[]; literal?: string } | null = null;
    private tag = 0;
    private greeting: (() => void) | null = null;

    private constructor(private socket: net.Socket) {
        socket.setEncoding('utf8');
        socket.on('data', (chunk: string) => this.onData(chunk));
    }

    static async open(user: string, password: string): Promise<Imap> {
        const socket = net.connect(3143, MAIL_HOST);
        const client = new Imap(socket);
        await new Promise<void>((resolve, reject) => {
            client.greeting = resolve;
            socket.on('error', reject);
        });
        const result = await client.run(`LOGIN "${user}" "${password}"`);
        if (!result.ok) throw new Error(`IMAP login failed for ${user}`);
        return client;
    }

    private onData(chunk: string) {
        this.buffer += chunk;
        let index;
        while ((index = this.buffer.indexOf('\r\n')) >= 0) {
            this.onLine(this.buffer.slice(0, index));
            this.buffer = this.buffer.slice(index + 2);
        }
    }

    private onLine(line: string) {
        if (this.greeting) {
            const greeting = this.greeting;
            this.greeting = null;
            greeting();
            return;
        }
        if (!this.pending) return;
        if (line.startsWith('+') && this.pending.literal !== undefined) {
            const literal = this.pending.literal;
            this.pending.literal = undefined;
            this.socket.write(`${literal}\r\n`);
            return;
        }
        if (line.startsWith(`${this.pending.tag} `)) {
            const { resolve, lines } = this.pending;
            this.pending = null;
            resolve({ ok: /^\S+ OK/.test(line), lines, status: line });
            return;
        }
        this.pending.lines.push(line);
    }

    run(command: string, literal?: string): Promise<Result> {
        const tag = `T${++this.tag}`;
        return new Promise((resolve) => {
            this.pending = { tag, resolve, lines: [], literal };
            this.socket.write(`${tag} ${command}\r\n`);
        });
    }

    append(folder: string, message: string, flags = ''): Promise<Result> {
        return this.run(`APPEND "${folder}" ${flags ? `(${flags}) ` : ''}{${Buffer.byteLength(message)}}`, message);
    }

    async select(folder: string): Promise<{ uidValidity: number }> {
        const result = await this.run(`SELECT "${folder}"`);
        if (!result.ok) throw new Error(result.status);
        const line = result.lines.find((entry) => entry.includes('UIDVALIDITY')) ?? '';
        return { uidValidity: Number(/UIDVALIDITY (\d+)/.exec(line)?.[1]) };
    }

    async search(criteria = 'ALL'): Promise<number[]> {
        const result = await this.run(`UID SEARCH ${criteria}`);
        const line = result.lines.find((entry) => entry.startsWith('* SEARCH')) ?? '* SEARCH';
        return line.replace('* SEARCH', '').trim().split(/\s+/).filter(Boolean).map(Number);
    }

    async flags(uid: number): Promise<string> {
        const result = await this.run(`UID FETCH ${uid} (FLAGS)`);
        return result.lines.join(' ').match(/FLAGS \(([^)]*)\)/)?.[1] ?? '';
    }

    /** The whole message as text, without setting \Seen. */
    async source(uid: number): Promise<string> {
        const result = await this.run(`UID FETCH ${uid} (BODY.PEEK[])`);
        return result.lines.slice(1).join('\r\n');
    }

    close() {
        this.socket.end();
    }
}

/** Runs against a mailbox and always logs out. */
export async function withMailbox<T>(address: string, work: (imap: Imap) => Promise<T>, password = MAIL_PASSWORD): Promise<T> {
    const imap = await Imap.open(address, password);
    try {
        return await work(imap);
    } finally {
        imap.close();
    }
}

export type Seed = {
    from?: string;
    to: string;
    subject: string;
    text?: string;
    html?: string;
    messageId: string;
    attachment?: { name: string; mime: string; bytes: Buffer };
    headers?: Record<string, string>;
};

/** A message as a mail server would store it. */
export function rfc822(seed: Seed): string {
    const head = [
        `From: ${seed.from ?? 'Casey Customer <casey@customer.example.org>'}`,
        `To: ${seed.to}`,
        `Subject: ${seed.subject}`,
        `Date: ${new Date().toUTCString().replace('GMT', '+0000')}`,
        `Message-ID: <${seed.messageId}>`,
        'MIME-Version: 1.0',
        ...Object.entries(seed.headers ?? {}).map(([name, value]) => `${name}: ${value}`),
    ];
    const bodyHeader = seed.html ? 'Content-Type: text/html; charset=UTF-8' : 'Content-Type: text/plain; charset=UTF-8';
    const body = seed.html ?? seed.text ?? 'Body.';
    if (!seed.attachment) return [...head, bodyHeader, '', body, ''].join('\r\n');
    const boundary = 'e2e-boundary';
    return [
        ...head,
        `Content-Type: multipart/mixed; boundary="${boundary}"`,
        '',
        `--${boundary}`,
        bodyHeader,
        '',
        body,
        `--${boundary}`,
        `Content-Type: ${seed.attachment.mime}; name="${seed.attachment.name}"`,
        `Content-Disposition: attachment; filename="${seed.attachment.name}"`,
        'Content-Transfer-Encoding: base64',
        '',
        seed.attachment.bytes.toString('base64'),
        `--${boundary}--`,
        '',
    ].join('\r\n');
}

/** Delivers one message and returns its UID. */
export async function deliver(address: string, seed: Seed, folder = 'INBOX'): Promise<number> {
    return withMailbox(address, async (imap) => {
        const appended = await imap.append(folder, rfc822(seed));
        if (!appended.ok) throw new Error(appended.status);
        await imap.select(folder);
        const uids = await imap.search(`HEADER Message-ID "<${seed.messageId}>"`);
        if (uids.length !== 1) throw new Error(`expected one message, found ${uids.length}`);
        return uids[0]!;
    });
}

export const folderUids = (address: string, folder: string, criteria = 'ALL') =>
    withMailbox(address, async (imap) => {
        await imap.select(folder);
        return imap.search(criteria);
    });

export const uidOfSubject = (address: string, subject: string, folder = 'INBOX') =>
    withMailbox(address, async (imap) => {
        await imap.select(folder);
        const [uid] = await imap.search(`SUBJECT "${subject}"`);
        return uid;
    });

export async function ensureFolders(address: string, folders: string[]) {
    await withMailbox(address, async (imap) => {
        for (const folder of folders) await imap.run(`CREATE "${folder}"`);
    });
}

/** GreenMail creates an account at first delivery: login and password are the address. */
export async function customerMessages(address: string, subject: string): Promise<string[]> {
    try {
        return await withMailbox(
            address,
            async (imap) => {
                await imap.select('INBOX');
                const uids = await imap.search(`SUBJECT "${subject}"`);
                const sources: string[] = [];
                for (const uid of uids) sources.push(await imap.source(uid));
                return sources;
            },
            address,
        );
    } catch {
        return [];
    }
}
