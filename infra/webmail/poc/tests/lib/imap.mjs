// Minimal IMAP client. Used only to seed and inspect mail: over GreenMail's plain test
// port, or with STARTTLS on the Dovecot test server.
import { readFileSync } from 'node:fs';
import net from 'node:net';
import tls from 'node:tls';

export class Imap {
    constructor(socket) {
        this.buffer = '';
        this.pending = null;
        this.tag = 0;
        this.attach(socket);
    }

    attach(socket) {
        this.socket = socket;
        socket.setEncoding('utf8');
        socket.on('data', (chunk) => this.onData(chunk));
    }

    static async connect(port, host) {
        const socket = net.connect(port, host);
        const client = new Imap(socket);
        await new Promise((resolve, reject) => {
            client.greeting = resolve;
            socket.on('error', reject);
        });
        return client;
    }

    static async open(user, password) {
        const client = await Imap.connect(3143, 'mail.test');
        const result = await client.run(`LOGIN "${user}" "${password}"`);
        if (!result.ok) throw new Error(`IMAP login failed for ${user}`);
        return client;
    }

    /** Upgrades the connection and verifies the server against the test CA. */
    async startTls(host) {
        const result = await this.run('STARTTLS');
        if (!result.ok) throw new Error(result.status);
        this.socket.removeAllListeners('data');
        const secure = tls.connect({ socket: this.socket, servername: host, ca: readFileSync('/poc-ca/ca.crt') });
        await new Promise((resolve, reject) => {
            secure.once('secureConnect', resolve);
            secure.once('error', reject);
        });
        this.attach(secure);
    }

    onData(chunk) {
        this.buffer += chunk;
        let index;
        while ((index = this.buffer.indexOf('\r\n')) >= 0) {
            this.onLine(this.buffer.slice(0, index));
            this.buffer = this.buffer.slice(index + 2);
        }
    }

    onLine(line) {
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

    run(command, literal) {
        const tag = `T${++this.tag}`;
        return new Promise((resolve) => {
            this.pending = { tag, resolve, lines: [], literal };
            this.socket.write(`${tag} ${command}\r\n`);
        });
    }

    append(folder, message, flags = '') {
        return this.run(`APPEND "${folder}" ${flags ? `(${flags}) ` : ''}{${Buffer.byteLength(message)}}`, message);
    }

    async select(folder) {
        const result = await this.run(`SELECT "${folder}"`);
        if (!result.ok) throw new Error(result.status);
        const line = result.lines.find((entry) => entry.includes('UIDVALIDITY')) ?? '';
        return { uidValidity: Number(/UIDVALIDITY (\d+)/.exec(line)?.[1]) };
    }

    async search(criteria = 'ALL') {
        const result = await this.run(`UID SEARCH ${criteria}`);
        const line = result.lines.find((entry) => entry.startsWith('* SEARCH')) ?? '* SEARCH';
        return line.replace('* SEARCH', '').trim().split(/\s+/).filter(Boolean).map(Number);
    }

    async flags(uid) {
        const result = await this.run(`UID FETCH ${uid} (FLAGS)`);
        return result.lines.join(' ').match(/FLAGS \(([^)]*)\)/)?.[1] ?? '';
    }

    close() {
        this.socket.end();
    }
}
