#!/bin/bash
# Replaces the upstream entrypoint, whose restart path runs composer and needs egress.
# Everything is already in the image; this only prepares the runtime directories and the
# database schema. It needs nothing but the webmail database.
set -euo pipefail

for name in ROUNDCUBEMAIL_DB_HOST ROUNDCUBEMAIL_DB_PORT ROUNDCUBEMAIL_DB_USER \
    ROUNDCUBEMAIL_DB_PASSWORD ROUNDCUBEMAIL_DB_NAME ROUNDCUBEMAIL_DES_KEY \
    ORBIT_WEBMAIL_BRIDGE_URL ORBIT_WEBMAIL_BRIDGE_SECRET ORBIT_WEBMAIL_PARENT_ORIGIN; do
    if [[ -z "${!name:-}" ]]; then
        echo "orbit-webmail: $name is not set" >&2
        exit 1
    fi
done

mkdir -p /tmp/roundcube-temp "$APACHE_RUN_DIR" "$APACHE_LOCK_DIR"

/wait-for-it.sh "$ROUNDCUBEMAIL_DB_HOST:$ROUNDCUBEMAIL_DB_PORT" -t 60
bin/initdb.sh --dir="$PWD/SQL" --update

exec "$@"
