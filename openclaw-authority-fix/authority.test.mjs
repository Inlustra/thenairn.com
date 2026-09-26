import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import test from 'node:test';
import { patches, transform } from './patch.mjs';

const original = patches.map(p => fs.readFileSync(`/app/dist/${p.file}`, 'utf8'));
const fixed = original.map((s, i) => transform(s, patches[i]));
const start = fixed[0].indexOf('async function prepareAgentRunUserTurn(params) {');
const end = fixed[0].indexOf('\nfunction finalizePreparedAgentRunUserTurn', start);
const prepare = vm.runInNewContext(`${fixed[0].slice(start, end)}; prepareAgentRunUserTurn`, {
  randomUUID: () => 'test-claim',
  clientHasAdminScope: client => client?.admin === true,
});

for (const [name, admin, provenance, cron, expected] of [
  ['verified admin', true, undefined, false, true],
  ['external admin', true, { kind: 'external_user' }, false, true],
  ['external guest', false, { kind: 'external_user' }, false, false],
  ['missing admin', undefined, undefined, false, false],
  ['admin A2A', true, { kind: 'inter_session', sourceTool: 'sessions_send' }, false, false],
  ['guest A2A', false, { kind: 'inter_session' }, false, false],
  ['trusted cron continuation', false, undefined, true, true],
  ['A2A cannot borrow cron owner', true, { kind: 'inter_session' }, true, false],
]) test(name, async () => {
  const result = await prepare({
    request: {}, client: { admin }, inputProvenance: provenance,
    restoredCronContinuation: cron, requestedPromptPersistenceSuppression: true,
    message: 'bounded test', effectiveTranscriptInputText: 'bounded test',
  });
  assert.equal(result.senderIsOwner, expected);
});

const guardStart = fixed[1].indexOf('function requireOwner(options) {');
const guardEnd = fixed[1].indexOf('\nfunction readConversationRef', guardStart);
const guard = vm.runInNewContext(`${fixed[1].slice(guardStart, guardEnd)}; requireOwner`, {
  ToolAuthorizationError: class extends Error {},
});
test('conversation guard accepts only explicit verified owner', () => {
  guard({ senderIsOwner: true });
  for (const value of [false, undefined, null, 'true', 1])
    assert.throws(() => guard({ senderIsOwner: value }), /owner access/);
});
test('patch is repeat-safe', () => fixed.forEach((s, i) => assert.equal(transform(s, patches[i]), s)));
test('unknown source cannot be patched', () => assert.throws(() => transform(`${original[0]}\n`, patches[0]), /refusing/));
