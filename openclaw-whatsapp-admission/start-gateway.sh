#!/bin/sh
set -u
AUTHORITY_PATCH=/mnt/user/HQ/thenairn.com/openclaw-authority-fix/patch.mjs
if ! node "$AUTHORITY_PATCH" --apply; then
  echo "ERROR: owner-authority repair validation failed; refusing unsafe Gateway startup" >&2
  exit 1
fi
PATCHER=/mnt/user/HQ/thenairn.com/openclaw-whatsapp-admission/patch-installed-whatsapp.mjs
if ! node "$PATCHER"; then
  echo "ERROR: WhatsApp Concierge admission UX patch did not apply; starting Gateway with upstream secure pairing behavior" >&2
fi
exec node /app/openclaw.mjs gateway
