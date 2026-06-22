#!/bin/bash
set -e

HQ_DIR="/mnt/user/Internal/thenairn.com/hq"
BUN_DIR="/mnt/user/HQ/.bun"
SESSIONS_DIR="/mnt/user/HQ/sessions"
GO_FILE="/boot/config/go"
MARKER="# Homelab Launcher (hq)"
TMUX_PKG="/boot/config/plugins/preclear.disk/tmux-3.0a-x86_64-1.txz"

echo "=== HQ Setup ==="
echo ""

# 1. Check/install Bun (needed for building)
if [ -x "$BUN_DIR/bin/bun" ]; then
    echo "[ok] Bun already installed at $BUN_DIR"
else
    echo "[..] Installing Bun to $BUN_DIR..."
    BUN_INSTALL="$BUN_DIR" curl -fsSL https://bun.sh/install | bash
    echo "[ok] Bun installed"
fi

export PATH="$BUN_DIR/bin:$PATH"
echo "     Bun version: $(bun --version)"

# 2. Install dependencies & build binary
echo "[..] Installing npm dependencies..."
cd "$HQ_DIR"
bun install --frozen-lockfile 2>/dev/null || bun install
echo "[ok] Dependencies installed"

echo "[..] Building hq binary..."
bun run build
echo "[ok] Binary compiled at $HQ_DIR/hq"

# 3. Check tmux
if command -v tmux &>/dev/null; then
    echo "[ok] tmux available: $(tmux -V)"
else
    if [ -f "$TMUX_PKG" ]; then
        echo "[..] Installing tmux from preclear plugin package..."
        installpkg "$TMUX_PKG"
        echo "[ok] tmux installed: $(tmux -V)"
    else
        echo "[!!] tmux not found. Install it via NerdTools/NerdPack."
        read -r
    fi
fi

# 4. Create sessions dir
mkdir -p "$SESSIONS_DIR"

# 5. Update /boot/config/go for boot persistence
if grep -q "$MARKER" "$GO_FILE" 2>/dev/null; then
    echo "[ok] Boot script already configured"
else
    echo "[..] Adding HQ to boot script ($GO_FILE)..."
    cat >> "$GO_FILE" << 'GOBLOCK'

# Homelab Launcher (hq)
[ -f /boot/config/plugins/preclear.disk/tmux-3.0a-x86_64-1.txz ] && installpkg /boot/config/plugins/preclear.disk/tmux-3.0a-x86_64-1.txz >/dev/null 2>&1
echo 'export BUN_INSTALL="/mnt/user/HQ/.bun"' >> /etc/profile
echo 'export PATH="/mnt/user/Internal/thenairn.com/hq:$BUN_INSTALL/bin:$PATH"' >> /etc/profile
# Create hq user for one-time SSH session routing
useradd -M -s /mnt/user/Internal/thenairn.com/hq/hq-shell.sh -d /mnt/user/HQ hq 2>/dev/null
usermod -aG users hq 2>/dev/null
echo "hq:$(head -c 32 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9' | head -c 32)" | chpasswd 2>/dev/null
mkdir -p /mnt/user/HQ/sessions
GOBLOCK
    echo "[ok] Boot script updated"
fi

echo ""
echo "=== Setup Complete ==="
echo "TUI binary: $HQ_DIR/hq"
echo "Web UI: rebuild jarvis-console container"
echo "After reboot, type: hq"
