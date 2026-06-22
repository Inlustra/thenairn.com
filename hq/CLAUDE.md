# HQ — Homelab Control Panel

Two interfaces for the same homelab: a TUI (for SSH/Termius) and a Web UI (for mobile browser).

## Architecture

### TUI (`hq` binary)
- Compiled Bun+Ink binary at `/mnt/user/Internal/thenairn.com/hq/hq`
- Run via `hq` command (in PATH via /boot/config/go)
- 4 tabs: Projects, Servers, Disks, Scripts
- Uses tmux for session management

### Web UI (jarvis-console container)
- Lives at `/mnt/user/Internal/thenairn.com/jarvis-console/`
- Accessible at `console.thenairn.com` (behind Google OAuth via Caddy)
- Bun server + React frontend, mobile-first
- 4 views: Status, Projects, Claude Sessions, Commands

### One-Time SSH Flow (mobile -> terminal)
- Web UI generates a one-time password for the `hq` system user
- Returns `ssh://hq:<pass>@console.thenairn.com` link
- Termius opens it, `hq-shell.sh` (ForceCommand) reads session target from `/mnt/user/HQ/sessions/`, attaches to tmux
- Password is invalidated after 60 seconds or first use

## Key Paths
- TUI source: `/mnt/user/Internal/thenairn.com/hq/src/`
- Web source: `/mnt/user/Internal/thenairn.com/jarvis-console/src/`
- Session files: `/mnt/user/HQ/sessions/` (ephemeral, on HQ share)
- Bun: `/mnt/user/HQ/.bun/`
- Boot script: `/boot/config/go`

## Persistence
- Unraid resets on reboot. `/boot/config/go` recreates:
  - tmux (from preclear plugin package)
  - PATH + BUN_INSTALL in /etc/profile
  - `hq` system user with hq-shell.sh as login shell
- Code lives on persistent shares (Internal = array, HQ = cache SSD)
- Docker container rebuilds from thenairn.com repo

## Development
```bash
# TUI
cd /mnt/user/Internal/thenairn.com/hq && bun run build

# Web (hot reload via Docker)
cd /mnt/user/Internal/thenairn.com && docker compose up -d --build jarvis-console
```
