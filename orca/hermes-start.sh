#!/usr/bin/env bash
# Start the Hermes gateway (the project-manager seat) beside the Orca runtime.
# Called from orca-entrypoint before it execs `orca serve`. Idempotent.
# Binary: baked into the image (Dockerfile, HERMES_VERSION). State: $HOME/.hermes, persisted.
set -uo pipefail
: "${HOME:=/home/orca}"
HQ_CONTROL="${HQ_CONTROL:-/mnt/user/HQ/repos/hq-control}"
PROFILE="${HERMES_PM_PROFILE:-rowm}"
LOG_DIR="$HOME/.hermes/logs"
mkdir -p "$LOG_DIR"
log() { echo "[hermes-start] $(date '+%F %T') $*"; }

command -v hermes >/dev/null 2>&1 || { log "no hermes binary in this image; skipping"; exit 0; }

# Profiles are Hermes distributions kept in hq-control. --force keeps memories, sessions and auth.
if [ -d "$HQ_CONTROL/profiles" ]; then
  for p in "$HQ_CONTROL"/profiles/*/; do
    [ -f "$p/distribution.yaml" ] || continue
    if hermes profile install "$p" --force -y >>"$LOG_DIR/profile-install.log" 2>&1; then
      log "profile $(basename "$p") installed"
    else
      log "profile $(basename "$p") install FAILED (see profile-install.log)"
    fi
  done
else
  log "no hq-control checkout at $HQ_CONTROL; gateway starts with whatever profiles exist"
fi

if pgrep -f "hermes.* gateway run" >/dev/null 2>&1; then
  log "gateway already running"
else
  nohup hermes -p "$PROFILE" gateway run >>"$LOG_DIR/gateway-$PROFILE.log" 2>&1 &
  log "gateway started for profile $PROFILE (pid $!)"
fi

# Dashboard for Caddy (hermes.thenairn.com -> orca:9119). Non-loopback binds require Hermes' own auth.
if pgrep -f "hermes.* dashboard" >/dev/null 2>&1; then
  log "dashboard already running"
else
  nohup hermes dashboard --host 0.0.0.0 --port 9119 --no-open --skip-build >>"$LOG_DIR/dashboard.log" 2>&1 &
  log "dashboard started (pid $!)"
fi
