import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { isIP } from "node:net";
import { fileURLToPath } from "node:url";
import WebSocket, { WebSocketServer } from "ws";
import { parseJsonRejectDuplicates } from "./strict-json.js";

const OPEN = WebSocket.OPEN;
const LOOPBACKS = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

function integerEnv(env, name, fallback, minimum, maximum) {
  const raw = env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} through ${maximum}`);
  }
  return value;
}

export function loadConfig(env = process.env) {
  return {
    listenHost: env.BRIDGE_LISTEN_HOST ?? "127.0.0.1",
    listenPort: Number(env.BRIDGE_LISTEN_PORT ?? 18791),
    websocketPath: env.BRIDGE_WEBSOCKET_PATH ?? "/",
    expectedHost: env.BRIDGE_EXPECTED_HOST ?? "claw-native.thenairn.com",
    upstreamUrl: env.BRIDGE_UPSTREAM_URL ?? "ws://openclaw-gateway:18789",
    mappedUser: env.BRIDGE_MAPPED_USER ?? "thomas@rowm.co",
    forwardedProto: env.BRIDGE_FORWARDED_PROTO ?? "https",
    forwardedHost: env.BRIDGE_FORWARDED_HOST ?? "claw-native.thenairn.com",
    tokenFile: env.BRIDGE_TOKEN_FILE ?? "/run/secrets/openclaw_native_bridge_token",
    connectMaxBytes: integerEnv(env, "BRIDGE_CONNECT_MAX_BYTES", 65_536, 1_024, 1_048_576),
    relayMaxBytes: integerEnv(env, "BRIDGE_RELAY_MAX_BYTES", 26_214_400, 65_536, 104_857_600),
    handshakeTimeoutMs: integerEnv(env, "BRIDGE_HANDSHAKE_TIMEOUT_MS", 7_500, 500, 60_000),
    upstreamOpenTimeoutMs: integerEnv(env, "BRIDGE_UPSTREAM_OPEN_TIMEOUT_MS", 5_000, 500, 60_000),
    maxBufferedBytes: integerEnv(env, "BRIDGE_MAX_BUFFERED_BYTES", 8_388_608, 65_536, 104_857_600),
    failuresPerWindow: integerEnv(env, "BRIDGE_FAILURES_PER_WINDOW", 5, 1, 100),
    failureWindowMs: integerEnv(env, "BRIDGE_FAILURE_WINDOW_MS", 60_000, 1_000, 3_600_000),
    failureBlockMs: integerEnv(env, "BRIDGE_FAILURE_BLOCK_MS", 300_000, 1_000, 86_400_000),
    globalFailuresPerWindow: integerEnv(env, "BRIDGE_GLOBAL_FAILURES_PER_WINDOW", 100, 1, 10_000),
  };
}

export function loadToken(path) {
  const stat = statSync(path);
  if (!stat.isFile() || stat.size < 32 || stat.size > 4098) {
    throw new Error("bridge token file must be a regular file containing 32-4096 bytes");
  }
  let token = readFileSync(path, "utf8");
  token = token.endsWith("\r\n") ? token.slice(0, -2) : token.endsWith("\n") ? token.slice(0, -1) : token;
  if (token.length < 32 || token.length > 4096 || /[\r\n\0]/.test(token)) {
    throw new Error("bridge token must be 32-4096 characters with no NUL or line breaks");
  }
  return token;
}

function tokenDigest(token) {
  return createHash("sha256").update(token, "utf8").digest();
}

export function constantTimeTokenEqual(expectedDigest, candidate) {
  const candidateDigest = tokenDigest(typeof candidate === "string" ? candidate : "");
  return timingSafeEqual(expectedDigest, candidateDigest);
}

class FailureLimiter {
  constructor(config) {
    this.config = config;
    this.entries = new Map();
    this.global = [];
  }

  compact(now) {
    const cutoff = now - this.config.failureWindowMs;
    this.global = this.global.filter((time) => time > cutoff);
    for (const [key, entry] of this.entries) {
      entry.times = entry.times.filter((time) => time > cutoff);
      if (entry.blockedUntil <= now && entry.times.length === 0) this.entries.delete(key);
    }
  }

  blocked(key, now = Date.now()) {
    this.compact(now);
    const entry = this.entries.get(key);
    return Boolean(entry?.blockedUntil > now || this.global.length >= this.config.globalFailuresPerWindow);
  }

  failure(key, now = Date.now()) {
    this.compact(now);
    const entry = this.entries.get(key) ?? { times: [], blockedUntil: 0 };
    entry.times.push(now);
    if (entry.times.length >= this.config.failuresPerWindow) entry.blockedUntil = now + this.config.failureBlockMs;
    this.entries.set(key, entry);
    this.global.push(now);
  }

  success(key) {
    this.entries.delete(key);
  }
}

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseConnect(data) {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(data);
  const frame = parseJsonRejectDuplicates(text);
  // Admission only needs to establish that this is a connect request carrying
  // the bridge token. Leave full request-schema validation (including request
  // ID representation) to the authoritative Gateway so native client protocol
  // revisions do not get rejected by a stricter shadow schema here.
  if (!plainObject(frame)) throw new Error("connect root is not an object");
  if (frame.type !== "req") throw new Error("first message is not a request");
  if (frame.method !== "connect") throw new Error("first request is not connect");
  if (!plainObject(frame.params)) throw new Error("connect params are missing");
  if (!plainObject(frame.params.auth)) throw new Error("connect auth is missing");
  if (!Object.hasOwn(frame.params.auth, "token")) throw new Error("connect token is missing");
  if (typeof frame.params.auth.token !== "string" || frame.params.auth.token.length === 0) {
    throw new Error("connect token is not a non-empty string");
  }
  return frame;
}

function validChallenge(data, isBinary) {
  if (isBinary || data.length > 65_536) return false;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(data);
    const frame = parseJsonRejectDuplicates(text);
    return plainObject(frame) && frame.type === "event" && frame.event === "connect.challenge" &&
      plainObject(frame.payload) && typeof frame.payload.nonce === "string" &&
      frame.payload.nonce.length >= 16 && frame.payload.nonce.length <= 1024 &&
      Number.isSafeInteger(frame.payload.ts) && frame.payload.ts >= 0;
  } catch {
    return false;
  }
}

function forwardedClientIp(req) {
  const value = req.headers["x-forwarded-for"];
  if (typeof value !== "string" || value.length > 64 || value.includes(",") || value.includes("%")) return null;
  const ip = value.trim();
  if (!isIP(ip) || LOOPBACKS.has(ip) || ip === "0.0.0.0" || ip === "::") return null;
  return ip;
}

function safeClose(socket, code, reason) {
  if (!socket || socket.readyState === WebSocket.CLOSED || socket.readyState === WebSocket.CLOSING) return;
  const validStandard = code >= 1000 && code <= 1014 && ![1004, 1005, 1006].includes(code);
  const validCode = validStandard || (code >= 3000 && code <= 4999) ? code : 1011;
  const safeReason = Buffer.from(reason ?? "").subarray(0, 123).toString("utf8");
  socket.close(validCode, safeReason);
}

function rejectUpgrade(socket, status, label) {
  const body = `${label}\n`;
  socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\nCache-Control: no-store\r\n\r\n${body}`);
}

function raisePostConnectLimit(socket, bytes) {
  // ws exposes maxPayload only at construction time. With the dependency pinned,
  // raise its Receiver ceiling only after the bounded first message has passed.
  // Fail closed if a future ws release changes this audited internal shape.
  const receiver = socket?._receiver;
  if (!receiver || !Number.isSafeInteger(receiver._maxPayload)) return false;
  receiver._maxPayload = bytes;
  return receiver._maxPayload === bytes;
}

function logEvent(logger, level, event, fields = {}) {
  logger[level]?.(JSON.stringify({ level, event, ...fields }));
}

export async function startBridge(options = {}) {
  const config = { ...loadConfig(options.env ?? process.env), ...options.config };
  if (config.listenHost !== "127.0.0.1" && config.listenHost !== "::1") {
    throw new Error("bridge must listen on loopback only");
  }
  if (!Number.isInteger(config.listenPort) || config.listenPort < 0 || config.listenPort > 65_535) {
    throw new Error("invalid listen port");
  }
  const expectedToken = options.token ?? loadToken(config.tokenFile);
  const expectedDigest = tokenDigest(expectedToken);
  const logger = options.logger ?? console;
  const limiter = new FailureLimiter(config);
  const server = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/healthz") {
      const body = '{"status":"ok"}\n';
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store", "content-length": Buffer.byteLength(body) });
      res.end(body);
      return;
    }
    res.writeHead(404, { "content-type": "text/plain", "cache-control": "no-store" });
    res.end("not found\n");
  });
  const downstreamServer = new WebSocketServer({
    noServer: true,
    maxPayload: config.connectMaxBytes,
    perMessageDeflate: false,
    autoPong: false,
  });
  const connections = new Set();

  server.on("upgrade", (req, socket, head) => {
    const clientIp = forwardedClientIp(req);
    const remote = req.socket.remoteAddress;
    const host = req.headers.host?.toLowerCase();
    const forwardedHost = req.headers["x-forwarded-host"]?.toLowerCase();
    const path = new URL(req.url ?? "/", "http://bridge.invalid").pathname;
    if (!LOOPBACKS.has(remote) || path !== config.websocketPath || host !== config.expectedHost ||
        forwardedHost !== config.forwardedHost.toLowerCase() || !clientIp) {
      if (clientIp) limiter.failure(clientIp);
      rejectUpgrade(socket, "403 Forbidden", "forbidden");
      return;
    }
    if (head.length > config.connectMaxBytes || limiter.blocked(clientIp)) {
      rejectUpgrade(socket, "429 Too Many Requests", "rate limited");
      return;
    }
    downstreamServer.handleUpgrade(req, socket, head, (client) => {
      downstreamServer.emit("connection", client, req, clientIp);
    });
  });

  downstreamServer.on("connection", (client, req, clientIp) => {
    let upstream;
    let state = "awaiting-challenge";
    let ended = false;
    const timer = setTimeout(() => fail("handshake timeout"), config.handshakeTimeoutMs);
    timer.unref();
    connections.add(client);

    function finish() {
      if (ended) return;
      ended = true;
      clearTimeout(timer);
    }

    function fail(reason, rateLimit = true) {
      if (ended) return;
      if (rateLimit) limiter.failure(clientIp);
      logEvent(logger, "warn", "connection_rejected", { clientIp, reason });
      finish();
      safeClose(client, 1008, "authentication failed");
      safeClose(upstream, 1008, "downstream authentication failed");
    }

    function relay(target, data, isBinary) {
      if (target.readyState !== OPEN || target.bufferedAmount > config.maxBufferedBytes) {
        fail("relay backpressure", false);
        return;
      }
      target.send(data, { binary: isBinary }, (error) => {
        if (error) fail("relay write failed", false);
      });
    }

    upstream = new WebSocket(config.upstreamUrl, {
      perMessageDeflate: false,
      autoPong: false,
      maxPayload: config.relayMaxBytes,
      handshakeTimeout: config.upstreamOpenTimeoutMs,
      followRedirects: false,
      headers: {
        Host: config.forwardedHost,
        "X-Forwarded-User": config.mappedUser,
        "X-Forwarded-Proto": config.forwardedProto,
        "X-Forwarded-Host": config.forwardedHost,
        "X-Forwarded-For": clientIp,
        "X-Real-IP": clientIp,
      },
    });

    upstream.on("message", (data, isBinary) => {
      if (state === "awaiting-challenge") {
        if (!validChallenge(data, isBinary)) return fail("invalid upstream challenge", false);
        state = "awaiting-connect";
        relay(client, data, false); // exact challenge bytes; no reserialization
        return;
      }
      if (state !== "authenticated") return fail("upstream message before authentication", false);
      relay(client, data, isBinary);
    });

    client.on("message", (data, isBinary) => {
      if (state === "awaiting-challenge") return fail("client spoke before challenge");
      if (state === "awaiting-connect") {
        if (data.length > config.connectMaxBytes) return fail("invalid first frame");
        let frame;
        try {
          frame = parseConnect(data);
        } catch (error) {
          return fail(error instanceof Error ? error.message : "malformed connect request");
        }
        if (!constantTimeTokenEqual(expectedDigest, frame.params.auth.token)) return fail("invalid token");
        if (!raisePostConnectLimit(client, config.relayMaxBytes)) return fail("unsupported ws receiver", false);
        state = "authenticated";
        clearTimeout(timer);
        limiter.success(clientIp);
        relay(upstream, data, isBinary); // exact original connect frame preserves device signature
        return;
      }
      if (state !== "authenticated") return fail("client message before authentication");
      relay(upstream, data, isBinary);
    });

    function relayControl(target, method, data, preAuthReason, rateLimit) {
      if (state !== "authenticated") return fail(preAuthReason, rateLimit);
      if (target.readyState !== OPEN || target.bufferedAmount > config.maxBufferedBytes) {
        return fail("relay backpressure", false);
      }
      target[method](data, undefined, (error) => {
        if (error) fail("relay write failed", false);
      });
    }

    client.on("ping", (data) => relayControl(upstream, "ping", data, "client control frame before authentication", true));
    client.on("pong", (data) => relayControl(upstream, "pong", data, "client control frame before authentication", true));
    upstream.on("ping", (data) => relayControl(client, "ping", data, "upstream control frame before authentication", false));
    upstream.on("pong", (data) => relayControl(client, "pong", data, "upstream control frame before authentication", false));

    client.on("close", (code, reason) => {
      connections.delete(client);
      finish();
      safeClose(upstream, code, reason);
    });
    upstream.on("close", (code, reason) => {
      finish();
      safeClose(client, code, reason);
    });
    client.on("error", () => {
      connections.delete(client);
      if (!ended && state !== "authenticated") {
        limiter.failure(clientIp);
        logEvent(logger, "warn", "connection_rejected", { clientIp, reason: "websocket protocol error" });
      }
      finish();
      upstream?.terminate();
    });
    upstream.on("error", () => {
      if (!ended) logEvent(logger, "warn", "upstream_error", { clientIp });
      finish();
      client.terminate();
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.listenPort, config.listenHost, resolve);
  });
  const address = server.address();
  logEvent(logger, "info", "bridge_listening", { host: config.listenHost, port: address.port });

  return {
    config,
    port: address.port,
    async close() {
      for (const socket of connections) socket.terminate();
      downstreamServer.close();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  startBridge().catch((error) => {
    console.error(JSON.stringify({ level: "error", event: "startup_failed", message: error.message }));
    process.exitCode = 1;
  });
}
