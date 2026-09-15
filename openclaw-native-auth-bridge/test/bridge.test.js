import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { WebSocket, WebSocketServer } from "ws";
import { constantTimeTokenEqual, loadToken, startBridge } from "../src/server.js";

const TOKEN = "test-token-not-a-secret-0123456789abcdef";
const silentLogger = { info() {}, warn() {}, error() {} };

function onceMessage(socket) {
  return new Promise((resolve, reject) => {
    socket.once("message", (data, isBinary) => resolve({ data, isBinary }));
    socket.once("error", reject);
    socket.once("close", (code) => reject(new Error(`socket closed before message (${code})`)));
  });
}

function onceClose(socket) {
  return new Promise((resolve) => socket.once("close", (code, reason) => resolve({ code, reason: reason.toString() })));
}

function onceControl(socket, event) {
  return new Promise((resolve, reject) => {
    socket.once(event, (data) => resolve(Buffer.from(data)));
    socket.once("error", reject);
  });
}

async function mockGateway({ challengeDelayMs = 0 } = {}) {
  const wss = new WebSocketServer({
    host: "127.0.0.1",
    port: 0,
    perMessageDeflate: false,
    maxPayload: 30_000_000,
    autoPong: false,
  });
  await new Promise((resolve) => wss.once("listening", resolve));
  const address = wss.address();
  const challenge = Buffer.from('{ "type":"event", "event":"connect.challenge", "payload":{"nonce":"0123456789abcdef0123456789abcdef","ts":1788957000000} }');
  const connections = [];
  wss.on("connection", (socket, req) => {
    connections.push({ socket, headers: req.headers, messages: [] });
    socket.on("message", (data, isBinary) => connections.at(-1).messages.push({ data: Buffer.from(data), isBinary }));
    setTimeout(() => socket.readyState === WebSocket.OPEN && socket.send(challenge.toString("utf8")), challengeDelayMs);
  });
  return {
    url: `ws://127.0.0.1:${address.port}`,
    challenge,
    connections,
    close: () => new Promise((resolve) => wss.close(resolve)),
  };
}

async function setup(overrides = {}, gatewayOptions = {}) {
  const gateway = await mockGateway(gatewayOptions);
  const bridge = await startBridge({
    token: TOKEN,
    logger: process.env.BRIDGE_TEST_DEBUG ? console : silentLogger,
    config: {
      listenHost: "127.0.0.1",
      listenPort: 0,
      expectedHost: "claw-native.thenairn.com",
      forwardedHost: "claw-native.thenairn.com",
      upstreamUrl: gateway.url,
      handshakeTimeoutMs: 500,
      upstreamOpenTimeoutMs: 500,
      connectMaxBytes: 1024,
      relayMaxBytes: 2_000_000,
      ...overrides,
    },
  });
  return {
    gateway,
    bridge,
    connect(extraHeaders = {}) {
      return new WebSocket(`ws://127.0.0.1:${bridge.port}/`, {
        perMessageDeflate: false,
        headers: {
          Host: "claw-native.thenairn.com",
          "X-Forwarded-Host": "claw-native.thenairn.com",
          "X-Forwarded-For": "203.0.113.9",
          ...extraHeaders,
        },
      });
    },
    async close() {
      for (const entry of gateway.connections) entry.socket.terminate();
      await bridge.close();
      await gateway.close();
    },
  };
}

function connectFrame(token = TOKEN) {
  return JSON.stringify({
    type: "req",
    id: "connect-1",
    method: "connect",
    params: {
      minProtocol: 4,
      maxProtocol: 4,
      client: { id: "openclaw-ios", version: "1", platform: "ios", mode: "ui" },
      role: "operator",
      scopes: ["operator.read"],
      auth: { token },
      device: { id: "device", publicKey: "key", signature: "signature", signedAt: 1788957000000, nonce: "0123456789abcdef0123456789abcdef" },
    },
  });
}

test("loads a newline-terminated secret without exposing it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bridge-token-"));
  const path = join(directory, "token");
  await writeFile(path, `${TOKEN}\n`, { mode: 0o600 });
  assert.equal(loadToken(path), TOKEN);
  const digest = createHash("sha256").update(TOKEN).digest();
  assert.equal(constantTimeTokenEqual(digest, TOKEN), true);
  assert.equal(constantTimeTokenEqual(digest, "wrong"), false);
});

test("health endpoint is bounded and credential-free", async () => {
  const fixture = await setup();
  try {
    const response = await new Promise((resolve, reject) => {
      request({ host: "127.0.0.1", port: fixture.bridge.port, path: "/healthz" }, (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
      }).on("error", reject).end();
    });
    assert.deepEqual(response, { status: 200, body: '{"status":"ok"}\n' });
    assert.equal(response.body.includes(TOKEN), false);
  } finally {
    await fixture.close();
  }
});

test("relays exact challenge/connect bytes and attributed proxy headers", async () => {
  const fixture = await setup();
  try {
    const client = fixture.connect();
    const challenge = await onceMessage(client);
    assert.deepEqual(challenge.data, fixture.gateway.challenge);
    const original = Buffer.from(connectFrame());
    client.send(original, { binary: false });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(fixture.gateway.connections[0].messages[0].data, original);
    assert.equal(fixture.gateway.connections[0].messages[0].isBinary, false);
    const headers = fixture.gateway.connections[0].headers;
    assert.equal(headers["x-forwarded-user"], "thomas@rowm.co");
    assert.equal(headers["x-forwarded-proto"], "https");
    assert.equal(headers["x-forwarded-host"], "claw-native.thenairn.com");
    assert.equal(headers["x-forwarded-for"], "203.0.113.9");
    client.terminate();
  } finally {
    await fixture.close();
  }
});

test("accepts the native client's binary UTF-8 connect frame without changing bytes or opcode", async () => {
  const fixture = await setup();
  try {
    const client = fixture.connect();
    await onceMessage(client);
    const original = Buffer.from(connectFrame());
    client.send(original, { binary: true });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(fixture.gateway.connections[0].messages[0], { data: original, isBinary: true });
    client.terminate();
  } finally {
    await fixture.close();
  }
});

test("does not shadow-validate the Gateway request ID representation", async () => {
  const fixture = await setup();
  try {
    const client = fixture.connect();
    await onceMessage(client);
    const original = Buffer.from(connectFrame().replace('"id":"connect-1"', '"id":1'));
    client.send(original, { binary: false });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(fixture.gateway.connections[0].messages[0].data, original);
    client.terminate();
  } finally {
    await fixture.close();
  }
});

test("raises the payload limit only after authentication and relays binary", async () => {
  const fixture = await setup();
  try {
    const client = fixture.connect();
    await onceMessage(client);
    client.send(connectFrame());
    await new Promise((resolve) => setTimeout(resolve, 20));
    const large = Buffer.alloc(64_000, 0xa5);
    client.send(large, { binary: true });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(fixture.gateway.connections[0].messages[1], { data: large, isBinary: true });
    client.terminate();
  } finally {
    await fixture.close();
  }
});

test("preserves post-auth text, binary, ping, pong, and standard close frames bidirectionally", async () => {
  const fixture = await setup();
  try {
    const client = fixture.connect();
    await onceMessage(client);
    client.send(connectFrame());
    await new Promise((resolve) => setTimeout(resolve, 20));
    const upstream = fixture.gateway.connections[0].socket;

    const textMessage = onceMessage(client);
    upstream.send("gateway-text");
    assert.deepEqual(await textMessage, { data: Buffer.from("gateway-text"), isBinary: false });

    const binaryMessage = onceMessage(client);
    upstream.send(Buffer.from([1, 2, 3]), { binary: true });
    assert.deepEqual(await binaryMessage, { data: Buffer.from([1, 2, 3]), isBinary: true });

    const upstreamPing = onceControl(upstream, "ping");
    client.ping(Buffer.from("from-client"));
    assert.equal((await upstreamPing).toString(), "from-client");

    const clientPing = onceControl(client, "ping");
    const automaticClientPong = onceControl(upstream, "pong");
    upstream.ping(Buffer.from("from-gateway"));
    assert.equal((await clientPing).toString(), "from-gateway");
    assert.equal((await automaticClientPong).toString(), "from-gateway");

    const upstreamPong = onceControl(upstream, "pong");
    client.pong(Buffer.from("client-pong"));
    assert.equal((await upstreamPong).toString(), "client-pong");

    const clientPong = onceControl(client, "pong");
    upstream.pong(Buffer.from("gateway-pong"));
    assert.equal((await clientPong).toString(), "gateway-pong");

    const closed = onceClose(client);
    upstream.close(1001, "gateway restart");
    assert.deepEqual(await closed, { code: 1001, reason: "gateway restart" });
  } finally {
    await fixture.close();
  }
});

test("does not inspect or rewrite any client text after the accepted first request", async () => {
  const fixture = await setup();
  try {
    const client = fixture.connect();
    await onceMessage(client);
    client.send(connectFrame());
    await new Promise((resolve) => setTimeout(resolve, 20));
    const laterBytes = Buffer.from(connectFrame("this-is-not-the-admission-token"));
    client.send(laterBytes, { binary: false });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(fixture.gateway.connections[0].messages[1], { data: laterBytes, isBinary: false });
    client.terminate();
  } finally {
    await fixture.close();
  }
});

test("rejects wrong, missing, malformed, duplicate-key, and oversized first messages", async (t) => {
  const cases = [
    ["wrong token", () => Buffer.from(connectFrame("definitely-wrong")), false],
    ["binary wrong token", () => Buffer.from(connectFrame("definitely-wrong")), true],
    ["missing token", () => Buffer.from(connectFrame().replace(`"token":"${TOKEN}"`, '"password":"not-accepted"')), false],
    ["malformed JSON", () => Buffer.from('{"type":"req","method":"connect"'), false],
    ["duplicate key", () => Buffer.from(connectFrame().replace('"auth":{"token":', '"auth":{"token":"first","token":')), false],
    ["oversized", () => Buffer.alloc(2048, 0x20), false],
  ];
  for (const [name, payload, binary] of cases) {
    await t.test(name, async () => {
      const fixture = await setup();
      try {
        const client = fixture.connect();
        await onceMessage(client);
        const closed = onceClose(client);
        client.send(payload(), { binary });
        const result = await closed;
        assert.notEqual(result.code, 1000);
        assert.equal(fixture.gateway.connections[0].messages.length, 0);
      } finally {
        await fixture.close();
      }
    });
  }
});

test("rejects unsafe forwarded attribution without opening an upstream socket", async () => {
  const fixture = await setup();
  try {
    const unsafe = fixture.connect({ "X-Forwarded-For": "203.0.113.9, 198.51.100.4" });
    const rejection = await new Promise((resolve, reject) => {
      unsafe.once("error", (error) => resolve({ error: error.message }));
      unsafe.once("close", (code) => resolve({ code }));
      unsafe.once("unexpected-response", (_request, response) => resolve({ status: response.statusCode }));
      unsafe.once("message", () => reject(new Error("unsafe attribution was accepted")));
      unsafe.once("open", () => reject(new Error("unsafe attribution upgrade opened")));
    });
    assert.ok(rejection.error?.includes("403") || rejection.status === 403 || rejection.code === 1006);
    assert.equal(fixture.gateway.connections.length, 0);
  } finally {
    await fixture.close();
  }
});

test("rejects a client frame sent before the upstream challenge", async () => {
  const fixture = await setup({}, { challengeDelayMs: 100 });
  try {
    const client = fixture.connect();
    await new Promise((resolve, reject) => {
      client.once("open", resolve);
      client.once("error", reject);
    });
    const closed = onceClose(client);
    client.send(connectFrame());
    assert.equal((await closed).code, 1008);
    assert.equal(fixture.gateway.connections[0].messages.length, 0);
  } finally {
    await fixture.close();
  }
});

test("rate-limits repeated authentication failures by attributed client IP", async () => {
  const fixture = await setup({ failuresPerWindow: 2, failureWindowMs: 10_000, failureBlockMs: 10_000 });
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const client = fixture.connect();
      await onceMessage(client);
      const closed = onceClose(client);
      client.send(connectFrame("wrong-token"));
      assert.equal((await closed).code, 1008);
    }
    const blocked = fixture.connect();
    const rejection = await new Promise((resolve, reject) => {
      blocked.once("error", (error) => resolve({ error: error.message }));
      blocked.once("close", (code) => resolve({ code }));
      blocked.once("unexpected-response", (_request, response) => resolve({ status: response.statusCode }));
      blocked.once("open", () => reject(new Error("rate-limited upgrade opened")));
    });
    assert.ok(rejection.error?.includes("429") || rejection.status === 429 || rejection.code === 1006);
  } finally {
    await fixture.close();
  }
});

test("times out when the client never sends connect", async () => {
  const fixture = await setup({ handshakeTimeoutMs: 100 });
  try {
    const client = fixture.connect();
    await onceMessage(client);
    assert.equal((await onceClose(client)).code, 1008);
  } finally {
    await fixture.close();
  }
});
