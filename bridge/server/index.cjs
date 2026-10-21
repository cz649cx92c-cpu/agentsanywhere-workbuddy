'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const crypto = require('node:crypto');
const { StringDecoder } = require('node:string_decoder');

const WORKSPACE = require('../config.cjs').load().workspace;
const ACTIONS = new Set(['probe', 'models', 'list', 'get', 'create', 'send', 'interrupt', 'notices', 'respond']);
const LIMIT = 32 * 1024 * 1024;
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
function fail(code, message) { throw Object.assign(new Error(message || code), { code }); }
function allowed(value) { return typeof value === 'string' && path.win32.isAbsolute(value) && path.win32.normalize(value).toLowerCase() === WORKSPACE.toLowerCase(); }
function assertCwd(value) { if (!allowed(value)) fail('workspace_forbidden', 'Session is outside the configured workspace'); }
function atomic(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(tmp, file);
}
function proof(ticket, role, endpoint, clientNonce, serverNonce) {
  return crypto.createHmac('sha256', ticket).update(JSON.stringify(['aa-workbuddy-v1', role, endpoint, clientNonce, serverNonce])).digest('base64url');
}
function equal(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}
function kind(value) { return value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value; }
function safeShape(value, fields) {
  const result = { kind: kind(value) };
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    result.fields = Object.fromEntries(fields.filter(key => Object.hasOwn(value, key)).map(key => [key, kind(value[key])]));
  }
  return result;
}
function safeError(error) {
  const names = new Set(['Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'DOMException']);
  const codes = new Set(['PERMISSION_DENIED', 'METHOD_NOT_FOUND', 'CONVERSATION_NOT_FOUND', 'ERR_INVALID_ARG_TYPE', 'ERR_INVALID_ARG_VALUE', 'ERR_IPC_CHANNEL_CLOSED', 'ERR_IPC_DISCONNECTED', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOENT']);
  const message = typeof error?.message === 'string' ? error.message.toLowerCase() : '';
  const category = /permission|not authorized|access denied/.test(message) ? 'permission' : /not a function|method.*not found|unknown.*method/.test(message) ? 'missing_method' : /serializ|could not be cloned|cannot.*clone/.test(message) ? 'serialization' : /not found|does not exist/.test(message) ? 'not_found' : /timed? ?out|timeout/.test(message) ? 'timeout' : 'native_failure';
  return { type: names.has(error?.name) ? error.name : 'Error', category, ...(codes.has(error?.code) ? { nativeCode: error.code } : {}), signature: hash([error?.name, error?.code, error?.message]).slice(0, 16) };
}
async function atStage(stage, work, schema) {
  try { return await work(); }
  catch (value) {
    const error = value instanceof Error ? value : new Error('Native operation rejected');
    if (!error.bridgeStage) error.bridgeStage = stage;
    if (schema) error.bridgeSchema = schema;
    throw error;
  }
}
function textOf(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(textOf).filter(Boolean).join('\n');
  if (typeof value !== 'object') return '';
  // Only user-visible text blocks and message envelopes may contribute text.
  // A thinking/tool block can also contain `.text` or nested text content.
  if (value.type !== undefined && !['text', 'input_text', 'output_text', 'message'].includes(value.type)) return '';
  if (['text', 'input_text', 'output_text'].includes(value.type) && typeof value.text === 'string') return value.text;
  if (value.content !== undefined) return textOf(value.content);
  if (value.message !== undefined) return textOf(value.message);
  return '';
}
function newNativeRequestId() {
  const bytes = crypto.randomBytes(16);
  let time = Date.now();
  for (let i = 5; i >= 0; i--) { bytes[i] = time % 256; time = Math.floor(time / 256); }
  bytes[6] = (bytes[6] & 15) | 112;
  bytes[8] = (bytes[8] & 63) | 128;
  return bytes.toString('hex');
}
function timestamp(value) {
  const parsed = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}
function normalizedState(raw, active) {
  if (['pending', 'waiting_permission', 'waiting_approval', 'waitingForUserInput'].includes(raw)) return 'waiting_approval';
  if (active || ['planning', 'working', 'streaming', 'running', 'preparing'].includes(raw)) return 'running';
  if (['error', 'failed'].includes(raw)) return 'error';
  if (raw === 'stopping') return 'stopping';
  return 'idle';
}
function infoOf(value, active = false) {
  const info = value.info || value;
  return { id: info.id, title: info.title || 'WorkBuddy', cwd: info.space?.cwd || info.cwd,
    state: normalizedState(info.state || info.status, active), updatedAt: timestamp(info.lastActivityAt || info.updatedAt || info.createdAt),
    model: value.configManager?.model || info.model };
}
function normalizeMessages(data, clientIds = new Map()) {
  const rows = data?.requests || data?.items || [];
  if (!Array.isArray(rows)) fail('invalid_native_response', 'Invalid native message history');
  const out = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) fail('invalid_native_response', 'Native history contains an invalid request');
    const rid = row.id || row.requestId;
    if (typeof rid !== 'string' || !rid) fail('invalid_native_response', 'Native history has no stable request ID');
    for (const [role, keys] of [['user', ['userMessage', 'prompt', 'userPrompt']], ['assistant', ['assistantMessage', 'assistantMessages', 'response']], ['system', ['systemMessage']]]) {
      const value = keys.map(key => row[key]).find(value => value !== undefined), text = textOf(value);
      if (!text) continue;
      const raw = value?.state || row.state;
      const status = role === 'user' ? 'done' : ['streaming', 'running', 'working'].includes(raw) ? 'running' : ['error', 'failed'].includes(raw) ? 'failed' : ['cancelled', 'interrupted'].includes(raw) ? 'interrupted' : 'done';
      const mapping = clientIds.get(rid);
      const clientMessageId = typeof row.clientRequestId === 'string' ? row.clientRequestId : mapping && mapping.promptFingerprint === hash(text) ? mapping.clientMessageId : undefined;
      out.push({ id: `${rid}:${role}`, role, text, status, ...(role === 'user' && clientMessageId ? { clientMessageId } : {}) });
    }
  }
  return out;
}
function normalizePending(pending) {
  if (!pending) return [];
  const id = pending.matchId || pending.toolCallId || pending.id;
  if (typeof id !== 'string' || !id) fail('invalid_native_response', 'Native approval has no stable ID');
  return [{ id, title: pending.title || 'WorkBuddy approval', message: pending.description || '', interactionType: 'approval',
    actions: (pending.options || []).map(option => ({ actionId: option.optionId || option.id, label: option.name || option.label || option.optionId || option.id })) }];
}

function createHandler(wb, stateDir) {
  const ledgerPath = path.join(stateDir, 'operations.json');
  let ledger = {};
  try { ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const active = new Map(), save = () => atomic(ledgerPath, ledger);
  let mutationTail = Promise.resolve();
  function serial(fn) { const result = mutationTail.then(fn, fn); mutationTail = result.catch(() => {}); return result; }
  function operation(key, body) {
    const fingerprint = hash(body), old = ledger[key];
    if (old) { if (old.fingerprint !== fingerprint) fail('invalid_request', 'The clientMessageId was reused with different input'); return { old }; }
    ledger[key] = { fingerprint, state: 'pending', createdAt: Date.now() }; save(); return { entry: ledger[key] };
  }
  async function getNative(id) {
    if (typeof id !== 'string' || !id || id.length > 160) fail('invalid_params', 'A native conversation ID is required');
    const snapshot = await wb.conversations.get(id);
    if (!snapshot || snapshot.errorCode) fail('session_not_found', 'WorkBuddy conversation is unavailable');
    const info = infoOf(snapshot, active.has(id));
    if (info.id !== id) fail('invalid_native_response', 'Native conversation identity differs');
    assertCwd(info.cwd); return { snapshot, info };
  }
  async function readHistory(id) {
    const beforeSeen = new Set(), requests = new Map();
    let data, beforeRequestId, pages = 0, complete = false;
    while (pages < 100) {
      data = await atStage('get.history.page', () => wb.conversations.requestEntries(id, { byteLength: 262144, resultScope: 'page', ...(beforeRequestId ? { beforeRequestId } : {}) }), { pages });
      pages++;
      const schema = { ...safeShape(data, ['requests', 'entries', 'totalRequests', 'hasOlder', 'historyReady', 'historyKnownEmpty']), pages };
      await atStage('get.history.schema', () => {
        if (!data || typeof data !== 'object' || !Array.isArray(data.requests)) fail('invalid_native_response', 'Native history has no request array');
        for (const row of data.requests) {
          if (!row || typeof row.id !== 'string' || !row.id) fail('invalid_native_response', 'Native history has no stable request ID');
        }
      }, schema);
      // Newest page wins if native pagination overlaps or returns cumulative rows.
      const merged = new Map(data.requests.map(row => [row.id, row]));
      for (const [key, row] of requests) merged.set(key, row);
      requests.clear(); for (const [key, row] of merged) requests.set(key, row);
      if (data.historyReady === false) break;
      if (data.hasOlder !== true) { complete = true; break; }
      beforeRequestId = data.requests[0]?.id;
      if (typeof beforeRequestId !== 'string' || beforeSeen.has(beforeRequestId)) break;
      beforeSeen.add(beforeRequestId);
    }
    return { data: { ...data, requests: [...requests.values()], hasOlder: !complete, historyReady: data?.historyReady !== false }, diagnostic: { ...safeShape(data, ['requests', 'entries', 'totalRequests', 'hasOlder', 'historyReady', 'historyKnownEmpty']), pages, requestCount: requests.size, complete, request: safeShape([...requests.values()][0], ['id', 'userMessage', 'assistantMessage', 'systemMessage', 'state', 'timestamp']) } };
  }
  async function dispatch(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || !ACTIONS.has(input.action)) fail('invalid_request', 'Unsupported WorkBuddy bridge action');
    const { action } = input, p = input.params || {};
    if (typeof p !== 'object' || Array.isArray(p)) fail('invalid_params');
    if (p.cwd !== undefined) assertCwd(p.cwd);
    if (action === 'probe') {
      if (wb.checkReady && !(await wb.checkReady())) fail('unavailable', 'WorkBuddy native desktop is unavailable');
      return { available: true, name: 'WorkBuddy', version: wb.bridgeInfo?.version || '5.7.6', bridgeVersion: wb.bridgeInfo?.bridgeVersion || '0.1.0', transport: wb.bridgeInfo?.transport || 'extension', nativeConversations: true, cwd: WORKSPACE };
    }
    if (action === 'models') {
      const value = await wb.models.list({ scope: 'conversation' }), rows = Array.isArray(value) ? value : value?.items || value?.models || [];
      return { models: rows.filter(row => row && typeof row.id === 'string' && !row.disabled).map(row => ({ id: row.id, title: row.name || row.title || row.id })) };
    }
    if (action === 'list') {
      const rows = [], seen = new Set(); let complete = false;
      for (let page = 1; page <= 100; page++) {
        const value = await wb.conversations.local.list({ page, size: 100 }), batch = Array.isArray(value) ? value : value?.items || [];
        if (!Array.isArray(batch)) fail('invalid_native_response');
        for (const row of batch) {
          const id = row.info?.id || row.id;
          if (seen.has(id)) fail('invalid_native_response', 'Native inventory repeated a conversation');
          seen.add(id); const info = infoOf(row, active.has(id)); if (allowed(info.cwd)) rows.push(info);
        }
        const total = value?.total ?? value?.pagination?.total;
        if (Array.isArray(value) || value?.hasMore === false || (Number.isFinite(total) && page * 100 >= total) || batch.length < 100) { complete = true; break; }
      }
      return { sessions: rows, complete };
    }
    if (action === 'create') return serial(async () => {
      assertCwd(p.cwd);
      if (typeof p.clientMessageId !== 'string' || !p.clientMessageId || p.clientMessageId.length > 180) fail('invalid_params', 'A stable clientMessageId is required');
      const { old, entry } = operation('create:' + p.clientMessageId, { cwd: WORKSPACE, title: p.title || 'WorkBuddy', model: p.model || null });
      if (old) { if (old.state === 'complete') return old.result; fail('outcome_unknown', 'Conversation creation is already pending; inspect it before resubmitting'); }
      const id = 'aa-' + hash(p.clientMessageId).slice(0, 40);
      const snapshot = await wb.conversations.create({ conversationId: id, transport: 'local', kind: 'assistant', space: { type: 'local', cwd: WORKSPACE }, cwd: WORKSPACE, title: p.title || 'WorkBuddy', ...(p.model ? { model: p.model } : {}) });
      if (snapshot?.errorCode) fail('outcome_unknown', 'WorkBuddy could not confirm creating the native conversation');
      const result = infoOf(snapshot); assertCwd(result.cwd);
      if (result.id !== id) fail('outcome_unknown', 'WorkBuddy returned a different creation identity');
      entry.state = 'complete'; entry.result = result; save(); return result;
    });
    const id = p.id, native = await atStage(action + '.native', () => getNative(id));
    if (action === 'get' || action === 'notices') {
      const pending = await atStage(action + '.pending', () => wb.conversations.getPendingInfo(id)); if (pending) native.info.state = 'waiting_approval';
      const pendingShape = safeShape(pending, ['id', 'matchId', 'toolCallId', 'category', 'title', 'description', 'options']);
      const history = action === 'get' ? await readHistory(id) : undefined;
      const latest = Object.values(ledger).filter(entry => entry.sessionId === id).at(-1);
      if (latest?.state === 'error' && !active.has(id)) native.info.state = 'error';
      const clientIds = new Map(Object.entries(ledger).filter(([key, entry]) => key.startsWith('send:') && entry.sessionId === id && typeof entry.nativeRequestId === 'string').map(([key, entry]) => [entry.nativeRequestId, { clientMessageId: entry.clientMessageId || key.slice(5), promptFingerprint: entry.promptFingerprint }]));
      const messages = await atStage(action + '.messages', () => normalizeMessages(history?.data, clientIds), history?.diagnostic);
      const notices = await atStage(action + '.pending.normalize', () => normalizePending(pending), pendingShape);
      return { info: native.info, messages, pending: notices, complete: history?.diagnostic.complete ?? true, diagnostics: { pending: pendingShape, ...(history ? { history: history.diagnostic } : {}) } };
    }
    if (action === 'send') return serial(async () => {
      if (typeof p.text !== 'string' || !p.text.trim() || p.text.length > 100000 || typeof p.clientMessageId !== 'string' || !p.clientMessageId || p.clientMessageId.length > 180) fail('invalid_params', 'A prompt and stable clientMessageId are required');
      const old = ledger['send:' + p.clientMessageId];
      if (old) {
        if (old.fingerprint !== hash({ id, text: p.text, model: p.model || null })) fail('invalid_request', 'The clientMessageId was reused with different input');
        if (['accepted', 'complete', 'error'].includes(old.state)) return { accepted: true, status: old.state };
        fail('outcome_unknown', 'Do not repeat a message with an unknown outcome');
      }
      if (active.has(id) || native.info.state === 'running') fail('session_busy', 'WorkBuddy is already running this conversation');
      if (p.model && native.snapshot.configManager?.model !== p.model) {
        const changed = await wb.conversations.configSetModel(id, p.model); if (changed?.errorCode) fail('invalid_params', 'WorkBuddy rejected the selected model');
      }
      const { entry } = operation('send:' + p.clientMessageId, { id, text: p.text, model: p.model || null });
      entry.sessionId = id; entry.clientMessageId = p.clientMessageId; entry.promptFingerprint = hash(p.text); entry.nativeRequestId = newNativeRequestId(); entry.state = 'accepted'; save(); active.set(id, p.clientMessageId);
      const content = [{ type: 'text', text: p.text }];
      Promise.resolve().then(() => wb.conversations.runPrompt(id, content, { clientRequestId: p.clientMessageId, emitUserMessage: true, _meta: { 'codebuddy.ai/conversationRequestId': entry.nativeRequestId } })).then(result => {
        if (typeof result?.requestId === 'string' && result.requestId) entry.nativeRequestId = result.requestId;
        entry.state = result?.errorCode || ['error', 'failed'].includes(result?.state) ? 'error' : 'complete'; entry.errorCode = result?.errorCode; save();
      }, error => { entry.state = 'error'; entry.errorCode = typeof error?.code === 'string' ? error.code : 'native_prompt_failed'; save(); }).finally(() => { if (active.get(id) === p.clientMessageId) active.delete(id); });
      return { accepted: true };
    });
    if (action === 'interrupt') { await wb.conversations.cancel(id); return { ok: true }; }
    if (action === 'respond') return serial(async () => {
      const pending = await wb.conversations.getPendingInfo(id), notice = normalizePending(pending)[0];
      if (!notice || notice.id !== p.noticeId || !notice.actions.some(action => action.actionId === p.actionId)) fail('invalid_params', 'Native approval or action changed');
      const key = 'respond:' + hash([id, p.noticeId, p.actionId]);
      const { old, entry } = operation(key, { id, noticeId: p.noticeId, actionId: p.actionId, inputData: p.inputData || {} });
      if (old) { if (old.state === 'complete') return { ok: true }; fail('outcome_unknown'); }
      await wb.conversations.resolvePending(id, notice.id, { optionId: p.actionId }); entry.state = 'complete'; save(); return { ok: true };
    });
    fail('invalid_request');
  }
  return async input => {
    try { return { ok: true, result: await dispatch(input) }; }
    catch (error) {
      const known = new Set(['invalid_request', 'invalid_params', 'invalid_native_response', 'session_not_found', 'workspace_forbidden', 'outcome_unknown', 'session_busy']);
      const uncertain = ['create', 'send', 'interrupt', 'respond'].includes(input?.action);
      const code = known.has(error?.code) ? error.code : error?.code === 'PERMISSION_DENIED' ? 'permission_denied' : uncertain ? 'outcome_unknown' : 'native_error';
      const message = code === 'native_error' ? 'WorkBuddy native operation failed' : code === 'outcome_unknown' ? 'WorkBuddy could not confirm the operation; refresh and do not automatically resubmit' : String(error.message || code).slice(0, 300);
      return { ok: false, error: { code, message, ...(error?.bridgeStage ? { stage: error.bridgeStage, diagnostic: safeError(error), ...(error.bridgeSchema ? { schema: error.bridgeSchema } : {}) } : {}) } };
    }
  };
}

async function start(wb, options = {}) {
  const configDir = process.env.WORKBUDDY_CONFIG_DIR || process.env.CODEBUDDY_CONFIG_DIR || path.join(os.homedir(), '.workbuddy-ai');
  const stateDir = options.stateDir || path.join(configDir, 'agents-anywhere-bridge');
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const endpoint = options.endpoint || `\\\\.\\pipe\\agents-anywhere-workbuddy-${crypto.randomBytes(12).toString('hex')}`;
  const ticket = crypto.randomBytes(32).toString('base64url'), endpointFile = path.join(stateDir, 'endpoint.json'), handle = createHandler(wb, stateDir);
  const sockets = new Set();
  const server = net.createServer(socket => {
    if (sockets.size >= 32) { socket.destroy(); return; }
    sockets.add(socket); socket.setTimeout(90000, () => socket.destroy());
    const decoder = new StringDecoder('utf8');
    let buffer = '', phase = 'hello', clientNonce, serverNonce, requestSeen = false;
    const send = value => { const line = JSON.stringify(value) + '\n'; if (Buffer.byteLength(line) > LIMIT) { socket.destroy(); return; } socket.write(line); };
    socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket));
    socket.on('data', chunk => {
      buffer += decoder.write(chunk); if (Buffer.byteLength(buffer) > 220000) { socket.destroy(); return; }
      for (;;) {
        const index = buffer.indexOf('\n'); if (index < 0) break;
        let value; try { value = JSON.parse(buffer.slice(0, index)); } catch { socket.destroy(); return; } buffer = buffer.slice(index + 1);
        if (phase === 'hello') {
          if (value.type !== 'hello' || typeof value.nonce !== 'string' || !/^[A-Za-z0-9_-]{20,100}$/.test(value.nonce)) { socket.destroy(); return; }
          clientNonce = value.nonce; serverNonce = crypto.randomBytes(24).toString('base64url'); phase = 'prove';
          send({ type: 'challenge', nonce: serverNonce, proof: proof(ticket, 'server', endpoint, clientNonce, serverNonce) });
        } else if (phase === 'prove') {
          if (value.type !== 'prove' || !equal(value.proof, proof(ticket, 'client', endpoint, clientNonce, serverNonce))) { socket.destroy(); return; }
          phase = 'ready'; send({ type: 'ready', version: 1 });
        } else if (phase === 'ready' && !requestSeen && value.type === 'request' && typeof value.id === 'string') {
          requestSeen = true; handle(value.input).then(result => { send({ type: 'response', id: value.id, result }); socket.end(); }, () => socket.destroy());
        } else { socket.destroy(); return; }
      }
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(endpoint, resolve); });
  atomic(endpointFile, { version: 1, endpoint, ticket, pid: process.pid });
  return { async dispose() {
    for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve));
    try { const current = JSON.parse(fs.readFileSync(endpointFile, 'utf8')); if (current.endpoint === endpoint) fs.unlinkSync(endpointFile); } catch {}
  } };
}
exports.activate = wb => start(wb);
exports.start = start;
exports._test = { start, createHandler, normalizeMessages, normalizePending, infoOf, allowed, proof, textOf };
