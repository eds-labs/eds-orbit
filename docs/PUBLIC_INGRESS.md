# Public ingress

Public ingress is everything Orbit accepts without a member's session: signed provider webhooks and the modules' public APIs (WP4.2). It is off unless `ORBIT_PUBLIC_INGRESS=true`. While it is off, every path below answers 404 before the body is parsed.

Switching the flag on in production needs two things first: the security reviews of WP4.2a and WP4.2b in `docs/SECURITY_REVIEW.md` (done 2026-10-17, findings PI-1 to PI-8 fixed), and Mario's approval for that step.

## Routes

| Path                                                               | Who calls it                                                     | Authenticated by                                          |
| ------------------------------------------------------------------ | ---------------------------------------------------------------- | --------------------------------------------------------- |
| `POST /api/hooks/<provider>/<workspace>/<project>/<connection>`    | a provider (a module's webhook, Slack, the owner's Telegram bot) | the provider's secret on that connection                  |
| `/api/public/<module>/<publicKey>/...`                             | browsers on a key's allowed origins, and servers                 | the key, its origins, and a public session's bearer token |
| `GET/POST /api/projects/<id>/public-keys`, `POST …/<keyId>/revoke` | project owners                                                   | the member session (owner role)                           |

There are two kinds of webhook provider:

- **Signed providers** (`SignedWebhookProvider`) are stored as `inbound_webhooks` and processed by the module's worker job. A replayed message id gets 409. The message id must be covered by the provider's signature; otherwise a captured delivery could be replayed under a new id.
- **Direct providers** (`DirectWebhookProvider`) answer within the request.
  - `telegram`: JSON.
  - `slack`: form-encoded.

  Each checks its own secret against its own connection exactly as on its old route.

## Limits

- Hooks: 120 calls per minute per connection, and 600 per minute per client address across all hooks. JSON only for signed providers, up to 256 KB.
- Public API: 20 new sessions per minute per key and client address, 120 calls per minute per session, and 300 per minute per key and client address. JSON only, up to 64 KB.
- The client address is the browser's, as the web proxy forwards it (`X-Orbit-Client-IP`), not the proxy's own.

## Web proxy

Every call reaches the API through the web app's `/api` proxy, which forwards only listed headers:

- under `/api/public/`, also `Authorization` (the session's bearer token);
- under `/api/hooks/`, every header except cookies, hop-by-hop headers and the proxy-only `x-orbit-*` and `x-forwarded-*`, because providers sign with headers of their own choosing.

## Data kept

- **Public sessions** (`public_sessions`) hold a SHA-256 of the token, never the token. They are valid for 12 hours and deleted one hour after they expire.
- **Received webhooks** (`inbound_webhooks`) are kept 30 days, then deleted with their versions.

Both are purged hourly per project by the platform task `public-ingress-cleanup`, and by the project's retention action. Neither kind is part of a project export.

## Public keys

Owners manage keys under Project access → Public keys.

- A key belongs to one module that has a public API. Production has no such module yet, so no key can be issued there.
- Allowed origins are exact: `https://` with host and port, no path, at most ten. `http://localhost` and `http://127.0.0.1` are allowed for development.
- A key is an identifier, not a secret. Revoking it makes its API answer 404 at once.

## Cutover of Slack and Telegram

Slack interactions and the owner's bot are reachable through the hooks route as well as through their old routes:

| Old URL (registered today)                      | Hooks URL                                                   |
| ----------------------------------------------- | ----------------------------------------------------------- |
| `/api/slack/<workspace>/<project>/interactions` | `/api/hooks/slack/<workspace>/<project>/<slackConnectorId>` |
| `/api/telegram/<project>/<connection>`          | `/api/hooks/telegram/<workspace>/<project>/<connection>`    |

The old URLs stay the registered ones until the cutover. A bot or Slack app moved to a hooks URL would stop working the moment the flag is switched off again. So the cutover waits until the flag has run stably in production. Each step needs Mario's approval:

1. `ORBIT_PUBLIC_INGRESS=true` in production, after the security review.
2. A change that registers the hooks URL:
   - `connectTelegram` calls `setWebhook` with the hooks URL;
   - the Slack connection view shows the hooks URL.
3. Existing bots: the owner connects the bot again, which registers the new URL. In the Slack app, the interactivity URL is changed by hand.
4. After a quiet week: remove the old routes, together with their Origin exemptions in `server.ts`.

Rollback before step 4: register the old URL again; the old routes still exist.
