#!/usr/bin/env bash
# Encrypted off-host PostgreSQL backup for Orbit.
# Daily: pg_dump (custom format) -> pg_restore -l check -> age encryption to the
# owner's public key -> upload with a SHA-256 sidecar -> size verification.
# The age private key never exists on the server. Retention is a bucket
# lifecycle rule, so this container needs no delete permission.
set -euo pipefail

STATE_FILE=/tmp/orbit-backup-state
: "${BACKUP_HOUR_UTC:=3}"
: "${BACKUP_S3_PREFIX:=orbit/}"
export HOME=/tmp RCLONE_CONFIG=/tmp/rclone.conf
[[ -f "$RCLONE_CONFIG" ]] || : >"$RCLONE_CONFIG"

log() { echo "$(date -u +%FT%TZ) orbit-backup $*"; }
state() { printf '%s %s %s\n' "$1" "$(date -u +%s)" "${2:-}" >"$STATE_FILE"; }

configured() {
  [[ -n "${BACKUP_AGE_RECIPIENT:-}" ]] || return 1
  [[ -n "${BACKUP_RCLONE_REMOTE:-}" ]] && return 0
  [[ -n "${BACKUP_S3_ENDPOINT:-}" && -n "${BACKUP_S3_BUCKET:-}" &&
    -n "${BACKUP_S3_ACCESS_KEY_ID:-}" && -n "${BACKUP_S3_SECRET_ACCESS_KEY:-}" ]]
}

remote() {
  if [[ -n "${BACKUP_RCLONE_REMOTE:-}" ]]; then
    printf '%s/%s' "${BACKUP_RCLONE_REMOTE%/}" "$BACKUP_S3_PREFIX"
  else
    printf 'orbitbackup:%s/%s' "$BACKUP_S3_BUCKET" "$BACKUP_S3_PREFIX"
  fi
}

# Runs in a subshell so the work directory is always removed on exit.
run_once() (
  export RCLONE_CONFIG_ORBITBACKUP_TYPE=s3
  export RCLONE_CONFIG_ORBITBACKUP_PROVIDER="${BACKUP_S3_PROVIDER:-Cloudflare}"
  export RCLONE_CONFIG_ORBITBACKUP_ENDPOINT="${BACKUP_S3_ENDPOINT:-}"
  export RCLONE_CONFIG_ORBITBACKUP_ACCESS_KEY_ID="${BACKUP_S3_ACCESS_KEY_ID:-}"
  export RCLONE_CONFIG_ORBITBACKUP_SECRET_ACCESS_KEY="${BACKUP_S3_SECRET_ACCESS_KEY:-}"
  export RCLONE_CONFIG_ORBITBACKUP_REGION="${BACKUP_S3_REGION:-auto}"
  export RCLONE_CONFIG_ORBITBACKUP_NO_CHECK_BUCKET=true
  local ts name work dump enc sha size uploaded
  ts="$(date -u +%Y%m%dT%H%M%SZ)"
  name="orbit-${ts}.dump.age"
  work="$(mktemp -d /tmp/orbit-backup.XXXXXX)"
  trap 'rm -rf "$work"' EXIT
  umask 077
  dump="$work/orbit.dump"
  enc="$work/$name"
  pg_dump --format=custom --file="$dump"
  pg_restore --list "$dump" >/dev/null
  age --recipient "$BACKUP_AGE_RECIPIENT" --output "$enc" "$dump"
  sha="$(sha256sum "$enc" | cut -d' ' -f1)"
  size="$(stat -c %s "$enc")"
  rclone copyto --retries 3 "$enc" "$(remote)$name"
  printf '%s  %s\n' "$sha" "$name" | rclone rcat "$(remote)$name.sha256"
  uploaded="$(rclone lsf --format s "$(remote)$name")"
  if [[ "$uploaded" != "$size" ]]; then
    log "upload size mismatch for $name: local=$size remote=$uploaded"
    return 1
  fi
  log "ok $name bytes=$size sha256=$sha"
  state ok "$name"
)

health() {
  [[ -f "$STATE_FILE" ]] || exit 1
  read -r status at _ <"$STATE_FILE"
  case "$status" in
    not_configured | waiting) exit 0 ;;
    ok) (($(date -u +%s) - at < 26 * 3600)) && exit 0 || exit 1 ;;
    *) exit 1 ;;
  esac
}

seconds_until_next_run() {
  local now next
  now="$(date -u +%s)"
  next="$(date -u -d "today ${BACKUP_HOUR_UTC}:00" +%s)"
  ((next > now)) || next="$(date -u -d "tomorrow ${BACKUP_HOUR_UTC}:00" +%s)"
  echo $((next - now))
}

main() {
  case "${1:-loop}" in
    health) health ;;
    once)
      configured || { log "not configured"; exit 2; }
      run_once
      ;;
    loop)
      if ! configured; then
        log "not configured; set BACKUP_AGE_RECIPIENT and the BACKUP_S3_* variables"
        state not_configured
        exec sleep infinity
      fi
      if [[ "${BACKUP_RUN_ON_START:-false}" == "true" ]]; then
        run_once || { log "failed"; state failed; }
      else
        state waiting
      fi
      while true; do
        sleep "$(seconds_until_next_run)"
        until run_once; do
          log "failed; retrying in one hour"
          state failed
          sleep 3600
        done
      done
      ;;
    *)
      echo "usage: orbit-backup [loop|once|health]" >&2
      exit 64
      ;;
  esac
}

main "$@"
