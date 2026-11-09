# ADR 0026: Webmail module (Roundcube as a client of Orbit's mailboxes)

## Status

Accepted by Mario on 2026-11-09 for local implementation. Nothing is deployed. The push to `main`, the schema hash in Coolify, DNS and TLS for the webmail host, production secrets, `ORBIT_WEBMAIL`, `ORBIT_WEBMAIL_REPLICAS` and any mail to real recipients each need their own approval.

Extends [ADR 0009](0009-modular-platform.md) (module contracts). Mailbox ownership between Support and Finance stays as defined by `apps/api/src/platform/email/ownership.ts`.

## Context

Orbit reads project mailboxes over IMAP and runs its own ticket system, but offers no way to work in a mailbox such as `info@` or to turn a single message into a ticket. Roundcube is added as a webmail client on the existing connections. Orbit stays responsible for fetching, Support, Finance and agents; no second mail backend and no mail server are introduced.

Three properties of the existing system shape the decision:

- Roundcube renders untrusted HTML and has a record of exploited flaws (CVE-2025-49113, CVE-2025-68461 in CISA KEV) with roughly monthly security releases on the 1.7 line.
- Polling (`platform/email/inbound.ts`) reads `UID lastUid+1:*` of the INBOX with no flag filter in normal operation, but only `UNSEEN` during first sync, backlog and after a UIDVALIDITY change. A second IMAP client that moves or deletes a message before the next pass makes Orbit miss it for good.
- Orbit's session cookie is host-only and every non-GET API request must carry `Origin == APP_ORIGIN` (`apps/api/src/server.ts`).

## Decision

1. **Separate origin (E1).** Roundcube is served from a sibling host (`WEBMAIL_ORIGIN`, for example `webmail.orbit.eds-labs.io`) and embedded in a sandboxed iframe. It is not served under `/webmail/` on Orbit's origin, where an XSS in a displayed mail would act with the member's Orbit session.
2. **Roundcube holds no mail credentials (E2).** Its user is opaque (`mb-<mailboxId>@orbit.invalid`) and its stored password is an opaque session handle. The `storage_connect` and `smtp_connect` hooks obtain host, login and password per request from the bridge, so the real password exists only in that PHP request's memory.
3. **Internal bridge (E3).** `apps/api/src/webmail-bridge-main.ts` runs as its own service, reachable only on a private network shared with Roundcube and protected by `WEBMAIL_BRIDGE_SECRET`. It stays health-only while the flag is off, like `mcp-main.ts`.
4. **One-time handoff (E4).** An authenticated Orbit request creates a `WebmailSession` and a short-lived signed token. The Orbit page posts it into the iframe, the plugin verifies the `Origin` header against login CSRF, and the bridge consumes it atomically. Tokens are HMAC-signed over the row id with a key derived from `AUTH_SECRET`, so forgeries fail before any database access and no secret is stored; the row is what revokes them. The webmail route alone sends `Referrer-Policy: strict-origin-when-cross-origin`, because Orbit's `same-origin` policy would make the browser send `Origin: null`.
5. **Grants are the only mailbox authority (E5).** `WebmailMailboxGrant` holds read, send, organize, convert and manage. No row means no access; project roles and module activation never imply one, for owners included. Finance-owned mailboxes additionally need `finance.settings`, checked on every request through `mailboxOwner`.
6. **Every request is authorized again (E6).** `session/authorize` checks the Better Auth session, membership, module activation, grant, mailbox state and owner, project pause and `liveSending()`, and returns the vetted host address with the TLS peer name so `assertPublicMailHost` is not bypassed. The plugin maps every Roundcube action to a capability and refuses what is unknown. This is an application-level boundary: code execution inside Roundcube reaches the mailboxes of currently open sessions.
7. **The ticket dialog is native Orbit UI (E7).** A Roundcube button sends an origin-checked `postMessage`; the dialog runs in the Orbit shell and calls the API with the member's own session. Roundcube never writes Orbit data, and the server reads the message again from the mailbox bound to the route.
8. **Module boundary (E8).** The platform contribution `emailImport` (`platform/email/import-contract.ts`) lets Webmail hand a message over without importing Support. The caller derives a scope for the receiving module, so a Webmail role grants nothing in Support; Support adds `support.tickets.import`.
9. **Flag and marker (E9).** Changes to the fetch path apply only with `ORBIT_WEBMAIL=true` and a marker on the mailbox set by the Webmail module, preserved on re-save. Without either, the previous code path runs unchanged.

### Ticket takeover

Idempotent per `(projectId, mailboxId, dedupeKey)`, where `dedupeKey` is sha256 of Message-ID, From and Date, or of the raw message when it has no Message-ID. A claim row carries a lease and an attempt id. IMAP and file storage run outside the transaction; one final transaction re-checks the attempt, writes the ticket and marks the claim done. INBOX messages are ingested through the normal path first, so a takeover cannot make Finance or Support skip them; messages of other folders get an `inbound_emails` row without the polling keys, so retention still finds the original. `channel` stays `"email"`. A new option suppresses AI and domain events. Assignment and notifications remain, and no customer mail is sent.

### Synchronisation

Before Roundcube moves, deletes or expunges INBOX messages, the bridge ingests exactly those UIDs, under the same per-connection lock as the worker's pass. The action is refused if that fails (fail closed). A snapshot of the unseen UIDs keeps a read during backlog from dropping them; a UIDVALIDITY change searches `SINCE` the last pass as well as `UNSEEN`; messages without a Message-ID are deduplicated by a hash of the raw source; a UID above the cursor with an old INTERNALDATE counts as backlog, so no acknowledgement is sent. Mailboxes no module would act on are not stored.

### Proof of concept (2026-11-09)

The design was tested against the real Roundcube 1.7.6 image with a mock bridge in Chromium, Firefox and WebKit (`infra/webmail/poc/REPORT.md`). It changed three things:

- The content security policy needs `script-src 'unsafe-inline' 'unsafe-eval'`: Roundcube's `app.js` evaluates the `exec` field of every AJAX response. Since inline script is required anyway, the policy does not stop script injection; its value lies in `connect-src`, `img-src`, `form-action`, `base-uri`, `object-src` and `frame-ancestors`. A local interpreter that removes `unsafe-eval` works but would patch core behaviour on every upgrade, so it is not shipped.
- `frame-ancestors` also needs `'self'` for Roundcube's own preview frames.
- A small plugin shim keeps `set_unread_message` from aborting under a cross-origin parent.

Cookie and iframe behaviour in real Safari with Intelligent Tracking Prevention and the proxy attachment under Coolify could not be tested locally and are rollout checks. Under Coolify it must also be confirmed that Roundcube cannot reach `api:4311`.

## Consequences

- Monthly Roundcube security updates become an operational duty; the image is pinned by digest.
- Read and write restrictions are enforced in the application, not at the IMAP server.
- One active webmail session per browser. Messages above the existing 10 MB inbound limit cannot be converted. Replies sent from Roundcube are not ticket replies.
- Deleting or moving a brand-new message can be refused for a moment, and is refused while the project's file quota is exhausted.

## Alternatives considered

- **Same-origin `/webmail/`:** rejected, see decision 1.
- **Roundcube's password in its encrypted session:** a compromise of its database and `des_key` would expose every mailbox password that was ever opened, and revocation would not reach open sessions.
- **MCP OAuth as SSO provider:** built for a different audience and token shape, and Roundcube would then need the mail password from a claim.
- **An own webmail UI in Orbit:** remains the fallback if embedding proves unreliable; it means building the whole client.
