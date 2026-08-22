FROM oven/bun:1-alpine
WORKDIR /app
COPY server.ts .
USER bun
EXPOSE 7791
CMD ["bun", "run", "server.ts"]
