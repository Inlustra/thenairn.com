# Build stage: compile to single binary
FROM oven/bun:1 AS build
WORKDIR /app
COPY package.json bun.lock* bunfig.toml ./
RUN bun install --frozen-lockfile
COPY src ./src
COPY tsconfig.json ./
RUN bun build ./src/index.ts --compile --target=bun-linux-x64 --outfile jarvis-console

# Runtime: just the binary + docker CLI + compose plugin
FROM debian:bookworm-slim
RUN apt-get update && \
    apt-get install -y --no-install-recommends docker.io ca-certificates curl && \
    mkdir -p /usr/local/lib/docker/cli-plugins && \
    curl -SL "https://github.com/docker/compose/releases/latest/download/docker-compose-linux-x86_64" -o /usr/local/lib/docker/cli-plugins/docker-compose && \
    chmod +x /usr/local/lib/docker/cli-plugins/docker-compose && \
    rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/jarvis-console /app/jarvis-console
COPY commands.json /app/commands.json
ENV NODE_ENV=production
ENV PORT=3099
ENV COMMANDS_PATH=/app/commands.json
EXPOSE 3099
CMD ["/app/jarvis-console"]
