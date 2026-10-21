'use strict';
const { EventEmitter } = require('node:events');
const SAFE_METHODS = new Set([
  'models.list', 'conversations.get', 'conversations.local.list', 'conversations.create',
  'conversations.runPrompt', 'conversations.requestEntries', 'conversations.getPendingInfo',
  'conversations.cancel', 'conversations.configSetModel', 'conversations.resolvePending',
]);
class DesktopCdp extends EventEmitter {
  constructor(socket) {
    super(); this.socket = socket; this.sequence = 0; this.pending = new Map();
    socket.addEventListener('message', event => {
      let message; try { message = JSON.parse(event.data); } catch { return; }
      if (!message.id) return;
      const entry = this.pending.get(message.id); if (!entry) return;
      this.pending.delete(message.id); clearTimeout(entry.timer);
      message.error ? entry.reject(Object.assign(new Error('Desktop debugger request failed'), { code: 'unavailable' })) : entry.resolve(message.result);
    });
    socket.addEventListener('close', () => {
      for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(Object.assign(new Error('WorkBuddy desktop disconnected'), { code: 'unavailable' })); }
      this.pending.clear(); this.emit('disconnected');
    });
  }
  static async connect(port) {
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid local desktop port');
    const response = await fetch('http://127.0.0.1:' + port + '/json/list', { signal: AbortSignal.timeout(3000) });
    const targets = await response.json();
    const pages = targets.filter(t => t.type === 'page' && /^file:/.test(t.url) && /app\.asar\/renderer\/index\.html/.test(t.url));
    if (pages.length !== 1) throw new Error('WorkBuddy main renderer is not ready');
    const url = new URL(pages[0].webSocketDebuggerUrl);
    if (!['ws:'].includes(url.protocol) || !['127.0.0.1', 'localhost'].includes(url.hostname) || Number(url.port) !== port) throw new Error('Unexpected desktop debugger address');
    const socket = new WebSocket(url.href);
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { socket.close(); reject(new Error('Desktop connection timed out')); }, 5000);
      socket.addEventListener('open', () => { clearTimeout(timeout); resolve(); }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timeout); reject(new Error('Desktop connection failed')); }, { once: true });
    });
    const cdp = new DesktopCdp(socket);
    const ready = await cdp.evaluate('({ready:typeof globalThis.wb?.conversations?.get==="function",title:document.title})');
    if (!ready?.ready) { cdp.close(); throw new Error('WorkBuddy native conversation SDK is not ready'); }
    return cdp;
  }
  command(method, params, timeoutMs = 90000) {
    return new Promise((resolve, reject) => {
      if (this.socket.readyState !== WebSocket.OPEN) { reject(Object.assign(new Error('WorkBuddy desktop is unavailable'), { code: 'unavailable' })); return; }
      const id = ++this.sequence;
      const timer = setTimeout(() => { this.pending.delete(id); reject(Object.assign(new Error('Desktop request timed out'), { code: 'unavailable' })); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer }); this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression, timeoutMs) {
    const result = await this.command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, timeoutMs);
    if (result.exceptionDetails) throw Object.assign(new Error('WorkBuddy native operation failed'), { code: 'native_error' });
    return result.result?.value;
  }
  async call(method, args) {
    if (!SAFE_METHODS.has(method)) throw Object.assign(new Error('Desktop method is not permitted'), { code: 'invalid_request' });
    const bound = ['runPrompt', 'requestEntries', 'getPendingInfo', 'cancel', 'resolvePending', 'configSetModel'].includes(method.split('.').at(-1));
    const expression = bound
      ? `(async()=>{const args=${JSON.stringify(args)},handle=await globalThis.wb.conversations.get(args[0]);if(!handle)throw new Error('Conversation is unavailable');const result=await ${method === 'conversations.configSetModel' ? 'handle.configManager.setModel' : 'handle.' + method.split('.').at(-1)}(...args.slice(1));return {value:result===undefined?null:result};})()`
      : `(async()=>{const keys=${JSON.stringify(method.split('.'))};let owner=globalThis.wb;for(const key of keys.slice(0,-1))owner=owner[key];const result=await owner[keys.at(-1)](...${JSON.stringify(args)});return {value:result===undefined?null:result};})()`;
    const result = await this.evaluate(expression, method === 'conversations.runPrompt' ? 30 * 60 * 1000 : 60000);
    return result?.value;
  }
  proxy(version) {
    const call = (name) => (...args) => this.call(name, args);
    return {
      bridgeInfo: { version, transport: 'desktop-debugger', bridgeVersion: '0.2.0' },
      checkReady: () => this.evaluate('typeof globalThis.wb?.conversations?.get==="function"'),
      models: { list: call('models.list') },
      conversations: {
        local: { list: call('conversations.local.list') },
        ...Object.fromEntries(['get', 'create', 'runPrompt', 'requestEntries', 'getPendingInfo', 'cancel', 'configSetModel', 'resolvePending'].map(name => [name, call('conversations.' + name)])),
      },
    };
  }
  close() { this.socket.close(); }
}
exports.DesktopCdp = DesktopCdp;
exports.SAFE_METHODS = SAFE_METHODS;
