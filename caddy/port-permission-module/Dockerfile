# Step 1: Build the Go binary
FROM golang:1.21-alpine as builder

# Set the working directory inside the container
WORKDIR /app

COPY go.mod .

# Copy the Go code into the container
COPY main.go .

# Build the Go binary
RUN go build -ldflags="-s -w" -o server

# Step 2: Create a lightweight image
FROM scratch

# Copy the binary from the builder stage
COPY --from=builder /app/server /server

# Expose the port (for documentation purposes)
EXPOSE 8000

# Set environment variables (can be overridden at runtime)
ENV PORT=8000
ENV MIN_VALUE=2000
ENV MAX_VALUE=4000

# Run the compiled binary
ENTRYPOINT ["/server"]
