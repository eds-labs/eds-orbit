#!/bin/sh
# Build images without interpolating production runtime secrets through Compose.
set -eu
cd "$(dirname "$0")/.."
sh scripts/check-pve-schema.sh
docker build --target runner -f infra/Dockerfile -t eds-orbit:pve-production .
docker build -f infra/backup/Dockerfile -t eds-orbit-backup:pve-production .
