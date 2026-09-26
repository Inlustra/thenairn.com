#!/bin/bash
# The ONLY command the media worker is allowed to run.
#
#   watch-request.sh "<exact title>" "<sourceSession>"
#
# Creates a one-shot automation that watches that one download and wakes the
# asking conversation the moment it finishes, fails or gets stuck. The worker
# gets this script rather than the openclaw CLI, so the only thing it can
# create is a concierge-bound watch for a title it was just asked to fetch.
set -euo pipefail

TITLE="${1:-}"
SOURCE_SESSION="${2:-}"
WATCHER=/mnt/user/HQ/thenairn.com/media-watch/watch-one.mjs
OPENCLAW=/usr/local/bin/openclaw

die() { echo "watch-request: $*" >&2; exit 1; }

[ -n "$TITLE" ] || die "a title is required"
[ -n "$SOURCE_SESSION" ] || die "a source session is required"
[ "${#TITLE}" -le 200 ] || die "title too long"

# Only ever bind a watch to a real guest conversation with Milo. This is the
# guard that makes handing the worker this script safe: it cannot schedule a
# turn for Thor, for the media agent, or for itself.
case "$SOURCE_SESSION" in
  agent:concierge:cron:*|agent:concierge:*:run:*)
    die "refusing to bind a watch to a transient run session" ;;
  agent:concierge:*) : ;;
  *) die "refusing to bind a watch outside a concierge conversation" ;;
esac
printf '%s' "$SOURCE_SESSION" | grep -Eq '^agent:concierge:[A-Za-z0-9:+._@-]+$' \
  || die "source session has unexpected characters"

# Shell-quote the title for the on-exit command string, which the Gateway runs
# via sh -lc. Without this a title containing a quote would break out.
QUOTED_TITLE=$(printf '%q' "$TITLE")

exec "$OPENCLAW" cron create "watch: ${TITLE}" \
  --on-exit "node ${WATCHER} --match ${QUOTED_TITLE}" \
  --agent concierge \
  --session current \
  --session-key "$SOURCE_SESSION" \
  --tools ask_user,sessions_send,automations \
  --announce \
  --delete-after-run \
  --description "Per-request watch on ${TITLE}. Fires once when it finishes, fails or stalls." \
  --message "The download you were waiting on has changed state: ${TITLE}. Ask the worker for fresh status, then tell this person in your own voice if it is worth telling them. If it went wrong, say so plainly and say what you are doing about it. If nothing here is worth their time, say nothing."
