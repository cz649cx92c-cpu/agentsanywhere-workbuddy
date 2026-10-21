'use strict';
const fs = require('node:fs'), path = require('node:path'), net = require('node:net');
const { spawn } = require('node:child_process');
const { DesktopCdp } = require('./desktop-cdp.cjs');
const { load } = require('./config.cjs');
const bridge = require('./server/index.cjs');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function main() {
  const config = load(), file = path.join(config.stateDir, 'desktop.json');
  fs.mkdirSync(config.stateDir, { recursive: true });
  const version = require('./asar-read.cjs').version();
  let port, app;
  if (process.argv.includes('--attach')) {
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    port = state.port;
    fs.writeFileSync(file, JSON.stringify({ ...state, hostPid: process.pid, version }));
  } else {
    port = await freePort();
    const env = { ...process.env }; delete env.NODE_OPTIONS; delete env.ELECTRON_RUN_AS_NODE;
    const log = fs.openSync(path.join(config.stateDir, 'desktop.log'), 'a');
    app = spawn(config.workbuddyExe, ['--remote-debugging-address=127.0.0.1', '--remote-debugging-port=' + port], {
      cwd: path.dirname(config.workbuddyExe), env, detached: true, windowsHide: true, stdio: ['ignore', log, log],
    });
    app.once('error', () => { console.error('WorkBuddy could not start'); process.exit(1); });
    fs.closeSync(log);
    fs.writeFileSync(file, JSON.stringify({ port, appPid: app.pid, hostPid: process.pid, version, startedAt: new Date().toISOString() }));
  }
  let cdp;
  for (let attempt = 0; attempt < 90; attempt++) {
    try { cdp = await DesktopCdp.connect(port); break; } catch {}
    if (app && app.exitCode !== null) throw new Error('WorkBuddy exited before its bridge was ready. Close plain WorkBuddy, then use the bridge shortcut.');
    await delay(1000);
  }
  if (!cdp) throw new Error('WorkBuddy bridge not ready; close plain WorkBuddy and use the bridge shortcut.');
  const server = await bridge.start(cdp.proxy(version), { stateDir: config.stateDir });
  console.log(JSON.stringify({ ready: true, version }));
  let stopping = false;
  async function stop() {
    if (stopping) return;
    stopping = true; await server.dispose(); cdp.close(); process.exit(0);
  }
  cdp.once('disconnected', () => { stop().catch(() => process.exit(1)); });
  process.once('SIGTERM', () => { stop().catch(() => process.exit(1)); });
  process.once('SIGINT', () => { stop().catch(() => process.exit(1)); });
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
