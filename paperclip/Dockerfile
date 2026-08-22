FROM node:22

# Pinned so a rebuild is reproducible. Bump deliberately, the way orca pins
# ORCA_VERSION — an unpinned `latest` here means a rebuild can silently change
# the agent runtime under a running board.
ARG PAPERCLIP_VERSION=2026.817.0
ARG CLAUDE_CODE_VERSION=latest

# git + ripgrep: agents check out and search repos.
RUN apt-get update && apt-get install -y --no-install-recommends \
        git ripgrep ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g "paperclipai@${PAPERCLIP_VERSION}" \
                   "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}"

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
