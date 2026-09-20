'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { readArtifact } = require('../src/threadloop/files');
const { MAX_BYTES } = require('../src/threadloop/codec');

test('artifact handles reject growth after stat and close on failure (4d3b2297)', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'run-invariant-read-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'artifact.json');
  fs.writeFileSync(file, '{}');
  const originalStat = fs.fstatSync;
  const originalRead = fs.readSync;
  const originalClose = fs.closeSync;
  let bytes = 0;
  let closed = 0;
  let watchedHandle;
  t.mock.method(fs, 'fstatSync', (handle) => {
    watchedHandle = handle;
    const stat = originalStat(handle);
    fs.truncateSync(file, MAX_BYTES + 20 * 1024 * 1024);
    return stat;
  });
  t.mock.method(fs, 'readSync', (...args) => {
    const count = originalRead(...args);
    bytes += count;
    return count;
  });
  t.mock.method(fs, 'closeSync', (handle) => {
    if (handle === watchedHandle) closed++;
    return originalClose(handle);
  });
  assert.throws(() => readArtifact(root, 'artifact.json'), /byte limit/);
  assert.equal(bytes, MAX_BYTES + 2);
  assert.equal(closed, 1);
});

test('artifact handles reject direct and ancestor symlinks', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'run-invariant-read-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'actual'));
  fs.writeFileSync(path.join(root, 'actual/file'), '{}');
  fs.symlinkSync(path.join(root, 'actual/file'), path.join(root, 'link'));
  fs.symlinkSync(path.join(root, 'actual'), path.join(root, 'directory'));
  assert.throws(() => readArtifact(root, 'link'));
  assert.throws(() => readArtifact(root, 'directory/file'), /directory/);
  assert.equal(readArtifact(root, 'actual/file').toString(), '{}');
});
