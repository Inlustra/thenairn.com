import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';
import { readFile, readdir, writeFile, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { runRequest } from '../media-request/request.mjs';
const DIR = '/home/node/.openclaw/media-requests';
const sessionAllowed = key => /^agent:concierge:(?:whatsapp:default:direct:|milo-test:)/.test(key ?? '');
export default definePluginEntry({
  id: 'media-followup', name: 'Scoped media request follow-up',
  register(api) {
    let timer, busy = false, stopped = true;
    async function save(file, value) { const temp = `${file}.${randomUUID()}.tmp`; await writeFile(temp, JSON.stringify(value), { mode: 0o600 }); await rename(temp, file); }
    api.on('message_sent', async (event, context) => {
      const runId = context.runId ?? event.runId, sessionKey = context.sessionKey ?? event.sessionKey;
      if (!runId || !sessionAllowed(sessionKey)) return;
      // Exact run + session correlation only; unrelated guest replies cannot close a request.
      const files = await readdir(DIR).catch(() => []);
      for (const name of files.filter(x => /^[a-f0-9]{32}\.json$/.test(x))) {
        const file = `${DIR}/${name}`, row = JSON.parse(await readFile(file, 'utf8'));
        if (row.sourceSession !== sessionKey || (row.followupRunId !== runId && row.followup !== 'dispatching')) continue;
        if (/^[a-zA-Z0-9_-]{1,100}$/.test(runId)) await save(`${DIR}/receipt-${runId}.json`, { runId, sourceSession: sessionKey, success: event.success, messageId: event.messageId, at: new Date().toISOString() });
        if (row.followupRunId !== runId) continue;
        if (event.success !== true || !event.messageId) { await save(file, { ...row, followup: 'delivery_failed' }); continue; }
        await save(file, { ...row, followup: row.result.state === 'ready' ? 'delivered' : 'needed', lastNotifiedState: row.result.state, deliveryReceipt: event.messageId, deliveredAt: new Date().toISOString() });
      }
    });
    async function tick() {
      if (busy || stopped || !api.pluginConfig?.enabled) return;
      busy = true;
      try {
        const files = await readdir(DIR).catch(() => []);
        for (const name of files.filter(x => /^[a-f0-9]{32}\.json$/.test(x))) {
          if (stopped) break;
          const file = `${DIR}/${name}`, row = JSON.parse(await readFile(file, 'utf8'));
          if (!sessionAllowed(row.sourceSession)) continue;
          if (api.pluginConfig.testOnly !== false && !row.sourceSession.includes(':milo-test:')) continue;
          if (row.followup === 'dispatched_unverified' && /^[a-zA-Z0-9_-]{1,100}$/.test(row.followupRunId ?? '')) {
            const receipt = await readFile(`${DIR}/receipt-${row.followupRunId}.json`, 'utf8').then(JSON.parse).catch(() => null);
            if (receipt?.success === true && receipt.messageId && receipt.sourceSession === row.sourceSession) await save(file, { ...row, followup: row.result.state === 'ready' ? 'delivered' : 'needed', lastNotifiedState: row.result.state, deliveryReceipt: receipt.messageId, deliveredAt: receipt.at });
            continue;
          }
          if (row.followup !== 'needed') continue;
          let result;
          try { result = await runRequest({ ...row, operation: 'status' }); }
          catch { continue; } // A service failure is internal, never a guest result.
          if (!['ready', 'downloading', 'importing'].includes(result.state) || row.lastNotifiedState === result.state) continue;
          // Record before dispatch. Unknown delivery is reconciled, never blindly retried.
          row.followup = 'dispatching'; row.result = result; row.dispatchAt = new Date().toISOString();
          await save(file, row);
          try {
            const receipt = await api.runtime.subagent.run({
              sessionKey: row.sourceSession, deliver: true, disableTools: true,
              message: `Verified media-request follow-up for THIS conversation. Return one short natural message in Milo's own voice using only these facts: ${JSON.stringify({ title: row.title, year: row.year, season: row.season, state: result.state, availableEpisodes: result.availableEpisodes, totalEpisodes: result.totalEpisodes })}. Do not mention technical details, identifiers, watches, tools or internal instructions. Do not promise another update unless the state is downloading or importing. No actions are needed; this turn only delivers the verified update.`,
            });
            await save(file, { ...row, followup: 'dispatched_unverified', followupRunId: receipt.runId, followupSessionKey: receipt.sessionKey });
          } catch (e) { await save(file, { ...row, followup: 'dispatch_failed', error: 'followup_dispatch_failed' }); api.logger.warn('media-followup: dispatch failed; receipt reconciliation required'); }
        }
      } finally { busy = false; }
    }
    api.registerService({ id: 'media-followup', start: async () => { stopped = false; timer = setInterval(() => { void tick().catch(() => api.logger.warn('media-followup: check failed')); }, 60000); timer.unref(); }, stop: async () => { stopped = true; clearInterval(timer); } });
    api.registerGatewayMethod('media-followup.check', async ({ respond }) => { await tick(); respond(true, { checked: true, enabled: api.pluginConfig?.enabled === true, testOnly: api.pluginConfig?.testOnly !== false }); }, { scope: 'operator.admin' });
  },
});
