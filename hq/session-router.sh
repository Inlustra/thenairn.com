#!/bin/bash
# Session Router — called by sshd ForceCommand for user 'hq'
# Looks up the password used to authenticate, finds the target tmux session,
# attaches to it, and invalidates the password.

LOOKUP_FILE="/mnt/user/HQ/session-lookup.json"
LOG_FILE="/mnt/user/HQ/session-router.log"

log() {
  echo "$(date '+%Y-%m-%d %H:%M:%S') $1" >> "$LOG_FILE"
}

# The HQ_SESSION env var is set by the PAM exec script after password validation
SESSION_TARGET="$HQ_SESSION"

if [ -z "$SESSION_TARGET" ]; then
  log "ERROR: No session target found"
  echo "No session target. Connection rejected."
  exit 1
fi

log "Connecting to session: $SESSION_TARGET"

# Attach to existing tmux session or create it
if tmux has-session -t "$SESSION_TARGET" 2>/dev/null; then
  log "Attaching to existing session: $SESSION_TARGET"
  exec tmux attach-session -t "$SESSION_TARGET"
else
  # Check if it's a project path
  PROJECT_DIR="/mnt/user/Internal/$SESSION_TARGET"
  if [ -d "$PROJECT_DIR" ]; then
    log "Creating new session for project: $SESSION_TARGET at $PROJECT_DIR"
    tmux new-session -d -s "$SESSION_TARGET" -c "$PROJECT_DIR"
    exec tmux attach-session -t "$SESSION_TARGET"
  else
    log "ERROR: No tmux session and no project dir for: $SESSION_TARGET"
    echo "Session '$SESSION_TARGET' not found."
    exit 1
  fi
fi
