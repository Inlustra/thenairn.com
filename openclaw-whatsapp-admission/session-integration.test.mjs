import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { deliverOwnerAlert } from "./delivery.mjs";

// Deployment integration check. Isolate state BEFORE importing the installed SDK.
// Only transport is stubbed: routing, runtime configuration and SQLite are real.
process.env.OPENCLAW_STATE_DIR = await mkdtemp(join(tmpdir(), "admission-sdk-"));
const root = process.env.ADMISSION_TEST_OPENCLAW_ROOT || "/app";
const { createPluginRuntime } = await import(`${root}/dist/plugins/runtime/index.js`);
const { setRuntimeConfigSnapshot } = await import(`${root}/dist/plugin-sdk/config-runtime.js`);
const { upsertSessionEntry, getSessionEntry } = await import(`${root}/dist/plugin-sdk/session-store-runtime.js`);
const { appendAssistantMirrorMessageByIdentity, readVisibleSessionTranscriptMessageEntries } = await import(`${root}/dist/plugin-sdk/session-transcript-runtime.js`);

test("installed runtime delivers context to SQLite and preserves platform reply correlation", async () => {
  const cfg = { agents: { list: [{ id: "concierge" }] }, bindings: [{ type: "route", agentId: "concierge", match: { channel: "whatsapp", accountId: "default" }, session: { dmScope: "per-account-channel-peer" } }] };
  setRuntimeConfigSnapshot(cfg);
  const runtime = createPluginRuntime();
  const config = { ownerNumber: "+447700900001", accountId: "default" };
  const route = runtime.channel.routing.resolveAgentRoute({ cfg, channel: "whatsapp", accountId: config.accountId, peer: { kind: "direct", id: config.ownerNumber } });
  const scope = { agentId: route.agentId, sessionKey: route.sessionKey, sessionId: crypto.randomUUID() };
  await upsertSessionEntry({ ...scope, entry: { sessionId: scope.sessionId, updatedAt: Date.now() } });
  let sends = 0;
  runtime.channel.outbound.loadAdapter = async () => ({ sendText: async () => { sends++; return { messageId: "synthetic-platform-id" }; } });
  const args = { api: { runtime, logger: { info() {} } }, config,
    event: { channel: "whatsapp", accountId: "default", senderId: "+447700900002", metadata: { name: "Synthetic test" } },
    getSessionEntry, appendMirror: appendAssistantMirrorMessageByIdentity };
  await deliverOwnerAlert(args);
  const entries = await readVisibleSessionTranscriptMessageEntries(scope);
  assert.equal(entries.length, 1);
  assert.match(JSON.stringify(entries), /Synthetic test/);
  assert.match(JSON.stringify(entries), /synthetic-platform-id/);
  await deliverOwnerAlert(args);
  assert.equal((await readVisibleSessionTranscriptMessageEntries(scope)).length, 1);
  assert.equal(sends, 2); // identical synthetic receipts dedupe only the mirror
});
