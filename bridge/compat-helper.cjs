'use strict';
const { request } = require('./client.cjs');
async function dispatch(input) {
  const strategy = input.params?._aaStrategy;
  if (strategy === 'version') return { ok: true, result: { version: require('./asar-read.cjs').version() } };
  if (!['extension', 'desktop-cdp'].includes(strategy)) throw new Error('Unsupported transport');
  const params = { ...input.params }; delete params._aaStrategy;
  const probe = await request({ action: 'probe' }, 5000);
  const expected = strategy === 'extension' ? 'extension' : 'desktop-debugger';
  if (!probe.ok || !probe.result?.available || probe.result.version !== require('./asar-read.cjs').version() || probe.result.transport !== expected) {
    throw new Error('Desktop bridge not ready for this WorkBuddy version');
  }
  return input.action === 'probe' ? probe : request({ action: input.action, params });
}
if (require.main === module) {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', value => { raw += value; if (Buffer.byteLength(raw) > 200000) process.exit(2); });
  process.stdin.on('end', async () => {
    let input;
    try { input = JSON.parse(raw); console.log(JSON.stringify(await dispatch(input))); }
    catch {
      const uncertain = ['create', 'send', 'interrupt', 'respond'].includes(input?.action);
      console.log(JSON.stringify({ ok: false, error: { code: uncertain ? 'outcome_unknown' : 'unavailable', message: 'Native desktop transport unavailable' } }));
      process.exitCode = 1;
    }
  });
}
exports.dispatch = dispatch;
