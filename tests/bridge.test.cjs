'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { _test: api } = require('../bridge/server/index.cjs');
const { request } = require('../bridge/client.cjs');
const WORKSPACE = require('../bridge/config.cjs').load().workspace;
function fakeWb() {
  const counts = {}, sessions = new Map(), messages = new Map(), pending = new Map();
  let finishPrompt;
  const record = key => { counts[key] = (counts[key] || 0) + 1; };
  const snapshot = id => ({ info: sessions.get(id), configManager: { model: 'model-a' } });
  sessions.set('native-existing', { id: 'native-existing', cwd: WORKSPACE, title: '真实中文会话', state: 'idle', updatedAt: Date.now() });
  sessions.set('native-outside', { id: 'native-outside', cwd: 'D:\\Other', title: 'Outside', state: 'idle', updatedAt: Date.now() });
  messages.set('native-existing', [{ id: 'request-1', state: 'completed', userMessage: { content: [{ type: 'text', text: '原生问题' }] }, assistantMessage: { content: [{ type: 'text', text: '原生回答' }] } }]);
  return { counts, pending, messages, sessions, finish: () => finishPrompt?.({}), wb: {
    models: { async list() { return { items: [{ id: 'model-a', name: 'Model A', apiKey: 'SHOULD_NOT_LEAK' }] }; } },
    conversations: {
      local: { async list() { return { items: [...sessions.values()], total: sessions.size }; } },
      async get(id) { record('get'); return sessions.has(id) ? snapshot(id) : undefined; },
      async create(params) { record('create'); sessions.set(params.conversationId, { id: params.conversationId, cwd: params.cwd, title: params.title, state: 'idle', updatedAt: Date.now() }); return snapshot(params.conversationId); },
      async requestEntries(id) { return { requests: messages.get(id) || [], historyReady: true, hasOlder: false }; },
      async getPendingInfo(id) { return pending.get(id); },
      async configSetModel() { record('model'); },
      runPrompt(id, content, options) { assert.equal(Array.isArray(content), true, 'Native SDK requires content blocks, not a string'); assert.deepEqual(content.map(block => Object.keys(block).sort()), content.map(() => ['text', 'type'])); assert.equal(content.every(block => block.type === 'text' && typeof block.text === 'string'), true); const requestId = options._meta['codebuddy.ai/conversationRequestId']; assert.match(requestId, /^[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$/); record('send'); messages.set(id, [{ id: requestId, state: 'streaming', userMessage: { content }, assistantMessage: { state: 'streaming', content: [{ type: 'text', text: '进行中' }] } }]); return new Promise(resolve => { finishPrompt = resolve; }); },
      async cancel() { record('interrupt'); finishPrompt?.({}); },
      async resolvePending(id) { record('respond'); pending.delete(id); },
    },
  } };
}

test('authenticated named pipe supports native sessions and denies unauthenticated clients', async t => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-aa-test-'));
  const endpoint = '\\\\.\\pipe\\agents-anywhere-workbuddy-test-' + crypto.randomBytes(10).toString('hex');
  const fake = fakeWb();
  const service = await api.start(fake.wb, { stateDir, endpoint });
  const options = { endpointFile: path.join(stateDir, 'endpoint.json') };
  t.after(async () => { fake.finish(); await service.dispose(); fs.rmSync(stateDir, { recursive: true, force: true }); });
  const call = (action, params = {}) => request({ action, params }, 5000, options);

  await t.test('probe and models return only normalized safe fields', async () => {
    assert.equal((await call('probe')).result.available, true);
    const models = await call('models');
    assert.deepEqual(models.result.models, [{ id: 'model-a', title: 'Model A' }]);
    assert.equal(JSON.stringify(models).includes('SHOULD_NOT_LEAK'), false);
  });
  await t.test('inventory and history retain real IDs but filter foreign workspaces', async () => {
    const result = await call('list', { cwd: WORKSPACE });
    assert.equal(result.result.sessions.length, 1);
    assert.equal(result.result.sessions[0].title, '真实中文会话');
    assert.match(result.result.sessions[0].updatedAt, /^\d{4}-\d\d-/);
    const history = await call('get', { id: 'native-existing', cwd: WORKSPACE });
    assert.deepEqual(history.result.messages.map(row => row.text), ['原生问题', '原生回答']);
    assert.equal(history.result.messages[0].status, 'done');
    assert.equal((await call('get', { id: 'native-outside', cwd: WORKSPACE })).error.code, 'workspace_forbidden');
  });
  await t.test('create and send use native API exactly once despite replay', async () => {
    const params = { cwd: WORKSPACE, title: '新建', clientMessageId: 'create-message', model: 'model-a' };
    const created = await call('create', params), again = await call('create', params);
    assert.equal(created.result.id, again.result.id);
    assert.equal(fake.counts.create, 1);
    const sent = { id: created.result.id, cwd: WORKSPACE, text: '回复即可', clientMessageId: 'send-message', model: 'model-a' };
    assert.equal((await call('send', sent)).result.accepted, true);
    assert.equal((await call('send', sent)).result.accepted, true);
    assert.equal(fake.counts.send, 1);
    const streaming = await call('get', { id: created.result.id, cwd: WORKSPACE });
    assert.equal(streaming.result.info.state, 'running');
    assert.equal(streaming.result.messages[0].clientMessageId, 'send-message');
    assert.notEqual(streaming.result.messages[0].id, 'send-message:user');
    const afterRestart = await api.createHandler(fake.wb, stateDir)({ action: 'get', params: { id: created.result.id, cwd: WORKSPACE } });
    assert.equal(afterRestart.result.messages[0].clientMessageId, 'send-message');
    const nativeRow = fake.messages.get(created.result.id)[0];
    nativeRow.userMessage.content = [{ type: 'text', text: 'changed native content' }];
    const changed = await call('get', { id: created.result.id, cwd: WORKSPACE });
    assert.equal(changed.result.messages[0].clientMessageId, undefined);
    const clash = await call('send', { ...sent, text: 'different' });
    assert.equal(clash.error.code, 'invalid_request');
    fake.finish();
  });
  await t.test('pending is awaited and only native current actions may be answered', async () => {
    fake.pending.set('native-existing', { id: 'approval-1', options: [{ optionId: 'allow_once', name: '仅一次' }] });
    const data = await call('get', { id: 'native-existing', cwd: WORKSPACE });
    assert.equal(data.result.info.state, 'waiting_approval');
    assert.deepEqual(data.result.pending[0].actions, [{ actionId: 'allow_once', label: '仅一次' }]);
    assert.equal((await call('respond', { id: 'native-existing', cwd: WORKSPACE, noticeId: 'approval-1', actionId: 'invented' })).error.code, 'invalid_params');
    assert.equal((await call('respond', { id: 'native-existing', cwd: WORKSPACE, noticeId: 'approval-1', actionId: 'allow_once' })).result.ok, true);
    assert.equal(fake.counts.respond, 1);
  });
  await t.test('foreign workspace and arbitrary RPC actions are rejected', async () => {
    assert.equal((await call('create', { cwd: 'D:\\Other', clientMessageId: 'foreign' })).error.code, 'workspace_forbidden');
    assert.equal((await call('invoke', { channel: 'shell.exec' })).error.code, 'invalid_request');
  });
  await t.test('wrong ticket cannot authenticate the server', async () => {
    const address = JSON.parse(fs.readFileSync(options.endpointFile, 'utf8'));
    const wrongFile = path.join(stateDir, 'wrong.json');
    fs.writeFileSync(wrongFile, JSON.stringify({ ...address, ticket: crypto.randomBytes(32).toString('base64url') }));
    await assert.rejects(request({ action: 'probe' }, 5000, { endpointFile: wrongFile }), error => error.code === 'authentication_failed');
  });
  await t.test('unauthenticated request is closed without invoking a native method', async () => {
    const before = { ...fake.counts };
    await new Promise((resolve, reject) => {
      const socket = net.connect(endpoint);
      const timer = setTimeout(() => { socket.destroy(); reject(new Error('unauthenticated socket remained open')); }, 1500);
      socket.on('connect', () => socket.write(JSON.stringify({ type: 'request', id: 'bad', input: { action: 'create', params: { cwd: WORKSPACE } } }) + '\n'));
      socket.on('error', () => {});
      socket.on('close', () => { clearTimeout(timer); resolve(); });
    });
    assert.deepEqual(fake.counts, before);
  });
});

test('persistent native mutation ledger prevents restart duplication and leaves unknown results blocked', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-aa-ledger-test-'));
  const fake = fakeWb();
  try {
    const input = { action: 'create', params: { cwd: WORKSPACE, title: 'Persistent', clientMessageId: 'persistent' } };
    const first = await api.createHandler(fake.wb, dir)(input);
    const second = await api.createHandler(fake.wb, dir)(input);
    assert.equal(first.result.id, second.result.id);
    assert.equal(fake.counts.create, 1);
    fake.wb.conversations.create = async () => { throw new Error('lost native response'); };
    const lost = { action: 'create', params: { cwd: WORKSPACE, title: 'Uncertain', clientMessageId: 'lost' } };
    assert.equal((await api.createHandler(fake.wb, dir)(lost)).ok, false);
    assert.equal((await api.createHandler(fake.wb, dir)(lost)).error.code, 'outcome_unknown');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('history pages merge oldest to newest, deduplicate overlaps, and retain the newest snapshot', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-aa-history-test-'));
  const fake = fakeWb(), calls = [];
  const row = (id, text) => ({ id, state: 'completed', userMessage: { content: text } });
  fake.wb.conversations.requestEntries = async (id, query) => {
    calls.push(query);
    if (!query.beforeRequestId) return { requests: [row('r3', 'newest'), row('r4', 'last')], hasOlder: true, historyReady: true };
    if (query.beforeRequestId === 'r3') return { requests: [row('r2', 'middle'), row('r3', 'stale overlap')], hasOlder: true, historyReady: true };
    return { requests: [row('r1', 'first')], hasOlder: false, historyReady: true };
  };
  try {
    const result = await api.createHandler(fake.wb, dir)({ action: 'get', params: { id: 'native-existing', cwd: WORKSPACE } });
    assert.equal(result.ok, true);
    assert.deepEqual(result.result.messages.map(message => message.text), ['first', 'middle', 'newest', 'last']);
    assert.equal(result.result.complete, true);
    assert.equal(result.result.diagnostics.history.pages, 3);
    assert.equal(result.result.diagnostics.history.requestCount, 4);
    assert.equal(calls.every(query => query.resultScope === 'page'), true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('safe read diagnostics identify stages without exposing native errors or message content', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-aa-diagnostic-test-'));
  const fake = fakeWb(), input = { action: 'get', params: { id: 'native-existing', cwd: WORKSPACE } };
  const handle = api.createHandler(fake.wb, dir);
  try {
    fake.wb.conversations.getPendingInfo = async () => { throw Object.assign(new TypeError('Cannot serialize TOP_SECRET_NATIVE_TOKEN'), { code: 'TOP_SECRET_NATIVE_CODE' }); };
    const pending = await handle(input);
    assert.equal(pending.error.stage, 'get.pending');
    assert.equal(pending.error.diagnostic.type, 'TypeError');
    assert.equal(pending.error.diagnostic.category, 'serialization');
    assert.equal(JSON.stringify(pending).includes('TOP_SECRET'), false);
    fake.wb.conversations.getPendingInfo = async () => undefined;
    fake.wb.conversations.requestEntries = async () => ({ requests: [null], hasOlder: false, historyReady: true, secret: 'SHOULD_NOT_LEAK' });
    const history = await handle(input);
    assert.equal(history.error.stage, 'get.history.schema');
    assert.equal(history.error.code, 'invalid_native_response');
    assert.equal(history.error.schema.fields.requests, 'array');
    assert.equal(JSON.stringify(history).includes('SHOULD_NOT_LEAK'), false);
    fake.wb.conversations.requestEntries = async () => ({ requests: [], hasOlder: true, historyReady: false });
    const hydrating = await handle(input);
    assert.equal(hydrating.result.complete, false);
    assert.deepEqual(hydrating.result.messages, []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('message projection includes visible text and suppresses reasoning, thinking, and tool payloads', () => {
  const messages = api.normalizeMessages({ requests: [{ id: 'native-request', userMessage: { type: 'text', content: [{ type: 'input_text', text: 'question' }] }, assistantMessage: { type: 'text', content: [
    { type: 'thinking', text: 'PRIVATE_THINKING' },
    { type: 'reasoning', content: [{ type: 'text', text: 'PRIVATE_REASONING' }] },
    { type: 'reasoning_text', text: 'PRIVATE_REASONING_TEXT' },
    { type: 'tool', text: 'PRIVATE_TOOL', content: [{ type: 'text', text: 'PRIVATE_NESTED_TOOL' }] },
    { type: 'resource', text: 'PRIVATE_RESOURCE' },
    { type: 'unknown', text: 'PRIVATE_UNKNOWN' },
    { type: 'text', text: 'answer' }, { type: 'output_text', text: 'continued' },
  ] } }] });
  assert.deepEqual(messages.map(message => message.text), ['question', 'answer\ncontinued']);
  assert.equal(JSON.stringify(messages).includes('PRIVATE_'), false);
});
