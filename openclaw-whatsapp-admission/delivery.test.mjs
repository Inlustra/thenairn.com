import assert from "node:assert/strict";
import test from "node:test";
import { deliverOwnerAlert } from "./delivery.mjs";

function fixture() {
  const calls = [];
  const config = { accountId: "default", ownerNumber: "+447700900001" };
  const event = { channel: "whatsapp", accountId: "default", senderId: "+447700900002", code: "SECRET", metadata: { name: "Example", body: "PRIVATE" } };
  const route = { agentId: "concierge", sessionKey: "agent:concierge:whatsapp:default:direct:+447700900001" };
  const api = { runtime: {
    config: { current: () => ({ session: {} }) },
    channel: {
      routing: { resolveAgentRoute: () => route },
      session: { resolveStorePath: () => "/isolated-test/sessions.json" },
      outbound: { loadAdapter: async () => ({ sendText: async p => { calls.push(["send", p]); return { messageId: "WA-1" }; } }) },
    },
  }, logger: { info: text => calls.push(["log", text]) } };
  return { calls, route, args: { api, config, event,
    getSessionEntry: () => ({ sessionId: "session-1" }),
    appendMirror: async p => { calls.push(["mirror", p]); return { ok: true, messageId: "mirror-1" }; },
  } };
}

test("delivered notification is mirrored to the exact owner session with reply correlation, no code/body", async () => {
  const { args, calls } = fixture();
  await deliverOwnerAlert(args);
  assert.deepEqual(calls.map(c => c[0]), ["send", "mirror", "log"]);
  assert.equal(calls[0][1].text, calls[1][1].text);
  assert.equal(calls[1][1].sessionId, "session-1");
  assert.equal(calls[1][1].deliveryMirror.sourceMessageId, "WA-1");
  assert.match(calls[1][1].sessionKey, /direct:\+447700900001$/);
  assert.doesNotMatch(JSON.stringify(calls), /SECRET|PRIVATE/);
});

test("wrong channel/account cannot notify or write", async () => {
  for (const patch of [{ channel: "telegram" }, { accountId: "another" }]) {
    const { args, calls } = fixture(); Object.assign(args.event, patch);
    await deliverOwnerAlert(args); assert.deepEqual(calls, []);
  }
});

test("shared or wrong-owner routing fails closed before sending", async () => {
  for (const patch of [{ agentId: "main" }, { sessionKey: "agent:concierge:main" }, { sessionKey: "agent:concierge:whatsapp:default:direct:+447700900999" }]) {
    const { args, route, calls } = fixture(); Object.assign(route, patch);
    await assert.rejects(deliverOwnerAlert(args), /isolated Concierge/);
    assert.deepEqual(calls, []);
  }
});

test("missing session or failed transport cannot create a false delivery mirror", async () => {
  const f = fixture(); f.args.getSessionEntry = () => undefined;
  await assert.rejects(deliverOwnerAlert(f.args), /conversation must exist/);
  assert.deepEqual(f.calls, []);
  const g = fixture(); g.args.api.runtime.channel.outbound.loadAdapter = async () => ({ sendText: async () => { throw Error("offline"); } });
  await assert.rejects(deliverOwnerAlert(g.args), /offline/);
  assert.deepEqual(g.calls, []);
});

test("session reset during send is fenced and not reported as complete", async () => {
  const { args, calls } = fixture();
  args.appendMirror = async () => ({ ok: false, code: "session-rebound" });
  await assert.rejects(deliverOwnerAlert(args), /session-rebound/);
  assert.deepEqual(calls.map(c => c[0]), ["send"]);
});
