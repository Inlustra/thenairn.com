# Tower's agent harness: Milo on WhatsApp, Thor on Telegram, the media agent.
# Built by docker-compose.harness.yml. Code is baked in; all state lives in
# ${CONFIG_DIR}/harness (bind-mounted), so rebuilding loses nothing.

# Same Bun as the OpenClaw image, pinned by version and amd64 digest.
ARG BUN_VERSION=1.4.2
FROM oven/bun:${BUN_VERSION}@sha256:9114c058aeae42162ee16dd5084b95fe9473970bb6bcb5b232ab1630f0546895

# Thor and the media agent run shell commands on Tower from in here, so give
# them the same working kit OpenClaw's agents had: docker CLI (driving the host
# daemon over the mounted socket, no daemon in here), gh, git, jq, ripgrep,
# sqlite3, python3, and friends.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      bash ca-certificates curl dnsutils file gh git gnupg iproute2 jq less \
      netcat-openbsd patch procps psmisc python3 ripgrep rsync sqlite3 unzip xz-utils zip \
 && install -m 0755 -d /etc/apt/keyrings \
 && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
 && chmod a+r /etc/apt/keyrings/docker.asc \
 && echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian bookworm stable" > /etc/apt/sources.list.d/docker.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends docker-ce-cli docker-compose-plugin \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
# Dependencies first, for layer caching. shims/ holds the better-sqlite3
# stand-in (bun:sqlite) that Mem0 imports; it's a file: dependency.
COPY package.json bun.lock ./
COPY shims ./shims
RUN bun install --frozen-lockfile --production
COPY src ./src
COPY prompts ./prompts
COPY tsconfig.json ./

ENV NODE_ENV=production
CMD ["bun", "src/main.ts"]
