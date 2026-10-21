'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const ROOT = path.resolve(__dirname, '..');
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const read = file => fs.existsSync(file) ? fs.readFileSync(file) : null;
const manifestPath = root => path.join(root, '.local', 'install-manifest.json');
function manifest(root) {
  const file = manifestPath(root);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { version: 1, root, files: [] };
}
function json(value) { return Buffer.from(JSON.stringify(value, null, 2) + '\n'); }
function validate(config) {
  for (const key of ['workbuddyExe', 'workspace', 'nodePath', 'stateDir']) {
    if (typeof config[key] !== 'string' || !path.win32.isAbsolute(config[key]) || /[\r\n\0]/.test(config[key])) throw new Error('Expected an absolute Windows path: ' + key);
  }
  for (const key of ['workbuddyExe', 'nodePath']) if (!fs.statSync(config[key]).isFile()) throw new Error('File not found: ' + key);
  if (!fs.statSync(config.workspace).isDirectory()) throw new Error('Workspace must already exist');
  if (!fs.existsSync(path.join(path.dirname(config.workbuddyExe), 'resources', 'app.asar'))) throw new Error('WorkBuddy resources/app.asar was not found next to its EXE');
  if (!Array.isArray(config.connectorPaths) || !config.connectorPaths.length) throw new Error('No Python Connector packages found; bundled binaries are not supported');
  if (!['off', 'check', 'repair'].includes(config.monitorMode)) throw new Error('Invalid monitor mode');
}
function planInstall(config, root = ROOT) {
  validate(config);
  const previous = manifest(root), operations = new Map();
  if (previous.root !== root) throw new Error('Repository moved; uninstall from the original folder before reinstalling');
  function stage(file, after) {
    file = path.resolve(file); after = Buffer.isBuffer(after) ? after : Buffer.from(after);
    const before = read(file), prior = previous.files.find(item => item.path === file);
    if (prior && (before ? digest(before) : null) !== prior.installedHash) throw new Error('Installed file changed outside this installer; restore/review it before updating: ' + file);
    operations.set(file, { path: file, before, after, original: prior ? prior.original : before?.toString('base64') ?? null });
  }
  for (const base of [...new Set(config.connectorPaths.map(p => path.resolve(p)))]) {
    const providersFile = path.join(base, 'runtimes', 'providers.py');
    const protocolFile = path.join(base, 'server', 'protocol.py');
    if (!fs.existsSync(path.join(base, 'runtime_protocol', 'supervisor.py'))) throw new Error('Unsupported Connector package: ' + base);
    let providers = fs.readFileSync(providersFile, 'utf8');
    if (!providers.includes('from connector.runtimes.workbuddy.provider import WorkBuddyProvider')) {
      const anchor = 'from connector.runtimes.dsh.provider import DshProvider';
      if (!providers.includes(anchor)) throw new Error('Unknown provider registry format: ' + base);
      providers = providers.replace(anchor, anchor + '\nfrom connector.runtimes.workbuddy.provider import WorkBuddyProvider');
    }
    if (!providers.includes('DshProvider(), WorkBuddyProvider()')) {
      const anchor = '(CodexProvider(), ClaudeProvider(), DshProvider())';
      if (!providers.includes(anchor)) throw new Error('Unknown provider list format: ' + base);
      providers = providers.replace(anchor, '(CodexProvider(), ClaudeProvider(), DshProvider(), WorkBuddyProvider())');
    }
    let protocol = fs.readFileSync(protocolFile, 'utf8');
    const runtimeName = /^RuntimeName\s*=\s*Literal\[([^\]\r\n]+)\]/m;
    const match = protocol.match(runtimeName);
    if (!match || !match[1].includes('"codex"') || !match[1].includes('"dsh"')) throw new Error('Unknown RuntimeName format: ' + base);
    if (!match[1].includes('"workbuddy"')) protocol = protocol.replace(runtimeName, 'RuntimeName = Literal[' + match[1] + ', "workbuddy"]');
    stage(providersFile, providers); stage(protocolFile, protocol);
    const dest = path.join(base, 'runtimes', 'workbuddy');
    for (const name of ['__init__.py', 'bridge.py', 'projection.py', 'provider.py', 'runtime.py']) stage(path.join(dest, name), fs.readFileSync(path.join(root, 'connector', 'workbuddy', name)));
    stage(path.join(dest, 'installation.json'), json({ nodePath: config.nodePath, helperPath: path.join(root, 'bridge', 'client.cjs'), workspace: path.win32.normalize(config.workspace) }));
  }
  stage(path.join(root, 'config.local.json'), json(config));
  return { root, previous, operations: [...operations.values()] };
}
function apply(plan) {
  const applied = [];
  try {
    for (const item of plan.operations) {
      const now = read(item.path);
      if ((now ? digest(now) : null) !== (item.before ? digest(item.before) : null)) throw new Error('File changed during installation: ' + item.path);
      fs.mkdirSync(path.dirname(item.path), { recursive: true });
      fs.writeFileSync(item.path, item.after); applied.push(item);
    }
    const records = new Map(plan.previous.files.map(item => [item.path, item]));
    for (const item of plan.operations) records.set(item.path, { path: item.path, original: item.original, installedHash: digest(item.after) });
    const file = manifestPath(plan.root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, json({ version: 1, root: plan.root, installedAt: new Date().toISOString(), files: [...records.values()] }));
  } catch (error) {
    for (const item of applied.reverse()) {
      if (item.before) fs.writeFileSync(item.path, item.before);
      else if (fs.existsSync(item.path)) fs.unlinkSync(item.path);
    }
    throw error;
  }
}
function uninstall(root = ROOT, dryRun = false) {
  const record = manifest(root);
  if (record.root !== root) throw new Error('Installation folder does not match manifest');
  // Validate every hash before restoring any file; never overwrite an upstream update.
  for (const item of record.files) {
    const current = read(item.path);
    if ((current ? digest(current) : null) !== item.installedHash) throw new Error('Cannot safely restore a changed file: ' + item.path);
  }
  if (!dryRun) {
    for (const item of record.files) {
      if (item.original === null) fs.unlinkSync(item.path);
      else fs.writeFileSync(item.path, Buffer.from(item.original, 'base64'));
    }
    if (fs.existsSync(manifestPath(root))) fs.renameSync(manifestPath(root), manifestPath(root) + '.' + Date.now() + '.uninstalled');
  }
  return record.files.map(item => item.path);
}
exports.planInstall = planInstall; exports.apply = apply; exports.uninstall = uninstall;
if (require.main === module) {
  try {
    const [action, file] = process.argv.slice(2), dryRun = process.argv.includes('--dry-run');
    if (action === 'uninstall') console.log(JSON.stringify({ dryRun, restored: uninstall(ROOT, dryRun) }));
    else if (action === 'install') {
      const config = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
      const plan = planInstall(config);
      if (!dryRun) apply(plan);
      console.log(JSON.stringify({ dryRun, files: plan.operations.map(item => item.path), monitorMode: config.monitorMode }));
    } else throw new Error('Expected install <config-file> or uninstall');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
