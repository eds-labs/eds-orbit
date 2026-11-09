#!/usr/bin/env bash
# Runs the Roundcube proof of concept. Everything stays on the local Docker daemon.
#
#   ./run.sh up        generate throwaway secrets and start the stack
#   ./run.sh test      seed mail and run the Playwright gates in three browsers
#   ./run.sh checks    run the container-side gates (G1, G4, G5 inventory, G7, G9 logs)
#   ./run.sh down      remove the project's containers, networks and volumes
#   ./run.sh all       up, test, checks, down
#
# POC_APEX selects the parent host. The default sits under a public suffix because Linux
# WebKit treats webmail.orbit.test and orbit.test as cross-site and drops the iframe cookies.
# The names only exist as aliases on the compose network; no request leaves it.
set -euo pipefail

cd "$(dirname "$0")"
PROJECT=orbit-webmail-poc
WORK=.work
export POC_APEX="${POC_APEX:-orbit.example.com}"

hex() { openssl rand -hex "$1"; }

generate_env() {
    mkdir -p "$WORK/results"
    [[ -f "$WORK/env" ]] && return
    umask 077
    {
        echo "POC_DB_PASSWORD=$(hex 24)"
        # Roundcube's triple DES key must be exactly 24 bytes.
        echo "POC_DES_KEY=$(hex 12)"
        echo "POC_BRIDGE_SECRET=$(hex 32)"
        echo "POC_CONTROL_SECRET=$(hex 32)"
        echo "POC_ALICE_PASSWORD=$(hex 24)"
        echo "POC_BOB_PASSWORD=$(hex 24)"
    } > "$WORK/env"
}

issue_cert() { # name cn san...
    local name=$1 cn=$2 san=$3 dir="$WORK/certs"
    openssl req -newkey rsa:2048 -nodes -subj "/CN=$cn" \
        -keyout "$dir/$name.key" -out "$dir/$name.csr" 2>/dev/null
    printf 'subjectAltName=%s\n' "$san" > "$dir/$name.ext"
    openssl x509 -req -days 30 -in "$dir/$name.csr" -CA "$dir/ca.crt" -CAkey "$dir/ca.key" \
        -CAcreateserial -extfile "$dir/$name.ext" -out "$dir/$name.crt" 2>/dev/null
    rm -f "$dir/$name.csr" "$dir/$name.ext"
}

generate_certs() {
    local dir="$WORK/certs"
    mkdir -p "$dir"
    [[ -f "$dir/ca.crt" ]] && return
    openssl req -x509 -newkey rsa:2048 -nodes -days 30 -subj "/CN=Orbit Webmail PoC CA" \
        -keyout "$dir/ca.key" -out "$dir/ca.crt" 2>/dev/null
    issue_cert site orbit.test \
        "DNS:orbit.test,DNS:webmail.orbit.test,DNS:evil.orbit.test,DNS:tracker.orbit.test,DNS:orbit.example.com,DNS:webmail.orbit.example.com,DNS:evil.orbit.example.com,DNS:tracker.orbit.example.com"
    issue_cert mail mail.test "DNS:mail.test"
    openssl pkcs12 -export -name greenmail -in "$dir/mail.crt" -inkey "$dir/mail.key" \
        -out "$dir/mail.p12" -passout pass:changeit \
        -keypbe PBE-SHA1-3DES -certpbe PBE-SHA1-3DES 2>/dev/null
    chmod 644 "$dir"/*.crt "$dir"/*.p12
    chmod 644 "$dir/site.key"
}

compose() {
    docker compose --project-name "$PROJECT" --env-file "$WORK/env" -f compose.yml "$@"
}

cmd_up() {
    generate_env
    generate_certs
    compose up -d --build --wait --wait-timeout 180
}

cmd_test() {
    compose --profile tests run --rm tests bash -lc \
        'npm install --no-audit --no-fund --loglevel=error && npx playwright test "$@"' -- "$@"
}

cmd_checks() {
    ./tools/checks.sh
}

cmd_down() {
    [[ -f "$WORK/env" ]] || generate_env
    compose --profile tests down -v --remove-orphans
}

case "${1:-all}" in
    up) cmd_up ;;
    test) shift; cmd_test "$@" ;;
    checks) cmd_checks ;;
    down) cmd_down ;;
    all) cmd_up; cmd_test; cmd_checks; cmd_down ;;
    *) echo "usage: $0 up|test|checks|down|all" >&2; exit 2 ;;
esac
