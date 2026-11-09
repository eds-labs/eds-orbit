import { test, expect } from '@playwright/test';
import { ajaxGet, ajaxPost, bridgeCalls, FULL_ACCESS, openWebmail, READ_ONLY, resetBridge } from '../lib/poc';
import { folderCount, inboxContains, seedAlice, uidOf, withAlice } from '../lib/seed.mjs';

const SUBJECT = 'Keep one';

test.describe('G5 action enforcement', () => {
    test.beforeEach(async () => {
        await seedAlice();
        await resetBridge();
    });

    test('a read-only session cannot change mail through direct POSTs', async ({ page }) => {
        const frame = await openWebmail(page, { capabilities: READ_ONLY });
        const uid = String(await uidOf(SUBJECT));
        const inbox = { _mbox: 'INBOX' };
        const attempts: Array<[string, string, Record<string, string>]> = [
            ['mail', 'move', { ...inbox, _uid: uid, _target_mbox: 'Archive' }],
            ['mail', 'delete', { ...inbox, _uid: uid }],
            ['mail', 'folder-expunge', inbox],
            ['mail', 'expunge', inbox],
            ['mail', 'folder-purge', inbox],
            ['mail', 'purge', inbox],
            ['mail', 'mark', { ...inbox, _uid: uid, _flag: 'delete' }],
            ['mail', 'mark', { ...inbox, _uid: '*', _flag: 'delete', _folders: 'all' }],
            ['mail', 'copy', { ...inbox, _uid: uid, _target_mbox: 'Archive' }],
            ['mail', 'send', { _to: 'bob@mail.test', _subject: 'nope', _message: 'x' }],
            // Spelling variants that reach the same handlers in Roundcube's dispatcher.
            ['mail', 'folder_purge', inbox],
            ['mail', 'folder_expunge', inbox],
            ['mail', 'DELETE', { ...inbox, _uid: uid }],
            ['mail', 'Move', { ...inbox, _uid: uid, _target_mbox: 'Archive' }],
        ];

        for (const [task, action, fields] of attempts) {
            const result = await ajaxPost(frame, task, action, fields);
            expect(result.status, `${task}/${action}`).toBe(403);
        }

        await withAlice(async (imap) => {
            await imap.select('INBOX');
            expect(await imap.flags(uid)).not.toContain('Deleted');
        });
        expect(await inboxContains(SUBJECT)).toBe(true);
        expect(await folderCount('INBOX')).toBe(7);
        expect(await folderCount('Archive')).toBe(1);
        expect(await bridgeCalls('session/barrier')).toEqual([]);
    });

    test('a read-only session can list and read', async ({ page }) => {
        const frame = await openWebmail(page, { capabilities: READ_ONLY });
        const uid = await uidOf(SUBJECT);

        expect((await ajaxGet(frame, 'mail', 'list', '&_mbox=INBOX')).status).toBe(200);
        expect((await ajaxGet(frame, 'mail', 'show', `&_mbox=INBOX&_uid=${uid}`)).status).toBe(200);
    });

    test('without send capability compose is refused and nothing is delivered', async ({ page }) => {
        const frame = await openWebmail(page, { capabilities: ['read', 'organize'] });

        expect((await ajaxGet(frame, 'mail', 'compose')).status).toBe(403);
        expect((await ajaxPost(frame, 'mail', 'send', { _to: 'bob@mail.test', _subject: 's', _message: 'm' })).status).toBe(403);
    });

    test('denied actions stay denied with full mailbox capabilities', async ({ page }) => {
        const frame = await openWebmail(page, { capabilities: FULL_ACCESS });
        const denied: Array<[string, string]> = [
            ['settings', ''],
            ['settings', 'identities'],
            ['settings', 'identity-save'],
            ['settings', 'folders'],
            ['settings', 'folder-delete'],
            ['settings', 'folder-rename'],
            ['settings', 'folder-purge'],
            ['settings', 'response-save'],
            ['settings', 'prefs-save'],
            ['settings', 'about'],
            ['addressbook', ''],
            ['addressbook', 'save'],
            ['contacts', ''],
            ['mail', 'addcontact'],
            ['utils', 'modcss'],
            ['utils', 'killcache'],
            ['utils', 'spell'],
            ['login', ''],
            ['login', 'oauth'],
            ['dummy', ''],
            ['mail', 'not-a-real-action'],
            ['mail', 'plugin.unknown'],
        ];

        for (const [task, action] of denied) {
            const result = await ajaxPost(frame, task, action, { _mbox: 'INBOX', _name: 'x' });
            expect(result.status, `${task}/${action}`).toBe(403);
        }
    });

    test('a revoked session stops at the next request', async ({ page }) => {
        const frame = await openWebmail(page, { capabilities: FULL_ACCESS });
        await (await import('../lib/poc')).control('/revoke');

        const result = await ajaxGet(frame, 'mail', 'list', '&_mbox=INBOX');

        expect(result.text).toContain('session_error');
        expect(result.text).not.toContain('Plain welcome');
    });
});
