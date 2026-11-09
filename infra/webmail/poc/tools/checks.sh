#!/usr/bin/env bash
# Container-side gates: G1 (secrets at rest), G4 (config, idempotent restart), G5 (inventory),
# G7 (compose semantics, networks). Prints conclusions only, never secret values.
set -uo pipefail

cd "$(dirname "$0")/.."
PROJECT=orbit-webmail-poc
source .work/env

compose() {
    docker compose --project-name "$PROJECT" --env-file .work/env -f compose.yml "$@"
}

FAILED=0
pass() { echo "PASS $1"; }
fail() { echo "FAIL $1"; FAILED=$((FAILED + 1)); }
expect() { # description expected actual
    if [[ "$2" == "$3" ]]; then pass "$1 ($3)"; else fail "$1: expected '$2', got '$3'"; fi
}

positive() { # description actual
    if [[ "$2" -gt 0 ]]; then pass "$1 ($2)"; else fail "$1: expected more than 0"; fi
}

section() { printf '\n== %s\n' "$1"; }

count_secret_in_stream() { # stdin; prints occurrences of either mailbox password
    grep -cF -e "$POC_ALICE_PASSWORD" -e "$POC_BOB_PASSWORD" || true
}

g1() {
    section 'G1 secrets at rest'
    local inspection status
    inspection=$(compose exec -T -e "POC_SECRET_1=$POC_ALICE_PASSWORD" -e "POC_SECRET_2=$POC_BOB_PASSWORD" \
        roundcube php /poc-tools/inspect-session.php)
    status=$?
    sort <<<"$inspection" | uniq -c
    expect 'exit status of the session inspection' 0 "$status"

    local files
    files=$(compose exec -T -e "POC_SECRET_1=$POC_ALICE_PASSWORD" -e "POC_SECRET_2=$POC_BOB_PASSWORD" roundcube sh -c \
        'grep -rlF -e "$POC_SECRET_1" -e "$POC_SECRET_2" /var/www/html /tmp /var/roundcube /var/log 2>/dev/null | wc -l')
    expect 'files in the Roundcube container containing a real password' 0 "$(tr -d '[:space:]' <<<"$files")"

    expect 'occurrences in a full database dump' 0 \
        "$(compose exec -T webmail-db pg_dump -U roundcube roundcubemail | count_secret_in_stream)"
    expect 'occurrences in Roundcube container logs' 0 "$(compose logs --no-log-prefix roundcube 2>&1 | count_secret_in_stream)"
    expect 'occurrences in proxy logs' 0 "$(compose logs --no-log-prefix caddy 2>&1 | count_secret_in_stream)"
    expect 'occurrences in bridge logs' 0 "$(compose logs --no-log-prefix bridge 2>&1 | count_secret_in_stream)"
}

g4_config() {
    section 'G4 effective configuration'
    compose exec -T roundcube php /poc-tools/print-config.php
    expect 'hits on the tracker host in the proxy log' 0 \
        "$(compose logs --no-log-prefix caddy 2>&1 | grep -c '"host":"tracker\.' || true)"
}

g4_readonly() {
    section 'G4 read-only filesystem'
    expect 'root filesystem is mounted read-only' true \
        "$(docker inspect -f '{{.HostConfig.ReadonlyRootfs}}' "$PROJECT-roundcube-1")"
    expect 'the docroot is not writable' denied \
        "$(compose exec -T roundcube php -r 'echo @file_put_contents("/var/www/html/probe","x")===false?"denied":"written";')"
    expect 'the docroot is owned by root' 0 \
        "$(compose exec -T roundcube php -r 'echo fileowner("/var/www/html/index.php");')"
    expect 'composer is not in the image' false \
        "$(compose exec -T roundcube php -r 'echo is_file("/usr/local/bin/composer")?"true":"false";')"
}

table_count() {
    compose exec -T webmail-db psql -U roundcube -d roundcubemail -Atc \
        "select count(*) from information_schema.tables where table_schema='public'"
}

composer_lines_since() { # since service
    compose logs --no-log-prefix --since "$1" "$2" 2>&1 | grep -ci composer || true
}

g4_restart() {
    section 'G4 idempotent restart'
    local before_tables after_tables since
    before_tables=$(table_count)
    since=$(date -u +%Y-%m-%dT%H:%M:%SZ)

    compose restart roundcube >/dev/null 2>&1
    compose up -d --wait --wait-timeout 180 roundcube >/dev/null 2>&1
    expect 'log lines mentioning composer after restart' 0 "$(composer_lines_since "$since" roundcube)"

    since=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    compose up -d --force-recreate --wait --wait-timeout 180 roundcube >/dev/null 2>&1
    expect 'log lines mentioning composer after recreate' 0 "$(composer_lines_since "$since" roundcube)"

    after_tables=$(table_count)
    expect 'table count is unchanged by restart and recreate' "$before_tables" "$after_tables"
    expect 'container is healthy after recreate' healthy \
        "$(docker inspect -f '{{.State.Health.Status}}' "$PROJECT-roundcube-1")"
    expect 'schema version row exists' 1 "$(compose exec -T webmail-db psql -U roundcube -d roundcubemail -Atc \
        "select count(*) from system where name='roundcube-version'")"
}

g4_no_egress() {
    section 'G4 start and restart without egress'
    compose --profile isolated up -d --wait --wait-timeout 180 roundcube-isolated >/dev/null 2>&1
    expect 'fresh container on the internal network only is healthy' healthy \
        "$(docker inspect -f '{{.State.Health.Status}}' "$PROJECT-roundcube-isolated-1")"
    expect 'it has no default route' false \
        "$(compose --profile isolated exec -T roundcube-isolated php -r '$s=@fsockopen("1.1.1.1",443,$e,$m,3); echo $s?"true":"false";')"

    compose --profile isolated restart roundcube-isolated >/dev/null 2>&1
    compose --profile isolated up -d --wait --wait-timeout 180 roundcube-isolated >/dev/null 2>&1
    expect 'it is healthy after a restart' healthy \
        "$(docker inspect -f '{{.State.Health.Status}}' "$PROJECT-roundcube-isolated-1")"
    compose --profile isolated rm -fsv roundcube-isolated >/dev/null 2>&1
}

g10_starttls() {
    section 'G10 STARTTLS in the server logs'
    local logs
    logs=$(compose logs --no-log-prefix mail-starttls 2>&1)
    positive 'Dovecot logins over TLS' "$(grep -c 'imap-login: Login: .*TLS' <<<"$logs" || true)"
    positive 'Postfix TLS sessions on submission' "$(grep -c 'TLS connection established from' <<<"$logs" || true)"
    expect 'plaintext IMAP logins' 0 "$(grep 'imap-login: Login:' <<<"$logs" | grep -vc 'TLS' || true)"
}

g5_inventory() {
    section 'G5 inventory'
    compose exec -T roundcube php /poc-tools/extract-actions.php json > action-inventory.json || fail 'inventory extraction'
    compose exec -T roundcube php /poc-tools/extract-actions.php md > action-inventory.md || fail 'inventory extraction'
    node -e "const j=require('./action-inventory.json');console.log('entries',Object.keys(j.actions).length,JSON.stringify(j.counts))"
}

g7() {
    section 'G7 compose semantics'
    expect 'replica-probe containers with the variable unset' 0 \
        "$(compose ps -a --format '{{.Service}}' | grep -c '^replica-probe$' || true)"
    echo "effective replicas: $(compose config --format json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).services['replica-probe'].deploy.replicas))")"

    ORBIT_WEBMAIL_REPLICAS=1 compose up -d replica-probe >/dev/null 2>&1
    expect 'replica-probe containers with ORBIT_WEBMAIL_REPLICAS=1' 1 \
        "$(ORBIT_WEBMAIL_REPLICAS=1 compose ps --format '{{.Service}}' | grep -c '^replica-probe$' || true)"
    ORBIT_WEBMAIL_REPLICAS=0 compose up -d replica-probe >/dev/null 2>&1
    expect 'replica-probe containers after returning to 0' 0 \
        "$(compose ps -a --format '{{.Service}}' | grep -c '^replica-probe$' || true)"

    section 'G7 network reachability from Roundcube'
    local php_tcp='$s=@fsockopen($argv[1],(int)$argv[2],$e,$m,3); echo $s?"open":"closed";'
    expect 'frontend service name does not resolve' frontend-canary \
        "$(compose exec -T roundcube php -r 'echo gethostbyname("frontend-canary");')"

    local canary_ip
    canary_ip=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$PROJECT-frontend-canary-1")
    expect 'frontend service IP is unreachable' closed \
        "$(compose exec -T roundcube php -r "$php_tcp" -- "$canary_ip" 4311)"
    expect 'bridge is reachable' open "$(compose exec -T roundcube php -r "$php_tcp" -- bridge 8080)"
    expect 'webmail database is reachable' open "$(compose exec -T roundcube php -r "$php_tcp" -- webmail-db 5432)"
    expect 'mail server is reachable' open "$(compose exec -T roundcube php -r "$php_tcp" -- mail.test 3993)"
    expect 'webmail database has no default route' 0 \
        "$(compose exec -T webmail-db sh -c 'ip route | grep -c default || true' | tr -d '[:space:]')"
}

g1
g4_config
g4_readonly
g5_inventory
g7
g10_starttls
g4_restart
g4_no_egress

printf '\nFAILED=%s\n' "$FAILED"
exit "$((FAILED > 0))"
