#!/bin/bash
#
# up.sh — the single bring-up for thenairn.com.
#
#     cd /mnt/user/HQ/thenairn.com && tools/up.sh
#
# That is the whole thing. One command, cold host to 43 containers, in a
# recorded order, safe to re-run.
#
# From a clean box, where .env does not exist yet, it is two:
#
#     tools/bootstrap-env.sh && tools/up.sh --build
#
# `./up.sh` at the repo root is a symlink to this file and works identically:
# the script resolves the symlink to find the repo root, so either path works
# and both `cd` to the repo root before doing anything.
#
#
# WHY THIS EXISTS
# ---------------
# The stack is 43 services spread over 12 `docker-compose*.yml` files that all
# share ONE project name, `thenairncom`. They are not twelve stacks; they are
# one stack that happens to be written down in twelve files. `caddy` in
# docker-compose.yml `links:` to `sonarr`, `paperless`, `invoiceninja` and seven
# others that are defined in three other files — so no single file is even a
# valid project on its own. Compose refuses it: "service caddy depends on
# undefined service sonarr".
#
# The merge was previously done by `COMPOSE_FILE` in `.env`. That list drifted:
# `docker-compose.hindsight.yml` was deleted from the repo in 630dde0 (RAI-5)
# and never removed from the list, so as of 2026-08-22 EVERY bare `docker
# compose` command in this directory failed on a missing file.
#
# The bug was not "a list". It was a list kept OUTSIDE the directory it
# described, in an untracked file nobody diffs, with nothing checking it against
# reality. The list now lives in `compose.manifest` next to the files it names,
# is version-controlled, and is checked against the directory in BOTH directions
# on every run — a file listed but missing, or present but unlisted, aborts the
# bring-up. The set is recorded, and the record is enforced.
#
#
# ORDER
# -----
# Most of the ordering is already declared and Compose computes it: `depends_on`
# (transmission→gluetun, paperless→broker, paperclip→postgres healthy,
# immich-server→redis+db, unifi-app→unifi-db, frigate→go2rtc) and `links:`,
# which Compose also treats as a start-order edge (caddy→its ten upstreams).
#
# The stages below add what is NOT declared anywhere, and they are the part
# nobody had written down:
#
#   1. core-data  Databases and the permission sidecar first, alone, so a
#                 failing DB is a failing DB and not one of forty log streams.
#   2. vpn        Both gluetun tunnels next. Everything torrent- and iPlayer-
#                 side runs INSIDE their network namespaces, so a container
#                 started against a half-open tunnel comes up with no route.
#                 These take the longest to become healthy; start them early
#                 and let them settle while stage 3 runs.
#   3. control    paperclip (the board this business runs on) and orca (the
#                 host-management surface). Deliberately before the media zoo:
#                 if bring-up goes wrong from here, these two are how you find
#                 out and how you fix it.
#   4. business   Invoicing and documents. Real money and real records; they
#                 get their own stage and their own check.
#   5. media      The bulk. Plex first for the GPU.
#   6. home       Photos, cameras, sync, the galleries.
#   7. edge       Caddy LAST, on purpose. It fronts all of the above and holds
#                 the TLS certs. Bringing it up once its upstreams are live
#                 means no vhost ever serves a 502, and no cert is renewed
#                 against a backend that isn't there yet.
#
#
# SAFETY
# ------
# * `--remove-orphans` is NEVER passed, and this script will refuse to pass it.
#   Every file shares the project name, so `--remove-orphans` with an incomplete
#   file list deletes the rest of the stack. This has a whole section in HQ's
#   CLAUDE.md for a reason.
# * `up -d` on a subset never stops anything that is already running, so this is
#   safe to re-run at any point, including against a fully-up stack.
# * There are no named volumes anywhere in this stack — every mount is a host
#   bind — so no `docker compose` operation here can orphan data. `down -v` is
#   still refused below, because that will not always be true.
# * `orca` is in stage 3 and WILL be recreated by a full run. If you are reading
#   this from a Claude session inside orca, that session dies mid-run. Use
#   `tools/up.sh --skip control` from inside the container, or run it from the
#   host. The same applies to `paperclip`, which is where the agents run.
#
set -euo pipefail

# Repo root, resolved through the symlink at ./up.sh. `readlink -f` gives the
# real path (…/thenairn.com/tools/up.sh) whichever of the two paths was invoked,
# so `..` is always the repo root and never the caller's cwd.
cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/.."

PROJECT=thenairncom
MANIFEST=compose.manifest
HEALTH_TIMEOUT=${HEALTH_TIMEOUT:-180}   # seconds to wait per stage for healthchecks

# ---------------------------------------------------------------------------
# The stages. Every service in every compose file must appear in exactly one of
# these, and `./up.sh check` enforces that — so adding a service to a compose
# file and forgetting to place it here is a loud error, not a service that
# quietly never starts.
# ---------------------------------------------------------------------------
STAGE_NAMES=(core-data vpn control business media home edge)

STAGE_core_data=(port-permission-module paperclip-postgres invoiceninjadb unifi-db immich-redis immich-database paperless-broker)
STAGE_vpn=(gluetun gluetun-uk)
STAGE_control=(paperclip orca fleet-breaker)
STAGE_business=(invoiceninja paperless unifi-network-application)
STAGE_media=(plex transmission sonarr animesonarr radarr animeradarr prowlarr flaresolverr seerr get_iplayer iplayarr recyclarr plex-meta-manager suwayomi syncyomi paperbox)
STAGE_home=(immich-server immich-machine-learning immich-kiosk go2rtc frame-cams frigate syncthing weddingphotos gallery gracewedding)
STAGE_edge=(plugsy rclone caddy)

stage_services() {                      # $1 = stage name -> echoes its services
  local var="STAGE_${1//-/_}[@]"
  printf '%s\n' "${!var}"
}

# ---------------------------------------------------------------------------
# Plumbing
# ---------------------------------------------------------------------------
say()  { printf '\n\033[1m== %s\033[0m\n' "$*"; }
info() { printf '   %s\n' "$*"; }
die()  { printf '\033[31mup.sh: %s\033[0m\n' "$*" >&2; exit 1; }

# The file list — READ FROM compose.manifest, in manifest order (which is the
# Compose merge order; later files win on conflicting keys). Strips `#` comments
# and blank lines. This is the recorded live set; `check_manifest` below is what
# stops the record and the directory from drifting apart.
compose_files() {
  [[ -f "$MANIFEST" ]] || die "$MANIFEST is missing — it is the record of which compose files are live"
  sed -e 's/#.*//' -e 's/[[:space:]]*$//' "$MANIFEST" | grep -v '^$'
}

# What is actually sitting in the directory. Anything with `bak` in the name is
# ignored: backup-by-copy is the house style here.
compose_files_on_disk() {
  local f
  for f in $(ls docker-compose*.yml 2>/dev/null | LC_ALL=C sort); do
    [[ "$f" == *bak* ]] && continue
    echo "$f"
  done
}

# Both directions. A file recorded but gone is the hindsight bug exactly; a file
# present but unrecorded is a service that would silently never start.
check_manifest() {
  local listed present missing unlisted
  listed="$(compose_files | LC_ALL=C sort)"
  present="$(compose_files_on_disk)"

  missing="$(comm -23 <(echo "$listed") <(echo "$present"))"
  unlisted="$(comm -13 <(echo "$listed") <(echo "$present"))"

  if [[ -n "$missing" ]]; then
    printf '\033[31m   in %s but NOT on disk:\033[0m\n' "$MANIFEST" >&2
    printf '     %s\n' $missing >&2
    printf '     (this is the docker-compose.hindsight.yml bug. Remove it from %s.)\n' "$MANIFEST" >&2
  fi
  if [[ -n "$unlisted" ]]; then
    printf '\033[31m   on disk but NOT in %s:\033[0m\n' "$MANIFEST" >&2
    printf '     %s\n' $unlisted >&2
    printf '     (add it to %s and place its services in a stage, or it never starts.)\n' "$MANIFEST" >&2
  fi
  [[ -z "$missing$unlisted" ]] || die "$MANIFEST does not match the directory — fix it before bringing anything up"
}

FILE_ARGS=()
build_file_args() {
  local f
  check_manifest
  FILE_ARGS=()
  while IFS= read -r f; do FILE_ARGS+=(-f "$f"); done < <(compose_files)
  [[ ${#FILE_ARGS[@]} -gt 0 ]] || die "$MANIFEST lists no compose files"
}

# Every compose call in this script goes through here. Note the explicit -f
# flags: they override whatever `COMPOSE_FILE` in .env happens to say, so this
# script stays correct even when that line is stale (it was, on 2026-08-22).
dc() { docker compose -p "$PROJECT" "${FILE_ARGS[@]}" "$@"; }

# Services declared across the merged project — asked of Compose itself.
#
# This used to hand-parse the YAML with python3 + PyYAML. That broke the moment
# it was first actually executed (2026-08-22, once RAI-28 granted the socket):
# `check` — and therefore `up`, which calls it first — died on
# ModuleNotFoundError before starting a single service. Failing closed was
# correct; needing a pip install to bring the stack up was not.
#
# Verified missing in the paperclip container. NOT verified on the Unraid host,
# which is where this script normally runs — so treat "the host was broken too"
# as unproven. The dependency is unnecessary either way.
#
# `config --services` has no dependency beyond the compose binary this script
# already requires, and it is authoritative rather than approximate: it answers
# for the MERGED project, so overrides, extends and anchors resolve the way
# they will at `up` time. Interpolation is exercised as a side effect.
declared_services() {
  dc config --services | LC_ALL=C sort
}

staged_services() {
  local s
  for s in "${STAGE_NAMES[@]}"; do stage_services "$s"; done | LC_ALL=C sort
}

# ---------------------------------------------------------------------------
# check — does the map in this file still match the files on disk?
# ---------------------------------------------------------------------------
cmd_check() {
  build_file_args
  local files=() f
  while IFS= read -r f; do files+=("$f"); done < <(compose_files)

  say "Compose files (${#files[@]}, from $MANIFEST, matched against the directory)"
  printf '   %s\n' "${files[@]}"

  local declared staged
  declared="$(declared_services)"
  staged="$(staged_services)"

  say "Services: $(wc -l <<<"$declared") declared, $(wc -l <<<"$staged") staged"

  local missing extra
  missing="$(comm -23 <(echo "$declared") <(echo "$staged"))"
  extra="$(comm -13 <(echo "$declared") <(echo "$staged"))"

  if [[ -n "$missing" ]]; then
    printf '\033[31m   declared in a compose file but in no stage:\033[0m\n' >&2
    printf '     %s\n' $missing >&2
  fi
  if [[ -n "$extra" ]]; then
    printf '\033[31m   listed in a stage but declared nowhere:\033[0m\n' >&2
    printf '     %s\n' $extra >&2
  fi
  [[ -z "$missing$extra" ]] || die "stage map is out of date — fix the STAGE_* arrays above"

  # Compose's own validation: interpolation, links, depends_on, syntax.
  info "validating merged project ..."
  dc config -q || die "docker compose config failed — see above"
  info "merged project is valid"
}

# ---------------------------------------------------------------------------
# preflight — the things that make a bring-up fail ten minutes in
# ---------------------------------------------------------------------------
cmd_preflight() {
  say "Preflight"
  command -v docker >/dev/null || die "no docker on PATH"
  docker info >/dev/null 2>&1 || die "docker daemon not reachable"
  info "docker: $(docker --version)"

  [[ -f .env ]] || die ".env is missing — run 'tools/bootstrap-env.sh && tools/up.sh --build' (it rebuilds .env from 1Password)"
  [[ -f .env.immich ]] || die ".env.immich is missing — docker-compose.immich.yml reads it via env_file"

  # Every *_DIR the compose files interpolate must exist, or Docker silently
  # creates an empty directory at the bind path and the service comes up
  # looking healthy with no data.
  #
  # THIS CHECK IS ONLY MEANINGFUL ON THE HOST. It tests our own mount namespace,
  # but the daemon binds from the host's. Run from inside the paperclip
  # container (which mounts only HQ and Internal) 15 of 17 paths report missing
  # while being perfectly present on Tower — measured 2026-08-22, RAI-28.
  # The socket grants Docker, not the host filesystem. Do not "fix" the paths
  # this prints without confirming where you are running.
  local missing=0 name path
  while IFS='=' read -r name path; do
    path="${path%\"}"; path="${path#\"}"
    if [[ -n "$path" && ! -d "$path" ]]; then
      printf '\033[31m   missing host path: %s=%s\033[0m\n' "$name" "$path" >&2
      missing=1
    fi
  done < <(grep -E '^[A-Z_]+_DIR=' .env)
  [[ $missing -eq 0 ]] || die "host paths above do not exist — fix before bringing anything up (if you are inside a container, see the note above: run this on the host)"
  info "all *_DIR paths in .env exist"

  # plex and frigate both declare `runtime: nvidia`.
  if docker info --format '{{json .Runtimes}}' 2>/dev/null | grep -q nvidia; then
    info "nvidia runtime present (needed by plex, frigate)"
  else
    printf '\033[33m   WARNING: no nvidia runtime — plex and frigate will fail to start.\033[0m\n' >&2
    printf '\033[33m   Unraid: Settings > Nvidia Driver, then reboot.\033[0m\n' >&2
  fi

  [[ -e /dev/net/tun ]] || printf '\033[33m   WARNING: /dev/net/tun missing — both gluetun tunnels will fail.\033[0m\n' >&2
}

# ---------------------------------------------------------------------------
# Waiting. Only some containers declare a healthcheck; for those, wait for it.
# For the rest, "created and running" is all Docker can tell us and all we claim.
# ---------------------------------------------------------------------------
wait_stage() {
  local -a svcs=("$@")
  local deadline=$((SECONDS + HEALTH_TIMEOUT))
  local pending=1 svc cid state health

  while (( pending )); do
    pending=0
    for svc in "${svcs[@]}"; do
      cid="$(dc ps -q "$svc" 2>/dev/null | head -1)" || true
      [[ -n "$cid" ]] || { pending=1; continue; }
      state="$(docker inspect -f '{{.State.Status}}' "$cid" 2>/dev/null || echo unknown)"
      health="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$cid" 2>/dev/null || true)"
      # A container with no healthcheck is done as soon as it is running.
      # recyclarr and plex-meta-manager are one-shot jobs and legitimately exit.
      case "$svc" in recyclarr|plex-meta-manager) continue ;; esac
      [[ "$state" == running ]] || pending=1
      [[ -z "$health" || "$health" == healthy ]] || pending=1
    done
    (( pending )) || break
    if (( SECONDS > deadline )); then
      printf '\033[33m   still not healthy after %ss — continuing anyway:\033[0m\n' "$HEALTH_TIMEOUT" >&2
      for svc in "${svcs[@]}"; do
        cid="$(dc ps -q "$svc" 2>/dev/null | head -1)" || true
        [[ -n "$cid" ]] || { printf '     %-28s not created\n' "$svc" >&2; continue; }
        printf '     %-28s %s %s\n' "$svc" \
          "$(docker inspect -f '{{.State.Status}}' "$cid")" \
          "$(docker inspect -f '{{if .State.Health}}({{.State.Health.Status}}){{end}}' "$cid")" >&2
      done
      return 0
    fi
    sleep 3
  done
  info "stage healthy"
}

# ---------------------------------------------------------------------------
# up
# ---------------------------------------------------------------------------
cmd_up() {
  local build="$1"; shift
  local -a skip=("$@")

  cmd_preflight
  cmd_check

  local stage svcs
  for stage in "${STAGE_NAMES[@]}"; do
    if [[ " ${skip[*]-} " == *" $stage "* ]]; then
      say "Stage: $stage — SKIPPED (--skip $stage)"
      continue
    fi
    local -a svcs=()
    while IFS= read -r s; do svcs+=("$s"); done < <(stage_services "$stage")

    say "Stage: $stage (${#svcs[@]} services)"
    info "${svcs[*]}"
    # --no-recreate: a service already running with an unchanged config is left
    # strictly alone. That is what makes a re-run cheap and non-disruptive.
    # Pass --build on a cold host with no images.
    if [[ "$build" == yes ]]; then
      dc up -d --build --no-recreate "${svcs[@]}"
    else
      dc up -d --no-recreate "${svcs[@]}"
    fi
    wait_stage "${svcs[@]}"
  done

  say "Up. Post-bring-up checks"
  cat <<'EOF'
   tools/up.sh status                  every service and its state
   docker compose -p thenairncom logs -f caddy      TLS + vhost errors
   curl -sI https://rainn.thenairn.com  | head -1   the board
   curl -sI https://docs.thenairn.com   | head -1   paperless
   curl -sI https://invoice.thenairn.com| head -1   invoiceninja
   docker exec gluetun    wget -qO- https://ipinfo.io/country   expect CH
   docker exec gluetun-uk wget -qO- https://ipinfo.io/country   expect GB
EOF
}

cmd_status() {
  build_file_args
  dc ps --format 'table {{.Service}}\t{{.State}}\t{{.Status}}'
  echo
  printf 'running: %s / declared: %s\n' \
    "$(dc ps -q | wc -l)" \
    "$(declared_services | wc -l)"
}

cmd_down() {
  build_file_args
  say "Teardown — all 43 services, project $PROJECT"
  printf '   This stops and removes every container in the stack.\n'
  printf '   All mounts are host binds, so no data is removed.\n'
  read -r -p '   Type the project name to confirm: ' answer
  [[ "$answer" == "$PROJECT" ]] || die "aborted"
  dc down
}

usage() {
  cat <<'EOF'
up.sh — the single bring-up for thenairn.com (43 services, 12 compose files)

  tools/up.sh                 bring the whole stack up, in stages, idempotent
  tools/up.sh --build         same, but build images first (cold host)
  tools/up.sh --skip control  same, but leave a stage alone (repeatable).
                              Use --skip control when running from INSIDE orca
                              or the paperclip container — that stage recreates
                              the container you are typing into.
  tools/up.sh check           validate the merged project, the manifest and the
                              stage map. Changes nothing. Run this first.
  tools/up.sh status          what is actually running
  tools/up.sh files           the recorded compose file list (compose.manifest)
  tools/up.sh down            stop and remove the whole stack (asks first)

From a clean box, where .env does not exist yet:

  tools/bootstrap-env.sh && tools/up.sh --build

Stages, in order: core-data vpn control business media home edge
The compose file set is recorded in compose.manifest and checked against the
directory on every run. The start order is the STAGE_* map in this file.
EOF
}

# ---------------------------------------------------------------------------
main() {
  local build=no
  local -a skip=()
  case "${1:-up}" in
    check)  build_file_args; cmd_check; exit 0 ;;
    status) cmd_status; exit 0 ;;
    files)  build_file_args; compose_files; exit 0 ;;
    down)   cmd_down; exit 0 ;;
    -h|--help|help) usage; exit 0 ;;
  esac

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --build) build=yes; shift ;;
      --skip)  skip+=("$2"); shift 2 ;;
      up)      shift ;;
      --remove-orphans)
        die "refused. Every compose file here shares project '$PROJECT'; --remove-orphans deletes the rest of the stack." ;;
      *) usage; die "unknown argument: $1" ;;
    esac
  done

  build_file_args
  cmd_up "$build" "${skip[@]-}"
}

main "$@"
