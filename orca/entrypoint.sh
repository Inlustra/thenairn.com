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

# codex and opencode each share ONE credential store with the host, which links
# the same two paths into its own tmpfs /root (user script `agent-cli-setup`),
# so a single login on either side serves both. Pointed straight at HQ rather
# than via /hostroot, so neither side depends on the other having booted first.
#
# /mnt/cache, not /mnt/user: HQ is cache=only so they are the same directory,
# but /mnt/user is shfs (FUSE) and this compose file bind-mounts /mnt/cache, so
# both sides reach these files as the same btrfs inode. That is what makes
# sharing opencode's SQLite WAL database safe — it is then no more shared than
# between two processes on one machine. Via the /mnt/user view it would not be.
# Directory symlinks, never file ones: both tools rewrite credentials through
# an atomic rename(), which would replace a file symlink with a real file and
# silently split the store in two.
if [ -d /mnt/cache/HQ ]; then
  for pair in "$HOME/.codex:/mnt/cache/HQ/.codex" \
              "$HOME/.local/share/opencode:/mnt/cache/HQ/.opencode"; do
    dst="${pair%%:*}"; store="${pair#*:}"
    mkdir -p "$store" "$(dirname "$dst")"
    if [ ! -L "$dst" ] && [ -e "$dst" ]; then
      cp -a --update "$dst"/. "$store"/ 2>/dev/null || true
      rm -rf "$dst"
    fi
    ln -sfn "$store" "$dst"
  done
fi

# Ensure the agent CLI *binaries* exist (container-native, persisted npm
# prefix). Their state lives in the persisted HOME too, so logins survive a
# recreate: claude via the /hostroot symlink above, codex and opencode via the
# shared HQ stores linked just above. Nothing here logs anyone in — these are
# re-installs for a wiped prefix, not a credential path.
for spec in claude:@anthropic-ai/claude-code codex:@openai/codex opencode:opencode-ai; do
  bin="${spec%%:*}"; pkg="${spec#*:}"
  command -v "$bin" >/dev/null 2>&1 && continue
  echo "[orca] installing $bin into $NPM_CONFIG_PREFIX ..."
  npm install -g "$pkg" >"/tmp/$bin-install.log" 2>&1 \
    || echo "[orca] $bin install failed (see /tmp/$bin-install.log)" >&2
done

# Headless display for Electron. NOTE: xvfb-run hangs when the container is
# detached, so start Xvfb directly and export DISPLAY ourselves.
Xvfb :99 -screen 0 1280x1024x24 -nolisten tcp >/tmp/xvfb.log 2>&1 &
export DISPLAY=:99
for _ in $(seq 1 50); do [ -e /tmp/.X11-unix/X99 ] && break; sleep 0.1; done

CLI=/opt/Orca/resources/app.asar.unpacked/out/cli/index.js
exec env ELECTRON_RUN_AS_NODE=1 /opt/Orca/orca-ide "$CLI" \
  serve --port "$ORCA_PORT" --pairing-address "$ORCA_PAIRING_ADDRESS"
