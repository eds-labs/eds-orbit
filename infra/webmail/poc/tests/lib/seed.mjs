// Restores a known mailbox state before each test.
import { Imap } from './imap.mjs';

export const ALICE = { login: 'alice@mail.test', password: process.env.POC_ALICE_PASSWORD };
export const BOB = { login: 'bob@mail.test', password: process.env.POC_BOB_PASSWORD };

const TRACKER = `tracker.${process.env.POC_APEX ?? 'orbit.test'}`;
const FOLDERS = ['INBOX', 'Trash', 'Archive', 'Sent', 'Drafts'];

function plain(subject, body, from = 'sender@example.test') {
    return [
        `From: ${from}`,
        'To: alice@mail.test',
        `Subject: ${subject}`,
        'Date: Mon, 09 Nov 2026 10:00:00 +0000',
        `Message-ID: <${subject.replace(/\W+/g, '-').toLowerCase()}@poc.test>`,
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset=UTF-8',
        '',
        body,
    ].join('\r\n');
}

function withAttachment() {
    const content = Buffer.from('attachment payload for the PoC\n').toString('base64');
    return [
        'From: sender@example.test',
        'To: alice@mail.test',
        'Subject: With attachment',
        'Date: Mon, 09 Nov 2026 10:01:00 +0000',
        'Message-ID: <with-attachment@poc.test>',
        'MIME-Version: 1.0',
        'Content-Type: multipart/mixed; boundary="poc-boundary"',
        '',
        '--poc-boundary',
        'Content-Type: text/plain; charset=UTF-8',
        '',
        'See attachment.',
        '--poc-boundary',
        'Content-Type: text/plain; name="report.txt"',
        'Content-Disposition: attachment; filename="report.txt"',
        'Content-Transfer-Encoding: base64',
        '',
        content,
        '--poc-boundary--',
        '',
    ].join('\r\n');
}

function hostile() {
    const html = [
        '<html><head>',
        `<link rel="stylesheet" href="https://${TRACKER}/style.css">`,
        `<style>body { background: url(https://${TRACKER}/background.png); }</style>`,
        '</head><body onload="window.__pwned = 1">',
        `<img src="https://${TRACKER}/pixel.png?id=hostile" alt="pixel">`,
        '<img src="x" onerror="window.__pwned = 2">',
        '<script>window.__pwned = 3</script>',
        `<iframe src="https://${TRACKER}/frame"></iframe>`,
        '<a id="js-link" href="javascript:window.__pwned = 4">click</a>',
        '<p id="hostile-marker">Hostile body text</p>',
        '</body></html>',
    ].join('');

    return [
        'From: sender@example.test',
        'To: alice@mail.test',
        'Subject: Hostile HTML',
        'Date: Mon, 09 Nov 2026 10:02:00 +0000',
        'Message-ID: <hostile@poc.test>',
        'MIME-Version: 1.0',
        'Content-Type: text/html; charset=UTF-8',
        '',
        html,
    ].join('\r\n');
}

async function emptyFolder(imap, folder) {
    await imap.run(`CREATE "${folder}"`);
    await imap.select(folder);
    await imap.run('UID STORE 1:* +FLAGS.SILENT (\\Deleted)');
    await imap.run('EXPUNGE');
}

export async function seedAlice() {
    const imap = await Imap.open(ALICE.login, ALICE.password);
    for (const folder of FOLDERS) await emptyFolder(imap, folder);

    await imap.append('INBOX', plain('Plain welcome', 'A plain text welcome message.'));
    await imap.append('INBOX', withAttachment());
    await imap.append('INBOX', hostile());
    for (const name of ['Keep one', 'Keep two', 'Keep three', 'Keep four']) {
        await imap.append('INBOX', plain(name, `${name} body.`));
    }
    await imap.append('Archive', plain('Archived message', 'Lives outside INBOX.'));
    imap.close();
}

export async function seedBob() {
    const imap = await Imap.open(BOB.login, BOB.password);
    await emptyFolder(imap, 'INBOX');
    await imap.append('INBOX', plain('Bob only', 'Message that only Bob can see.'));
    imap.close();
}

/** Adds one message whose second part is an attachment with the given content. */
export async function appendAttachment(subject, filename, contentType, base64) {
    const message = [
        'From: sender@example.test',
        'To: alice@mail.test',
        `Subject: ${subject}`,
        'Date: Mon, 09 Nov 2026 10:03:00 +0000',
        `Message-ID: <${filename}@poc.test>`,
        'MIME-Version: 1.0',
        'Content-Type: multipart/mixed; boundary="poc-boundary"',
        '',
        '--poc-boundary',
        'Content-Type: text/plain; charset=UTF-8',
        '',
        'See attachment.',
        '--poc-boundary',
        `Content-Type: ${contentType}; name="${filename}"`,
        `Content-Disposition: attachment; filename="${filename}"`,
        'Content-Transfer-Encoding: base64',
        '',
        base64,
        '--poc-boundary--',
        '',
    ].join('\r\n');

    await withAlice((imap) => imap.append('INBOX', message));
}

export async function withAlice(work) {
    const imap = await Imap.open(ALICE.login, ALICE.password);
    try {
        return await work(imap);
    } finally {
        imap.close();
    }
}

export async function uidOf(subject, folder = 'INBOX') {
    return withAlice(async (imap) => {
        await imap.select(folder);
        const [uid] = await imap.search(`SUBJECT "${subject}"`);
        return uid;
    });
}

export async function folderCount(folder) {
    return withAlice(async (imap) => {
        await imap.select(folder);
        return (await imap.search()).length;
    });
}

export async function inboxContains(subject) {
    return (await uidOf(subject)) !== undefined;
}
