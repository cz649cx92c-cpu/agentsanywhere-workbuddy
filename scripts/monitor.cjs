'use strict';
// Local health checks only. No server credentials, prompts, or worker termination.
const fs = require('node:fs'), path = require('node:path');
async function check({ request, repair, mode = 'check' }) {
  async function probe() {
    const response = await request({ action: 'probe' }, 3000);
    if (!response.ok || response.result?.available !== true) throw new Error('bridge_unavailable');
    const models = await request({ action: 'models' }, 10000);
    if (!models.ok || !Array.isArray(models.result?.models) || !models.result.models.length) throw new Error('models_unavailable');
    return { available: true, version: response.result.version, modelCount: models.result.models.length };
  }
  try { return { ...await probe(), repaired: false }; }
  catch {
    if (mode !== 'repair') return { available: false, repaired: false, reason: 'bridge_or_models_unavailable' };
    try {
      const result = await repair();
      if (!result.ready) return { available: false, repaired: false, reason: result.busy ? 'launcher_busy' : 'start_workbuddy_with_bridge_shortcut' };
      return { ...await probe(), repaired: true };
    } catch { return { available: false, repaired: false, reason: 'bridge_repair_failed' }; }
  }
}
function save(dir, result) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'monitor-status.json');
  let old; try { old = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  const status = { ...result, checkedAt: new Date().toISOString(), scope: 'local-bridge-and-models' };
  fs.writeFileSync(file, JSON.stringify(status, null, 2));
  if (old?.available !== status.available || old?.reason !== status.reason) {
    const log = path.join(dir, 'monitor.log');
    if (fs.existsSync(log) && fs.statSync(log).size > 256 * 1024) fs.renameSync(log, path.join(dir, 'monitor.previous.log'));
    fs.appendFileSync(log, JSON.stringify(status) + '\n');
  }
  return status;
}
async function main() {
  const { load, ROOT } = require('../bridge/config.cjs'), config = load();
  let mode = 'check';
  const scheduled = process.argv.includes('--scheduled');
  if (scheduled) {
    try { mode = JSON.parse(fs.readFileSync(path.join(ROOT, '.local', 'monitor.json'), 'utf8').replace(/^\uFEFF/, '')).mode; }
    catch { mode = 'off'; }
    if (mode === 'off') return;
  }
  const lock = path.join(config.stateDir, 'monitor.lock');
  fs.mkdirSync(config.stateDir, { recursive: true });
  try { fs.writeFileSync(lock, JSON.stringify({ pid: process.pid }), { flag: 'wx' }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const old = JSON.parse(fs.readFileSync(lock, 'utf8'));
    try { process.kill(old.pid, 0); return; } catch (error) { if (error.code !== 'ESRCH') throw error; }
    fs.unlinkSync(lock); fs.writeFileSync(lock, JSON.stringify({ pid: process.pid }), { flag: 'wx' });
  }
  try {
    const result = await check({ request: require('../bridge/client.cjs').request, repair: () => require('../bridge/launch.cjs').launch({ repairOnly: true }), mode });
    console.log(JSON.stringify(save(config.stateDir, result)));
    process.exitCode = result.available ? 0 : 1;
  } finally { fs.unlinkSync(lock); }
}
exports.check = check; exports.save = save;
if (require.main === module) main().catch(() => { console.error('Local monitoring failed; check installation paths and file permissions.'); process.exitCode = 1; });
