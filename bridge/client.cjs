'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const crypto = require('node:crypto');
const { StringDecoder } = require('node:string_decoder');
const MUTATIONS = new Set(['create', 'send', 'interrupt', 'respond']);
function fail(code, message) { return Object.assign(new Error(message || code), { code }); }
function proof(ticket, role, endpoint, clientNonce, serverNonce) {
  return crypto.createHmac('sha256', ticket).update(JSON.stringify(['aa-workbuddy-v1', role, endpoint, clientNonce, serverNonce])).digest('base64url');
}
function request(input, timeoutMs = 90000, options = {}) {
  return new Promise((resolve, reject) => {
    const endpointFile = options.endpointFile || path.join(require('./config.cjs').load().stateDir, 'endpoint.json');
    let address;
    try { address = JSON.parse(fs.readFileSync(endpointFile, 'utf8')); }
    catch { reject(fail('not_running', 'Start WorkBuddy using the Agents Anywhere bridge shortcut')); return; }
    const { endpoint, ticket } = address;
    if (address.version !== 1 || typeof endpoint !== 'string' || !endpoint.startsWith('\\\\.\\pipe\\agents-anywhere-workbuddy-') || typeof ticket !== 'string' || ticket.length < 32) {
      reject(fail('invalid_endpoint', 'Unexpected WorkBuddy extension endpoint')); return;
    }
    const clientNonce = crypto.randomBytes(24).toString('base64url'), id = crypto.randomUUID(), decoder = new StringDecoder('utf8');
    let serverNonce, buffer = '', settled = false, submitted = false, phase = 'challenge';
    const socket = net.connect(endpoint);
    const timer = setTimeout(() => finish(fail(submitted && MUTATIONS.has(input?.action) ? 'outcome_unknown' : 'unavailable', 'WorkBuddy did not confirm the request; refresh before resubmitting')), timeoutMs);
    function finish(error, value) { if (settled) return; settled = true; clearTimeout(timer); socket.destroy(); error ? reject(error) : resolve(value); }
    function send(value) { socket.write(JSON.stringify(value) + '\n'); }
    socket.on('connect', () => send({ type: 'hello', version: 1, nonce: clientNonce }));
    socket.on('data', chunk => {
      buffer += decoder.write(chunk);
      if (Buffer.byteLength(buffer) > 32 * 1024 * 1024) { finish(fail(submitted && MUTATIONS.has(input?.action) ? 'outcome_unknown' : 'invalid_response', 'WorkBuddy response exceeded the limit')); return; }
      for (;;) {
        const index = buffer.indexOf('\n'); if (index < 0) break;
        let value; try { value = JSON.parse(buffer.slice(0, index)); } catch { finish(fail(submitted && MUTATIONS.has(input?.action) ? 'outcome_unknown' : 'invalid_response', 'Invalid WorkBuddy response')); return; }
        buffer = buffer.slice(index + 1);
        if (phase === 'challenge' && value.type === 'challenge' && typeof value.nonce === 'string') {
          serverNonce = value.nonce;
          const expected = Buffer.from(proof(ticket, 'server', endpoint, clientNonce, serverNonce)), actual = Buffer.from(String(value.proof || ''));
          if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) { finish(fail('authentication_failed', 'WorkBuddy extension authentication failed')); return; }
          phase = 'ready'; send({ type: 'prove', proof: proof(ticket, 'client', endpoint, clientNonce, serverNonce) });
        } else if (phase === 'ready' && value.type === 'ready' && value.version === 1) {
          phase = 'response'; submitted = true; send({ type: 'request', id, input });
        } else if (phase === 'response' && value.type === 'response' && value.id === id && typeof value.result?.ok === 'boolean') {
          finish(null, value.result); return;
        } else { finish(fail(submitted && MUTATIONS.has(input?.action) ? 'outcome_unknown' : 'invalid_response', 'Unexpected WorkBuddy extension response')); return; }
      }
    });
    socket.on('error', () => finish(fail(submitted && MUTATIONS.has(input?.action) ? 'outcome_unknown' : 'not_running', 'Cannot connect to the WorkBuddy extension')));
    socket.on('close', () => { if (!settled) finish(fail(submitted && MUTATIONS.has(input?.action) ? 'outcome_unknown' : 'unavailable', 'WorkBuddy closed before confirming the request')); });
  });
}
exports.request = request;
if (require.main === module) {
  let raw = ''; process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { raw += chunk; if (Buffer.byteLength(raw) > 200000) process.exit(2); });
  process.stdin.on('end', async () => {
    try { process.stdout.write(JSON.stringify(await request(JSON.parse(raw))) + '\n'); }
    catch (error) { process.stdout.write(JSON.stringify({ ok: false, error: { code: error.code || 'invalid_request', message: error.message || 'WorkBuddy request failed' } }) + '\n'); process.exitCode = 1; }
  });
}
