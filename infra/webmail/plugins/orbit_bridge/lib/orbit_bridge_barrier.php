<?php

/**
 * Detects requests that could remove messages from INBOX and describes their selection.
 *
 * Runs in the "ready" hook, before the action handler. It reads the same parameters as
 * the handlers: mail/move, mail/delete and mail/mark use rcmail_action::get_uids() on
 * POST data, the folder actions use _mbox.
 */
class orbit_bridge_barrier
{
    public const ALL = '*';

    private const WHOLE_FOLDER_ACTIONS = [
        'folder-expunge' => 'expunge',
        'expunge' => 'expunge',
        'folder-purge' => 'purge',
        'purge' => 'purge',
    ];

    /**
     * @return array|null Barrier request body, or null when INBOX is not affected
     */
    public static function requestFor(string $task, string $action): ?array
    {
        if ($task !== 'mail') {
            return null;
        }

        if (isset(self::WHOLE_FOLDER_ACTIONS[$action])) {
            $operation = self::WHOLE_FOLDER_ACTIONS[$action];
            $targets = [self::postedFolder() => self::ALL];
        } elseif ($action === 'move' || $action === 'delete') {
            $operation = $action;
            $targets = self::selectedMessages();
        } elseif ($action === 'mark' && self::setsDeletedFlag()) {
            $operation = 'mark_deleted';
            $targets = self::markTargets();
        } else {
            return null;
        }

        $selection = self::inboxSelection($targets);

        return $selection === null ? null : ['operation' => $operation, 'folder' => 'INBOX', 'selection' => $selection];
    }

    /**
     * The mark handler upper-cases any flag name it does not know and hands it to IMAP,
     * where flag names are case-insensitive. So "DELETED", "deleted" and "\Deleted" all set
     * the flag, not only Roundcube's own "delete". A name starting with "un" removes a flag.
     */
    private static function setsDeletedFlag(): bool
    {
        $flag = strtolower((string) rcube_utils::get_input_string('_flag', rcube_utils::INPUT_POST));

        return str_contains($flag, 'delete') && !str_starts_with($flag, 'un');
    }

    private static function selectedMessages(): array
    {
        return rcmail_action::get_uids(null, null, $multifolder, rcube_utils::INPUT_POST);
    }

    private static function markTargets(): array
    {
        $scope = rcube_utils::get_input_string('_folders', rcube_utils::INPUT_POST);

        if ($scope === 'all') {
            return ['INBOX' => self::ALL];
        }

        if ($scope === 'sub' || $scope === 'cur') {
            return [self::postedFolder() => self::ALL];
        }

        return self::selectedMessages();
    }

    private static function postedFolder(): string
    {
        return (string) rcube_utils::get_input_string('_mbox', rcube_utils::INPUT_POST, true);
    }

    /**
     * An empty folder name means "the current folder", which the handlers resolve
     * from _mbox in the query string or from the session.
     */
    private static function effectiveFolder(string $folder): string
    {
        if ($folder !== '') {
            return $folder;
        }

        $requested = (string) rcube_utils::get_input_string('_mbox', rcube_utils::INPUT_GPC, true);

        return $requested !== '' ? $requested : (string) ($_SESSION['mbox'] ?? 'INBOX');
    }

    /**
     * IMAP treats the name INBOX case-insensitively, so "inbox" addresses the same folder.
     */
    private static function inboxSelection(array $targets): ?array
    {
        $uids = [];
        $isAffected = false;

        foreach ($targets as $folder => $selected) {
            if (strcasecmp(self::effectiveFolder((string) $folder), 'INBOX') !== 0) {
                continue;
            }

            $isAffected = true;

            if ($selected === self::ALL || in_array(self::ALL, (array) $selected, true)) {
                return ['type' => 'all'];
            }

            $uids = array_merge($uids, array_map('strval', (array) $selected));
        }

        return $isAffected ? ['type' => 'uids', 'uids' => array_values(array_unique($uids))] : null;
    }
}
