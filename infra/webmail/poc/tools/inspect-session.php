<?php

// G1 evidence: decrypts stored Roundcube sessions with des_key and verifies that they
// hold only opaque values. Prints conclusions, never the stored values themselves.
define('INSTALL_PATH', '/var/www/html/');
require_once INSTALL_PATH . 'program/include/clisetup.php';

$rcmail = rcube::get_instance(rcube::INIT_WITH_DB);
$db = $rcmail->get_dbh();
$secrets = array_filter([getenv('POC_SECRET_1'), getenv('POC_SECRET_2')]);
$failures = 0;

$contains = static function (string $haystack) use ($secrets): bool {
    foreach ($secrets as $secret) {
        if (str_contains($haystack, $secret)) {
            return true;
        }
    }

    return false;
};

$check = static function (bool $ok, string $label) use (&$failures): void {
    echo ($ok ? 'PASS ' : 'FAIL ') . $label . PHP_EOL;
    $failures += $ok ? 0 : 1;
};

session_start();
$sessions = 0;
$withPassword = 0;
$handles = [];
$result = $db->query('SELECT vars FROM ' . $db->table_name('session', true));

while ($row = $db->fetch_assoc($result)) {
    $sessions++;
    $raw = base64_decode($row['vars']);
    $check(!$contains($raw), 'session row has no real password in its serialized form');
    $_SESSION = [];
    session_decode($raw);

    if (empty($_SESSION['password'])) {
        continue;
    }

    $withPassword++;
    $handle = (string) $rcmail->decrypt($_SESSION['password']);
    $handles[$handle] = true;
    $check(strlen($handle) >= 40 && !$contains($handle), 'decrypted session password is an opaque handle');
    $check(str_ends_with((string) $_SESSION['username'], '@orbit.invalid'), 'session username is opaque');
    $check((string) $_SESSION['storage_host'] === 'orbit.invalid', 'session storage host is the placeholder');
}

echo "sessions={$sessions} with_password={$withPassword} distinct_handles=" . count($handles) . PHP_EOL;
$check($withPassword > 0, 'at least one authenticated session was inspected');

$result = $db->query('SELECT username, mail_host, preferences FROM ' . $db->table_name('users', true));

while ($row = $db->fetch_assoc($result)) {
    $check((bool) preg_match('/^mb-[a-z0-9-]+@orbit\.invalid$/', $row['username']), 'users.username is opaque: ' . $row['username']);
    $check($row['mail_host'] === 'orbit.invalid', 'users.mail_host is the placeholder');
    $check(!$contains((string) $row['preferences']), 'users.preferences has no real password');
}

$result = $db->query('SELECT email FROM ' . $db->table_name('identities', true));

while ($row = $db->fetch_assoc($result)) {
    echo 'identity email: ' . $row['email'] . PHP_EOL;
}

exit($failures > 0 ? 1 : 0);
