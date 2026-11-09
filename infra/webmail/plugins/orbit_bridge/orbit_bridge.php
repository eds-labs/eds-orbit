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
    private const AUTHORIZATION_UNSET = false;

    private $rcmail;
    private $bridge;
    private $policy;
    private $loginHandle;
    private $authorization = self::AUTHORIZATION_UNSET;

    public function init()
    {
        $this->rcmail = rcmail::get_instance();
        $this->bridge = new orbit_bridge_client(
            $this->rcmail->get_http_client(),
            (string) $this->rcmail->config->get('orbit_bridge_url'),
            (string) $this->rcmail->config->get('orbit_bridge_secret')
        );
        $this->policy = new orbit_bridge_policy(require __DIR__ . '/actions.inc.php');

        $this->add_texts('localization/');
        $this->shieldCrossOriginParent();
        $this->register_action(self::REFERENCE_ACTION, [$this, 'sendConversionReference']);

        $this->add_hook('startup', [$this, 'startup']);
        $this->add_hook('authenticate', [$this, 'authenticate']);
        $this->add_hook('unauthenticated', [$this, 'unauthenticated']);
        $this->add_hook('user_create', [$this, 'userCreate']);
        $this->add_hook('storage_connect', [$this, 'storageConnect']);
        $this->add_hook('smtp_connect', [$this, 'smtpConnect']);
        $this->add_hook('ready', [$this, 'ready']);
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
                $this->refuseUnauthenticated();
            }

            return $args;
        }

        if (empty($_SESSION['user_id'])) {
            $this->refuseUnauthenticated();
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
        $session = $token !== '' ? $this->bridge->consumeHandoff($token, $origin) : null;

        if (empty($session['handle']) || empty($session['user'])) {
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
        $this->refuseUnauthenticated();

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
            $args['user_name'] = $authorization['displayName'] ?? '';
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
            $this->rcmail->kill_session();
            $this->refuseUnauthenticated();
        }

        $capability = $this->policy->capabilityFor($args['task'], $args['action']);

        if (!in_array($capability, $authorization['capabilities'], true)) {
            $this->rcmail->output->sendExitError(403, $this->gettext('actiondenied'));
        }

        $this->passBarrier($args);
        $this->addConvertButton($args, $authorization);

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

        if (empty($data['UIDVALIDITY'])) {
            $this->rcmail->output->show_message('orbit_bridge.conversionfailed', 'error');
        } else {
            $this->rcmail->output->command(self::REFERENCE_ACTION, [
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

    private function addConvertButton(array $args, array $authorization): void
    {
        $isMessageView = $args['task'] === 'mail' && in_array($args['action'], ['', 'show'], true);

        if (
            !$isMessageView
            || $this->rcmail->output->type !== 'html'
            || !empty($_REQUEST['_framed'])
            || !in_array('convert', $authorization['capabilities'], true)
        ) {
            return;
        }

        $this->rcmail->output->set_env('orbit_parent_origin', $this->parentOrigin());
        $this->include_script('orbit_bridge.js');
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
                : null;
            $this->authorization = empty($result['ok']) ? null : $result;
        }

        return $this->authorization;
    }

    private function sessionHandle(): string
    {
        return (string) ($this->loginHandle ?? $this->rcmail->get_user_password());
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
     * Ends the request without rendering Roundcube's login page.
     */
    private function refuseUnauthenticated(): void
    {
        if ($this->rcmail->output->ajax_call) {
            $this->rcmail->output->command('session_error', $this->rcmail->url(['_err' => 'session']));
            $this->rcmail->output->send();
        }

        http_response_code(403);
        header('Content-Type: text/html; charset=UTF-8');
        echo '<!doctype html><title>Orbit Webmail</title><p>'
            . rcube::Q($this->gettext('openfromorbit'))
            . '</p>';
        exit;
    }
}
