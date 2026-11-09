# Webmail proof of concept: results

Roundcube 1.7.6 (`1.7.6-apache-nonroot`, pinned by digest) with a mock bridge, a GreenMail test server and a TLS reverse proxy. Run with `infra/webmail/poc/run.sh`. Local Docker only; no real mailboxes. Final run on 2026-11-09: 168 of 168 Playwright tests (56 each in Chromium, Firefox and WebKit) and `tools/checks.sh` with no failures.

| Gate | Result | Evidence |
|---|---|---|
| G1 Credentials | Pass | `storage_connect` and `smtp_connect` replace login, host and TLS at login and on later requests. TLS by IP plus peer name; a wrong peer is rejected. 291 sessions decrypted to handles, 0 real passwords in the database dump, files or logs. |
| G2 One-time login | Pass | Null, wrong and missing `Origin` rejected before the token is consumed; replay, expiry and a plain login POST refused; a planted session id is replaced. |
| G3 Embedding | Pass with note | Sandboxed iframe, session and download work. `Referrer-Policy: same-origin` gives `Origin: null`, `strict-origin-when-cross-origin` gives the Orbit origin. |
| G4 Hardening | Fail as specified, pass with `'unsafe-eval'` | `__Host-` cookies, no remote image requests, clean docroot, idempotent restart and recreate. |
| G5 Action inventory | Pass | 150 actions, 104 denied. Direct POSTs from a read-only session are refused and the IMAP state stays unchanged. See `action-inventory.md`. |
| G6 Barrier | Pass | `retry` stops the action with a visible message. Multiple UIDs, compound sets, ranges and `*` covered; an unknown answer fails closed. |
| G7 Compose | Pass locally | Replicas 0, 1, 0. A `frontend` service is unreachable by name and by IP. |
| G8 Button | Pass | Single selection only, exact `targetOrigin`, a wrong origin is ignored, UIDVALIDITY read at click time from `folder_data`. |
| G9 Cost | Measured | HTTP requests / authorize calls / IMAP connections: list 3/3/3, message 3/3/2, poll 1/1/1. `authorize` runs once per request and is memoized. |

## Changes the proof of concept forced

1. **`'unsafe-eval'` in `script-src`.** `app.js` evaluates the `exec` field of every AJAX response; without it the mail list stays empty. `'unsafe-inline'` is needed for scripts too. See ADR 0026.
2. **`frame-ancestors 'self'`** alongside the Orbit origin, or Roundcube's own preview frames are blocked and initialisation crashes.
3. **`set_unread_message` reads `parent.rcmail` unguarded.** Under a cross-origin parent this aborted the bootstrap for unread messages. The plugin shadows `window.parent` and keeps `window.orbitParent`.

## Traps for the production build

- Roundcube also dispatches `folder_purge` and `DELETE`, so the policy compares exact names only.
- The barrier handles an empty `_mbox` (the session's folder), `inbox` in any case and `mark` with `_folders=all|sub|cur`. `_uid=*` is sent as `{type:"all"}`.
- Enforcement runs in `ready`, after the CSRF and session checks. Login is gated in `startup` and `authenticate`.
- Opening a message sets `\Seen`, also for read-only sessions.
- `addressbook/photo` is allowed as read.
- A container restart runs composer, which needs egress; a recreate does not.
- The interface still shows `mb-…@orbit.invalid`, and read-only members see buttons the server refuses.

## Not covered

- WebKit dropped iframe cookies on `orbit.test`, which is not under a public suffix; it passes on `orbit.example.com`, which has the production shape. Real Safari with Intelligent Tracking Prevention is untested.
- Browsers ran with `ignoreHTTPSErrors`. STARTTLS is untested, because GreenMail offers implicit TLS only.
- Traefik attachment and `deploy.replicas` under Coolify are rollout checks, as is confirming that Roundcube cannot reach `api:4311` there.
