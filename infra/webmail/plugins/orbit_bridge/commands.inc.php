<?php

// Roundcube client commands switched off in the browser, so that the interface does not
// offer what the session cannot do. This is presentation only: actions.inc.php and the
// "ready" hook are the control. A command missing here stays visible and is refused
// by the server.

return [
    // Features that do not exist inside Orbit, whatever the session may do.
    'never' => [
        'about',
        'add-contact',
        'addressbook',
        'always-load',
        'extwin',
        'folders',
        'insert-response',
        'logout',
        'open',
        'settings',
    ],
    'send' => [
        'bounce',
        'compose',
        'edit',
        'forward',
        'forward-attachment',
        'forward-inline',
        'reply',
        'reply-all',
        'reply-list',
    ],
    'organize' => [
        'copy',
        'delete',
        'expunge',
        'import-messages',
        'mark',
        'mark-all-read',
        'move',
        'purge',
        'toggle_flag',
        'toggle_status',
    ],
];
