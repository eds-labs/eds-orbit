# VM102: Orbit to public Matomo HTTPS loopback routing

This is a host operation, not an application startup script. Apply it only on
`orbit-coolify` (VM102), after the operator approves this network change.
It changes only the dedicated `ip eds_orbit_matomo` nftables table.

The public ingress address is `176.31.234.10`; its existing HTTPS proxy on VM102
is `10.50.0.12:443`. The helper permits TCP 443 only from the current API, MCP and
worker containers of application `q9xduufgytnsqmk6wurfvb4l`, and binds each source
IP to its actual Docker bridge. It discovers only container/network metadata;
it never reads environments or provider credentials. Other applications and
Orbit's database, web, backup and bridge containers are excluded as sources.

A separate NAT hook routes those already-public HTTPS requests to the same
local reverse proxy. Existing filter chains still apply. No public listener,
private-endpoint exception, TLS exception, SSH access or provider write is added.
The 15-second timer refreshes addresses after container replacement. Empty
container discovery produces an empty permitted-source set; invalid discovery
or failed nft validation removes only this optional route. Addresses from the
public DNS record are still checked and pinned by Orbit's connector transport.

## Approved installation

1. Verify `hostname` is `orbit-coolify`, the app ID and public DNS addresses still
   match, and the HTTPS proxy works with certificate verification. Save the
   current ruleset in a root-only change directory. Do not restore the whole
   snapshot over concurrent Docker changes.
2. Compare checksums of the three transferred source files with this checkout.
   Install `orbit-matomo-nat.py` as `/usr/local/sbin/eds-orbit-matomo-nat.py`
   (root-owned, 0755) and the `.service`/`.timer` in `/etc/systemd/system/` (0644).
3. Run `systemd-analyze verify` on both unit files and `systemctl daemon-reload`.
   Arm a 15-minute rollback **before** activation: it must disable/stop the
   refresh timer, stop the service, delete only `ip eds_orbit_matomo`, and remove
   `/run/eds-orbit-matomo-nat.json`. Cancel the earlier temporary probe rollback
   timer if it still exists.
4. Start `eds-orbit-matomo-nat.service`, then enable/start its timer. Check service
   result, source-set contents, the public HTTPS response/TLS and NAT counters.
5. Remove only the two analytics `extra_hosts` entries through the reviewed
   Compose generator change and approved Orbit release. After deployment, verify
   the new source addresses were refreshed, public DNS from API/MCP/worker, all
   application health checks, and Orbit's existing FamilyPlan site 2 read check.
6. Only after successful verification cancel the 15-minute rollback timer.
   Record commit, deployment, source-file checksums and sanitized results. No
   database restore, credential rotation or paid/provider-write smoke test.

## Rollback

Stop and disable `eds-orbit-matomo-nat.timer`, stop its service, then run:

```sh
nft delete table ip eds_orbit_matomo
rm -f /run/eds-orbit-matomo-nat.json
```

If the Orbit host-mapping removal was deployed, revert that isolated Compose
change, regenerate/check the adapter and redeploy its compatible revision.
The previous Matomo `PRIVATE_ENDPOINT` error returns; other host rules, data,
credentials, routes and services remain unchanged. Never flush the ruleset or
replace Docker's tables to remove this helper.

## Local validation

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s infra/network -p 'test_*.py'
pnpm test:coolify-compose
```

The tests check application/service restrictions, bridge/IP pairing, the exact
HTTPS destination, empty discovery, discovery failure and pre-apply validation
failure. A host-side `nft --check` and HTTPS test are also mandatory; unit tests
do not establish host reachability or a successful Matomo API login.
