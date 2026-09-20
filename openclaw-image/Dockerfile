# syntax=docker/dockerfile:1

# OpenClaw gateway image for the `thenairncom` stack.
#
# WHY A BUILD AT ALL, WHEN UPSTREAM PUBLISHES A GOOD IMAGE
# --------------------------------------------------------
# This is a THIN LAYER over the official release image, not a source build.
# Upstream's own docker-compose.yml builds `openclaw:local` from a checkout of
# openclaw/openclaw. We deliberately do not do that: ../.gitignore blocks
# `openclaw/` because that vendor checkout was committed here once already as a
# bare gitlink with no .gitmodules entry (RAI-9), so every fresh clone got an
# empty, unresolvable directory. Pulling the published image and adding to it
# keeps the version pinned and the provenance upstream's, with no vendor tree in
# this repo.
#
# This directory is `openclaw-image/`, NOT `openclaw/`, for that same reason —
# `openclaw/` is gitignored and a build context named that would never be
# committed. Do not rename it.
#
# PINNED IN TWO PLACES. The tag lives here AND in docker-compose.openclaw.yml,
# the same arrangement as ORCA_VERSION. Change both in the same commit.
#   gh release list --repo openclaw/openclaw
#
# Variants upstream publishes: plain, -slim, -browser (Chromium baked in, for
# the sandboxed browser tool without a first-run Playwright install). Plain is
# pinned below; switch the tag if the browser tool is ever wanted.

ARG BUN_VERSION=1.4.2
ARG OPENCLAW_VERSION=2026.9.4
# Official Bun image, pinned by version and immutable linux/amd64 manifest
# digest. Copying the standalone binary avoids running a remote installer and
# keeps Bun independent of the node user's writable home directory.
FROM oven/bun:${BUN_VERSION}@sha256:9114c058aeae42162ee16dd5084b95fe9473970bb6bcb5b232ab1630f0546895 AS bun-runtime

FROM ghcr.io/openclaw/openclaw:${OPENCLAW_VERSION}

# ---------------------------------------------------------------------------
# EXTENSION POINT — Orca-side tooling goes HERE and nowhere else.
#
# Deliberately empty today: as of this commit the image is byte-identical in
# behaviour to upstream's, which is the honest starting point. Adding a package
# is a two-line change, and keeping the scaffold in place means the first such
# change does not also have to invent the build.
#
# The base image runs as the unprivileged `node` user, so step up to root for
# the install and drop straight back — do not leave the final USER as root.
#
# USER root
# RUN apt-get update \
#  && apt-get install -y --no-install-recommends \
#       <packages> \
#  && rm -rf /var/lib/apt/lists/*
# USER node
#
# Upstream also honours OPENCLAW_IMAGE_APT_PACKAGES as a build arg for exactly
# this; prefer an explicit RUN here, so the package list is reviewable in git
# rather than living in .env.
# ---------------------------------------------------------------------------

# Shared agent operations toolbox + Docker CLI/Compose plugin, 2026-09-10.
# Keep this list explicit and conservative: these are the tools used for HQ
# source inspection, GitHub work, archives/sync, SQLite recovery, terminal
# sessions, and network/process diagnosis. Compilers, database clients/servers,
# editors, and overlapping download/YAML tools stay task-specific.
#
# The socket mount in
# docker-compose.openclaw.yml is useless without a client - the upstream image
# ships none, so `docker ps` was "not found". CLI only: no daemon, no DinD. It
# drives Tower's daemon via the bind-mounted socket as node:281.
USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      bzip2 \
      ca-certificates \
      curl \
      dnsutils \
      file \
      gh \
      gnupg \
      iproute2 \
      jq \
      less \
      netcat-openbsd \
      patch \
      psmisc \
      ripgrep \
      rsync \
      socat \
      sqlite3 \
      tmux \
      unzip \
      xz-utils \
      zip \
 && install -m 0755 -d /etc/apt/keyrings \
 && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
 && chmod a+r /etc/apt/keyrings/docker.asc \
 && echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian bookworm stable" > /etc/apt/sources.list.d/docker.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends docker-ce-cli docker-compose-plugin docker-buildx-plugin \
 && rm -rf /var/lib/apt/lists/*

# Bun is used by repository workflows that declare Bun-native scripts and
# lockfiles. Keep both `bun` and its `bunx` alias available system-wide.
COPY --from=bun-runtime /usr/local/bin/bun /usr/local/bin/bun
RUN ln -s /usr/local/bin/bun /usr/local/bin/bunx
# Claude Code, pinned like OPENCLAW_VERSION. Root-owned under /usr/local so the
# node user cannot self-update it; DISABLE_AUTOUPDATER stops the attempt.
ARG CLAUDE_CODE_VERSION=2.1.274
RUN npm install -g --allow-scripts=@anthropic-ai/claude-code @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} \
 && npm cache clean --force
ENV DISABLE_AUTOUPDATER=1

USER node
