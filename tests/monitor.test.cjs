'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { check } = require('../scripts/monitor.cjs');
test('check-only monitoring makes no repair calls and sends no messages', async () => {
  const calls = [];
  const status = await check({ request: async input => { calls.push(input.action); throw new Error('offline'); }, repair: async () => assert.fail('repair not allowed'), mode: 'check' });
  assert.equal(status.available, false); assert.deepEqual(calls, ['probe']);
});
test('healthy monitor reads probe and catalog only', async () => {
  const calls = [];
  const status = await check({ request: async input => { calls.push(input.action); return { ok: true, result: input.action === 'probe' ? { available: true, version: '5.8.4' } : { models: [{ id: 'model' }] } }; }, repair: async () => assert.fail('unexpected repair'), mode: 'repair' });
  assert.equal(status.available, true); assert.equal(status.repaired, false); assert.deepEqual(calls, ['probe', 'models']);
});
test('repair mode performs a single bridge attach and rechecks without mutations', async () => {
  let ready = false, repairs = 0; const calls = [];
  const status = await check({ request: async input => {
    calls.push(input.action); if (!ready) throw new Error('offline');
    return { ok: true, result: input.action === 'probe' ? { available: true, version: '5.8.4' } : { models: [{ id: 'model' }] } };
  }, repair: async () => { repairs++; ready = true; return { ready: true }; }, mode: 'repair' });
  assert.equal(status.available, true); assert.equal(status.repaired, true); assert.equal(repairs, 1);
  assert.deepEqual(calls, ['probe', 'probe', 'models']);
});
test('closed desktop is reported without repeated attempts', async () => {
  let repairs = 0;
  const status = await check({ request: async () => { throw new Error('offline'); }, repair: async () => { repairs++; return { ready: false }; }, mode: 'repair' });
  assert.equal(status.available, false); assert.equal(repairs, 1); assert.equal(status.reason, 'start_workbuddy_with_bridge_shortcut');
});
