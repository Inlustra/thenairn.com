import { defineChannelPluginEntry, createChatChannelPlugin, createChannelPluginBase } from 'openclaw/plugin-sdk/channel-core';
import { dispatchInboundDirectDm } from 'openclaw/plugin-sdk/channel-inbound';
import { defineStableChannelIngressIdentity, resolveChannelMessageIngress } from 'openclaw/plugin-sdk/channel-ingress-runtime';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { getRuntimeConfig } from 'openclaw/plugin-sdk/config-runtime';
const CHANNEL = 'milo-test';
const PEER = 'repair-guest';
const LOG = '/home/node/.openclaw/milo-test/delivery.jsonl';
async function capture(text, to = PEER) {
  if (to !== PEER && to !== `dm:${PEER}` && to !== `${CHANNEL}:${PEER}`) throw new Error('test transport destination rejected');
  const messageId = randomUUID();
  await mkdir('/home/node/.openclaw/milo-test', { recursive: true, mode: 0o700 });
  await appendFile(LOG, JSON.stringify({ messageId, at: new Date().toISOString(), text }) + '\n', { mode: 0o600 });
  return { channel: CHANNEL, messageId, to };
}
const plugin = createChatChannelPlugin({
  base: createChannelPluginBase({
    id: CHANNEL, meta: { label: 'Milo test', selectionLabel: 'Milo isolated test', docsPath: '/channels/milo-test', blurb: 'Local test sink. No external network delivery.' },
    config: { listAccountIds: () => ['default'], resolveAccount: cfg => ({ accountId: 'default', enabled: cfg.channels?.[CHANNEL]?.enabled === true, configured: true }), inspectAccount: cfg => ({ enabled: cfg.channels?.[CHANNEL]?.enabled === true, configured: true }) },
    setup: { applyAccountConfig: ({ cfg }) => cfg },
  }),
  security: { dm: { channelKey: CHANNEL, resolvePolicy: () => 'allowlist', resolveAllowFrom: () => [PEER], defaultPolicy: 'allowlist' } },
  outbound: { deliveryMode: 'direct', textChunkLimit: 4000, sendText: async ({ text, to }) => capture(text, to) },
});
const identity = defineStableChannelIngressIdentity({ key: 'test-user', normalize: value => typeof value === 'string' ? value.trim() : undefined, sensitivity: 'public' });
export default defineChannelPluginEntry({
  id: CHANNEL, name: 'Milo isolated test transport', description: 'Admin-operated synthetic non-owner ingress, local-only reply capture.', plugin,
  registerFull(api) {
    api.registerGatewayMethod('milo-test.inject', async ({ params, respond }) => {
      try {
        if (typeof params?.message !== 'string' || params.message.length > 2000) throw new Error('message required, maximum 2000 characters');
        const cfg = getRuntimeConfig();
        if (cfg.channels?.[CHANNEL]?.enabled !== true) throw new Error('test transport disabled');
        const result = await dispatchInboundDirectDm({
          cfg, channel: CHANNEL, channelRuntime: api.runtime.channel, accountId: 'default', peer: { kind: 'direct', id: PEER },
          channelLabel: 'Milo test', conversationLabel: 'Isolated guest test', senderId: PEER, senderAddress: `${CHANNEL}:${PEER}`, recipientAddress: `${CHANNEL}:milo`,
          originatingTo: PEER, rawBody: params.message, messageId: randomUUID(), timestamp: Date.now(), commandAuthorized: false,
          resolveChannelIngress: contextBinding => resolveChannelMessageIngress({ channelId: CHANNEL, accountId: 'default', identity, subject: { stableId: PEER }, conversation: { kind: 'direct', id: PEER }, contextBinding, event: { kind: 'message', authMode: 'inbound', mayPair: false }, policy: { dmPolicy: 'allowlist', groupPolicy: 'disabled' }, allowFrom: [PEER], readStoreAllowFrom: async () => [] }),
          deliver: async payload => { if (payload.text) return capture(payload.text); },
          onDispatchError: error => api.logger.error(`milo-test dispatch: ${error?.message ?? 'failed'}`),
        });
        respond(true, { sessionKey: result.route.sessionKey, senderIsOwner: result.ctxPayload.SenderIsOwner ?? null, testTransport: true });
      } catch (e) { respond(false, undefined, { code: 'UNAVAILABLE', message: e.message }); }
    }, { scope: 'operator.admin' });
    api.registerGatewayMethod('milo-test.receipts', async ({ respond }) => {
      let entries = []; try { entries = (await readFile(LOG, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse).slice(-30); } catch(e) { if (e.code !== 'ENOENT') throw e; }
      respond(true, { entries });
    }, { scope: 'operator.admin' });
  },
});
