<?php

// G4 evidence: the effective values Roundcube resolves after all configuration layers.
define('INSTALL_PATH', '/var/www/html/');
require_once INSTALL_PATH . 'program/include/clisetup.php';

$config = rcube::get_instance()->config;

foreach ([
    'plugins', 'skin', 'show_images', 'identities_level', 'dont_override',
    'imap_cache', 'messages_cache', 'session_name', 'session_auth_name', 'session_samesite',
    'session_path', 'session_domain', 'use_https', 'x_frame_options', 'enable_installer',
    'enable_spellcheck', 'logout_purge', 'logout_expunge', 'imap_host', 'smtp_host',
] as $key) {
    echo $key . ' = ' . json_encode($config->get($key)) . PHP_EOL;
}
