#!/bin/bash
# Recreate the orca container onto the newly built image, then verify it stays
# up AND actually serves. If it fails within the grace window, auto-roll-back to
# the saved image.
#
# Run from a DETACHED helper container (not the orca container itself), since
# recreating orca would kill any driver running inside it.
#
# Version-agnostic by design: it reads the target from the compose file and the
# rollback target from the tag you pass in, so it does not need editing every
# upgrade. The previous revision hardcoded versions and drifted into pointing at
# a rollback image that no longer existed.
#
# Usage: do-upgrade.sh <rollback-version>
#   e.g. do-upgrade.sh 1.4.144   (requires thenairncom-orca:rollback-1.4.144)

set -uo pipefail

REPO="/mnt/user/HQ/thenairn.com"
COMPOSE="$REPO/docker-compose.orca.yml"
DOCKERFILE="$REPO/orca/Dockerfile"
PORT=6768

log() { echo "[orca-upgrade] $(date '+%F %T') $*"; }
die() { log "ERROR: $*"; exit 2; }

ROLLBACK_VER="${1:-}"
[ -n "$ROLLBACK_VER" ] || die "usage: $0 <rollback-version>"

ROLLBACK_IMAGE="thenairncom-orca:rollback-${ROLLBACK_VER}"
docker image inspect "$ROLLBACK_IMAGE" >/dev/null 2>&1 \
  || die "rollback image $ROLLBACK_IMAGE does not exist — tag it before upgrading"

TARGET_VER=$(grep -oP 'ORCA_VERSION:\s*"\K[^"]+' "$COMPOSE")
[ -n "$TARGET_VER" ] || die "could not read ORCA_VERSION from $COMPOSE"
[ "$TARGET_VER" != "$ROLLBACK_VER" ] || die "target and rollback are both $TARGET_VER"

log "upgrading orca: $ROLLBACK_VER -> $TARGET_VER (rollback image: $ROLLBACK_IMAGE)"

# --no-deps so a stale dependency cannot drag other services into the recreate.
docker compose -p thenairncom -f "$COMPOSE" up -d --force-recreate --no-deps orca \
  || die "compose up failed; container left as-is"

# Health = running, not restart-looping, and the serve port accepting TCP.
# Container-runs-only was the old check's blind spot: orca can stay up with
# pairing broken.
ok=0
for i in $(seq 1 45); do
  sleep 2
  state=$(docker inspect orca --format '{{.State.Status}}' 2>/dev/null || echo missing)
  restarts=$(docker inspect orca --format '{{.RestartCount}}' 2>/dev/null || echo 0)
  serving=no
  if [ "$state" = "running" ] \
    && docker exec orca bash -c "exec 3<>/dev/tcp/127.0.0.1/$PORT" >/dev/null 2>&1; then
    serving=yes
  fi
  log "check $i: state=$state restarts=$restarts serving=$serving"
  if [ "$state" = "running" ] && [ "${restarts:-0}" -lt 2 ] && [ "$serving" = yes ]; then
    # require it to hold healthy for three consecutive checks
    ok=$((ok + 1))
    [ "$ok" -ge 3 ] && { log "orca is up and serving on $TARGET_VER"; exit 0; }
  else
    ok=0
  fi
done

log "orca did NOT stabilise on $TARGET_VER — auto-rolling back to $ROLLBACK_VER"
sed -i "s/ORCA_VERSION: \"$TARGET_VER\"/ORCA_VERSION: \"$ROLLBACK_VER\"/" "$COMPOSE"
sed -i "s/ARG ORCA_VERSION=$TARGET_VER/ARG ORCA_VERSION=$ROLLBACK_VER/" "$DOCKERFILE"
docker tag "$ROLLBACK_IMAGE" thenairncom-orca:latest
docker compose -p thenairncom -f "$COMPOSE" up -d --force-recreate --no-deps orca
log "rolled back to $ROLLBACK_VER"
exit 1
