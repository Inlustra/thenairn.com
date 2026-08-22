#!/usr/bin/env sh
set -e

DATA_DIR="${PAPERCLIP_DATA_DIR:-/root/.paperclip}"
INSTANCE="${PAPERCLIP_INSTANCE:-default}"
INST_DIR="$DATA_DIR/instances/$INSTANCE"
CFG="$INST_DIR/config.json"
ENVF="$INST_DIR/.env"

if [ -z "$DATABASE_URL" ]; then
  echo "[entrypoint] FATAL: DATABASE_URL is not set." >&2
  exit 1
fi

mkdir -p "$INST_DIR"/{logs,secrets,data/storage,data/backups}

# Secrets live in the instance .env (which Paperclip reads), generated once and
# persisted on the bind mount. Generated here rather than committed to the repo
# .env so they never touch git.
if [ ! -f "$ENVF" ]; then
  echo "[entrypoint] generating instance secrets -> $ENVF"
  gen() { node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"; }
  {
    echo "BETTER_AUTH_SECRET=$(gen)"
    echo "PAPERCLIP_AGENT_JWT_SECRET=$(gen)"
  } > "$ENVF"
  chmod 600 "$ENVF"
fi

# Seed config deterministically rather than running `paperclipai onboard`,
# which is an interactive TTY wizard that cannot complete in a container.
if [ ! -f "$CFG" ]; then
  echo "[entrypoint] no config at $CFG - seeding"
  cat > "$CFG" <<JSON
{
  "\$meta": { "version": 1, "updatedAt": "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)", "source": "configure" },
  "database": {
    "mode": "postgres",
    "connectionString": "$DATABASE_URL",
    "backup": {
      "enabled": true,
      "intervalMinutes": 60,
      "retentionDays": 30,
      "dir": "$INST_DIR/data/backups"
    }
  },
  "logging": { "mode": "file", "logDir": "$INST_DIR/logs" },
  "server": {
    "deploymentMode": "authenticated",
    "exposure": "private",
    "bind": "lan",
    "host": "0.0.0.0",
    "port": 3100,
    "allowedHostnames": ["rainn.thenairn.com"],
    "serveUi": true
  },
  "telemetry": { "enabled": true },
  "auth": { "baseUrlMode": "auto", "disableSignUp": false },
  "storage": {
    "provider": "local_disk",
    "localDisk": { "baseDir": "$INST_DIR/data/storage" }
  },
  "secrets": {
    "provider": "local_encrypted",
    "strictMode": false,
    "localEncrypted": { "keyFilePath": "$INST_DIR/secrets/master.key" }
  }
}
JSON
  chmod 600 "$CFG"
fi

# gh is not in the base image; HQ ships a statically-linked build, so link it
# rather than baking a second copy into the image.
if ! command -v gh >/dev/null 2>&1 && [ -x /mnt/user/HQ/tools/gh ]; then
  ln -sf /mnt/user/HQ/tools/gh /usr/local/bin/gh
  ln -sf /mnt/user/HQ/tools/gh /usr/bin/gh
  echo "[entrypoint] linked gh from HQ/tools"
fi

# Git over HTTPS using the gh token. The host gitconfig is mounted read-only at
# .gitconfig-host and included, so its safe.directory entries still apply; the
# rewrite exists because the repos use git@github.com remotes but this container
# deliberately has no SSH key.
cat > /root/.gitconfig <<GITCFG
[include]
	path = /root/.gitconfig-host
[url "https://github.com/"]
	insteadOf = git@github.com:
	insteadOf = ssh://git@github.com/
[credential]
	helper = !gh auth git-credential
GITCFG

echo "[entrypoint] starting paperclip (instance=$INSTANCE, port 3100)"
exec paperclipai run --instance "$INSTANCE" --force
