#!/bin/bash
# Roll Orca back to 1.4.42-rc.5 if the 1.4.60 upgrade misbehaves.
# Run on the Unraid host (or any context with the docker.sock).
set -euo pipefail
COMPOSE="/mnt/user/Internal/thenairn.com/docker-compose.orca.yml"

# Re-pin the version in compose + Dockerfile.
sed -i 's/ORCA_VERSION: "1.4.60"/ORCA_VERSION: "1.4.42-rc.5"/' "$COMPOSE"
sed -i 's/ARG ORCA_VERSION=1.4.60/ARG ORCA_VERSION=1.4.42-rc.5/' \
  /mnt/user/Internal/thenairn.com/orca/Dockerfile

# Restore the saved image and recreate from it (no rebuild needed).
docker tag thenairncom-orca:rollback-1.4.42-rc.5 thenairncom-orca:latest
docker compose -p thenairncom -f "$COMPOSE" up -d --force-recreate orca
echo "[orca] rolled back to 1.4.42-rc.5"
