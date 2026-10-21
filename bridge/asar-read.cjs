'use strict';
// Read the package version only; no writes to signed application files.
const fs = require('node:fs');
const path = require('node:path');
function version() {
  const asar = path.join(path.dirname(require('./config.cjs').load().workbuddyExe), 'resources', 'app.asar');
  const fd = fs.openSync(asar, 'r');
  try {
    const header = Buffer.alloc(16);
    if (fs.readSync(fd, header, 0, 16, 0) !== 16) throw new Error('Invalid ASAR header');
    const size = header.readUInt32LE(12);
    if (size < 1 || size > 32 * 1024 * 1024) throw new Error('Invalid ASAR index size');
    const bytes = Buffer.alloc(size);
    fs.readSync(fd, bytes, 0, size, 16);
    const item = JSON.parse(bytes.toString()).files['package.json'];
    if (!item || item.unpacked || item.link || item.size > 1024 * 1024) throw new Error('Unsupported ASAR package metadata');
    const data = Buffer.alloc(item.size);
    fs.readSync(fd, data, 0, data.length, 8 + header.readUInt32LE(4) + Number(item.offset));
    const value = JSON.parse(data.toString()).version;
    if (typeof value !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(value)) throw new Error('Invalid WorkBuddy version');
    return value;
  } finally { fs.closeSync(fd); }
}
exports.version = version;
