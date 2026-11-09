<?php

// Capability required for each Roundcube action. Anything not listed is denied.
// "*" holds actions the core dispatches under every task.
// Generated inventory and rationale: infra/webmail/poc/action-inventory.md.

return [
    '*' => [
        'keep-alive' => 'read',
        'save-pref' => 'read',
    ],
    'mail' => [
        'index' => 'read',
        'list' => 'read',
        'show' => 'read',
        'preview' => 'read',
        'print' => 'read',
        'get' => 'read',
        'viewsource' => 'read',
        'headers' => 'read',
        'pagenav' => 'read',
        'search' => 'read',
        'check-recent' => 'read',
        'refresh' => 'read',
        'getunread' => 'read',

        'compose' => 'send',
        'send' => 'send',
        'sendmdn' => 'send',
        'bounce' => 'send',
        'autocomplete' => 'send',
        'list-contacts' => 'send',
        'search-contacts' => 'send',
        'group-expand' => 'send',
        'attachment-upload' => 'send',
        'upload' => 'send',
        'attachment-delete' => 'send',
        'remove-attachment' => 'send',
        'attachment-rename' => 'send',
        'rename-attachment' => 'send',
        'attachment-display' => 'send',
        'display-attachment' => 'send',

        'move' => 'organize',
        'copy' => 'organize',
        'delete' => 'organize',
        'mark' => 'organize',
        'import' => 'organize',
        'folder-expunge' => 'organize',
        'expunge' => 'organize',
        'folder-purge' => 'organize',
        'purge' => 'organize',

        'plugin.orbit_bridge.convert_reference' => 'convert',
    ],
    'addressbook' => [
        // The message header requests a sender photo; without one it returns a placeholder.
        'photo' => 'read',
    ],
    'utils' => [
        'error' => 'read',
        'html2text' => 'send',
        'text2html' => 'send',
    ],
];
