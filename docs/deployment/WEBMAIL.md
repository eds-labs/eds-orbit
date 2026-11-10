# Webmail operator runbook

Roundcube as a client of Orbit's mailboxes ([ADR 0026](../adr/0026-webmail-module.md)). **The code is on `main` since 2026-11-10 with `ORBIT_WEBMAIL` off and `ORBIT_WEBMAIL_REPLICAS` at 0. The first network check failed (results below), so Roundcube now runs as its own Coolify application, and enabling waits for the checks on that layout.** DNS and TLS for the webmail host, production secrets, `ORBIT_WEBMAIL`, `ORBIT_WEBMAIL_REPLICAS` and any mail to real recipients each need their own approval. See [COOLIFY.md](COOLIFY.md) for how production builds and how schema approval works.

## Applications and services

Webmail spans two Coolify applications on the same server, built from the same repository and branch:

| Application | Compose file | Webmail services |
|---|---|---|
| Orbit (`Orbit Production (GitHub)`) | `docker-compose.pve.yml`, generated from `docker-compose.yml` | `webmail-bridge` |
| Webmail | `docker-compose.webmail.yml` | `webmail`, `webmail-db` |

Coolify attaches every service of a Compose application to one network of the application's own, in addition to the networks in the Compose file. Inside Orbit's application that put Roundcube next to the API, Postgres and Redis (see [Results on production](#results-on-production-2026-11-10-coolify-46-docker-299-compose-56)). In its own application that network holds only Roundcube and its database. Each application starts its webmail services only when its own `ORBIT_WEBMAIL_REPLICAS` is 1; with the default 0 they do not exist.

| Service | Image | Networks (plus Coolify's network of its application) | Purpose |
|---|---|---|---|
| `webmail` | `infra/webmail/Dockerfile` | `webmail`, `webmail-egress`, `webmail-link` | Roundcube 1.7 on Apache, port 8000. Renders untrusted HTML. Never on Orbit's `frontend`, `database` or `egress`, which would put it next to the API, the MCP gateway and the worker. |
| `webmail-db` | pinned `postgres:17` | `webmail`, `webmail-backup` | Roundcube's own database: preferences, identities, sessions. No mail content, no mail passwords and no collected addresses. |
| `webmail-bridge` | Orbit runtime image | `webmail-link`, `database`, `egress` | Internal API on port 4313, protected by `WEBMAIL_BRIDGE_SECRET`. Health-only while `ORBIT_WEBMAIL` is off. |

The two applications meet only on two internal networks with fixed names, which Orbit's Compose file creates, so Orbit is deployed before the webmail application:

- `orbit-webmail-link` (`webmail-link`): Roundcube and the bridge. Roundcube reaches the bridge as `webmail-bridge:4313`.
- `orbit-webmail-backup` (`webmail-backup`): the webmail database and Orbit's `backup` service, so backup never sits next to Roundcube (see [Backup and restore](#backup-and-restore)).

The first rollout attempt left an unused volume `<orbit uuid>_orbit-webmail-pg` and the networks `<orbit uuid>_webmail`, `_webmail-egress` and `_webmail-backup` behind in Orbit's application. They hold nothing and can be removed on the host.

The image bakes in everything: Roundcube's code and dependencies, the `orbit_bridge` plugin, the compiled `orbit` skin and the configuration. The upstream entrypoint is replaced, because its restart path runs composer and needs egress. Neither a restart nor a recreate needs anything beyond the webmail database; at runtime Roundcube talks only to the bridge and to IMAP/SMTP. The root filesystem is read-only with a 256 MB tmpfs on `/tmp`, which holds Apache's runtime files, PHP uploads and attachments being composed. The code is owned by root, and composer is removed from the image.

Limits to know:

- Attachments are limited to 5 MB by the upstream PHP defaults (`upload_max_filesize`, `post_max_size`). Raising them means a change to the image.
- All members of a mailbox share one Roundcube user, so list settings such as columns and sort order are shared. The interface language follows each member's browser.
- A session without `organize` never sets `\Seen` and a session without `send` ignores read-receipt requests, because either would change a shared mailbox or send mail. A session with `send` but not `organize` still sets `\Answered` and `$Forwarded` when it replies or forwards; that is part of sending.
- Attachment bodies and message source are served with a CSP `sandbox` and no `allow-scripts`, so script in an attachment such as an SVG cannot run on the webmail origin. PDF is exempt, because the browsers' viewers could not be verified under a sandbox. Roundcube's own pages around attachments also keep their scripts.

## Configuration

| Variable | Set on | Notes |
|---|---|---|
| `ORBIT_WEBMAIL_REPLICAS` | Both applications | `0` (default) or `1`. In Orbit it creates or removes the bridge, in the webmail application Roundcube and its database. |
| `ORBIT_WEBMAIL` | Orbit | Application flag on the API, worker and bridge. Default `false`. |
| `WEBMAIL_ORIGIN` | Orbit | Public origin of Roundcube, a sibling host of Orbit, for example `https://webmail.orbit.eds-labs.io`. |
| `APP_ORIGIN` | Both applications | Orbit's origin; in Orbit derived from the `web` domain, in the webmail application required and set by hand. Becomes `ORBIT_WEBMAIL_PARENT_ORIGIN`, the only origin that may start a session or embed the page. |
| `WEBMAIL_BRIDGE_SECRET` | Both applications, same value | Reference the environment's shared variable, `{{environment.WEBMAIL_BRIDGE_SECRET}}`, in both. Required in the webmail application. If the two differ, the bridge refuses every request. |
| `WEBMAIL_DB_PASSWORD` | Both applications, same value | `{{environment.WEBMAIL_DB_PASSWORD}}` in both: the webmail application creates the database with it, Orbit's `backup` dumps it. Required in the webmail application. |
| `ROUNDCUBE_DES_KEY` | Webmail application, generated | Defaults to `SERVICE_HEX_64_ROUNDCUBEDES`. Any length; hashed to an AES-256 key. Changing it only ends open sessions. |
| `ORBIT_WEBMAIL_TLS_CA_FILE` | Not set in production | Path to a private CA bundle. Unset means the image's system CA store. It exists for the test stack. |

Generate each shared value once, for example with `openssl rand -hex 32`, and store it only as a shared variable of the Coolify environment.

Compose refuses to deploy the webmail application while `APP_ORIGIN`, `WEBMAIL_BRIDGE_SECRET` or `WEBMAIL_DB_PASSWORD` is empty, even with the replicas at 0. `webmail` itself exits at start when another required value is empty, and logs which one.

The names `orbit-webmail-link` and `orbit-webmail-backup` are global on the Docker host. Never deploy a second copy of either application on the same server, and run the local suite only on a workstation (it uses its own `orbit-e2e-…` names). Do not change the definition of either network in `docker-compose.yml` while the webmail application runs: Compose would try to recreate a network that still has endpoints, after Coolify has already removed Orbit's old containers. Stop the webmail application first.

## Enabling sequence

Each step needs its own approval. Stop at the first failure and roll back.

1. Approve the schema hash for the webmail migrations in Coolify (`COOLIFY.md`, VM102). Without it the deployment is refused.
2. Create DNS for the webmail host and set `WEBMAIL_ORIGIN` in Orbit.
3. Create the shared variables `WEBMAIL_BRIDGE_SECRET` and `WEBMAIL_DB_PASSWORD` in the Coolify environment, and reference both in Orbit.
4. Deploy Orbit. This creates `orbit-webmail-link` and `orbit-webmail-backup`.
5. Create the webmail application: Git source, same repository and branch, Docker Compose build pack, Compose file `/docker-compose.webmail.yml`, same project, environment and server, no predefined network. Set `APP_ORIGIN` and the two references. Switch off "Inject Build Args to Dockerfile" (`inject_build_args_to_dockerfile: false`) before the first build, or the shared secrets end up in the image history. Set the domain of service `webmail` to `https://<webmail host>:8000`; the port names the container port, the public URL has none. The Compose file declares no `SERVICE_URL_*` variable, so Coolify generates no sslip.io host and a missing domain means no route at all. Deploy once with `ORBIT_WEBMAIL_REPLICAS` at 0: no container starts.
6. Set `ORBIT_WEBMAIL_REPLICAS=1` in Orbit and redeploy (the bridge), then in the webmail application and redeploy. `ORBIT_WEBMAIL` stays `false`.
7. Run every [rollout check](#rollout-checks-on-a-real-coolify-instance). Do not continue until the network check is clean.
8. Set `ORBIT_WEBMAIL=true` in Orbit and redeploy.
9. Grant one test mailbox to one member. Check list, read, reply to an address you own, the convert dialog, and that a read-only grant shows no write controls.
10. Grant the remaining members.

## Rollback

1. Set `ORBIT_WEBMAIL=false` in Orbit and redeploy. Orbit stops offering webmail, the bridge goes health-only and every open session ends at its next request.
2. Set `ORBIT_WEBMAIL_REPLICAS=0` in the webmail application and redeploy, or stop that application. Roundcube and its database are removed.
3. Set `ORBIT_WEBMAIL_REPLICAS=0` in Orbit and redeploy. The bridge is removed.

The webmail application's volume `orbit_webmail_pg` is kept, and with `ORBIT_WEBMAIL=false` the mail fetch path is the previous one (ADR 0026, E9). Nothing has to be restored. Mail that was moved, deleted or sent stays that way, because those actions happened on the real mailbox.

For a critical Roundcube vulnerability with no update available yet, step 2 alone removes the exposed surface immediately.

Every deployment of Orbit's application removes its old containers before it starts the new ones, so each step that redeploys Orbit interrupts it for about half a minute.

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

- With `ORBIT_WEBMAIL_REPLICAS=0` in Orbit the database is not contacted at all and the main dump behaves as before: no failure and no alert. Orbit's value decides, so set it to 1 only once the webmail application runs.
- With webmail on, a failed webmail dump fails the run, so the scheduler alerts and the heartbeat is not sent. The main dump is taken first and is already uploaded by then.

The database holds preferences and identities, so it is low value: Roundcube recreates a user at the next login and a lost session only needs reopening from Orbit. Address collection is switched off (`collected_recipients`, `collected_senders`), so correspondents' addresses do not outlive Orbit's retention and erasure in this database or its backups. The original `ROUNDCUBE_DES_KEY` is not needed for a restore, because sessions are disposable.

Restore (the steps follow the isolation rules in [BACKUP_RESTORE.md](../BACKUP_RESTORE.md)):

```sh
sha256sum -c orbit-webmail-<ts>.dump.age.sha256
age --decrypt --identity orbit-backup.key --output webmail.dump orbit-webmail-<ts>.dump.age
pg_restore --list webmail.dump

# With webmail stopped (ORBIT_WEBMAIL_REPLICAS=0 in the webmail application removes
# webmail-db too, so stop only the webmail service for this step), replace the contents
# of the database:
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

### Results on production, 2026-11-10 (Coolify 4.6, Docker 29.9, Compose 5.6)

**The network check failed, so `ORBIT_WEBMAIL` stays off and `ORBIT_WEBMAIL_REPLICAS` is back at 0.**

- **`deploy.replicas`: pass.** At 0 no webmail container existed. At 1 the deployment created `webmail-db`, `webmail-bridge` and `webmail`, all healthy, and Roundcube initialised its schema. Back at 0 all three were removed.
- **Network isolation: fail.** Run inside the `webmail` container through a temporary Coolify scheduled task (since deleted), with `fsockopen` by service name: `api:4311`, `web:4310`, `mcp:4312`, `postgres:5432` and `redis:6379` were all reachable. The container had three IPv4 interfaces, while the Compose file gives it two networks: Coolify attaches every service of a Compose application to the application's own network as well. That network is shared by every Orbit service, so the "Connect to Predefined Network" setting, which adds the shared `coolify` network, is not the cause and switching it off cannot fix it.
- **Domain and TLS: not reached.** The DNS record `webmail.orbit.eds-labs.io` resolved to the server, but the domain had not been stored on the `webmail` service, so Traefik had no router for it (503, Traefik default certificate). The service kept the domain Coolify generated, `http://webmail-<application uuid>.<server ip>.sslip.io`, so Roundcube was publicly reachable over plain HTTP from 06:25 to 07:20 UTC with the flag off: it answered with its 403 "open from Orbit" page, the bridge was health-only and no session could start.
- **Traefik route, Safari: not reached.**

### Results on production with the separate application, 2026-11-10

All checks passed, so `ORBIT_WEBMAIL` was set to `true` at 10:07 UTC. Probes ran from temporary scheduled tasks, deleted afterwards.

- **Networks.** Coolify kept the fixed names: Orbit's deployment created `orbit-webmail-link` and `orbit-webmail-backup`, and the webmail application joined them. Roundcube had four interfaces (its three Compose networks and the webmail application's own network); Orbit's services sat in four other subnets; the only shared subnet was `orbit-webmail-link`, where only the bridge is.
- **Isolation: pass.** From `webmail`: `api`, `web`, `mcp`, `postgres` and `redis` do not resolve; `api` timed out (errno 110) on all four of its addresses; the bridge answered on its `orbit-webmail-link` address and timed out on its other three. From `webmail-db`: no Orbit name resolves and `api` is closed on all four addresses; `webmail:8000` is open (positive control).
- **Backup path: pass.** `backup` logged in to `webmail-db` over `orbit-webmail-backup` with the shared password.
- **Domain and TLS: pass.** Let's Encrypt certificate for `webmail.orbit.eds-labs.io`, `403` from Roundcube with `frame-ancestors 'self' https://orbit.eds-labs.io`, no `X-Frame-Options`, HSTS, a `__Host-` cookie, HTTP redirected to HTTPS. Neither application has a generated sslip.io host (both answer 503).
- **`deploy.replicas`: pass** in both applications.
- **Build arguments.** Coolify's Compose build first injected every variable of the webmail application as an `ARG` into the Dockerfile, which would put the shared secrets into the image history. `inject_build_args_to_dockerfile` is now off for that application and the image was rebuilt without cache; the second build injected nothing.
- **Not reached yet:** a test mailbox (enabling sequence step 9) and real Safari.

Consequence of the first attempt: `webmail` and `webmail-db` moved into their own Coolify application, joined to Orbit only through `orbit-webmail-link` and `orbit-webmail-backup` (see [Applications and services](#applications-and-services)). The local suite now models Coolify's application network, so its isolation check would have failed the same way on the old layout. The checks below are repeated for the new layout before `ORBIT_WEBMAIL` is set.

**Domain and TLS.** `curl -sSI "$WEBMAIL_ORIGIN/"` gives `403` over a valid certificate, with `Content-Security-Policy` containing `frame-ancestors 'self' <APP_ORIGIN>` and no `X-Frame-Options`. The origin must be a sibling of Orbit's host and must not be served under it.

**Traefik reaches the service.** The same request must be answered by Roundcube (the page says to open the mailbox from Orbit), not with a Traefik 404 or 502, or Coolify's 503 "Site not available", which means no route for the host. Check the service domain carries `:8000`.

**Network isolation, the blocking check.** Roundcube leaves through its own `webmail-egress` network rather than the shared `egress`, and Coolify attaches it to the webmail application's own network, not Orbit's. Roundcube must not be able to reach Orbit's internal services. Without host access, the same probe runs from a temporary Coolify scheduled task on container `webmail` (its command field holds about 255 characters, so send short `echo <base64> | base64 -d | php` scripts) and the task is deleted afterwards:

```sh
C=$(docker ps --filter name=webmail- --format '{{.Names}}' | grep -v -e bridge -e db | head -1)
for target in api:4311 web:4310 mcp:4312 postgres:5432 redis:6379; do
  docker exec "$C" php -r '[$h,$p]=explode(":",$argv[1]); $s=@fsockopen($h,(int)$p,$e,$m,3); echo $argv[1]," ",$s?"REACHABLE":"closed","\n";' -- "$target"
done
docker inspect -f '{{json .NetworkSettings.Networks}}' "$C"
```

Every target must print `closed`. A name that does not resolve also prints `closed`, and across applications Orbit's names never resolve, so the check that counts is the one by IP: repeat it with the container IPs from `docker inspect <container>`, or, without host access, with the addresses a scheduled task on each Orbit container prints (`hostname -I` in `api`, `web`, `mcp`). `webmail-bridge:4313` is the one that must be reachable, at its address on `orbit-webmail-link`.

Then check the backup path: a scheduled task on `backup` connects to `webmail-db` with `WEBMAIL_PGPASSWORD` (for example `psql -h webmail-db -U roundcube -d roundcubemail -c 'select 1'`). A failure means the shared password is not referenced in Orbit, and the nightly backup will fail.

Also run the probe from `webmail-db` (`nc -z -w 3 <host> <port>`, BusyBox): it shares the webmail application's network with Roundcube, so it must not reach Orbit either.

If anything is reachable, **do not set `ORBIT_WEBMAIL=true`**. Set `ORBIT_WEBMAIL_REPLICAS=0` in the webmail application, redeploy, and find which network connects them (`docker inspect`, or the interfaces printed by `net_get_interfaces()`). Make sure "Connect to Predefined Network" is off in both applications. A remaining path needs a review of its own, for example `DOCKER-USER` firewall rules.

**`deploy.replicas`.** Passed on 2026-11-10 with the old layout: unset or 0 created no container, 1 created all three, 0 again removed them. Repeat it for each application.

**Real Safari.** On macOS and iOS with Intelligent Tracking Prevention, in a fresh profile: open a mailbox from Orbit, navigate, reply, reload. WebKit in the test stack passed only with a parent on a real public suffix. If iframe cookies are dropped, the frame reports no `orbit.webmail.ready` and Orbit has to offer the fallback.

## License

- **Roundcube** is licensed under the GNU GPL version 3 or later, with exceptions for skins and plugins. Its code is unmodified in the image; only the installer and composer are removed.
- **`orbit_bridge`** is Orbit's own plugin and is covered by that exception.
- **Elastic** is licensed under CC BY-SA 3.0. The `orbit` skin is an adaptation and carries the same license under ShareAlike, with attribution in its `meta.json` and `LICENSE`. That also applies to its LESS sources and the stylesheets compiled from them, and the skin may not be relicensed.
- The EDS Labs mark in `skins/orbit/images/logo.svg` is not part of that license.
- Elastic's bundled Bootstrap, FontAwesome and Roboto keep their own licenses, listed in Elastic's `README.md`.

Running the image for Orbit is not distribution. Handing the image to a third party would be, and would bring the GPL's source obligations and the attribution and ShareAlike terms with it.
