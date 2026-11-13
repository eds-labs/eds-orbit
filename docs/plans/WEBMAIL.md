# Webmail module: implementation contracts

Companion to [ADR 0026](../adr/0026-webmail-module.md). The interfaces the workstreams build against. `apps/api/src/modules/webmail/bridge-contract.ts` is the bridge wire contract, and `apps/api/src/platform/email/{import-contract,shared-client}.ts` are the platform interfaces.

## HTTP API

Base: `/api/projects/:projectId/webmail`. Every route runs through a wrapper like `inSocial` (`scopeFor`, then `requireWebmail`). `WEBMAIL_USE` opens the module; the grant decides per mailbox. A mailbox without a grant answers 404, never 403, so its existence does not leak.

| Method and path | Access | Body or query | Answer |
|---|---|---|---|
| `GET /mailboxes` | use | | `{ origin, mailboxes: [{ id, address, displayName, sensitive, capabilities: { read, send, organize, convert, manage }, status: "ok" \| "error" \| "disabled", sync: "ok" \| "backlog" \| "error", lastError: string \| null }] }`; only mailboxes with `canRead` or `canManage` |
| `POST /mailboxes/:mailboxId/session` | `canRead` | | 201 `{ action, fields: { _task, _action, _orbit_handoff }, expiresAt }`; revokes the member's earlier sessions on this mailbox |
| `DELETE /mailboxes/:mailboxId/session` | use | | 204 |
| `GET /mailboxes/:mailboxId/convert/options` | `canConvert` | | `{ targets: [{ key, label, destinations }] }`; empty when no target is active |
| `GET /mailboxes/:mailboxId/convert/records` | `canConvert` | `?target&q` | `{ records: EmailImportRecordHit[] }` |
| `GET /mailboxes/:mailboxId/convert/status` | `canConvert` | `?folder&uid&uidValidity` | `{ converted: false }` or `{ converted: true, target, recordId, number }` |
| `POST /mailboxes/:mailboxId/convert` | `canConvert` and the target's permission | `{ folder, uid, uidValidity, target, mode: EmailImportMode }` | 200 `{ status: "done", target, recordId, number, duplicate, skippedAttachments }`; 202 `{ status: "pending" }` while another attempt holds the lease |
| `GET /settings` | settings | | `{ connections: [{ connectionId, address, owner, opened: { id, enabled, sensitive, displayName, version } \| null }] }` |
| `POST /settings/mailboxes` | settings | `{ connectionId, displayName?, sensitive? }` | 201 the mailbox; a Finance-owned mailbox also needs `finance.settings` and is always sensitive |
| `PATCH /settings/mailboxes/:mailboxId` | settings | `{ version, enabled?, displayName?, sensitive? }` | the mailbox |
| `DELETE /settings/mailboxes/:mailboxId` | settings | | 204 |
| `GET /mailboxes/:mailboxId/grants` | settings or `canManage` | | `{ members: [{ userId, name, email, grant: {...} \| null }] }` |
| `PUT /mailboxes/:mailboxId/grants/:userId` | settings or `canManage` | `{ canRead, canSend, canOrganize, canConvert, canManage }`; all false removes the row | the grant; revokes the member's sessions on this mailbox |

Error codes: `WEBMAIL_DISABLED`, `WEBMAIL_MAILBOX_NOT_FOUND` (404), `WEBMAIL_MESSAGE_NOT_FOUND` (404), `WEBMAIL_UID_VALIDITY_CHANGED` (409), `WEBMAIL_MESSAGE_TOO_LARGE` (413), `WEBMAIL_TARGET_UNAVAILABLE` (404), `WEBMAIL_MAILBOX_UNAVAILABLE` (409).

Installation status, control-plane metadata only: `GET /api/admin/webmail/status` gives `{ enabled, originConfigured, bridge: "ok" | "unreachable" | "off" }`.

## Sessions and tokens

`WebmailSession` is one member on one mailbox. Handoff (60 s, one use) and handle (absolute 8 h) are HMAC tokens in the form of `modules/social/media/upload-sessions.ts`, each with its own HKDF label over `AUTH_SECRET`, carrying workspace, project and session ids. `authorize` updates `lastSeenAt` at most once a minute and refuses with the codes in `bridge-contract.ts`. The session ends with its Better Auth session.

## Takeover

Target key `support.ticket`. Order: claim row with lease, then `readMailboxMessage`, `inboundRowForImport`, `target.prepare`, one `scoped` transaction that re-checks `attemptId` and runs `target.commit`, then done. On any failure `target.discard`. Scope for the target: `actorScope` for a fresh membership, `moduleScope(fresh, target.owner)`, `authorize(effective, target.permission)`.

## Embedded client

The Orbit page submits a form into the iframe: `POST <origin>/` with the fields from the session call. The client posts `webmailConvertMessage` (`bridge-contract.ts`) to the parent with the exact Orbit origin as `targetOrigin`; the page accepts it only from `WEBMAIL_ORIGIN`.
