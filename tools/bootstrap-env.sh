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
# WHERE THE TOKEN IS WHEN TOWER IS GONE  (RAI-24, settled 2026-08-23)
# -------------------------------------------------------------------
# The service account token is what unlocks everything, and by default it lives
# at /mnt/user/HQ/.op/service-account-token -- on the same NVMe as the .env this
# migration exists to protect. So that file is NOT the copy you recover from.
#
# The copy that survives the disk is the 1Password item
#   "Service Account Auth Token: Claw"  (vault claw, id bmvzjdvqk5f2tizhfduqoavjoq)
# verified on 2026-08-23 to be byte-identical to the on-disk file.
#
# Read it as a HUMAN, not with op. The service account cannot fetch its own
# token when it has no token -- that is the circle. Thomas signs in to
# 1Password on his phone (account password + secret key, no service account
# involved), opens that item, copies the credential field, and then:
#
#     OP_SERVICE_ACCOUNT_TOKEN=ops_... tools/bootstrap-env.sh
#
# Rehearsed 2026-08-23 with nothing in the environment but that one variable:
# rebuilt all 73 variables, every value identical to the live .env, mode 600.
#
# Expiry: none recorded on the item and none carried in the token itself, so it
# cannot be read from this box -- only from the 1Password console. Created
# 2026-04-03 and still valid, so it is not on a 30/60/90-day rotation.
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
