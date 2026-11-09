# Webmail operator runbook

Roundcube as a client of Orbit's mailboxes ([ADR 0026](../adr/0026-webmail-module.md)). **Nothing here is deployed yet.** The push to `main`, the schema hash in Coolify, DNS and TLS for the webmail host, production secrets, `ORBIT_WEBMAIL`, `ORBIT_WEBMAIL_REPLICAS` and any mail to real recipients each need their own approval. See [COOLIFY.md](COOLIFY.md) for how production builds and how schema approval works.

## Services

All three start only when `ORBIT_WEBMAIL_REPLICAS` is 1. With the default 0 they do not exist.

| Service | Image | Networks | Purpose |
|---|---|---|---|
| `webmail` | `infra/webmail/Dockerfile` | `webmail`, `webmail-egress` | Roundcube 1.7 on Apache, port 8000. Renders untrusted HTML. Shares no network with `api`, `web`, `mcp` or `worker`; `webmail-egress` is its own way out to the mail servers. |
| `webmail-db` | pinned `postgres:17` | `webmail` | Roundcube's own database: preferences, identities, sessions. No mail content and no mail passwords. |
| `webmail-bridge` | Orbit runtime image | `webmail`, `database`, `egress` | Internal API on port 4313, protected by `WEBMAIL_BRIDGE_SECRET`. Health-only while `ORBIT_WEBMAIL` is off. |

The `backup` service also joins the `webmail` network, to reach `webmail-db` (see [Backup and restore](#backup-and-restore)).

The image bakes in everything: Roundcube's code and dependencies, the `orbit_bridge` plugin, the compiled `orbit` skin and the configuration. The upstream entrypoint is replaced, because its restart path runs composer and needs egress. Neither a restart nor a recreate needs anything beyond the webmail database; at runtime Roundcube talks only to the bridge and to IMAP/SMTP. The root filesystem is read-only with a 256 MB tmpfs on `/tmp`, which holds Apache's runtime files, PHP uploads and attachments being composed. The code is owned by root, and composer is removed from the image.

Limits to know:

- Attachments are limited to 5 MB by the upstream PHP defaults (`upload_max_filesize`, `post_max_size`). Raising them means a change to the image.
- All members of a mailbox share one Roundcube user, so list settings such as columns and sort order are shared. The interface language follows each member's browser.
- A session without `organize` never sets `\Seen` and a session without `send` ignores read-receipt requests, because either would change a shared mailbox or send mail. A session with `send` but not `organize` still sets `\Answered` and `$Forwarded` when it replies or forwards; that is part of sending.

## Configuration

| Variable | Set on | Notes |
|---|---|---|
| `ORBIT_WEBMAIL_REPLICAS` | Coolify | `0` (default) or `1`. Creates or removes the three services. |
| `ORBIT_WEBMAIL` | Coolify | Application flag on the API, worker and bridge. Default `false`. |
| `WEBMAIL_ORIGIN` | Coolify | Public origin of Roundcube, a sibling host of Orbit, for example `https://webmail.orbit.eds-labs.io`. |
| `APP_ORIGIN` | Coolify | Orbit's origin. Becomes `ORBIT_WEBMAIL_PARENT_ORIGIN`, the only origin that may start a session or embed the page. |
| `WEBMAIL_BRIDGE_SECRET` | Generated | Defaults to `SERVICE_HEX_64_WEBMAILBRIDGE`. Must be identical on the bridge and Roundcube; Compose takes care of that. |
| `WEBMAIL_DB_PASSWORD` | Generated | Defaults to `SERVICE_PASSWORD_64_WEBMAILDB`. Also passed to `backup`. |
| `ROUNDCUBE_DES_KEY` | Generated | Defaults to `SERVICE_HEX_64_ROUNDCUBEDES`. Any length; hashed to an AES-256 key. Changing it only ends open sessions. |
| `ORBIT_WEBMAIL_TLS_CA_FILE` | Not set in production | Path to a private CA bundle. Unset means the image's system CA store. It exists for the test stack. |

`webmail` exits at start when one of its required values is empty, and logs which one.

## Enabling sequence

Each step needs its own approval. Stop at the first failure and roll back.

1. Approve the schema hash for the webmail migrations in Coolify (`COOLIFY.md`, VM102). Without it the deployment is refused.
2. Create DNS for the webmail host, add it as the domain of service `webmail` on port 8000, and set `WEBMAIL_ORIGIN`.
3. Set `ORBIT_WEBMAIL_REPLICAS=1` and redeploy. `ORBIT_WEBMAIL` stays `false`.
4. Run every [rollout check](#rollout-checks-on-a-real-coolify-instance). Do not continue until the network check is clean.
5. Set `ORBIT_WEBMAIL=true` and redeploy.
6. Grant one test mailbox to one member. Check list, read, reply to an address you own, the convert dialog, and that a read-only grant shows no write controls.
7. Grant the remaining members.

## Rollback

1. Set `ORBIT_WEBMAIL=false` and redeploy. Orbit stops offering webmail, the bridge goes health-only and every open session ends at its next request.
2. Set `ORBIT_WEBMAIL_REPLICAS=0` and redeploy. The three containers are removed.

The volume `orbit_webmail_pg` is kept, and with `ORBIT_WEBMAIL=false` the mail fetch path is the previous one (ADR 0026, E9). Nothing has to be restored. Mail that was moved, deleted or sent stays that way, because those actions happened on the real mailbox.

For a critical Roundcube vulnerability with no update available yet, step 2 alone removes the exposed surface immediately.

## Monthly Roundcube upgrade

Roundcube ships security releases about monthly, and flaws in it have been exploited in the wild (ADR 0026). The image is pinned by digest, so nothing updates by itself.

**Subscribe** to the [Roundcube news feed](https://roundcube.net/news) and the [GitHub releases](https://github.com/roundcube/roundcubemail/releases). Apply a security release within days; if it is being actively exploited, within 24 hours or roll back as above.

Checklist:

- [ ] Read the release notes for changes to plugin hooks, Elastic templates and configuration options.
- [ ] Get the new digest: `docker buildx imagetools inspect roundcube/roundcubemail:<version>-apache-nonroot`.
- [ ] Change only the `FROM` line in `infra/webmail/Dockerfile`, tag and digest together.
- [ ] Compare the upstream entrypoint with `infra/webmail/entrypoint.sh`: `docker run --rm --entrypoint cat <image> /docker-entrypoint.sh`. Carry over anything the application now needs at start.
- [ ] Compare Elastic's `templates/includes/menu.html` and `templates/login.html` with the copies in `infra/webmail/skins/orbit/templates/`. `layout.html` and the stylesheets are rebuilt from the new version automatically.
- [ ] Run the suite: `infra/webmail/poc/run.sh all`. It must pass in all three browsers with no weakened assertions.
- [ ] Review the diff of `infra/webmail/poc/action-inventory.md`, which the run regenerates. New actions stay denied until they are added to `plugins/orbit_bridge/actions.inc.php` deliberately.
- [ ] Look for new client commands in `program/js/app.js` and Elastic's templates, and add those a capability forbids to `plugins/orbit_bridge/commands.inc.php`. Missing ones stay visible but are refused by the server.
- [ ] Run a backup before deploying. Schema updates run at container start, and going back to an older digest does not downgrade the schema.
- [ ] Deploy (approval), then repeat step 6 of the enabling sequence.

## Backup and restore

The daily `orbit-backup once` run also archives the webmail database, as `orbit-webmail-<UTC timestamp>.dump.age` with a `.sha256` sidecar under the same prefix and bucket lifecycle as the main dump, encrypted to the same `age` recipient.

- With `ORBIT_WEBMAIL_REPLICAS=0` the database is not contacted at all and the main dump behaves as before: no failure and no alert.
- With webmail on, a failed webmail dump fails the run, so the scheduler alerts and the heartbeat is not sent. The main dump is taken first and is already uploaded by then.

The database holds preferences, identities and the collected-recipients list, so it is low value: Roundcube recreates a user at the next login and a lost session only needs reopening from Orbit. The original `ROUNDCUBE_DES_KEY` is not needed for a restore, because sessions are disposable.

Restore (the steps follow the isolation rules in [BACKUP_RESTORE.md](../BACKUP_RESTORE.md)):

```sh
sha256sum -c orbit-webmail-<ts>.dump.age.sha256
age --decrypt --identity orbit-backup.key --output webmail.dump orbit-webmail-<ts>.dump.age
pg_restore --list webmail.dump

# With webmail stopped (ORBIT_WEBMAIL_REPLICAS=0 removes webmail-db too, so stop only
# the webmail service for this step), replace the contents of the database:
docker exec -i <webmail-db container> pg_restore -U roundcube -d roundcubemail --clean --if-exists --no-owner < webmail.dump
```

Then start `webmail` again. Sessions from the backup point in time are dead, because their handles no longer authorize at the bridge.

## Troubleshooting

| Symptom | Likely cause | Check |
|---|---|---|
| "Please open this mailbox from Orbit" in the frame | The handoff failed, or the session cookie did not arrive | `Origin` of the POST against `APP_ORIGIN`; Orbit's webmail route must send `Referrer-Policy: strict-origin-when-cross-origin`; in Safari see the rollout check |
| Frame stays blank | CSP `frame-ancestors` does not name Orbit | Response header on the webmail host; `ORBIT_WEBMAIL_PARENT_ORIGIN` in the container |
| "Orbit cannot be reached right now" | Bridge down, or its answer unusable | `webmail-bridge` health and logs; the secret must match on both sides |
| "This mailbox is currently unavailable" | The bridge refused with `mailbox_unavailable` | Connection state, project pause and mailbox owner in Orbit |
| Login fails right after the handoff | IMAP target unreachable, or certificate mismatch | Roundcube logs; the certificate must match the host name stored for the mailbox |
| Delete or move refused with "not finished reading" | The barrier could not ingest the message yet | Expected for a moment on new mail. Persistent: worker and file quota (ADR 0026) |
| Container restarts at start | A required variable is empty, or the database is unreachable | First log lines of `webmail` |
| `No space left` on upload | tmpfs on `/tmp` full | Size in `docker-compose.yml` |
| Interface unstyled after an upgrade | Skin build out of step with Elastic | Rebuild; compare the templates listed in the upgrade checklist |

The frame reports to the Orbit page with `orbit.webmail.ready` and `orbit.webmail.session_lost`; the contract is in `infra/webmail/poc/mock-bridge/contract.json`.

The `orbit` skin follows the browser's dark mode, using a palette derived from Orbit's navy mode surface, because `DESIGN_SYSTEM.md` defines no dark palette and the Orbit shell is light only. To keep the mail pane light, add `"config": { "dark_mode_support": false }` to `infra/webmail/skins/orbit/meta.json`.

## Rollout checks on a real Coolify instance

The test stack cannot prove these. Record each result before setting `ORBIT_WEBMAIL=true`.

**Domain and TLS.** `curl -sSI "$WEBMAIL_ORIGIN/"` gives `403` over a valid certificate, with `Content-Security-Policy` containing `frame-ancestors 'self' <APP_ORIGIN>` and no `X-Frame-Options`. The origin must be a sibling of Orbit's host and must not be served under it.

**Traefik reaches the service.** The same request must be answered by Roundcube (the page says to open the mailbox from Orbit), not with a Traefik 404 or 502. Check `SERVICE_URL_WEBMAIL_8000` produced a route to port 8000.

**Network isolation, the blocking check.** Coolify can attach services to its own network in addition to those in the Compose file. Roundcube must not be able to reach Orbit's internal services:

```sh
C=$(docker ps --filter name=webmail- --format '{{.Names}}' | grep -v -e bridge -e db | head -1)
for target in api:4311 web:4310 mcp:4312 postgres:5432 redis:6379; do
  docker exec "$C" php -r '[$h,$p]=explode(":",$argv[1]); $s=@fsockopen($h,(int)$p,$e,$m,3); echo $argv[1]," ",$s?"REACHABLE":"closed","\n";' -- "$target"
done
docker inspect -f '{{json .NetworkSettings.Networks}}' "$C"
```

Every target must print `closed`. A name that does not resolve also prints `closed`, so repeat the check with the container IPs from `docker inspect <container>`. `webmail-bridge:4313` is the one that must be reachable.

If anything is reachable, **do not set `ORBIT_WEBMAIL=true`**. Set `ORBIT_WEBMAIL_REPLICAS=0`, then remove the shared network from the service (Coolify's "Connect to Predefined Network" option, or the equivalent for the installed version) and repeat the check. If Coolify cannot do that, run the three webmail services as a separate Coolify resource and connect only the bridge to it, or block the traffic with `DOCKER-USER` firewall rules. Each of those is an architecture change that needs its own review.

**`deploy.replicas`.** With the variable unset, `docker ps -a --filter name=webmail` must list nothing. With `ORBIT_WEBMAIL_REPLICAS=1` it must list three containers, and going back to `0` must remove them. Local Compose does this; whether Coolify honours it has to be seen. If Coolify starts the services at 0, leave them unexposed and treat the flag as the only switch until this is resolved.

**Real Safari.** On macOS and iOS with Intelligent Tracking Prevention, in a fresh profile: open a mailbox from Orbit, navigate, reply, reload. WebKit in the test stack passed only with a parent on a real public suffix. If iframe cookies are dropped, the frame reports no `orbit.webmail.ready` and Orbit has to offer the fallback.

## License

- **Roundcube** is licensed under the GNU GPL version 3 or later, with exceptions for skins and plugins. Its code is unmodified in the image; only the installer and composer are removed.
- **`orbit_bridge`** is Orbit's own plugin and is covered by that exception.
- **Elastic** is licensed under CC BY-SA 3.0. The `orbit` skin is an adaptation and carries the same license under ShareAlike, with attribution in its `meta.json` and `LICENSE`. That also applies to its LESS sources and the stylesheets compiled from them, and the skin may not be relicensed.
- The EDS Labs mark in `skins/orbit/images/logo.svg` is not part of that license.
- Elastic's bundled Bootstrap, FontAwesome and Roboto keep their own licenses, listed in Elastic's `README.md`.

Running the image for Orbit is not distribution. Handing the image to a third party would be, and would bring the GPL's source obligations and the attribution and ShareAlike terms with it.
