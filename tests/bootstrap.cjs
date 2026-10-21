'use strict';
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
if (!process.env.AA_WORKBUDDY_CONFIG) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-wb-test-'));
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, JSON.stringify({ workbuddyExe: 'C:\\Apps\\WorkBuddy\\WorkBuddyAI.exe', workspace: 'C:\\Projects\\WorkBuddy', nodePath: process.execPath, stateDir: dir }));
  process.env.AA_WORKBUDDY_CONFIG = file;
  process.on('exit', () => { fs.rmSync(dir, { recursive: true, force: true }); });
}
