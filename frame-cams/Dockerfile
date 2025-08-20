# Use the official Bun image for building
FROM oven/bun:1 as builder
WORKDIR /usr/src/app

# Copy package files and install dependencies
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile

# Copy source code
COPY . .

# Compile to single executable for Linux x64
RUN bun build --compile --minify --sourcemap --target=bun-linux-x64 ./src/index.tsx --outfile frame-cams

# Use a minimal base image for the final stage
FROM gcr.io/distroless/base-debian12
WORKDIR /app

# Copy the compiled executable
COPY --from=builder /usr/src/app/frame-cams /app/frame-cams

# Expose port
EXPOSE 3000/tcp

# Run the compiled executable
USER nonroot:nonroot

ENTRYPOINT ["/app/frame-cams"]
