#!/bin/bash
# Recreate the orca container onto the new image, then verify it stays up.
# If it fails to run within the grace window, auto-roll-back to the saved image.
# Run from a DETACHED helper container (not the orca container itself), since
# recreating orca would kill any driver running inside it.
set -uo pipefail
COMPOSE="/mnt/user/Internal/thenairn.com/docker-compose.orca.yml"
log() { echo "[orca-upgrade] $(date '+%F %T') $*"; }

log "recreating orca onto thenairncom-orca:latest (1.4.144)"
docker compose -p thenairncom -f "$COMPOSE" up -d --force-recreate orca

# Give it up to 60s to settle into a running state.
ok=0
for i in $(seq 1 30); do
  sleep 2
  state=$(docker inspect orca --format '{{.State.Status}}' 2>/dev/null || echo missing)
  restarts=$(docker inspect orca --format '{{.RestartCount}}' 2>/dev/null || echo 0)
  log "check $i: state=$state restarts=$restarts"
  if [ "$state" = "running" ] && [ "${restarts:-0}" -lt 2 ]; then
    # require it to hold running for two consecutive checks
    ok=$((ok+1)); [ "$ok" -ge 2 ] && { log "orca is up on 1.4.144"; exit 0; }
  else
    ok=0
  fi
done

log "orca did NOT stabilise — auto-rolling back to 1.4.60"
sed -i 's/ORCA_VERSION: "1.4.144"/ORCA_VERSION: "1.4.60"/' "$COMPOSE"
sed -i 's/ARG ORCA_VERSION=1.4.144/ARG ORCA_VERSION=1.4.60/' \
  /mnt/user/Internal/thenairn.com/orca/Dockerfile
docker tag thenairncom-orca:rollback-1.4.60 thenairncom-orca:latest
docker compose -p thenairncom -f "$COMPOSE" up -d --force-recreate orca
log "rolled back to 1.4.60"
exit 1
