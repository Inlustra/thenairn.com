FROM oven/bun:latest
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --production
COPY . .
RUN bun run build
EXPOSE 3000
CMD ["bun", "run", "src/index.ts"]
