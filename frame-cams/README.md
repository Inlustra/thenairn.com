# bun-react-template

To install dependencies:

```bash
bun install
```

To start a development server:

```bash
bun dev
```

To run for production:

```bash
bun start
```

This project was created using `bun init` in bun v1.2.19. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.

## Docker Deployment

The Dockerfile creates a single-file executable using bun's `--compile` flag, resulting in a minimal container with just the compiled binary.

### Build Image

```bash
docker build -t frame-cams .
```

### Run Container

```bash
docker run -p 3000:3000 -e BUN_PUBLIC_LINKS_BASE=https://your-cam-server.com frame-cams
```

### Local Compilation

You can also compile the executable locally:

```bash
# For current platform
bun run compile

# For Linux x64 (Docker/server deployment)
bun run compile:linux

# Run the compiled executable
BUN_PUBLIC_LINKS_BASE=https://your-cam-server.com ./frame-cams
