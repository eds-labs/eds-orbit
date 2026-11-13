<?php

// Orbit webmail configuration, baked into the image as config/config.inc.php. The
// container filesystem is read-only, so every deployment value comes from the
// environment and nothing is generated at start.

$orbitDbUrl = sprintf(
    'pgsql://%s:%s@%s:%s/%s',
    rawurlencode((string) getenv('ROUNDCUBEMAIL_DB_USER')),
    rawurlencode((string) getenv('ROUNDCUBEMAIL_DB_PASSWORD')),
    (string) getenv('ROUNDCUBEMAIL_DB_HOST'),
    (string) getenv('ROUNDCUBEMAIL_DB_PORT'),
    rawurlencode((string) getenv('ROUNDCUBEMAIL_DB_NAME'))
);

$config['db_dsnw'] = $orbitDbUrl;
$config['request_path'] = '/';
$config['temp_dir'] = '/tmp/roundcube-temp';

// The secret has any length; AES-256 needs exactly 32 bytes. Only the opaque session
// handle is encrypted with this key.
$config['des_key'] = hash('sha256', (string) getenv('ROUNDCUBEMAIL_DES_KEY'), true);
$config['cipher_method'] = 'AES-256-CBC';

$config['plugins'] = ['orbit_bridge'];
$config['skin'] = 'orbit';
$config['skin_allow'] = ['orbit'];
$config['product_name'] = 'Orbit Webmail';
$config['display_product_info'] = 0;

// Connection targets are replaced per request by the storage_connect and smtp_connect
// hooks. These placeholders never resolve, so a missing hook cannot reach a real server.
$config['imap_host'] = 'orbit.invalid:143';
$config['smtp_host'] = 'orbit.invalid:587';
$config['smtp_user'] = '%u';
$config['smtp_pass'] = '%p';
$config['username_domain'] = '';
$config['auto_create_user'] = true;

// Bridge connection and the single origin allowed to start a session and embed the UI.
$config['orbit_bridge_url'] = (string) getenv('ORBIT_WEBMAIL_BRIDGE_URL');
$config['orbit_bridge_secret'] = (string) getenv('ORBIT_WEBMAIL_BRIDGE_SECRET');
$config['orbit_parent_origin'] = (string) getenv('ORBIT_WEBMAIL_PARENT_ORIGIN');
$config['orbit_tls_ca_file'] = (string) getenv('ORBIT_WEBMAIL_TLS_CA_FILE');

// Session cookies: host-only, HTTPS-only, never sent cross-site.
$config['use_https'] = true;
$config['session_name'] = '__Host-orbit_webmail_sid';
$config['session_auth_name'] = '__Host-orbit_webmail_auth';
$config['session_path'] = '/';
$config['session_domain'] = '';
$config['session_samesite'] = 'Strict';
$config['session_lifetime'] = 30;

// Embedding is governed by the CSP frame-ancestors directive set in Apache.
$config['x_frame_options'] = false;

// Remote content and identities cannot be changed by the mailbox user.
$config['show_images'] = 0;
$config['identities_level'] = 4;
$config['dont_override'] = [
    'show_images',
    'skin',
    'logout_purge',
    'logout_expunge',
    'skip_deleted',
    'flag_for_deletion',
    'delete_junk',
    'read_when_deleted',
    'mail_read_time',
    'mdn_requests',
    // All members of a mailbox share one Roundcube user, so the stored language would
    // be that of whoever opened it first. Without it, the browser's language applies.
    'language',
    'collected_recipients',
    'collected_senders',
];

// Addresses kept here would outlive Orbit's retention and erasure, in this database
// and in its backups.
$config['collected_recipients'] = false;
$config['collected_senders'] = false;

// Nothing that could reveal mailbox content or tolerate destructive automation.
$config['imap_cache'] = null;
$config['messages_cache'] = false;
$config['logout_purge'] = false;
$config['logout_expunge'] = false;
$config['skip_deleted'] = false;
$config['flag_for_deletion'] = false;
$config['delete_junk'] = false;

// The plugin tightens these per session for capabilities the member does not have.
$config['mail_read_time'] = 0;
$config['mdn_requests'] = 0;

// Features that are out of scope for the embedded client.
$config['enable_spellcheck'] = false;
$config['enable_installer'] = false;
$config['log_driver'] = 'stdout';
$config['log_logins'] = false;
$config['imap_debug'] = false;
$config['smtp_debug'] = false;
$config['sql_debug'] = false;
$config['support_url'] = '';
