#!/usr/bin/env bash
# Starts (or restarts) a throwaway local n8n for the end-to-end test: SQLite,
# loopback only, the three generated workflows and test-only secrets. Never
# point this at a shared or production n8n.
#
#   N8N_BIN=/path/to/n8n start-n8n.sh <integrations.json>
#
# <integrations.json> is the gateway's CC_GATEWAY_INTEGRATIONS document (the
# Orbit integration ids exist only once the test has created them).
set -euo pipefail
: "${N8N_BIN:?set N8N_BIN to the n8n executable}"
INTEGRATIONS=${1:?integrations file}
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
PORT=${N8N_E2E_PORT:-5678}
PID_FILE=${TMPDIR:-/tmp}/orbit-cc-n8n-e2e-$PORT.pid
# A fresh n8n home per start: n8n publishes imported versions asynchronously,
# so a reused home would serve the previous version for a while.
HOME_DIR=$(mktemp -d "${TMPDIR:-/tmp}/orbit-cc-n8n-e2e.XXXXXX")

token() { node --input-type=module -e "import { E2E } from '$HERE/e2e/product-stubs.mjs'; console.log(E2E.$1)"; }

# A clean environment (not the caller's, e.g. a test runner's NODE_ENV or
# PORT); execution-data and Code node settings as in deploy/n8n.env.example.
ENV=(PATH="$PATH" HOME="${HOME:-/tmp}"
  N8N_USER_FOLDER="$HOME_DIR" N8N_PORT="$PORT" N8N_LISTEN_ADDRESS=127.0.0.1 N8N_HOST=127.0.0.1 N8N_PROTOCOL=http
  DB_TYPE=sqlite N8N_DIAGNOSTICS_ENABLED=false N8N_PERSONALIZATION_ENABLED=false
  N8N_VERSION_NOTIFICATIONS_ENABLED=false N8N_TEMPLATES_ENABLED=false N8N_LOG_LEVEL=warn GENERIC_TIMEZONE=UTC
  EXECUTIONS_DATA_SAVE_ON_SUCCESS=none EXECUTIONS_DATA_SAVE_ON_ERROR=none EXECUTIONS_DATA_SAVE_ON_PROGRESS=false
  EXECUTIONS_DATA_SAVE_MANUAL_EXECUTIONS=false EXECUTIONS_DATA_PRUNE=true EXECUTIONS_DATA_MAX_AGE=24
  NODE_FUNCTION_ALLOW_BUILTIN=crypto N8N_BLOCK_ENV_ACCESS_IN_NODE=false
  CC_GATEWAY_INTEGRATIONS="$(cat "$INTEGRATIONS")"
  CC_DESK_BASE_URL="http://127.0.0.1:${DESK_STUB_PORT:-5801}" CC_DESK_TOKEN="$(token deskToken)"
  CC_FAMILYPLAN_FUNCTION_URL="http://127.0.0.1:${FAMILYPLAN_STUB_PORT:-5802}/functions/v1/support-customer-context"
  CC_FAMILYPLAN_TOKEN="$(token familyPlanToken)")
n8n() { env -i "${ENV[@]}" "$N8N_BIN" "$@"; }

if [ -f "$PID_FILE" ]; then
  kill "$(cat "$PID_FILE")" 2>/dev/null || true
  for _ in $(seq 1 30); do kill -0 "$(cat "$PID_FILE")" 2>/dev/null || break; sleep 1; done
fi
for file in adapter-uliquid-desk adapter-familyplan gateway; do
  n8n import:workflow --input="$HERE/workflows/$file.json" >/dev/null
done
for id in CcAdapterUliquidDesk01 CcAdapterFamilyPlan001 CcGatewayOrbit0001; do
  n8n publish:workflow --id="$id" >/dev/null
done
nohup env -i "${ENV[@]}" "$N8N_BIN" start >"$HOME_DIR/n8n.log" 2>&1 &
echo $! >"$PID_FILE"

# Ready when the gateway webhook answers: an unsigned call is refused with 401.
URL="http://127.0.0.1:$PORT/webhook/orbit-cc/v1/customer-context/lookup"
for _ in $(seq 1 120); do
  code=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' -d '{}' "$URL" || true)
  [ "$code" = "401" ] && { echo "n8n ready on :$PORT ($HOME_DIR)"; exit 0; }
  sleep 1
done
echo "n8n did not become ready" >&2
tail -20 "$HOME_DIR/n8n.log" >&2
exit 1
