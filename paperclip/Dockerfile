FROM node:22

# Pinned so a rebuild is reproducible. Bump deliberately, the way orca pins
# ORCA_VERSION — an unpinned `latest` here means a rebuild can silently change
# the agent runtime under a running board.
#
# RAI-105, 2026-08-23: pinned to this prerelease deliberately, ahead of a
# stable release, because it carries a specific known fix that stable does
# not yet have. Upstream issue paperclipai/paperclip#9976 (a session's config
# fingerprint includes the issue's own updatedAt, so every comment on an
# issue invalidates and cold-starts that issue's saved Claude session -
# measured as 54% of this company's token spend on RAI-55). Fixed upstream in
# PR #10111 (merged 2026-08-17T21:21Z, commit b90da4d): one line,
# `delete workspaceConfig.issueConfigRevisionAt` before hashing the
# fingerprint. `2026.817.0` (our previous pin, and still npm's stable
# `latest`) was cut from a tree that predates that merge by hours and does
# not have it - confirmed by grepping its installed
# dist/services/heartbeat.js, which still sets issueConfigRevisionAt with no
# exclusion. `2026.818.0-beta.1` is the earliest release that does carry it -
# confirmed the same way, against the built dist/services/heartbeat.js of
# @paperclipai/server@2026.818.0-beta.1, not the source or the changelog.
# When a stable release above 2026.817.0 ships with this same fix, prefer it
# over this prerelease and drop this comment block.
ARG PAPERCLIP_VERSION=2026.818.0-beta.1
ARG CLAUDE_CODE_VERSION=latest
# RAI-111: opencode_local shells out to `opencode` and, absent it, self-installs
# via a global npm install on every run start (buildNpmRuntimeCommandSpec).
# That install lands in the writable container layer, not the image, so it is
# gone on the next rebuild and comes back only as a silent per-run download.
# Baking it here makes the OpenRouter path reboot-durable instead.
ARG OPENCODE_VERSION=1.18.21

# git + ripgrep: agents check out and search repos.
RUN apt-get update && apt-get install -y --no-install-recommends \
        git ripgrep ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g "paperclipai@${PAPERCLIP_VERSION}" \
                   "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
                   "opencode-ai@${OPENCODE_VERSION}"

# Runs as root on purpose. The shared Claude credential store
# (/mnt/user/HQ/.claude/.credentials.json) is rw------- root, so a non-root
# Paperclip could not spawn Claude agents. Postgres is a separate container
# precisely so nothing here needs to drop privileges.
ENV HOME=/root
WORKDIR /root

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

EXPOSE 3100
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
