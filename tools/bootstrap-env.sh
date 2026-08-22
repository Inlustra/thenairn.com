#!/bin/bash
# Rebuild thenairn.com/.env from 1Password. One command, no interactive login.
#
#     tools/bootstrap-env.sh && tools/up.sh --build
#
# Those two commands are the whole recovery: .env rebuilt from the vault, then
# all 43 services up in a recorded order. NOT `docker compose up -d` — no single
# compose file here is a valid project on its own (caddy links to ten services
# defined in three other files), so a bare compose command needs the full -f
# chain that tools/up.sh assembles from compose.manifest.
#
# This is the ssh path (RAI-15). It is deliberately dependency-light: it needs
# the `op` binary, a service account token, and network. Nothing else.
#
# THE ONE THING THAT CAN STRAND YOU
# ---------------------------------
# The service account token is what unlocks everything, and by default it lives
# at /mnt/user/HQ/.op/service-account-token -- on the same NVMe as the .env this
# migration exists to protect. If that disk dies you have the vault and no key
# to it. Keep a copy of the token somewhere you can reach from a phone, and pass
# it in when recovering onto a fresh box:
#
#     OP_SERVICE_ACCOUNT_TOKEN=ops_... tools/bootstrap-env.sh
#
set -euo pipefail

HQ="${HQ:-/mnt/user/HQ}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OP="${OP_BIN:-$HQ/tools/op}"
TEMPLATE="${TEMPLATE:-$REPO/tools/env.template}"
TARGET="${TARGET:-$REPO/.env}"

die() { echo "bootstrap-env: $*" >&2; exit 1; }

[[ -x "$OP" ]] || die "no op binary at $OP (set OP_BIN)"
[[ -f "$TEMPLATE" ]] || die "no template at $TEMPLATE"

if [[ -z "${OP_SERVICE_ACCOUNT_TOKEN:-}" ]]; then
  for candidate in "$HQ/.op/service-account-token" "/HQ/.op/service-account-token"; do
    if [[ -r "$candidate" ]]; then
      OP_SERVICE_ACCOUNT_TOKEN="$(<"$candidate")"
      break
    fi
  done
fi
[[ -n "${OP_SERVICE_ACCOUNT_TOKEN:-}" ]] || die \
  "no service account token. Pass OP_SERVICE_ACCOUNT_TOKEN=ops_... (see header)."
export OP_SERVICE_ACCOUNT_TOKEN

# Never clobber a working .env silently -- it may hold a hand-edit that has not
# made it back into 1Password yet.
if [[ -e "$TARGET" ]]; then
  backup="$TARGET.pre-bootstrap-$(date +%Y%m%d-%H%M%S)"
  cp -p "$TARGET" "$backup"
  chmod 600 "$backup"
  echo "bootstrap-env: existing .env backed up to $(basename "$backup")"
fi

umask 077
tmp="$(mktemp "${TMPDIR:-/tmp}/env.XXXXXX")"
trap 'rm -f "$tmp"' EXIT

# `op inject -o` echoes the output path on stdout; keep this script's stdout to
# our own status line so it stays pipeable.
"$OP" inject -i "$TEMPLATE" -o "$tmp" -f >/dev/null \
  || die "op inject failed -- token invalid, offline, or item missing?"

count=$(grep -cE '^[A-Za-z_][A-Za-z0-9_]*=' "$tmp" || true)
[[ "$count" -gt 0 ]] || die "rebuilt file has no variables; refusing to install it"

# A reference that silently fails to resolve would leave an empty value and a
# service that starts misconfigured rather than not at all. Catch it here.
if grep -qE '^[A-Za-z_][A-Za-z0-9_]*=("")?$' "$tmp"; then
  die "one or more variables resolved to empty; refusing to install it"
fi

mv "$tmp" "$TARGET"
trap - EXIT
chmod 600 "$TARGET"
echo "bootstrap-env: wrote $TARGET ($count variables) from op://claw/thenairn-env"
