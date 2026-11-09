#!/usr/bin/env bash
# End-to-end proof of the webmail module on the real Orbit stack (ADR 0026). Nothing leaves
# the local Docker daemon: the application's only way out is a Docker-internal network.
#
#   infra/webmail/test/run.sh all        (default) up, test, checks, flag-off, down
#   infra/webmail/test/run.sh up         generate throwaway secrets and start the stack
#   infra/webmail/test/run.sh test [..]  run the Playwright scenarios (arguments are passed on)
#   infra/webmail/test/run.sh checks     run the container-side checks
#   infra/webmail/test/run.sh flag-off   ORBIT_WEBMAIL=false, replicas 0, and verify
#   infra/webmail/test/run.sh down       remove this project's containers, networks, volumes
#
# E2E_BROWSERS limits the browsers (comma list). KEEP_STACK=1 skips the final down.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
HERE="$ROOT/infra/webmail/test"
PROJECT=orbit-webmail-e2e
WORK="$HERE/.work"
BROWSERS=(chromium firefox webkit)
export E2E_APEX=orbit.example.com
export E2E_MAIL_HOST=mail.acme.example.net
SERVICES=(postgres redis migrate api worker web mcp webmail webmail-db webmail-bridge mail caddy)

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
    [[ -f "$WORK/env" ]] && return
    umask 077
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
        for name in DBAPP DBAUTH DBMIGRATOR ORBITSETUPTOKEN WEBMAILDB; do
            echo "SERVICE_PASSWORD_64_$name=$(hex 32)"
        done
        for name in CREDENTIALKEY FILESKEY WEBMAILBRIDGE ROUNDCUBEDES; do
            echo "SERVICE_HEX_64_$name=$(hex 32)"
        done
        echo "SERVICE_REALBASE64_64_AUTHSECRET=$(openssl rand -base64 48 | tr -d '\n')"
        echo "SERVICE_BASE64_32_PUBLISHERINSTANCE=$(openssl rand -base64 24 | tr -d '\n')"
        echo "E2E_MAIL_PASSWORD=$mail_password"
        echo "E2E_GREENMAIL_USERS=$(mail_users "$mail_password")"
        echo "E2E_OWNER_PASSWORD=$(hex 24)"
        echo "E2E_MEMBER_PASSWORD=$(hex 24)"
    } > "$WORK/env"
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

# `up --wait` also fails on a one-shot that exited, so migrate is checked on its own.
wait_healthy() {
    local deadline=$((SECONDS + 420)) service state missing
    while (( SECONDS < deadline )); do
        missing=0
        for service in "$@"; do
            state=$(compose ps --all --format '{{.Health}}/{{.State}}' "$service" 2>/dev/null | head -1)
            [[ $state == healthy/running ]] || missing=1
        done
        (( missing == 0 )) && return 0
        sleep 3
    done
    echo "services not healthy in time:" >&2
    compose ps --all >&2
    return 1
}

cmd_up() {
    generate_env
    generate_certs
    compose build api webmail
    compose up -d --no-build "${SERVICES[@]}"
    wait_healthy api worker web webmail webmail-db webmail-bridge mail postgres redis
    [[ $(compose ps --all --format '{{.ExitCode}}' migrate) == 0 ]]
}

cmd_test() {
    compose --profile tests run --rm -e E2E_PHASE=enabled tests bash -lc \
        'npm install --no-audit --no-fund --loglevel=error && npx playwright test "$@"' -- "$@"
}

probe() { # container host port -> reachable|closed
    # shellcheck disable=SC2016
    docker exec "$1" php -r '[$h,$p]=[$argv[1],(int)$argv[2]];$s=@fsockopen($h,$p,$e,$m,3);echo $s?"reachable":"closed";' -- "$2" "$3"
}

cmd_checks() {
    local c ip target host port failed=0
    c=$(compose ps -q webmail)
    echo "== Roundcube's reach, by name and by IP"
    for target in api:4311 web:4310 mcp:4312 postgres:5432 redis:6379; do
        host=${target%%:*} port=${target##*:}
        if [[ $(probe "$c" "$host" "$port") != closed ]]; then
            echo "FAIL $target reachable by name"
            failed=1
        else
            echo "ok   $target closed by name"
        fi
        while read -r ip; do
            [[ -z $ip ]] && continue
            if [[ $(probe "$c" "$ip" "$port") != closed ]]; then
                echo "FAIL $target reachable at $ip"
                failed=1
            else
                echo "ok   $target closed at $ip"
            fi
        done < <(docker inspect -f '{{range .NetworkSettings.Networks}}{{println .IPAddress}}{{end}}' "$(compose ps -q "$host")")
    done
    if [[ $(probe "$c" webmail-bridge 4313) == reachable ]]; then
        echo "ok   webmail-bridge:4313 reachable"
    else
        echo "FAIL webmail-bridge:4313 not reachable"
        failed=1
    fi
    echo "== Containers"
    for service in api worker web webmail-bridge webmail; do
        docker inspect -f "$service readonly={{.HostConfig.ReadonlyRootfs}} capdrop={{.HostConfig.CapDrop}}" "$(compose ps -q "$service")"
    done
    return "$failed"
}

cmd_flag_off() {
    local name failed=0
    export ORBIT_WEBMAIL=false ORBIT_WEBMAIL_REPLICAS=0
    compose up -d --no-build --remove-orphans "${SERVICES[@]}"
    wait_healthy api worker web mail postgres redis
    echo "== Webmail containers with replicas 0"
    for name in webmail webmail-db webmail-bridge; do
        if [[ -n $(compose ps --all -q "$name") ]]; then
            echo "FAIL $name exists"
            failed=1
        else
            echo "ok   $name absent"
        fi
    done
    compose --profile tests run --rm -e E2E_PHASE=flag-off tests bash -lc \
        'npm install --no-audit --no-fund --loglevel=error && npx playwright test --project=flag-off' || failed=1
    return "$failed"
}

cmd_down() {
    generate_env
    generate_certs
    compose --profile tests down -v --remove-orphans
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
