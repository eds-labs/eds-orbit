<?php

require_once __DIR__ . '/lib/orbit_bridge_client.php';
require_once __DIR__ . '/lib/orbit_bridge_policy.php';
require_once __DIR__ . '/lib/orbit_bridge_barrier.php';

/**
 * Connects Roundcube to Orbit.
 *
 * Roundcube only ever knows an opaque user and a session handle. The real credentials
 * come from the bridge on each request and stay in PHP memory for that request.
 * Login happens exclusively through a one-time handoff, and every action must be on
 * the capability allowlist before its handler runs.
 */
class orbit_bridge extends rcube_plugin
{
    private const HANDOFF_FIELD = '_orbit_handoff';
    private const PLACEHOLDER_HOST = 'orbit.invalid';
    private const CONVERT_COMMAND = 'plugin.orbit_bridge.convert';
    private const REFERENCE_ACTION = 'plugin.orbit_bridge.convert_reference';
    private const REFERENCE_FAILED_ACTION = 'plugin.orbit_bridge.convert_failed';
    private const SESSION_LOST_ACTION = 'plugin.orbit_bridge.session_lost';
    private const AUTHORIZATION_UNSET = false;

    private const REASON_NO_SESSION = 'no_session';
    private const REASON_HANDOFF_FAILED = 'handoff_failed';

    // The session stays intact, so the next request can succeed without a new handoff.
    private const TEMPORARY_REASONS = ['mailbox_unavailable', orbit_bridge_client::UNAVAILABLE];

    private const REASON_MESSAGES = [
        'session_unknown' => 'sessionended',
        'session_revoked' => 'sessionended',
        'session_expired' => 'sessionended',
        'not_authorized' => 'notauthorized',
        'mailbox_unavailable' => 'mailboxunavailable',
        orbit_bridge_client::UNAVAILABLE => 'bridgeunavailable',
        self::REASON_NO_SESSION => 'openfromorbit',
        self::REASON_HANDOFF_FAILED => 'openfromorbit',
    ];

    private const SEEN_FLAG_NEVER = -1;
    private const MDN_REQUESTS_IGNORE = 2;

    // Without allow-scripts, allow-same-origin is safe and keeps Roundcube's image tools
    // working on the frame. Both policies apply: this one only adds to Apache's.
    private const RAW_CONTENT_SANDBOX = 'Content-Security-Policy: sandbox allow-same-origin allow-downloads allow-popups';

    private $rcmail;
    private $bridge;
    private $policy;
    private $loginHandle;
    private $refusal = self::REASON_HANDOFF_FAILED;
    private $authorization = self::AUTHORIZATION_UNSET;

    public function init()
    {
        $this->rcmail = rcmail::get_instance();
        $this->bridge = new orbit_bridge_client(
            $this->rcmail->get_http_client(),
            (string) $this->rcmail->config->get('orbit_bridge_url'),
            (string) $this->rcmail->config->get('orbit_bridge_secret')
        );
        $this->policy = new orbit_bridge_policy(
            require __DIR__ . '/actions.inc.php',
            require __DIR__ . '/commands.inc.php'
        );

        $this->add_texts('localization/');
        $this->shieldCrossOriginParent();
        $this->register_action(self::REFERENCE_ACTION, [$this, 'sendConversionReference']);

        $this->add_hook('startup', [$this, 'startup']);
        $this->add_hook('authenticate', [$this, 'authenticate']);
        $this->add_hook('unauthenticated', [$this, 'unauthenticated']);
        $this->add_hook('user_create', [$this, 'userCreate']);
        $this->add_hook('login_after', [$this, 'loginAfter']);
        $this->add_hook('storage_connect', [$this, 'storageConnect']);
        $this->add_hook('smtp_connect', [$this, 'smtpConnect']);
        $this->add_hook('ready', [$this, 'ready']);
        $this->add_hook('template_object_username', [$this, 'showMailboxName']);
        $this->add_hook('message_before_send', [$this, 'messageBeforeSend']);
        $this->add_hook('session_destroy', [$this, 'sessionDestroy']);
    }

    /**
     * Runs before login handling, so it is the one place that can stop every
     * unauthenticated request, including a plain credential POST.
     */
    public function startup($args)
    {
        if ($args['task'] === 'login' && $args['action'] === 'login') {
            if (!$this->isValidHandoffRequest()) {
                $this->refuse(self::REASON_HANDOFF_FAILED);
            }

            return $args;
        }

        if (empty($_SESSION['user_id'])) {
            $this->refuse(self::REASON_NO_SESSION);
        }

        return $args;
    }

    /**
     * Replaces form credentials with the result of the one-time handoff.
     */
    public function authenticate($args)
    {
        $token = (string) rcube_utils::get_input_string(self::HANDOFF_FIELD, rcube_utils::INPUT_POST);
        $origin = (string) ($_SERVER['HTTP_ORIGIN'] ?? '');
        $session = $token !== '' ? $this->bridge->consumeHandoff($token, $origin) : [];

        if (empty($session['handle']) || empty($session['user'])) {
            // The core keeps a live session when a login fails and goes on to serve this
            // request in it, so Orbit would never learn that its handoff failed.
            if (!empty($_SESSION['user_id'])) {
                $this->refuse(self::REASON_HANDOFF_FAILED);
            }

            $args['valid'] = false;
            $args['abort'] = true;

            return $args;
        }

        // The core only discards an existing session when its own CSRF token validates.
        $this->rcmail->kill_session();

        $this->loginHandle = $session['handle'];
        $args['user'] = $session['user'];
        $args['pass'] = $session['handle'];
        $args['host'] = self::PLACEHOLDER_HOST;
        $args['valid'] = true;
        $args['abort'] = false;
        // The first POST into the iframe arrives without any cookie.
        $args['cookiecheck'] = false;

        return $args;
    }

    /**
     * Covers failed logins and logouts, which would otherwise render the login page.
     */
    public function unauthenticated($args)
    {
        $this->refuse($this->refusal);

        return $args;
    }

    /**
     * Stores the mailbox address on the identity created with the opaque user.
     */
    public function userCreate($args)
    {
        $authorization = $this->authorization();

        if ($authorization) {
            $args['user_email'] = $authorization['email'];
            $args['user_name'] = $this->mailboxName($authorization);
        }

        return $args;
    }

    /**
     * The mailbox can be renamed in Orbit after its Roundcube user was created.
     */
    public function loginAfter($args)
    {
        $authorization = $this->authorization();
        $identity = $authorization ? $this->rcmail->user->get_identity() : null;

        if ($identity) {
            $current = ['name' => $this->mailboxName($authorization), 'email' => $authorization['email']];

            if ($identity['name'] !== $current['name'] || $identity['email'] !== $current['email']) {
                $this->rcmail->user->update_identity($identity['identity_id'], $current);
            }
        }

        return $args;
    }

    public function storageConnect($args)
    {
        $authorization = $this->authorization();

        // An empty host makes the IMAP client fail without opening a socket.
        if (!$authorization) {
            $args['host'] = '';

            return $args;
        }

        $imap = $authorization['imap'];
        $args['host'] = $imap['host'];
        $args['port'] = $imap['port'];
        $args['user'] = $imap['user'];
        $args['pass'] = $imap['password'];
        $args['ssl_mode'] = $imap['tlsMode'] === 'none' ? null : $imap['tlsMode'];
        $args['socket_options'] = $this->tlsOptions($imap);

        return $args;
    }

    public function smtpConnect($args)
    {
        $authorization = $this->authorization();

        if (!$authorization) {
            $args['smtp_host'] = self::PLACEHOLDER_HOST . ':1';

            return $args;
        }

        $smtp = $authorization['smtp'];
        $scheme = $smtp['tlsMode'] === 'none' ? '' : $smtp['tlsMode'] . '://';
        $args['smtp_host'] = $scheme . $smtp['host'] . ':' . $smtp['port'];
        $args['smtp_user'] = $smtp['user'];
        $args['smtp_pass'] = $smtp['password'];
        $args['smtp_conn_options'] = $this->tlsOptions($smtp);

        return $args;
    }

    /**
     * Enforcement point: the session and CSRF token are verified and no handler has run.
     */
    public function ready($args)
    {
        $authorization = $this->authorization();

        if (!$authorization) {
            $this->refuse($this->refusal);
        }

        $capability = $this->policy->capabilityFor($args['task'], $args['action']);

        if (!in_array($capability, $authorization['capabilities'], true)) {
            $this->rcmail->output->sendExitError(403, $this->gettext('actiondenied'));
        }

        $this->passBarrier($args);
        $this->applyCapabilities($args, $authorization);
        $this->sandboxRawContent($args);

        return $args;
    }

    /**
     * Roundcube would show the opaque login name here.
     */
    public function showMailboxName($args)
    {
        $authorization = $this->authorization();

        if ($authorization) {
            $name = $this->mailboxName($authorization);
            $email = $authorization['email'];
            $args['content'] = ($name !== $email ? html::span('orbit-mailbox-name', rcube::Q($name)) . ' ' : '')
                . html::span('orbit-mailbox-address', rcube::Q($email));
        }

        return $args;
    }

    /**
     * Sent addresses must match the mailbox, whatever the compose form contains.
     */
    public function messageBeforeSend($args)
    {
        $authorization = $this->authorization();

        if (!$authorization || strcasecmp((string) $args['from'], (string) $authorization['email']) !== 0) {
            $args['abort'] = true;
            $args['error'] = $this->gettext('senderdenied');
        }

        return $args;
    }

    public function sessionDestroy($args)
    {
        $handle = $this->sessionHandle();

        if ($handle !== '') {
            $this->bridge->endSession($handle, $this->rcmail->task === 'logout' ? 'logout' : 'session_destroy');
        }

        return $args;
    }

    /**
     * Returns the IMAP reference of one message. The UIDVALIDITY comes from the server
     * at click time, so the Orbit dialog never acts on a stale reference.
     */
    public function sendConversionReference()
    {
        $uid = (string) rcube_utils::get_input_string('_uid', rcube_utils::INPUT_POST);
        $folder = (string) rcube_utils::get_input_string('_mbox', rcube_utils::INPUT_POST, true);
        $data = ctype_digit($uid) && $folder !== '' ? $this->rcmail->get_storage()->folder_data($folder) : [];
        $mailboxId = $this->mailboxId();

        if (empty($data['UIDVALIDITY']) || $mailboxId === null) {
            $this->rcmail->output->show_message('orbit_bridge.conversionfailed', 'error');
            $this->rcmail->output->command(self::REFERENCE_FAILED_ACTION);
        } else {
            $this->rcmail->output->command(self::REFERENCE_ACTION, [
                'mailboxId' => $mailboxId,
                'folder' => $folder,
                'uid' => (int) $uid,
                'uidValidity' => (int) $data['UIDVALIDITY'],
            ]);
        }

        $this->rcmail->output->send();
    }

    /**
     * Roundcube reads parent.rcmail outside its framed code paths, for example when
     * opening an unread message, which throws and aborts the page's bootstrap script
     * under a cross-origin parent. Keeping the real parent for postMessage and shadowing
     * window.parent makes those reads resolve to this window. Same-origin parents of
     * Roundcube's own frames are left alone.
     */
    private function shieldCrossOriginParent(): void
    {
        if ($this->rcmail->output->type === 'html') {
            $this->rcmail->output->add_script(
                'try { void window.parent.rcmail; } catch (e) { window.orbitParent = window.parent; window.parent = window; }',
                'head_top'
            );
        }
    }

    private function passBarrier(array $args): void
    {
        $request = orbit_bridge_barrier::requestFor($args['task'], $args['action']);

        if ($request === null) {
            return;
        }

        $result = $this->bridge->barrier($this->sessionHandle(), $request);

        if (($result['status'] ?? null) === 'ok') {
            return;
        }

        if (!$this->rcmail->output->ajax_call) {
            $this->rcmail->output->sendExitError(409, $this->gettext('barrierretry'));
        }

        // The client removes rows optimistically, so it has to reload the list.
        $this->rcmail->output->show_message('orbit_bridge.barrierretry', 'error');
        $this->rcmail->output->command('list_mailbox');
        $this->rcmail->output->send();
    }

    /**
     * Keeps both the behaviour and the interface of this request within the session's
     * capabilities. The action check in ready() stays the actual control.
     */
    private function applyCapabilities(array $args, array $authorization): void
    {
        $capabilities = $authorization['capabilities'];

        // Reading must not change a mailbox the session may not organize: \Seen is set
        // on open otherwise, and it is visible to every other client of the mailbox.
        if (!in_array('organize', $capabilities, true)) {
            $this->rcmail->config->set('mail_read_time', self::SEEN_FLAG_NEVER);
        }

        if (!in_array('send', $capabilities, true)) {
            $this->rcmail->config->set('mdn_requests', self::MDN_REQUESTS_IGNORE);
        }

        if ($this->rcmail->output->type !== 'html') {
            return;
        }

        $canConvert = in_array('convert', $capabilities, true);

        $this->rcmail->output->set_env('orbit_parent_origin', $this->parentOrigin());
        $this->rcmail->output->set_env('orbit_can_convert', $canConvert);
        $this->rcmail->output->set_env('orbit_disabled_commands', $this->policy->disabledCommands($capabilities));
        $this->include_script('orbit_bridge.js');
        $this->markDocument($capabilities);

        if ($canConvert) {
            $this->rcmail->output->set_env('orbit_convert_link', $this->conversionLink($authorization));
            $this->rcmail->output->add_label('orbit_bridge.conversionfailed');
            $this->addConvertButton($args);
        }
    }

    /**
     * Start of the Orbit link the convert button opens when this page is not embedded.
     * Null while the bridge does not name the project: the button then reports failure.
     */
    private function conversionLink(array $authorization): ?string
    {
        $projectId = $authorization['projectId'] ?? null;
        $mailboxId = $this->mailboxId();

        if (!is_string($projectId) || $projectId === '' || $mailboxId === null) {
            return null;
        }

        return sprintf(
            '%s/p/%s/webmail?mailbox=%s',
            $this->parentOrigin(),
            rawurlencode($projectId),
            rawurlencode($mailboxId)
        );
    }

    /**
     * The session's mailbox, read from the opaque user `mb-<id>@orbit.invalid`.
     */
    private function mailboxId(): ?string
    {
        return preg_match('/^mb-([^@]+)@orbit\.invalid$/', (string) $this->rcmail->get_user_name(), $opaqueUser)
            ? $opaqueUser[1]
            : null;
    }

    /**
     * Mail content served as its own document, such as an SVG attachment, would otherwise
     * run under the page policy, which has to allow inline script. Roundcube's own pages
     * around attachments need script, and the browsers' PDF viewers cannot be verified
     * under a sandbox; neither runs mail content as script here.
     */
    private function sandboxRawContent(array $args): void
    {
        if ($args['task'] !== 'mail' || !in_array($args['action'], ['get', 'viewsource'], true)) {
            return;
        }

        header_register_callback(static function (): void {
            foreach (headers_list() as $header) {
                if (preg_match('~^content-type:\s*(text/html|application/pdf)~i', $header)) {
                    return;
                }
            }

            header(self::RAW_CONTENT_SANDBOX, false);
        });
    }

    /**
     * The skin hides forbidden controls by these classes. They are set before the first
     * paint, so forbidden buttons never flash.
     */
    private function markDocument(array $capabilities): void
    {
        $missing = array_diff(['send', 'organize', 'convert'], $capabilities);

        if ($missing) {
            $classes = array_map(static fn ($capability) => 'orbit-no-' . $capability, array_values($missing));
            $this->rcmail->output->add_script(
                'document.documentElement.classList.add(' . implode(',', array_map('json_encode', $classes)) . ');',
                'head_top'
            );
        }
    }

    private function addConvertButton(array $args): void
    {
        $isMessageView = $args['task'] === 'mail' && in_array($args['action'], ['', 'show'], true);

        if (!$isMessageView || !empty($_REQUEST['_framed'])) {
            return;
        }

        $this->add_button([
            'type' => 'link',
            'command' => self::CONVERT_COMMAND,
            'class' => 'button orbit-convert disabled',
            'classact' => 'button orbit-convert',
            'label' => 'orbit_bridge.convert',
            'title' => 'orbit_bridge.converttitle',
            'innerclass' => 'inner',
        ], 'toolbar');
    }

    /**
     * Fetches the session authorization once per HTTP request and reuses it for
     * action checks, IMAP and SMTP.
     */
    private function authorization(): ?array
    {
        if ($this->authorization === self::AUTHORIZATION_UNSET) {
            $handle = $this->sessionHandle();
            $result = $handle !== ''
                ? $this->bridge->authorize($handle, (string) $this->rcmail->task, (string) $this->rcmail->action)
                : ['error' => self::REASON_NO_SESSION];

            if ($this->isAuthorization($result)) {
                $this->authorization = $result;
            } else {
                $this->authorization = null;
                $this->refusal = $this->knownReason($result['error'] ?? null);
            }
        }

        return $this->authorization;
    }

    private function isAuthorization(array $result): bool
    {
        return ($result['ok'] ?? false) === true
            && is_array($result['capabilities'] ?? null)
            && is_string($result['email'] ?? null)
            && is_array($result['imap'] ?? null)
            && is_array($result['smtp'] ?? null);
    }

    private function knownReason($code): string
    {
        return is_string($code) && isset(self::REASON_MESSAGES[$code]) ? $code : orbit_bridge_client::UNAVAILABLE;
    }

    private function sessionHandle(): string
    {
        return (string) ($this->loginHandle ?? $this->rcmail->get_user_password());
    }

    private function mailboxName(array $authorization): string
    {
        $name = trim((string) ($authorization['displayName'] ?? ''));

        return $name !== '' ? $name : $authorization['email'];
    }

    private function tlsOptions(array $server): ?array
    {
        if ($server['tlsMode'] === 'none') {
            return null;
        }

        $options = [
            'verify_peer' => true,
            'verify_peer_name' => true,
            'allow_self_signed' => false,
            'peer_name' => $server['tlsPeerName'],
        ];
        $caFile = (string) $this->rcmail->config->get('orbit_tls_ca_file');

        if ($caFile !== '') {
            $options['cafile'] = $caFile;
        }

        return ['ssl' => $options];
    }

    private function parentOrigin(): string
    {
        return (string) $this->rcmail->config->get('orbit_parent_origin');
    }

    private function isValidHandoffRequest(): bool
    {
        return ($_SERVER['REQUEST_METHOD'] ?? '') === 'POST'
            && !empty($_POST[self::HANDOFF_FIELD])
            && ($_SERVER['HTTP_ORIGIN'] ?? '') !== ''
            && hash_equals($this->parentOrigin(), (string) $_SERVER['HTTP_ORIGIN']);
    }

    /**
     * Ends the request without rendering Roundcube's login page and tells the member
     * and the Orbit page why.
     */
    private function refuse(string $reason): void
    {
        $isTemporary = in_array($reason, self::TEMPORARY_REASONS, true);
        // A request to the login action that is no handoff, such as a link in a mail,
        // must not end the session it arrives in.
        $isStrayLogin = $reason === self::REASON_HANDOFF_FAILED
            && !empty($_SESSION['user_id'])
            && !$this->isValidHandoffRequest();
        $sessionEnded = !$isTemporary && !$isStrayLogin;

        if ($sessionEnded && !empty($_SESSION['user_id'])) {
            $this->rcmail->kill_session();
        }

        if ($this->rcmail->output->ajax_call) {
            $this->sendRefusalResponse($reason, $sessionEnded);
        }

        // A temporary failure inside a preview frame is not worth interrupting the member for.
        $reportToOrbit = $sessionEnded || ($isTemporary && empty($_REQUEST['_framed']));
        $this->sendRefusalPage($reason, $isTemporary ? 503 : 403, $reportToOrbit);
    }

    private function sendRefusalResponse(string $reason, bool $sessionEnded): void
    {
        $output = $this->rcmail->output;
        $output->show_message('orbit_bridge.' . self::REASON_MESSAGES[$reason], 'error');

        // Without a URL the client keeps the page, so a message being written stays visible.
        if ($sessionEnded) {
            $output->command('session_error');
            $output->command(self::SESSION_LOST_ACTION, ['reason' => $reason]);
        }

        $output->send();
    }

    private function sendRefusalPage(string $reason, int $status, bool $reportToOrbit): void
    {
        http_response_code($status);
        header('Content-Type: text/html; charset=UTF-8');
        header('Cache-Control: no-store');

        $language = substr((string) $this->rcmail->get_user_language(), 0, 2);

        echo '<!doctype html><html lang="' . rcube::Q($language ?: 'en') . '"><meta charset="utf-8">'
            . '<meta name="viewport" content="width=device-width, initial-scale=1">'
            . '<title>Orbit Webmail</title>'
            . '<style>'
            . 'html{color-scheme:light dark;font:14px/1.5 Inter,ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}'
            . 'body{margin:0;min-height:100vh;display:grid;place-items:center;padding:16px;box-sizing:border-box;background:#f7fcff;color:#071522}'
            . 'p{max-width:32em;margin:0;text-align:center}'
            . '@media (prefers-color-scheme:dark){body{background:#0e2739;color:#e6f1fa}}'
            . '</style>'
            . '<p>' . rcube::Q($this->gettext(self::REASON_MESSAGES[$reason])) . '</p>'
            . ($reportToOrbit ? $this->sessionLostScript($reason) : '');

        exit;
    }

    /**
     * A refused document cannot use the plugin script. Roundcube's own preview frames
     * hand the event to their parent page, which reports it to Orbit once.
     */
    private function sessionLostScript(string $reason): string
    {
        $origin = $this->parentOrigin();

        if ($origin === '') {
            return '';
        }

        $flags = JSON_HEX_TAG | JSON_HEX_AMP | JSON_HEX_APOS | JSON_HEX_QUOT | JSON_UNESCAPED_SLASHES;
        $details = json_encode(['reason' => $reason], $flags);
        $message = json_encode(['type' => 'orbit.webmail.session_lost', 'reason' => $reason], $flags);

        return '<script>(function(){var p=window.parent;if(p===window){return;}'
            . 'try{if(p.rcmail){p.rcmail.triggerEvent(' . json_encode(self::SESSION_LOST_ACTION, $flags) . ',' . $details . ');return;}}catch(e){}'
            . 'p.postMessage(' . $message . ',' . json_encode($origin, $flags) . ');})();</script>';
    }
}
