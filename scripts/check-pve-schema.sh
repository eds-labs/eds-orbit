#!/bin/sh
# A stored Coolify build-command hash approves database inputs independently of Git pushes.
set -eu
cd "$(dirname "$0")/.."
for file in packages/db/prisma/schema.prisma packages/db/prisma.config.ts scripts/db-deploy.ts packages/db/prisma/migrations/*/migration.sql; do
  test -f "$file" && test -r "$file" || { echo "PVE schema input is missing or unreadable" >&2; exit 1; }
done
actual=$(
  for file in packages/db/prisma/schema.prisma packages/db/prisma.config.ts scripts/db-deploy.ts packages/db/prisma/migrations/*/migration.sql; do
    sha256sum "$file"
  done | LC_ALL=C sort | sha256sum | cut -d ' ' -f 1
)
if [ "${1:-}" = "--print-hash" ]; then
  printf '%s\n' "$actual"
  exit 0
fi
canonical=$(sha256sum docker-compose.yml | cut -d ' ' -f 1)
recorded=$(sed -n 's/^# Canonical docker-compose.yml SHA256: //p' docker-compose.pve.yml)
if [ -z "$recorded" ] || [ "$canonical" != "$recorded" ]; then
  echo "PVE_COMPOSE_REGENERATION_REQUIRED: review and regenerate the VM102 adapter before deployment." >&2
  exit 1
fi
if [ -z "${ORBIT_APPROVED_SCHEMA_SHA256:-}" ] || [ "$actual" != "$ORBIT_APPROVED_SCHEMA_SHA256" ]; then
  echo "PVE_SCHEMA_APPROVAL_REQUIRED: database inputs changed or approval is missing. Keep production running and request migration review." >&2
  exit 1
fi
echo "Approved PVE database inputs unchanged"
