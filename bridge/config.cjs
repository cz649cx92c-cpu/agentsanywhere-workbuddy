'use strict';
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
function load(file = process.env.AA_WORKBUDDY_CONFIG || path.join(ROOT, 'config.local.json')) {
  const config = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  for (const key of ['workbuddyExe', 'workspace', 'nodePath', 'stateDir']) {
    if (typeof config[key] !== 'string' || !path.win32.isAbsolute(config[key]) || /[\r\n\0]/.test(config[key])) {
      throw new Error('Invalid installation path: ' + key);
    }
  }
  config.workspace = path.win32.normalize(config.workspace);
  return config;
}
exports.ROOT = ROOT;
exports.load = load;
