#!/usr/bin/env bash
set -uo pipefail

: "${ORCA_PORT:=6768}"
: "${ORCA_PAIRING_ADDRESS:=wss://orca.thenairn.com}"
: "${HOME:=/home/orca}"

# Persisted tool locations (HOME is bind-mounted to cache). Steer package
# managers here so anything installed at runtime survives container recreate.
# These stay container-owned (Debian binaries) — NOT shared with the host.
export NPM_CONFIG_PREFIX="${NPM_CONFIG_PREFIX:-$HOME/.npm-global}"
export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
export PIPX_HOME="${PIPX_HOME:-$HOME/.local/pipx}"
export PIPX_BIN_DIR="${PIPX_BIN_DIR:-$HOME/.local/bin}"
export MISE_DATA_DIR="${MISE_DATA_DIR:-$HOME/.local/share/mise}"
export PATH="$HOME/.local/bin:$NPM_CONFIG_PREFIX/bin:$BUN_INSTALL/bin:$PATH"
mkdir -p "$HOME/.local/bin" "$NPM_CONFIG_PREFIX/bin" "$BUN_INSTALL/bin"

# Share the host's root *configs* live (host /root bind-mounted at /hostroot).
# Symlinks, not bind mounts: hot files like .claude.json survive atomic
# rewrites, and a not-yet-restored /root self-heals once the host rsync
# repopulates it. Binaries are NOT shared (arch differs) — only data/creds.
HOSTROOT=/hostroot
if [ -d "$HOSTROOT" ]; then
  for rel in .claude .claude.json .gitconfig .ssh .config/gh; do
    src="$HOSTROOT/$rel"; dst="$HOME/$rel"
    [ -e "$src" ] || [ -L "$src" ] || continue
    if [ ! -L "$dst" ] && [ -e "$dst" ]; then rm -rf "$dst"; fi
    mkdir -p "$(dirname "$dst")"
    ln -sfn "$src" "$dst"
  done
fi

# Ensure the Claude Code *binary* exists (container-native, persisted npm
# prefix); its config/auth/history come from the host via the symlink above.
if ! command -v claude >/dev/null 2>&1; then
  echo "[orca] installing claude into $NPM_CONFIG_PREFIX ..."
  npm install -g @anthropic-ai/claude-code >/tmp/claude-install.log 2>&1 \
    || echo "[orca] claude install failed (see /tmp/claude-install.log)" >&2
fi

# Headless display for Electron. NOTE: xvfb-run hangs when the container is
# detached, so start Xvfb directly and export DISPLAY ourselves.
Xvfb :99 -screen 0 1280x1024x24 -nolisten tcp >/tmp/xvfb.log 2>&1 &
export DISPLAY=:99
for _ in $(seq 1 50); do [ -e /tmp/.X11-unix/X99 ] && break; sleep 0.1; done

CLI=/opt/Orca/resources/app.asar.unpacked/out/cli/index.js
exec env ELECTRON_RUN_AS_NODE=1 /opt/Orca/orca-ide "$CLI" \
  serve --port "$ORCA_PORT" --pairing-address "$ORCA_PAIRING_ADDRESS"
