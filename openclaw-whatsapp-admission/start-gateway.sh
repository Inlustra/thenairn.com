#!/bin/sh
set -u
PATCHER=/mnt/user/HQ/thenairn.com/openclaw-whatsapp-admission/patch-installed-whatsapp.mjs
if ! node "$PATCHER"; then
  echo "ERROR: WhatsApp Concierge admission UX patch did not apply; starting Gateway with upstream secure pairing behavior" >&2
fi
exec node /app/openclaw.mjs gateway
