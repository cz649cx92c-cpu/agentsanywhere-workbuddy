'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { planInstall, apply, uninstall } = require('../scripts/install-core.cjs');
function fixture(work) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-wb-install-'));
  const root = path.join(temp, 'repo with spaces'), connector = path.join(temp, 'connector');
  function write(file, content) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); }
  const registry = 'from connector.runtimes.dsh.provider import DshProvider\n\ndef default_runtime_providers():\n    return (CodexProvider(), ClaudeProvider(), DshProvider())\n';
  write(path.join(connector, 'runtimes', 'providers.py'), registry);
  write(path.join(connector, 'server', 'protocol.py'), 'RuntimeName = Literal["codex", "claude", "dsh"]\n');
  write(path.join(connector, 'runtime_protocol', 'supervisor.py'), '# fixture');
  for (const name of ['__init__.py', 'bridge.py', 'projection.py', 'provider.py', 'runtime.py']) write(path.join(root, 'connector', 'workbuddy', name), '# adapter ' + name);
  const app = path.join(temp, 'WorkBuddy', 'WorkBuddyAI.exe');
  write(app, 'fixture'); write(path.join(temp, 'WorkBuddy', 'resources', 'app.asar'), 'fixture');
  const workspace = path.join(temp, 'Project with spaces'); fs.mkdirSync(workspace);
  const config = { workbuddyExe: app, workspace, nodePath: process.execPath, stateDir: path.join(temp, 'state'), connectorPaths: [connector], monitorMode: 'off' };
  try { return work({ temp, root, connector, config, registry }); }
  finally { fs.rmSync(temp, { recursive: true, force: true }); }
}
test('preflight makes no changes, install is repeatable, uninstall restores exact originals', () => fixture(({ root, connector, config, registry }) => {
  const plan = planInstall(config, root);
  assert.equal(fs.existsSync(path.join(root, 'config.local.json')), false);
  assert.equal(fs.readFileSync(path.join(connector, 'runtimes', 'providers.py'), 'utf8'), registry);
  apply(plan);
  const packageConfig = JSON.parse(fs.readFileSync(path.join(connector, 'runtimes', 'workbuddy', 'installation.json')));
  assert.equal(packageConfig.workspace, config.workspace);
  assert.equal(packageConfig.helperPath, path.join(root, 'bridge', 'client.cjs'));
  apply(planInstall(config, root));
  const text = fs.readFileSync(path.join(connector, 'runtimes', 'providers.py'), 'utf8');
  assert.equal(text.match(/WorkBuddyProvider\(\)/g).length, 1);
  uninstall(root, true); assert.equal(fs.existsSync(path.join(root, 'config.local.json')), true);
  uninstall(root);
  assert.equal(fs.readFileSync(path.join(connector, 'runtimes', 'providers.py'), 'utf8'), registry);
  assert.equal(fs.existsSync(path.join(connector, 'runtimes', 'workbuddy', 'runtime.py')), false);
}));
test('uninstall and reinstall refuse files changed by an upstream update before touching others', () => fixture(({ root, connector, config }) => {
  apply(planInstall(config, root));
  const protocol = path.join(connector, 'server', 'protocol.py'); fs.appendFileSync(protocol, '# upstream change');
  const registryFile = path.join(connector, 'runtimes', 'providers.py'), before = fs.readFileSync(registryFile, 'utf8');
  assert.throws(() => uninstall(root), /changed file/);
  assert.throws(() => planInstall(config, root), /changed outside/);
  assert.equal(fs.readFileSync(registryFile, 'utf8'), before);
}));
test('an unknown Connector layout fails during preflight without writing files', () => fixture(({ root, connector, config, registry }) => {
  fs.writeFileSync(path.join(connector, 'server', 'protocol.py'), 'RuntimeName = something_new\n');
  assert.throws(() => planInstall(config, root), /Unknown RuntimeName/);
  assert.equal(fs.readFileSync(path.join(connector, 'runtimes', 'providers.py'), 'utf8'), registry);
  assert.equal(fs.existsSync(path.join(root, 'config.local.json')), false);
}));
test('partial write failure rolls back every already written file', () => fixture(({ root, connector, config, registry }) => {
  const plan = planInstall(config, root);
  const blocked = path.join(connector, 'not-a-directory'); fs.writeFileSync(blocked, 'block');
  plan.operations[1].path = path.join(blocked, 'cannot-write');
  assert.throws(() => apply(plan));
  assert.equal(fs.readFileSync(path.join(connector, 'runtimes', 'providers.py'), 'utf8'), registry);
  assert.equal(fs.existsSync(path.join(root, '.local', 'install-manifest.json')), false);
}));
test('changing source on upgrade preserves original pre-install files for rollback', () => fixture(({ root, connector, config, registry }) => {
  apply(planInstall(config, root));
  fs.writeFileSync(path.join(root, 'connector', 'workbuddy', 'runtime.py'), '# version 2');
  apply(planInstall(config, root));
  assert.equal(fs.readFileSync(path.join(connector, 'runtimes', 'workbuddy', 'runtime.py'), 'utf8'), '# version 2');
  uninstall(root);
  assert.equal(fs.readFileSync(path.join(connector, 'runtimes', 'providers.py'), 'utf8'), registry);
}));
