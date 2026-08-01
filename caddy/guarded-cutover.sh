#!/bin/bash
# Self-healing Caddy cutover: 2.9.1 -> 2.11.4-candidate, with automatic rollback.
# Pure bash — completes and rolls back on its own even if the edge (and thus the
# Orca pairing / Claude connection) drops mid-cutover. Rollback needs no LLM.
set -u
cd /mnt/user/Internal/thenairn.com
LOG(){ echo "[$(date -u +%H:%M:%S)] $*"; }

PROJECT="thenairncom"
# caddy has cross-file `links:` (invoiceninja, sonarr, plex, ...), so compose must be
# given the FULL project file set or config parsing fails with "undefined service".
COMPOSE="-p $PROJECT \
 -f docker-compose.yml -f docker-compose.media.yml -f docker-compose.paperbox.yml \
 -f docker-compose.immich.yml -f docker-compose.invoicing.yml -f docker-compose.syncthing.yml \
 -f docker-compose.cameras.yml -f docker-compose.openclaw.yml -f docker-compose.docs.yml \
 -f docker-compose.orca.yml"

health() {
  local cip
  cip=$(docker inspect caddy --format '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' 2>/dev/null | awk '{print $1}')
  [ -z "$cip" ] && return 1
  # edge serving: external HTTPS with a VALID cert (no -k) for the two hosts that matter,
  # resolved to this caddy. Any real HTTP code (200/302/401/502) => caddy is terminating
  # TLS and routing. 000/empty => TLS handshake failed or not listening => unhealthy.
  local host code
  for host in immich.thenairn.com orca.thenairn.com; do
    code=$(curl -s -o /dev/null -w '%{http_code}' --resolve "$host:443:$cip" --max-time 10 "https://$host/" 2>/dev/null)
    { [ -z "$code" ] || [ "$code" = "000" ]; } && { LOG "health FAIL: $host code=${code:-none}"; return 1; }
    LOG "health ok: $host code=$code"
  done
  return 0
}

wait_healthy() {  # up to ~75s
  for i in $(seq 1 15); do
    sleep 5
    if health; then return 0; fi
  done
  return 1
}

running_ver(){ docker exec caddy caddy version 2>/dev/null | head -1 | grep -oE 'v2\.[0-9]+\.[0-9]+'; }

LOG "=== CUTOVER: staging 2.11.4-candidate as :latest, force-recreating ==="
docker tag thenairncom-caddy:2.11.4-candidate thenairncom-caddy:latest
docker compose $COMPOSE up -d --no-deps --force-recreate caddy 2>&1 | grep -iE 'recreat|start|error' | grep -vi orphan | while read l; do LOG "$l"; done

LOG "=== verifying edge AND version on 2.11.4 ==="
if wait_healthy && [ "$(running_ver)" = "v2.11.4" ]; then
  LOG "SUCCESS: caddy healthy on $(running_ver). immich + orca edges serving with valid certs."
  exit 0
fi
LOG "post-cutover state: healthy=$(health && echo yes || echo no) version=$(running_ver)"

LOG "=== FAILED (unhealthy or version not 2.11.4) — AUTO-ROLLING BACK to 2.9.1 ==="
docker tag thenairncom-caddy:rollback-2.9.1 thenairncom-caddy:latest
docker compose $COMPOSE up -d --no-deps --force-recreate caddy 2>&1 | grep -iE 'recreat|start|error' | grep -vi orphan | while read l; do LOG "$l"; done
if wait_healthy; then
  LOG "ROLLED_BACK: caddy restored to $(running_ver) and healthy. No net change; investigate 2.11.4 before retrying."
  exit 2
else
  LOG "CRITICAL: rollback health also failing — caddy may be down. MANUAL INTERVENTION NEEDED (host 'c' shell)."
  exit 3
fi
