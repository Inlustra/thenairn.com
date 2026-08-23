#!/bin/sh
# Resolves PAPERCLIP_API_KEY from 1Password at container start so the
# credential never sits in this compose file or in .env. See the `runbook`
# document on RAI-106 for how to provision the 1Password item this reads.
set -eu

export PATH="/mnt/user/HQ/tools:${PATH}"
export OP_SERVICE_ACCOUNT_TOKEN="$(cat /mnt/user/HQ/.op/service-account-token 2>/dev/null || true)"

OP_REF="${BREAKER_API_KEY_OP_REF:-op://claw/paperclip-watchdog-key/credential}"
RETRY_SECONDS="${BREAKER_CREDENTIAL_RETRY_SECONDS:-300}"

if [ -z "${PAPERCLIP_API_KEY:-}" ]; then
    until PAPERCLIP_API_KEY="$(op read "$OP_REF" 2>/tmp/op-read.err)"; do
        echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) no credential yet at ${OP_REF} - retrying in ${RETRY_SECONDS}s, not crash-looping:" >&2
        cat /tmp/op-read.err >&2 || true
        sleep "$RETRY_SECONDS"
    done
    export PAPERCLIP_API_KEY
fi

exec python3 /app/breaker.py
