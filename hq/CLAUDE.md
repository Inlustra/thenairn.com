# HQ — Homelab Control Panel

> # ⚠️ THIS DOES NOT RUN. Nothing below is currently true.
>
> Verified on the box 2026-08-22 (RAI-7 / decision D7). Everything after this banner is
> written in the present tense and describes a system that is not deployed:
>
> | Documented | Reality |
> |---|---|
> | Web UI at `console.thenairn.com` | **No vhost.** No entry in the 988-line `caddy/Caddyfile`, and the host does not resolve at all — not a 502, nothing. |
> | `jarvis-console` container | **No such service** in any of the 13 `docker-compose*.yml` files. |
> | `hq` TUI reachable via `hq.thenairn.com` | The vhost exists (`caddy/Caddyfile:159`) and **502s** — nothing listens on `192.168.96.14:3777`. Dead since the agent platform stopped in April. |
> | Paths under `/mnt/user/Internal/thenairn.com/…` | Pre-migration. That path resolves only through a symlink; the current root is `/mnt/user/HQ/thenairn.com/`. |
>
> **The source is still here.** `thenairn.com/hq/` and `thenairn.com/jarvis-console/`
> are both intact on disk, inside the live infra repo. Nothing has been deleted.
>
> **Retire-or-revive is Thomas's decision** and it is open. If retire: move both trees to
> `_retired/`, delete the `hq.thenairn.com` vhost, delete this file. If revive: the
> `console.thenairn.com` vhost has to be written from scratch and the `jarvis-console`
> service added to a compose file — neither exists to restore.
>
> Until then, **do not follow the instructions below** and do not treat anything here as
> a description of the running stack.

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
