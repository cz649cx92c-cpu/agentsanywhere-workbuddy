'use strict';
const fs = require('node:fs'), path = require('node:path');
const { spawn } = require('node:child_process');
const { load } = require('./config.cjs');
const { request } = require('./client.cjs');
const { DesktopCdp } = require('./desktop-cdp.cjs');
async function launch({ repairOnly = false } = {}) {
  const config = load();
  const lock = path.join(config.stateDir, 'launcher.lock');
  fs.mkdirSync(config.stateDir, { recursive: true });
  try { fs.writeFileSync(lock, JSON.stringify({ pid: process.pid }), { flag: 'wx' }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const old = JSON.parse(fs.readFileSync(lock, 'utf8'));
    try { process.kill(old.pid, 0); return { busy: true }; } catch (error) { if (error.code !== 'ESRCH') throw error; }
    fs.unlinkSync(lock); fs.writeFileSync(lock, JSON.stringify({ pid: process.pid }), { flag: 'wx' });
  }
  try {
    try {
      if ((await request({ action: 'probe' }, 2500)).result?.available) {
        if (!repairOnly) {
          const env = { ...process.env }; delete env.NODE_OPTIONS; delete env.ELECTRON_RUN_AS_NODE;
          const child = spawn(config.workbuddyExe, [], { cwd: path.dirname(config.workbuddyExe), env, detached: true, windowsHide: true, stdio: 'ignore' });
          child.on('error', () => {}); child.unref();
        }
        return { ready: true, existing: true };
      }
    } catch {}
    let attach = false;
    try {
      const state = JSON.parse(fs.readFileSync(path.join(config.stateDir, 'desktop.json'), 'utf8'));
      const cdp = await DesktopCdp.connect(state.port); attach = true; cdp.close();
    } catch {}
    if (repairOnly && !attach) return { ready: false, reason: 'No existing WorkBuddy desktop bridge; application was not started.' };
    const env = { ...process.env }; delete env.NODE_OPTIONS; delete env.ELECTRON_RUN_AS_NODE;
    const log = fs.openSync(path.join(config.stateDir, 'bridge.log'), 'a');
    const child = spawn(config.nodePath, [path.join(__dirname, 'host.cjs'), ...(attach ? ['--attach'] : [])], {
      cwd: __dirname, env, detached: true, windowsHide: true, stdio: ['ignore', log, log],
    });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    child.unref(); fs.closeSync(log);
    for (let attempt = 0; attempt < 90; attempt++) {
      try { if ((await request({ action: 'probe' }, 1500)).result?.available) return { ready: true, attached: attach }; } catch {}
      if (child.exitCode !== null) throw new Error('Local bridge exited; see bridge.log.');
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    throw new Error('Bridge not ready; see bridge.log.');
  } finally {
    try { if (JSON.parse(fs.readFileSync(lock, 'utf8')).pid === process.pid) fs.unlinkSync(lock); } catch {}
  }
}
exports.launch = launch;
if (require.main === module) launch().then(result => { console.log(JSON.stringify(result)); }).catch(error => { console.error(error.message); process.exitCode = 1; });
