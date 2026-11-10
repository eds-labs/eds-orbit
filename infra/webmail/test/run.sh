#!/usr/bin/env bash
# End-to-end proof of the webmail module on the real Orbit stack (ADR 0026). Nothing leaves
# the local Docker daemon: the application's only way out is a Docker-internal network.
#
# Like production it runs two projects: Orbit with the bridge (docker-compose.yml +
# compose.yml) and Roundcube with its database (docker-compose.webmail.yml +
# compose.webmail.yml). Orbit starts first, because it creates the networks they share.
#
#   infra/webmail/test/run.sh all        (default) up, test, checks, flag-off, down
#   infra/webmail/test/run.sh up         generate throwaway secrets and start the stack
#   infra/webmail/test/run.sh test [..]  run the Playwright scenarios (arguments are passed on)
#   infra/webmail/test/run.sh checks     run the container-side checks
#   infra/webmail/test/run.sh flag-off   ORBIT_WEBMAIL=false, replicas 0, and verify
#   infra/webmail/test/run.sh down       remove both projects' containers, networks, volumes
#
# E2E_BROWSERS limits the browsers (comma list). KEEP_STACK=1 skips the final down.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
HERE="$ROOT/infra/webmail/test"
PROJECT=orbit-webmail-e2e
PROJECT_WEBMAIL=orbit-webmail-e2e-rc
WORK="$HERE/.work"
BROWSERS=(chromium firefox webkit)
export E2E_APEX=orbit.example.com
export E2E_MAIL_HOST=mail.acme.example.net
SERVICES=(postgres redis migrate api worker web mcp webmail-bridge mail caddy)
WEBMAIL_SERVICES=(webmail webmail-db)
# The suite's names for orbit-webmail-link and orbit-webmail-backup (compose.yml). Orbit
# creates the backup network in production through its backup service, which does not
# run here, so this script creates it with the labels Compose expects.
LINK_NETWORK=orbit-e2e-webmail-link
BACKUP_NETWORK=orbit-e2e-webmail-backup
WEBMAIL_DB_IMAGE=postgres:17.7-alpine@sha256:bb377b7239d2774ac8cc76f481596ce96c5a6b5e9d141f6d0a0ee371a6e7c0f2

hex() { openssl rand -hex "$1"; }

mail_users() {
    local password=$1 list="" browser box
    for browser in "${BROWSERS[@]}"; do
        for box in info sales support billing; do
            list+="$box-$browser:$password@acme.example.net,"
        done
    done
    printf '%s' "${list%,}"
}

generate_env() {
    mkdir -p "$WORK/results"
    umask 077
    if [[ ! -f "$WORK/env" ]]; then
        local mail_password
        mail_password=$(hex 24)
        {
            echo "ORBIT_IMAGE_TAG=webmail-e2e"
            echo "ORBIT_RELEASE_APPROVAL=webmail-e2e-local"
            echo "APP_ORIGIN=https://$E2E_APEX"
            echo "WEBMAIL_ORIGIN=https://webmail.$E2E_APEX"
            echo "SERVICE_URL_WEB=https://$E2E_APEX"
            echo "EXECUTION_MODE=live"
            echo "ENABLE_EXTERNAL_WRITES=true"
            for flag in ORBIT_WEBMAIL ORBIT_SUPPORT ORBIT_FINANCE ORBIT_EMAIL ORBIT_FILES ORBIT_MODULES ORBIT_ADMINISTRATION; do
                echo "$flag=true"
            done
            echo "ORBIT_WEBMAIL_REPLICAS=1"
            for name in DBAPP DBAUTH DBMIGRATOR ORBITSETUPTOKEN; do
                echo "SERVICE_PASSWORD_64_$name=$(hex 32)"
            done
            for name in CREDENTIALKEY FILESKEY ROUNDCUBEDES; do
                echo "SERVICE_HEX_64_$name=$(hex 32)"
            done
            echo "SERVICE_REALBASE64_64_AUTHSECRET=$(openssl rand -base64 48 | tr -d '\n')"
            echo "SERVICE_BASE64_32_PUBLISHERINSTANCE=$(openssl rand -base64 24 | tr -d '\n')"
            echo "E2E_MAIL_PASSWORD=$mail_password"
            echo "E2E_GREENMAIL_USERS=$(mail_users "$mail_password")"
            echo "E2E_OWNER_PASSWORD=$(hex 24)"
            echo "E2E_MEMBER_PASSWORD=$(hex 24)"
        } > "$WORK/env"
    fi
    # Set in both applications, as the shared values are in production.
    grep -q '^WEBMAIL_BRIDGE_SECRET=' "$WORK/env" || echo "WEBMAIL_BRIDGE_SECRET=$(hex 32)" >> "$WORK/env"
    grep -q '^WEBMAIL_DB_PASSWORD=' "$WORK/env" || echo "WEBMAIL_DB_PASSWORD=$(hex 32)" >> "$WORK/env"
}

issue_cert() { # name cn san
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
    openssl req -x509 -newkey rsa:2048 -nodes -days 30 -subj "/CN=Orbit Webmail E2E CA" \
        -keyout "$dir/ca.key" -out "$dir/ca.crt" 2>/dev/null
    issue_cert site "$E2E_APEX" "DNS:$E2E_APEX,DNS:webmail.$E2E_APEX,DNS:tracker.$E2E_APEX"
    issue_cert mail "$E2E_MAIL_HOST" "DNS:$E2E_MAIL_HOST"
    openssl pkcs12 -export -name greenmail -in "$dir/mail.crt" -inkey "$dir/mail.key" \
        -out "$dir/mail.p12" -passout pass:changeit \
        -keypbe PBE-SHA1-3DES -certpbe PBE-SHA1-3DES 2>/dev/null
    chmod 644 "$dir"/*.crt "$dir"/*.p12 "$dir/site.key"
}

compose() {
    docker compose --project-name "$PROJECT" --project-directory "$ROOT" \
        --env-file "$WORK/env" -f "$ROOT/docker-compose.yml" -f "$HERE/compose.yml" "$@"
}

compose_webmail() {
    docker compose --project-name "$PROJECT_WEBMAIL" --project-directory "$ROOT" \
        --env-file "$WORK/env" -f "$ROOT/docker-compose.webmail.yml" -f "$HERE/compose.webmail.yml" "$@"
}

# `up --wait` also fails on a one-shot that exited, so migrate is checked on its own.
wait_healthy() { # compose-function service...
    local run=$1 deadline=$((SECONDS + 420)) service state missing
    shift
    while (( SECONDS < deadline )); do
        missing=0
        for service in "$@"; do
            state=$("$run" ps --all --format '{{.Health}}/{{.State}}' "$service" 2>/dev/null | head -1)
            [[ $state == healthy/running ]] || missing=1
        done
        (( missing == 0 )) && return 0
        sleep 3
    done
    echo "services not healthy in time:" >&2
    "$run" ps --all >&2
    return 1
}

ensure_backup_network() {
    docker network inspect "$BACKUP_NETWORK" >/dev/null 2>&1 ||
        docker network create --internal \
            --label com.docker.compose.project="$PROJECT" \
            --label com.docker.compose.network=webmail-backup \
            "$BACKUP_NETWORK" >/dev/null
}

cmd_up() {
    generate_env
    generate_certs
    compose build api
    compose_webmail build webmail
    compose up -d --no-build "${SERVICES[@]}"
    wait_healthy compose api worker web webmail-bridge mail postgres redis
    [[ $(compose ps --all --format '{{.ExitCode}}' migrate) == 0 ]]
    ensure_backup_network
    compose_webmail up -d --no-build "${WEBMAIL_SERVICES[@]}"
    wait_healthy compose_webmail webmail webmail-db
}

cmd_test() {
    compose --profile tests run --rm -e E2E_PHASE=enabled tests bash -lc \
        'npm install --no-audit --no-fund --loglevel=error && npx playwright test "$@"' -- "$@"
}

probe() { # container host port -> reachable|refused|closed, from Roundcube
    # A refused connection means a network path exists, so it counts against isolation.
    # shellcheck disable=SC2016
    docker exec "$1" php -r '[$h,$p]=[$argv[1],(int)$argv[2]];$s=@fsockopen($h,$p,$e,$m,3);echo $s?"reachable":($e===111?"refused":"closed");' -- "$2" "$3"
}

probe_db() { # container host port -> reachable|closed, from the webmail database
    if docker exec "$1" nc -z -w 3 "$2" "$3" >/dev/null 2>&1; then echo reachable; else echo closed; fi
}

check_reach() { # label probe-function container -> failures on stdout
    local label=$1 run=$2 c=$3 ip target host port failed=0
    # The worker has no listener, so it is not a target.
    for target in api:4311 web:4310 mcp:4312 postgres:5432 redis:6379; do
        host=${target%%:*} port=${target##*:}
        if [[ $("$run" "$c" "$host" "$port") != closed ]]; then
            echo "FAIL $label -> $target reachable by name"
            failed=1
        else
            echo "ok   $label -> $target closed by name"
        fi
        while read -r ip; do
            [[ -z $ip ]] && continue
            if [[ $("$run" "$c" "$ip" "$port") != closed ]]; then
                echo "FAIL $label -> $target reachable at $ip"
                failed=1
            else
                echo "ok   $label -> $target closed at $ip"
            fi
        done < <(docker inspect -f '{{range .NetworkSettings.Networks}}{{println .IPAddress}}{{end}}' "$(compose ps -q "$host")")
    done
    return "$failed"
}

cmd_checks() {
    local c db bridge link_ip failed=0 service
    c=$(compose_webmail ps -q webmail)
    db=$(compose_webmail ps -q webmail-db)
    bridge=$(compose ps -q webmail-bridge)
    echo "== Reach of Roundcube and its database, by name and by IP"
    check_reach webmail probe "$c" || failed=1
    check_reach webmail-db probe_db "$db" || failed=1
    echo "== The paths that must exist"
    # In this suite Roundcube also shares the test mail network with the bridge, so only
    # the bridge's address on the link network proves the production path.
    link_ip=$(docker inspect -f "{{with index .NetworkSettings.Networks \"$LINK_NETWORK\"}}{{.IPAddress}}{{end}}" "$bridge")
    if [[ -n $link_ip && $(probe "$c" "$link_ip" 4313) == reachable ]]; then
        echo "ok   webmail -> webmail-bridge:4313 reachable at $link_ip ($LINK_NETWORK)"
    else
        echo "FAIL webmail -> webmail-bridge:4313 not reachable on $LINK_NETWORK"
        failed=1
    fi
    # Positive control for probe_db: Roundcube shares the webmail network with its database.
    if [[ $(probe_db "$db" webmail 8000) == reachable ]]; then
        echo "ok   webmail-db -> webmail:8000 reachable (probe works)"
    else
        echo "FAIL webmail-db -> webmail:8000 not reachable, so probe_db proves nothing"
        failed=1
    fi
    # What Orbit's backup does: resolve webmail-db and log in with the shared password.
    if [[ $(docker run --rm --network "$BACKUP_NETWORK" \
        --env-file <(sed -n 's/^WEBMAIL_DB_PASSWORD=/PGPASSWORD=/p' "$WORK/env") \
        "$WEBMAIL_DB_IMAGE" psql -h webmail-db -U roundcube -d roundcubemail -tAc 'select 1' 2>/dev/null) == 1 ]]; then
        echo "ok   backup path: webmail-db reachable on $BACKUP_NETWORK with the shared password"
    else
        echo "FAIL backup path: webmail-db not reachable on $BACKUP_NETWORK or password refused"
        failed=1
    fi
    echo "== Containers"
    for service in api worker web webmail-bridge; do
        docker inspect -f "$service readonly={{.HostConfig.ReadonlyRootfs}} capdrop={{.HostConfig.CapDrop}}" "$(compose ps -q "$service")"
    done
    docker inspect -f "webmail readonly={{.HostConfig.ReadonlyRootfs}} capdrop={{.HostConfig.CapDrop}}" "$c"
    return "$failed"
}

cmd_flag_off() {
    local name failed=0
    export ORBIT_WEBMAIL=false ORBIT_WEBMAIL_REPLICAS=0
    compose_webmail up -d --no-build --remove-orphans "${WEBMAIL_SERVICES[@]}"
    compose up -d --no-build --remove-orphans "${SERVICES[@]}"
    wait_healthy compose api worker web mail postgres redis
    echo "== Webmail containers with replicas 0"
    for name in webmail webmail-db; do
        if [[ -n $(compose_webmail ps --all -q "$name") ]]; then
            echo "FAIL $name exists"
            failed=1
        else
            echo "ok   $name absent"
        fi
    done
    if [[ -n $(compose ps --all -q webmail-bridge) ]]; then
        echo "FAIL webmail-bridge exists"
        failed=1
    else
        echo "ok   webmail-bridge absent"
    fi
    compose --profile tests run --rm -e E2E_PHASE=flag-off tests bash -lc \
        'npm install --no-audit --no-fund --loglevel=error && npx playwright test --project=flag-off' || failed=1
    return "$failed"
}

cmd_down() {
    generate_env
    generate_certs
    # The webmail project first: it uses networks the Orbit project owns.
    compose_webmail down -v --remove-orphans
    compose --profile tests down -v --remove-orphans
    docker network rm "$BACKUP_NETWORK" >/dev/null 2>&1 || true
}

case "${1:-all}" in
    up) cmd_up ;;
    test) shift; cmd_test "$@" ;;
    checks) cmd_checks ;;
    flag-off) cmd_flag_off ;;
    down) cmd_down ;;
    all)
        status=0
        cmd_up
        cmd_test || status=1
        cmd_checks || status=1
        cmd_flag_off || status=1
        [[ ${KEEP_STACK:-0} == 1 ]] || cmd_down
        exit "$status"
        ;;
    *) echo "usage: $0 all|up|test|checks|flag-off|down" >&2; exit 2 ;;
esac
