#!/bin/bash
# HQ Shell — login shell for the 'hq' user
# ForceCommand calls this. It finds the session target from the sessions dir
# and attaches to it. Each session file is named by password hash and contains
# the tmux session name. After use, the file is deleted (one-time use).

SESSIONS_DIR="/mnt/user/HQ/sessions"
LOG_FILE="/mnt/user/HQ/hq.log"
export PATH="/mnt/user/HQ/.bun/bin:/mnt/user/HQ/hq:$PATH"

log() {
  echo "$(date '+%Y-%m-%d %H:%M:%S') [hq-shell] $1" >> "$LOG_FILE"
}

# Find the oldest unclaimed session file (FIFO)
SESSION_FILE=$(ls -t "$SESSIONS_DIR"/*.session 2>/dev/null | tail -1)

if [ -z "$SESSION_FILE" ]; then
  log "No pending session files found"
  echo "No session available. Connection rejected."
  sleep 2
  exit 1
fi

SESSION_TARGET=$(cat "$SESSION_FILE")
SESSION_DIR=$(cat "${SESSION_FILE%.session}.dir" 2>/dev/null)
SESSION_CMD=$(cat "${SESSION_FILE%.session}.cmd" 2>/dev/null)

# Remove session files (one-time use)
rm -f "$SESSION_FILE" "${SESSION_FILE%.session}.dir" "${SESSION_FILE%.session}.cmd"

if [ -z "$SESSION_TARGET" ]; then
  log "Empty session target"
  echo "Invalid session. Connection rejected."
  sleep 2
  exit 1
fi

log "Session target: $SESSION_TARGET (dir: $SESSION_DIR, cmd: $SESSION_CMD)"

# Invalidate the password immediately by rotating to random
NEW_PASS=$(head -c 32 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9' | head -c 32)
echo "hq:$NEW_PASS" | chpasswd 2>/dev/null

# Determine working directory
if [ -n "$SESSION_DIR" ] && [ -d "$SESSION_DIR" ]; then
  DIR="$SESSION_DIR"
elif [ -d "/mnt/user/Internal/$SESSION_TARGET" ]; then
  DIR="/mnt/user/Internal/$SESSION_TARGET"
elif [ -d "/mnt/user/HQ/$SESSION_TARGET" ]; then
  DIR="/mnt/user/HQ/$SESSION_TARGET"
else
  DIR="/mnt/user/HQ"
fi

# Attach to existing or create new tmux session
if tmux has-session -t "$SESSION_TARGET" 2>/dev/null; then
  log "Attaching to existing: $SESSION_TARGET"
  exec tmux attach-session -t "$SESSION_TARGET"
else
  log "Creating session: $SESSION_TARGET at $DIR"
  if [ -n "$SESSION_CMD" ]; then
    # Create session with a specific command (e.g., "claude --continue")
    tmux new-session -d -s "$SESSION_TARGET" -c "$DIR" "$SESSION_CMD"
  else
    tmux new-session -d -s "$SESSION_TARGET" -c "$DIR"
  fi
  exec tmux attach-session -t "$SESSION_TARGET"
fi
