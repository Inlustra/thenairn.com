import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { runRequest, validate } from './request.mjs';
const base = { operation: 'lookup', mediaType: 'movie', title: 'Example', sourceSession: 'agent:concierge:test-a' };
test('rejects acquisitions without confirmation, arbitrary source and invalid seasons', () => {
  assert.throws(() => validate({ ...base, operation: 'acquire', tmdbId: 1 }));
  assert.throws(() => validate({ ...base, sourceSession: 'agent:main:main' }));
  assert.throws(() => validate({ ...base, mediaType: 'series', season: 0 }));
});
test('requires same-conversation candidate; existing ready movie makes no writes', async () => {
  const stateDir = await mkdtemp(`${tmpdir()}/media-test-`), calls = [];
  const api = async (kind, path, method = 'GET') => { calls.push(method); return path.startsWith('movie/lookup') ? [{ title: 'Example', year: 2020, tmdbId: 1 }] : [{ title: 'Example', tmdbId: 1, id: 12, hasFile: true }]; };
  try {
    await runRequest(base, { api, stateDir });
    const request = { ...base, operation: 'acquire', tmdbId: 1, confirmed: true };
    await assert.rejects(runRequest({ ...request, sourceSession: 'agent:concierge:test-b' }, { api, stateDir }), /lookup_required/);
    assert.equal((await runRequest(request, { api, stateDir })).state, 'ready');
    assert.ok(calls.every(x => x === 'GET'));
  } finally { await rm(stateDir, { recursive: true }); }
});
test('a series is not ready when any episode is missing', async () => {
  const stateDir = await mkdtemp(`${tmpdir()}/media-test-`);
  const api = async (kind, path) => path === 'series' ? [{ tvdbId: 1, id: 2 }] : path.startsWith('episode?') ? [{ seasonNumber: 1, airDateUtc: '2020-01-01', hasFile: true }, { seasonNumber: 1, airDateUtc: '2020-01-02', hasFile: false }] : { records: [] };
  try { assert.equal((await runRequest({ ...base, operation: 'availability', mediaType: 'series', tvdbId: 1, season: 1 }, { api, stateDir })).state, 'not_ready'); }
  finally { await rm(stateDir, { recursive: true }); }
});
test('an uncertain acquisition is not submitted twice', async () => {
  const stateDir = await mkdtemp(`${tmpdir()}/media-test-`);
  let writes = 0, added = false;
  const api = async (kind, path, method = 'GET') => {
    if (method === 'POST' && path === 'movie') { writes++; added = true; throw new Error('connection lost after write'); }
    if (method !== 'GET') { writes++; return { id: 99 }; }
    if (path.startsWith('movie/lookup')) return [{ title: 'Example', year: 2020, tmdbId: 1 }];
    if (path === 'movie') return added ? [{ title: 'Example', tmdbId: 1, id: 12, hasFile: false }] : [];
    return { records: [] };
  };
  try {
    await runRequest(base, { api, stateDir });
    const request = { ...base, operation: 'acquire', tmdbId: 1, confirmed: true };
    await assert.rejects(runRequest(request, { api, stateDir }));
    const retry = await runRequest(request, { api, stateDir });
    assert.equal(retry.duplicateSuppressed, true); assert.equal(writes, 1);
  } finally { await rm(stateDir, { recursive: true }); }
});
