import { test, expect, type Frame } from '@playwright/test';
import { ajaxPost, bridgeCalls, control, FULL_ACCESS, openWebmail, resetBridge, waitForMailList } from '../lib/poc';
import { folderCount, seedAlice, uidOf, withAlice } from '../lib/seed.mjs';

const RETRY_TEXT = 'Orbit has not finished reading';

async function lastBarrier() {
    const calls = await bridgeCalls('session/barrier');
    return calls[calls.length - 1];
}

function resetBridgeLog() {
    return control('/log/reset');
}

test.describe('G6 barrier', () => {
    let frame: Frame;

    test.beforeEach(async ({ page }) => {
        await seedAlice();
        await resetBridge();
        frame = await openWebmail(page, { capabilities: FULL_ACCESS });
    });

    test('retry stops a move with a visible message and no IMAP change', async () => {
        await control('/barrier', { status: 'retry', reason: 'ingest_pending' });
        const uid = String(await uidOf('Keep one'));

        const result = await ajaxPost(frame, 'mail', 'move', { _mbox: 'INBOX', _uid: uid, _target_mbox: 'Archive' });

        expect(result.status).toBe(200);
        expect(result.text).toContain(RETRY_TEXT);
        expect(await folderCount('INBOX')).toBe(7);
        expect(await folderCount('Archive')).toBe(1);
        expect(await lastBarrier()).toMatchObject({
            operation: 'move',
            folder: 'INBOX',
            selection: { type: 'uids', uids: [uid] },
        });
    });

    test('retry stops delete, mark delete, expunge and purge', async () => {
        await control('/barrier', { status: 'retry' });
        const uid = String(await uidOf('Keep one'));
        const inbox = { _mbox: 'INBOX' };

        for (const [action, fields, operation] of [
            ['delete', { ...inbox, _uid: uid }, 'delete'],
            ['mark', { ...inbox, _uid: uid, _flag: 'delete' }, 'mark_deleted'],
            ['folder-expunge', inbox, 'expunge'],
            ['expunge', inbox, 'expunge'],
            ['folder-purge', inbox, 'purge'],
            ['purge', inbox, 'purge'],
        ] as const) {
            const result = await ajaxPost(frame, 'mail', action, fields);
            expect(result.text, action).toContain(RETRY_TEXT);
            expect((await lastBarrier()).operation, action).toBe(operation);
        }

        expect(await folderCount('INBOX')).toBe(7);
        await withAlice(async (imap) => {
            await imap.select('INBOX');
            expect(await imap.flags(uid)).not.toContain('Deleted');
        });
    });

    test('every spelling that sets the deleted flag reaches the barrier', async () => {
        await control('/barrier', { status: 'retry' });
        const uid = String(await uidOf('Keep one'));

        for (const flag of ['DELETED', 'deleted', 'Deleted', 'DELETE', 'Delete', '\\Deleted', '\\DELETED']) {
            await resetBridgeLog();
            const result = await ajaxPost(frame, 'mail', 'mark', { _mbox: 'INBOX', _uid: uid, _flag: flag });
            expect(result.text, flag).toContain(RETRY_TEXT);
            expect((await lastBarrier()).operation, flag).toBe('mark_deleted');
        }

        await withAlice(async (imap) => {
            await imap.select('INBOX');
            expect(await imap.flags(uid)).not.toContain('Deleted');
        });
    });

    test('flags that cannot remove a message do not call the barrier', async () => {
        await control('/barrier', { status: 'retry' });
        const uid = String(await uidOf('Keep one'));

        for (const flag of ['read', 'unread', 'flagged', 'unflagged', 'undelete', 'UNDELETED']) {
            const result = await ajaxPost(frame, 'mail', 'mark', { _mbox: 'INBOX', _uid: uid, _flag: flag });
            expect(result.text, flag).not.toContain(RETRY_TEXT);
        }

        expect(await bridgeCalls('session/barrier')).toEqual([]);
    });

    test('multi-UID, compound, range and star selections reach the barrier', async () => {
        await control('/barrier', { status: 'retry' });
        const one = String(await uidOf('Keep one'));
        const two = String(await uidOf('Keep two'));

        await ajaxPost(frame, 'mail', 'move', { _mbox: 'INBOX', _uid: `${one},${two}`, _target_mbox: 'Archive' });
        expect((await lastBarrier()).selection).toEqual({ type: 'uids', uids: [one, two] });

        await ajaxPost(frame, 'mail', 'move', { _uid: `${one}-INBOX,${two}-INBOX`, _target_mbox: 'Archive' });
        expect((await lastBarrier()).selection).toEqual({ type: 'uids', uids: [one, two] });

        await ajaxPost(frame, 'mail', 'delete', { _mbox: 'INBOX', _uid: `${one}:${two}` });
        expect((await lastBarrier()).selection).toEqual({ type: 'uids', uids: [`${one}:${two}`] });

        await ajaxPost(frame, 'mail', 'delete', { _mbox: 'INBOX', _uid: '*' });
        expect((await lastBarrier()).selection).toEqual({ type: 'all' });

        await ajaxPost(frame, 'mail', 'mark', { _uid: '1', _flag: 'delete', _folders: 'all' });
        expect((await lastBarrier()).selection).toEqual({ type: 'all' });

        expect(await folderCount('INBOX')).toBe(7);
    });

    test('INBOX is matched when _mbox is omitted or differently cased', async () => {
        await control('/barrier', { status: 'retry' });
        const uid = String(await uidOf('Keep one'));
        const before = await folderCount('INBOX');

        for (const fields of [{ _uid: uid }, { _mbox: 'inbox', _uid: uid }, { _mbox: 'InBoX', _uid: uid }]) {
            const result = await ajaxPost(frame, 'mail', 'delete', fields);
            expect(result.text, JSON.stringify(fields)).toContain(RETRY_TEXT);
        }

        expect(await folderCount('INBOX')).toBe(before);
    });

    test('ok lets the move proceed', async () => {
        const uid = String(await uidOf('Keep one'));

        const result = await ajaxPost(frame, 'mail', 'move', { _mbox: 'INBOX', _uid: uid, _target_mbox: 'Archive' });

        expect(result.status).toBe(200);
        expect(await folderCount('INBOX')).toBe(6);
        expect(await folderCount('Archive')).toBe(2);
        expect((await lastBarrier()).result).toBe('ok');
    });

    test('an unknown barrier answer fails closed', async () => {
        await control('/barrier', { status: 'maybe' });
        const uid = String(await uidOf('Keep one'));

        const result = await ajaxPost(frame, 'mail', 'delete', { _mbox: 'INBOX', _uid: uid });

        expect(result.text).toContain(RETRY_TEXT);
        expect(await folderCount('INBOX')).toBe(7);
    });

    test('moves from other folders do not call the barrier', async () => {
        await control('/barrier', { status: 'retry' });
        const uid = String(await uidOf('Archived message', 'Archive'));

        const result = await ajaxPost(frame, 'mail', 'move', { _mbox: 'Archive', _uid: uid, _target_mbox: 'Trash' });

        expect(result.status).toBe(200);
        expect(await bridgeCalls('session/barrier')).toEqual([]);
        expect(await folderCount('Trash')).toBe(1);
    });

    test('the UI shows the retry message and keeps the row', async () => {
        await control('/barrier', { status: 'retry' });
        await waitForMailList(frame);

        await frame.evaluate(() => {
            const client = (window as any).rcmail;
            const uid = Object.keys(client.message_list.rows)[0];
            client.message_list.select(uid);
        });
        await frame.evaluate(() => (window as any).rcmail.command('delete'));

        await expect(frame.locator('#messagestack')).toContainText(RETRY_TEXT);
        await waitForMailList(frame);
        expect(await folderCount('INBOX')).toBe(7);
    });
});
