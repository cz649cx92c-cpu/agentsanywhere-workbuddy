'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { DesktopCdp } = require('../bridge/desktop-cdp.cjs');

function desktop() {
  const calls = [], handle = {
    marker: 'native-handle',
    configManager: { async setModel(model) { calls.push(['model', model]); } },
    async runPrompt(content, options) { assert.equal(this.marker, 'native-handle'); calls.push(['prompt', content, options]); return { stopReason: 'end_turn' }; },
    async requestEntries(options) { assert.equal(this.marker, 'native-handle'); calls.push(['history', options]); return { requests: [], historyReady: true }; },
    async getPendingInfo() { return null; },
    async resolvePending(id, response) { calls.push(['approval', id, response]); },
    async cancel() { calls.push(['cancel']); },
  };
  const wb = {
    models: { list: async () => [{ id: 'deepseek-v4.1-flash' }] },
    conversations: {
      get: async id => { assert.equal(id, 'native-id'); calls.push(['get', id]); return handle; },
      local: { list: async () => ({ items: [] }) },
      create: async params => { calls.push(['create', params]); return { info: { id: 'created-id' } }; },
    },
  };
  const client = Object.create(DesktopCdp.prototype);
  client.evaluate = expression => vm.runInNewContext(expression, { wb });
  return { client, calls };
}
test('5.8.4 calls prompt, history, model and approval through the native conversation handle', async () => {
  const { client, calls } = desktop();
  await client.call('conversations.configSetModel', ['native-id', 'deepseek-v4.1-flash']);
  const content = [{ type: 'text', text: 'verify' }], options = { clientRequestId: 'stable-client-id' };
  assert.equal((await client.call('conversations.runPrompt', ['native-id', content, options])).stopReason, 'end_turn');
  assert.equal((await client.call('conversations.requestEntries', ['native-id', { resultScope: 'page' }])).historyReady, true);
  await client.call('conversations.resolvePending', ['native-id', 'approval-id', { optionId: 'allow_once' }]);
  await client.call('conversations.cancel', ['native-id']);
  assert.deepEqual(JSON.parse(JSON.stringify(calls.filter(c => c[0] !== 'get'))), [
    ['model', 'deepseek-v4.1-flash'], ['prompt', content, options], ['history', { resultScope: 'page' }],
    ['approval', 'approval-id', { optionId: 'allow_once' }], ['cancel'],
  ]);
});
test('top-level model, inventory and creation methods preserve the SDK receiver and arguments', async () => {
  const { client, calls } = desktop();
  assert.equal((await client.call('models.list', [{ scope: 'conversation' }]))[0].id, 'deepseek-v4.1-flash');
  assert.equal((await client.call('conversations.local.list', [{ page: 1 }])).items.length, 0);
  const params = { cwd: 'C:\\Projects\\WorkBuddy', model: 'deepseek-v4.1-flash' };
  assert.equal((await client.call('conversations.create', [params])).info.id, 'created-id');
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [['create', params]]);
});
test('desktop transport never forwards arbitrary configuration or shell methods', async () => {
  const { client, calls } = desktop();
  await assert.rejects(client.call('config.setPreference', ['localTaskPermissionMode', 'full-access']), { code: 'invalid_request' });
  await assert.rejects(client.call('shell.exec', ['anything']), { code: 'invalid_request' });
  assert.equal(calls.length, 0);
});
